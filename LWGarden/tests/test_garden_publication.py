import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import FightArchive
import Garden
from LWApi import LWApi
from test_garden_deploy import FakeApi as DeployFakeApi


def write(folder, name, content):
    with open(os.path.join(folder, name), "w", encoding="utf-8") as handle:
        handle.write(content)


def git_state(commit="a" * 40, message="feat: x\n\nStratégie: seuil 30 %", dirty=False):
    return {"commit": commit, "committed_at": 1, "subject": message.splitlines()[0],
            "message": message, "dirty": dirty, "dirty_files": []}


class DeploySummaryTests(unittest.TestCase):
    def test_summary_counts_and_source_hash_follow_the_deployed_content(self):
        with tempfile.TemporaryDirectory() as root:
            write(root, "a.ts", "one")
            write(root, "b.leek", "two")
            first = Garden.deploy_local_ais(DeployFakeApi(), root)
            self.assertEqual((first["created"], first["updated"]), (2, 0))
            self.assertEqual((first["deleted_files"], first["deleted_folders"]), (0, 0))

            again = Garden.deploy_local_ais(DeployFakeApi(), root)
            self.assertEqual(again["source_hash"], first["source_hash"])

            write(root, "a.ts", "changed")
            changed = Garden.deploy_local_ais(DeployFakeApi(), root)
            self.assertNotEqual(changed["source_hash"], first["source_hash"])

    def test_summary_reports_updates_and_remote_deletions(self):
        with tempfile.TemporaryDirectory() as root:
            write(root, "main.ts", "new")
            api = DeployFakeApi(
                folders=["Old"],
                ais=[{"path": "main.ts"}, {"path": "Old/ai"}],
                codes={"main.ts": "old", "Old/ai": "x"},
            )
            summary = Garden.deploy_local_ais(api, root, lambda files, folders: True)
            self.assertEqual(
                (summary["created"], summary["updated"],
                 summary["deleted_files"], summary["deleted_folders"]),
                (0, 1, 1, 1))


class PushAllAisCallbackTests(unittest.TestCase):
    def test_on_published_is_called_per_secondary_and_stays_optional(self):
        class SecondaryApi(DeployFakeApi):
            def __init__(self):
                super().__init__()
                self.login = None

            def connect(self, username, password):
                self.login = username
                return True

            def get_farmer_self(self):
                return {"farmer": {"login": self.login}}

        secondaries = [{"username": "s1", "password": "x"}, {"username": "s2", "password": "x"}]
        with tempfile.TemporaryDirectory() as root:
            write(root, "a.ts", "one")
            Garden.push_all_ais(SecondaryApi(), secondaries, root)  # legacy call signature
            calls = []
            Garden.push_all_ais(SecondaryApi(), secondaries, root,
                                on_published=lambda login, summary: calls.append((login, summary)))
        self.assertEqual([login for login, _ in calls], ["s1", "s2"])
        self.assertTrue(all(summary["source_hash"] for _, summary in calls))


class GardenRecordPublicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.config = {"AIs_folder": self.tmp.name, "data_folder": os.path.join(self.tmp.name, "data")}
        self.summary = {"created": 0, "updated": 1, "deleted_files": 0,
                        "deleted_folders": 0, "source_hash": "ab" * 20}

    def tearDown(self):
        self.tmp.cleanup()

    def record(self, summary, state=None):
        with patch.object(FightArchive, "read_git_state", return_value=state or git_state()):
            return Garden.record_publication(self.config, "me", summary)

    def test_nothing_changed_or_no_summary_records_nothing(self):
        unchanged = dict(self.summary, updated=0)
        self.assertIsNone(self.record(unchanged))
        self.assertIsNone(self.record(None))
        self.assertEqual(FightArchive.load_publications(self.config["data_folder"]), [])

    def test_changed_push_is_recorded_once_and_honours_retention_setting(self):
        record = self.record(self.summary)
        self.assertEqual(record["id"], "aaaaaaa")
        self.assertTrue(record["has_strategy_section"])
        self.assertIsNone(self.record(self.summary))
        self.assertEqual(Garden.retention_versions(self.config), FightArchive.DEFAULT_RETENTION)
        self.assertEqual(Garden.retention_versions({"retention_versions": 3}), 3)

    def test_dirty_sources_get_a_content_bound_version_id(self):
        record = self.record(self.summary, git_state(dirty=True))
        self.assertEqual(record["id"], "aaaaaaa-dirty-" + ("ab" * 20)[:6])
        self.assertTrue(record["dirty"])

    def test_storage_failure_does_not_break_the_push_flow(self):
        with patch.object(FightArchive, "record_publication", side_effect=OSError("disk full")):
            self.assertIsNone(self.record(self.summary))


