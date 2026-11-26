import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import FightArchive
import Garden
import ReleaseFile
from test_garden_deploy import FakeApi, FakeResponse
from test_garden_publication import UnattendedApi, git_state, write

HEAD = {"commit": "b" * 40, "subject": "feat: x",
        "message": "feat: x\n\nStratégie: seuil 30 %\n*/ alert(1)\n\nCo-Authored-By: A <a@b>\n"
                   "Claude-Session: https://example.invalid/s"}


def git(folder, *args):
    subprocess.run(["git", "-C", folder, "-c", "user.name=t", "-c", "user.email=t@t",
                    "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"] + list(args),
                   check=True, capture_output=True)


class ContentTests(unittest.TestCase):
    def test_content_is_comment_only_and_names_commit_branch_tag_and_summary(self):
        content = ReleaseFile.build_content(HEAD, git_state(), "master", "leek-1", "me", now=0)
        lines = content.splitlines()
        self.assertEqual(lines[0], "// @version:5.8")
        self.assertTrue(all(line.startswith("//") for line in lines))
        for expected in ("// Commit déployé : " + "b" * 40, "// Branche : master",
                         "// Tag : leek-1", "// Compte : me",
                         "// Déployé le : 1970-01-01T00:00:00Z", "// feat: x",
                         "// Stratégie: seuil 30 %",
                         "// Dernier commit modifiant les sources ({0}) :".format("a" * 40)):
            self.assertIn(expected, lines)
        self.assertNotIn("Co-Authored-By", content)
        self.assertNotIn("Claude-Session", content)
        self.assertNotIn("ATTENTION", content)

    def test_dirty_sources_and_missing_git_are_stated(self):
        content = ReleaseFile.build_content(
            {"commit": None, "subject": "", "message": ""},
            dict(git_state(dirty=True), dirty_files=["Main/a.ts"]), "", "", "me", now=0)
        self.assertIn("// Commit déployé : inconnu", content)
        self.assertIn("// ATTENTION : sources modifiées localement", content)
        self.assertIn("Main/a.ts", content)
        self.assertIn("// Tag : aucun", content)


class GitTests(unittest.TestCase):
    def test_branch_and_tag_come_from_git_then_from_the_ci_environment(self):
        with tempfile.TemporaryDirectory() as root:
            git(root, "init", "-q", "-b", "work")
            write(root, "a.ts", "x")
            git(root, "add", ".")
            git(root, "commit", "-q", "-m", "feat: first\n\nStratégie: aucune")
            git(root, "tag", "leek-9")
            self.assertEqual(ReleaseFile.read_branch(root, {}), "work")
            self.assertEqual(ReleaseFile.read_tag(root, {}), "leek-9")
            head = ReleaseFile.read_head(root)
            self.assertEqual(head["subject"], "feat: first")
            self.assertIn("Stratégie: aucune", head["message"])
            # CI checks a tag out: HEAD is detached, the remote branches name it.
            git(root, "update-ref", "refs/remotes/origin/feature", "HEAD")
            git(root, "update-ref", "refs/remotes/origin/master", "HEAD")
            git(root, "checkout", "-q", "--detach")
            self.assertEqual(ReleaseFile.read_branch(root, {}), "master, feature")
            self.assertEqual(ReleaseFile.read_branch(
                root, {"GITHUB_REF_TYPE": "branch", "GITHUB_REF_NAME": "dev"}), "dev")
            self.assertEqual(ReleaseFile.read_tag(
                root, {"GITHUB_REF_TYPE": "tag", "GITHUB_REF_NAME": "leek-ci"}), "leek-ci")
        self.assertEqual(ReleaseFile.read_head(root)["commit"], None)


