import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import FightArchive


class FakeResponse:
    def __init__(self, payload=None, ok=True, status_code=200):
        self.payload = payload
        self.ok = ok
        self.status_code = status_code

    def json(self):
        return self.payload


class FakeApi:
    def __init__(self, fights, history_ids=None, logs_ok=True):
        self.fights = fights
        self.history_ids = history_ids if history_ids is not None else list(fights)
        self.logs_ok = logs_ok
        self.fight_calls = []

    def get_farmer_history(self, farmer_id):
        return FakeResponse({"fights": [{"id": i} for i in self.history_ids]})

    def get_fight(self, fight_id):
        self.fight_calls.append(fight_id)
        return FakeResponse(self.fights[fight_id])

    def get_fight_logs(self, fight_id):
        if not self.logs_ok:
            return FakeResponse(None, ok=False, status_code=403)
        return FakeResponse({"logs": {"1": ["turn 1 log {0}".format(fight_id)]}})


def make_fight(fight_id, date, winner=1, status=2):
    return {
        "id": fight_id, "date": date, "status": status, "winner": winner,
        "farmers1": {"7": {"id": 7}}, "farmers2": {"8": {"id": 8}},
        "report": {"duration": 9}, "data": {"actions": [[0]]},
    }


def git_state(commit, message="feat: x\n\nStratégie: y", dirty=False):
    return {"commit": commit, "committed_at": 1, "subject": message.splitlines()[0],
            "message": message, "dirty": dirty, "dirty_files": []}


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def publish(self, commit, when, account="me", **kwargs):
        return FightArchive.record_publication(
            self.data, account, git_state(commit, **kwargs), "ab" * 20,
            {"created": 0, "updated": 1}, now=when
        )

    def test_same_version_is_not_recorded_twice(self):
        self.assertIsNotNone(self.publish("a" * 40, 100))
        self.assertIsNone(self.publish("a" * 40, 200))
        self.assertEqual(len(FightArchive.load_publications(self.data)), 1)

    def test_dirty_version_id_depends_on_sources(self):
        clean = FightArchive.build_version_id(git_state("a" * 40), "11" * 20)
        dirty = FightArchive.build_version_id(git_state("a" * 40, dirty=True), "11" * 20)
        other = FightArchive.build_version_id(git_state("a" * 40, dirty=True), "22" * 20)
        self.assertEqual(clean, "aaaaaaa")
        self.assertNotEqual(dirty, other)
        self.assertTrue(dirty.startswith("aaaaaaa-dirty-"))

    def test_fight_belongs_to_latest_publication_before_it(self):
        self.publish("a" * 40, 100)
        self.publish("b" * 40, 200)
        self.publish("c" * 40, 150, account="other")
        publications = FightArchive.load_publications(self.data)
        self.assertIsNone(FightArchive.version_for_fight(publications, "me", 99))
        self.assertEqual(FightArchive.version_for_fight(publications, "me", 150)["id"], "aaaaaaa")
        self.assertEqual(FightArchive.version_for_fight(publications, "me", 200)["id"], "bbbbbbb")

    def test_strategy_section_detection(self):
        self.assertTrue(FightArchive.message_has_strategy_section("feat: a\n\nStratégie: seuil 30%"))
        self.assertTrue(FightArchive.message_has_strategy_section("fix: a\n\nStrategie: inchangé"))
        self.assertFalse(FightArchive.message_has_strategy_section("feat: a\n\nStratégie:"))
        self.assertFalse(FightArchive.message_has_strategy_section("feat: a"))

    def test_read_git_state_uses_last_commit_of_sources_and_ignores_other_files(self):
        repo = os.path.join(self.data, "repo")
        source = os.path.join(repo, "src")
        os.makedirs(os.path.join(source, "_oldLeekScript"))

        def git(*args):
            subprocess.run(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t"]
                           + list(args), check=True, capture_output=True)

        git("init")
        with open(os.path.join(source, "a.ts"), "w") as handle:
            handle.write("1")
        git("add", ".")
        git("commit", "-m", "feat: code\n\nStratégie: seuil")
        with open(os.path.join(repo, "notes.md"), "w") as handle:
            handle.write("doc")
        git("add", ".")
        git("commit", "-m", "docs: notes")
        for name in ("notes.txt", os.path.join("_oldLeekScript", "old.leek")):
            with open(os.path.join(source, name), "w") as handle:
                handle.write("x")
        state = FightArchive.read_git_state(source)
        self.assertEqual(state["subject"], "feat: code")
        self.assertFalse(state["dirty"])

    def test_read_git_state_detects_message_and_dirty_sources(self):
        repo = os.path.join(self.data, "repo")
        os.makedirs(repo)

        def git(*args):
            subprocess.run(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t"]
                           + list(args), check=True, capture_output=True)

        git("init")
        with open(os.path.join(repo, "a.ts"), "w") as handle:
            handle.write("1")
        git("add", ".")
        git("commit", "-m", "feat: sujet\n\nStratégie: corps")
        state = FightArchive.read_git_state(repo)
        self.assertEqual(state["subject"], "feat: sujet")
        self.assertIn("Stratégie: corps", state["message"])
        self.assertFalse(state["dirty"])
        with open(os.path.join(repo, "a.ts"), "w") as handle:
            handle.write("2")
        self.assertTrue(FightArchive.read_git_state(repo)["dirty"])
        self.assertIsNone(FightArchive.read_git_state(self.data)["commit"])

    def test_new_untracked_source_directory_is_dirty(self):
        repo = os.path.join(self.data, "repo")
        source = os.path.join(repo, "src")
        os.makedirs(source)

        def git(*args):
            subprocess.run(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t"]
                           + list(args), check=True, capture_output=True)

        git("init")
        with open(os.path.join(source, "base.ts"), "w", encoding="utf-8") as handle:
            handle.write("base")
        git("add", ".")
        git("commit", "-m", "feat: base")
        self.assertFalse(FightArchive.read_git_state(source)["dirty"])

        os.makedirs(os.path.join(source, "new", "nested"))
        with open(os.path.join(source, "new", "nested", "ai.ts"), "w", encoding="utf-8") as handle:
            handle.write("new AI")
        state = FightArchive.read_git_state(source)
        self.assertTrue(state["dirty"])
        self.assertTrue(any(path.replace("\\", "/").endswith("new/nested/ai.ts")
                            for path in state["dirty_files"]))
        self.assertIn("-dirty-", FightArchive.build_version_id(state, "ab" * 20))


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def test_archive_stores_fight_and_logs_and_skips_complete_ones(self):
        api = FakeApi({10: make_fight(10, 500), 11: make_fight(11, 600, status=1)})
        stats = FightArchive.archive_fights(api, self.data, 7, "me")
        self.assertEqual((stats["archived"], stats["pending"]), (1, 1))
        folder = os.path.join(self.data, "fights", "10")
        with open(os.path.join(folder, "logs.json"), encoding="utf-8") as handle:
            self.assertEqual(json.load(handle), {"1": ["turn 1 log 10"]})
        api.fight_calls.clear()
        stats = FightArchive.archive_fights(api, self.data, 7, "me")
        self.assertEqual(stats["skipped"], 1)
        self.assertEqual(api.fight_calls, [11])

    def test_missing_logs_are_retried_later(self):
        api = FakeApi({10: make_fight(10, 500)}, logs_ok=False)
        stats = FightArchive.archive_fights(api, self.data, 7, "me")
        self.assertEqual(stats["logs_missing"], 1)
        api.logs_ok = True
        stats = FightArchive.archive_fights(api, self.data, 7, "me")
        self.assertEqual(stats["archived"], 1)
        self.assertEqual(FightArchive.list_archived_fights(self.data)[0]["logs_status"], "ok")

    def test_retention_keeps_last_ten_publications_and_their_fights(self):
        for index in range(12):
            FightArchive.record_publication(
                self.data, "me", git_state(("%07x" % (index + 1)).ljust(40, "0")), "ab" * 20,
                {}, now=1000 + index * 100
            )
        publications = FightArchive.load_publications(self.data)
        self.assertEqual(len(publications), 10)
        self.assertEqual(publications[0]["published_at"], 1200)
        api = FakeApi({1: make_fight(1, 1150), 2: make_fight(2, 1250)})
        FightArchive.archive_fights(api, self.data, 7, "me")
        remaining = [meta["fight_id"] for meta in FightArchive.list_archived_fights(self.data)]
        self.assertEqual(remaining, [2])

    def test_export_groups_fights_by_version_with_outcome(self):
        FightArchive.record_publication(
            self.data, "me", git_state("a" * 40, message="feat: a\n\nStratégie: s"),
            "ab" * 20, {}, now=100
        )
        api = FakeApi({10: make_fight(10, 500, winner=1), 11: make_fight(11, 50, winner=2)})
        FightArchive.archive_fights(api, self.data, 7, "me")
        exported = FightArchive.export_for_analysis(self.data)
        self.assertEqual({key: count for key, (_, count) in exported.items()},
                         {"aaaaaaa": 1, "unknown-version": 1})
        with open(exported["aaaaaaa"][0], encoding="utf-8") as handle:
            content = json.load(handle)
        self.assertEqual(content["version"]["message"], "feat: a\n\nStratégie: s")
        entry = content["fights"][0]
        self.assertEqual(entry["outcome"], "win")
        self.assertEqual(entry["debug_logs"], {"1": ["turn 1 log 10"]})
        self.assertNotIn("data", entry["fight"])
        self.assertEqual(FightArchive.export_for_analysis(self.data, "zzz"), {})

    def test_shared_fight_is_archived_and_exported_for_each_account(self):
        for account, commit in (("first", "a" * 40), ("second", "b" * 40)):
            FightArchive.record_publication(
                self.data, account, git_state(commit), "ab" * 20, {}, now=100
            )

        class AccountApi(FakeApi):
            def __init__(self, account):
                super().__init__({10: make_fight(10, 500, winner=1)})
                self.account = account

            def get_fight_logs(self, fight_id):
                return FakeResponse({"logs": {"owner": self.account}})

        first, second = AccountApi("first"), AccountApi("second")
        legacy = os.path.join(self.data, "fights", "10")
        os.makedirs(legacy)
        for filename, payload in (
            ("fight.json", make_fight(10, 500, winner=1)),
            ("logs.json", {"owner": "first"}),
            ("meta.json", {"fight_id": 10, "date": 500, "account": "first",
                           "farmer_id": 7, "fetched_at": 600, "logs_status": "ok"}),
        ):
            with open(os.path.join(legacy, filename), "w", encoding="utf-8") as handle:
                json.dump(payload, handle)
        self.assertEqual(FightArchive.archive_fights(first, self.data, 7, "first")["skipped"], 1)
        FightArchive.archive_fights(second, self.data, 8, "second")
        archived = FightArchive.list_archived_fights(self.data)
        self.assertEqual({(meta["account"], meta["fight_id"]) for meta in archived},
                         {("first", 10), ("second", 10)})

        exported = FightArchive.export_for_analysis(self.data)
        entries = {}
        for path, _ in exported.values():
            with open(path, encoding="utf-8") as handle:
                content = json.load(handle)
            for entry in content["fights"]:
                entries[entry["account"]] = entry
        self.assertEqual(set(entries), {"first", "second"})
        for account, commit, outcome in (("first", "a" * 40, "win"),
                                         ("second", "b" * 40, "loss")):
            entry = entries[account]
            self.assertEqual(entry["publication"]["account"], account)
            self.assertEqual(entry["publication"]["commit"], commit)
            self.assertEqual(entry["fight_id"], 10)
            self.assertEqual(entry["outcome"], outcome)
            self.assertEqual(entry["debug_logs"], {"owner": account})

        for api, farmer_id, account in ((first, 7, "first"), (second, 8, "second")):
            api.fight_calls.clear()
            self.assertEqual(FightArchive.archive_fights(api, self.data, farmer_id, account)["skipped"], 1)
            self.assertEqual(api.fight_calls, [])

    def test_retention_removes_only_the_expired_account_of_a_shared_fight(self):
        for account, commit in (("first", "a" * 40), ("second", "b" * 40)):
            FightArchive.record_publication(
                self.data, account, git_state(commit), "ab" * 20, {}, now=100
            )
        fight = make_fight(10, 500, winner=1)
        first, second = FakeApi({10: fight}), FakeApi({10: fight})
        FightArchive.archive_fights(first, self.data, 7, "first")
        FightArchive.archive_fights(second, self.data, 8, "second")

        FightArchive.record_publication(
            self.data, "first", git_state("c" * 40), "ab" * 20, {}, now=600, retention=1
        )
        archived = FightArchive.list_archived_fights(self.data)
        self.assertEqual([(meta["account"], meta["fight_id"]) for meta in archived],
                         [("second", 10)])
        second.fight_calls.clear()
        self.assertEqual(FightArchive.archive_fights(second, self.data, 8, "second")["skipped"], 1)
        self.assertEqual(second.fight_calls, [])
        exported = FightArchive.export_for_analysis(self.data)
        path, count = exported["bbbbbbb"]
        self.assertEqual(count, 1)
        with open(path, encoding="utf-8") as handle:
            entry = json.load(handle)["fights"][0]
        self.assertEqual((entry["account"], entry["fight_id"], entry["outcome"]),
                         ("second", 10, "loss"))
        self.assertEqual(entry["publication"]["account"], "second")
        self.assertEqual(entry["debug_logs"], {"1": ["turn 1 log 10"]})

    def test_legacy_archive_without_farmer_id_is_reused_exported_and_pruned(self):
        for account, commit in (("first", "a" * 40), ("second", "b" * 40)):
            FightArchive.record_publication(
                self.data, account, git_state(commit), "ab" * 20, {}, now=100
            )
        legacy = os.path.join(self.data, "fights", "10")
        os.makedirs(legacy)
        for filename, payload in (
            ("fight.json", make_fight(10, 500)),
            ("logs.json", {"owner": "first"}),
            ("meta.json", {"fight_id": 10, "date": 500, "account": "first",
                           "logs_status": "ok"}),
        ):
            with open(os.path.join(legacy, filename), "w", encoding="utf-8") as handle:
                json.dump(payload, handle)
        api = FakeApi({10: make_fight(10, 500)})
        self.assertEqual(FightArchive.archive_fights(api, self.data, 7, "first")["skipped"], 1)
        self.assertEqual(api.fight_calls, [])
        FightArchive.archive_fights(api, self.data, 8, "second")

        exported = FightArchive.export_for_analysis(self.data)
        with open(exported["aaaaaaa"][0], encoding="utf-8") as handle:
            first = json.load(handle)["fights"][0]
        self.assertEqual(first["account"], "first")
        self.assertEqual(first["publication"]["account"], "first")
        self.assertEqual(first["debug_logs"], {"owner": "first"})
        self.assertIsNone(first["outcome"])

        FightArchive.record_publication(
            self.data, "first", git_state("c" * 40), "ab" * 20, {}, now=600, retention=1
        )
        self.assertEqual([(m["account"], m["fight_id"])
                          for m in FightArchive.list_archived_fights(self.data)],
                         [("second", 10)])
        with open(FightArchive.export_for_analysis(self.data)["bbbbbbb"][0],
                  encoding="utf-8") as handle:
            second = json.load(handle)["fights"][0]
        self.assertEqual((second["account"], second["fight_id"], second["outcome"]),
                         ("second", 10, "loss"))

    def test_same_commit_exports_each_account_with_its_own_publication(self):
        commit = "a" * 40
        for account, when in (("first", 100), ("second", 200)):
            FightArchive.record_publication(
                self.data, account, git_state(commit), "ab" * 20, {}, now=when
            )
        FightArchive.archive_fights(FakeApi({10: make_fight(10, 500)}),
                                    self.data, 7, "first")
        FightArchive.archive_fights(FakeApi({11: make_fight(11, 500)}),
                                    self.data, 8, "second")

        exported = FightArchive.export_for_analysis(self.data)
        self.assertEqual(set(exported), {"aaaaaaa"})
        path, count = exported["aaaaaaa"]
        self.assertEqual(count, 2)
        with open(path, encoding="utf-8") as handle:
            content = json.load(handle)
        self.assertIsNone(content["version"])
        publications = {publication["account"]: publication
                        for publication in content["publications"]}
        entries = {entry["account"]: entry for entry in content["fights"]}
        self.assertEqual(set(publications), {"first", "second"})
        self.assertEqual(set(entries), {"first", "second"})
        for account, when, fight_id in (("first", 100, 10), ("second", 200, 11)):
            publication = publications[account]
            self.assertEqual(publication["commit"], commit)
            self.assertEqual(publication["published_at"], when)
            self.assertEqual(entries[account]["fight_id"], fight_id)
            self.assertEqual(entries[account]["publication"], publication)


if __name__ == "__main__":
    unittest.main()