class RemoteTreeErrorTests(unittest.TestCase):
    def test_error_response_is_reported_and_never_wipes_local_sources(self):
        class ErrorApi:
            def get_ai_tree(self):
                return {"error": "unauthorized"}

        with tempfile.TemporaryDirectory() as root:
            marker = os.path.join(root, "keep.ts")
            with open(marker, "w") as handle:
                handle.write("x")
            for action in (lambda: Garden.get_all_ais(ErrorApi(), root),
                           lambda: Garden.deploy_local_ais(ErrorApi(), root)):
                with self.assertRaisesRegex(RuntimeError, "unauthorized"):
                    action()
            self.assertTrue(os.path.exists(marker))


class RetentionBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def publish(self, account, count, start=1000):
        for index in range(count):
            FightArchive.record_publication(
                self.data, account, git_state((account[0] + "%06x" % index).ljust(40, "0")),
                "ab" * 20, {}, now=start + index * 100
            )

    def store_fight(self, fight_id, date, account):
        FightArchive._write_json(
            os.path.join(self.data, "fights", str(fight_id), "meta.json"),
            {"fight_id": fight_id, "date": date, "account": account, "logs_status": "ok"})

    def test_nine_publications_keep_everything_ten_start_pruning_at_the_oldest_kept(self):
        self.publish("me", 9)
        self.store_fight(1, 10, "me")
        self.assertEqual(FightArchive.prune(self.data), {"publications": 0, "fights": 0})
        self.publish("me", 1, start=1900)
        self.assertEqual(len(FightArchive.load_publications(self.data)), 10)
        self.assertEqual(FightArchive.list_archived_fights(self.data), [])

    def test_fight_exactly_at_the_oldest_kept_publication_is_kept(self):
        self.publish("me", 12)  # kept: published_at 1200 .. 2100
        self.store_fight(1, 1199, "me")
        self.store_fight(2, 1200, "me")
        FightArchive.prune(self.data)
        self.assertEqual([m["fight_id"] for m in FightArchive.list_archived_fights(self.data)], [2])

    def test_retention_is_per_account(self):
        self.publish("me", 12)
        self.publish("other", 2, start=500)
        self.store_fight(1, 600, "other")
        FightArchive.prune(self.data)
        accounts = [p["account"] for p in FightArchive.load_publications(self.data)]
        self.assertEqual(accounts.count("me"), 10)
        self.assertEqual(accounts.count("other"), 2)
        self.assertEqual(len(FightArchive.list_archived_fights(self.data)), 1)


class FightOutcomeTests(unittest.TestCase):
    def test_outcome_from_the_farmer_point_of_view(self):
        fight = {"farmers1": {"7": {}}, "farmers2": {"8": {}}, "winner": 2}
        self.assertEqual(FightArchive.fight_outcome(fight, 8), "win")
        self.assertEqual(FightArchive.fight_outcome(fight, 7), "loss")
        self.assertEqual(FightArchive.fight_outcome(dict(fight, winner=0), 7), "draw")
        self.assertIsNone(FightArchive.fight_outcome(fight, 99))
        self.assertIsNone(FightArchive.fight_outcome(dict(fight, winner=None), 7))


class ApiEndpointTests(unittest.TestCase):
    def test_archive_endpoints_append_the_numeric_id_to_the_documented_paths(self):
        api = LWApi()
        requested = []

        class Response:
            ok = True

            def json(self):
                return {}

        session = api._LWApi__session
        with patch.object(session, "get", side_effect=lambda url, **kw: requested.append(url) or Response()):
            api.get_farmer_history("7")
            api.get_fight(123)
            api.get_fight_logs(123)
            with self.assertRaises(ValueError):
                api.get_fight("1/../2")
        root = api._LWApi__root_url
        self.assertEqual(requested, [
            root + "history/get-farmer-history/7",
            root + "fight/get/123",
            root + "fight/get-logs/123",
        ])


if __name__ == "__main__":
    unittest.main()