class PublishTests(unittest.TestCase):
    def publish(self, api):
        with patch.object(ReleaseFile, "read_head", return_value=HEAD), \
                patch.object(FightArchive, "read_git_state", return_value=git_state()):
            return ReleaseFile.publish(api, ".", "me", {}, now=0)

    def test_file_is_created_once_then_only_rewritten(self):
        api = FakeApi()
        self.assertTrue(self.publish(api))
        self.assertTrue(self.publish(api))
        self.assertEqual(api.created_ais, [("", "DEPLOYED.ts", 4)])
        self.assertEqual([path for path, _ in api.writes], ["DEPLOYED.ts"] * 2)
        self.assertIn("// Commit déployé : " + "b" * 40, api.codes["DEPLOYED.ts"])

    def test_hand_made_file_is_reused_whatever_its_case_or_extension(self):
        for existing in ("deployed.ts", "Deployed", "DEPLOYED.ts"):
            api = FakeApi(ais=[{"path": existing}, {"path": "Main/DEPLOYED.ts"}],
                          codes={existing: "", "Main/DEPLOYED.ts": "keep"})
            self.assertTrue(self.publish(api))
            self.assertEqual(api.created_ais, [])
            self.assertIn("// Commit déployé : " + "b" * 40, api.codes[existing])
            self.assertEqual(api.codes["Main/DEPLOYED.ts"], "keep")
            with tempfile.TemporaryDirectory() as root:
                write(root, "main.ts", "code")
                offered = []
                Garden.deploy_local_ais(
                    api, root, lambda files, folders: offered.append(files) or False)
                self.assertEqual(offered, [["Main/DEPLOYED.ts"]])

    def test_refused_creation_or_write_is_reported_not_raised(self):
        class NoCreate(FakeApi):
            def create_ai(self, folder, name, version=4):
                return FakeResponse(ok=False, content="wrong_token")

        class NoWrite(FakeApi):
            def write_ai(self, path, code):
                return FakeResponse(ok=False, content="boom")

        class NoTree(FakeApi):
            def get_ai_tree(self):
                return {"error": "wrong_token"}

        for api in (NoCreate(), NoWrite(), NoTree()):
            self.assertFalse(self.publish(api))
            self.assertNotIn("DEPLOYED.ts", api.codes)


class GardenIntegrationTests(unittest.TestCase):
    def test_unattended_push_writes_the_release_file_and_keeps_its_exit_code(self):
        for api_class, expected in ((UnattendedApi, True), (None, False)):
            if api_class is None:
                class api_class(UnattendedApi):
                    def create_ai(self, folder, name, version=4):
                        if name == "DEPLOYED.ts":
                            return FakeResponse(ok=False, content="wrong_token")
                        return super().create_ai(folder, name, version)
            api = api_class(ais=[{"path": "main.ts"}], codes={"main.ts": "old"})
            with tempfile.TemporaryDirectory() as root:
                write(root, "main.ts", "code")
                config = {"AIs_folder": root, "accounts": [],
                          "data_folder": os.path.join(root, "data")}
                with patch.object(FightArchive, "read_git_state", return_value=git_state()), \
                        patch.object(ReleaseFile, "read_head", return_value=HEAD):
                    code = Garden.push_unattended(api, {"LEEKWARS_API_KEY": "key"}, config)
            self.assertEqual(code, 0)
            self.assertEqual("DEPLOYED.ts" in api.codes, expected)
            self.assertIn("main.ts", api.codes)

    def test_release_file_is_never_a_deletion_candidate_nor_pulled_as_a_source(self):
        with tempfile.TemporaryDirectory() as root:
            write(root, "main.ts", "code")
            api = FakeApi(ais=[{"path": "DEPLOYED.ts"}, {"path": "old.ts"}],
                          codes={"DEPLOYED.ts": "// x", "old.ts": "y"})
            offered = []
            summary = Garden.deploy_local_ais(
                api, root, lambda files, folders: offered.append(files) or True)
            self.assertEqual(offered, [["old.ts"]])
            self.assertEqual(summary["deleted_files"], 1)
            self.assertIn("DEPLOYED.ts", api.codes)
            Garden.get_all_ais(api, root)
            self.assertEqual(sorted(os.listdir(root)), ["main.ts"])


if __name__ == "__main__":
    unittest.main()
