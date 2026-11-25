"""Real LWApi + FightArchive against a routed fake HTTP session (no network).

Measures logins, requests and interruption when fight/get-logs answers 401, and
checks that historical meta.json files (without the diagnostic fields) still work.
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import FightArchive
import Garden
import Uri
from LWApi import LWApi
from test_fight_archive import make_fight

NOW = 1_000_000
LOGS_PATH = "/" + Uri.get_fight_logs


class Reply:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self.ok = status_code < 400
        self.payload = payload if payload is not None else {}

    def json(self):
        return self.payload


class RoutedSession:
    """Answers by URL: history, fights, logins and logs (always `logs_status`)."""

    def __init__(self, dates, logs_status=401, logs_body=None, login_ok=True):
        self.headers = {}
        self.dates = dates
        self.logs_status = logs_status
        self.logs_body = logs_body
        self.login_ok = login_ok
        self.logins = 0
        self.self_calls = 0
        self.logs_requests = 0
        self.requests = 0

    def post(self, url, **kwargs):
        self.requests += 1
        self.logins += 1
        if self.logins > 1 and not self.login_ok:
            return Reply(401, {"error": "bad credentials"})
        return Reply(200, {"token": "token-{0}".format(self.logins)})

    def get(self, url, **kwargs):
        self.requests += 1
        if url.endswith(Uri.get_self):
            self.self_calls += 1
            return Reply(200, {"farmer": {"id": 7}})
        if Uri.get_farmer_history in url:
            return Reply(200, {"fights": [{"id": i} for i in self.dates]})
        if Uri.get_fight_logs in url:
            self.logs_requests += 1
            if self.logs_status == 200:
                return Reply(200, {"logs": {"1": ["x"]}})
            return Reply(self.logs_status, self.logs_body or {"error": "unauthorized"})
        fight_id = int(url.rstrip("/").rsplit("/", 1)[1])
        return Reply(200, make_fight(fight_id, self.dates[fight_id]))


class ArchiveWithRealApiTests(unittest.TestCase):
    def setUp(self):
        for target in ("LWApi.time.sleep", "builtins.print"):
            patcher = patch(target)
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_archive(self, dates, mode="login", **session_options):
        api = LWApi()
        session = RoutedSession(dates, **session_options)
        api._LWApi__session = session
        connected = (api.connect("me", "pw") if mode == "login"
                     else api.connect_with_api_key("key"))
        self.assertTrue(connected)
        session.logins = 1 if mode == "login" else 0
        session.self_calls = 0
        session.requests = session.logs_requests = 0
        with tempfile.TemporaryDirectory() as data:
            stats = FightArchive.archive_fights(api, data, 7, "me", now=NOW)
            metas = FightArchive.list_archived_fights(data)
        return session, stats, metas

    def recent(self, count, first=1000):
        return {first + i: NOW - 150 for i in range(count)}

    def old(self, count, first=2000):
        return {first + i: NOW - 5000 for i in range(count)}

    def test_100_recent_fights_in_401_with_a_valid_session(self):
        for mode in ("login", "api_key"):
            session, stats, metas = self.run_archive(self.recent(100), mode)
            self.assertFalse(stats["interrupted"], mode)
            self.assertEqual((stats["archived"], stats["logs_not_ready"]), (100, 100), mode)
            # one re-login + one replay, then the rejected endpoint is no longer retried
            relogins = session.logins - 1 if mode == "login" else session.self_calls
            self.assertEqual(relogins, 1, mode)
            self.assertEqual(session.logs_requests, 101, mode)
            self.assertTrue(all(meta["logs_not_ready"] for meta in metas), mode)

    def test_100_old_fights_in_401_interrupt_after_three(self):
        session, stats, metas = self.run_archive(self.old(100))
        self.assertTrue(stats["interrupted"])
        self.assertEqual((stats["archived"], stats["logs_not_ready"]), (3, 0))
        self.assertEqual(session.logins, 2)  # initial + 1 re-login, never a burst
        self.assertEqual(session.logs_requests, 4)  # 3 fights + the single replay
        self.assertTrue(all("logs_not_ready" not in meta for meta in metas))

    def test_mix_of_recent_and_old_fights(self):
        # Fights are processed by decreasing id. Old ones first: they stop the run at 3.
        dates = {**self.recent(50, 1000), **self.old(50, 2000)}
        session, stats, _ = self.run_archive(dates)
        self.assertTrue(stats["interrupted"])
        self.assertEqual((stats["archived"], stats["logs_not_ready"]), (3, 0))
        # Recent ones first: the 50 are transparent, then 3 old ones interrupt.
        dates = {**self.recent(50, 2000), **self.old(50, 1000)}
        session, stats, _ = self.run_archive(dates)
        self.assertTrue(stats["interrupted"])
        self.assertEqual((stats["archived"], stats["logs_not_ready"]), (53, 50))
        self.assertEqual(session.logins, 2)

    def test_age_boundaries_missing_and_future_dates(self):
        cases = [  # (fight date, expected not_ready)
            (NOW - 599, True), (NOW - 600, False), (NOW - 601, False),
            (NOW, True), (None, False),
        ]
        for date, expected in cases:
            api = LWApi()
            api._LWApi__session = RoutedSession({1: date})
            with tempfile.TemporaryDirectory() as data:
                stats = FightArchive.archive_fights(api, data, 7, "me", now=NOW)
                meta = FightArchive.list_archived_fights(data)[0]
            self.assertEqual(stats["log_failures"][0]["not_ready"], expected, date)
            self.assertEqual(meta.get("logs_not_ready", False), expected, date)
            self.assertEqual(meta["logs_age_seconds"], None if date is None else NOW - date)

    def test_a_date_too_far_in_the_future_is_not_a_recent_fight(self):
        # A clock skew of one day must not make every 401 "logs not ready" forever.
        session, stats, _ = self.run_archive({i: NOW + 86400 for i in range(1, 11)})
        self.assertEqual(stats["logs_not_ready"], 0)
        self.assertTrue(stats["interrupted"])

    def test_refused_relogin_on_recent_fights_is_reported_as_session_loss(self):
        # Session lost mid-run: the re-login is refused (credentials rejected). The run
        # stops after 3 refusals instead of reporting 100 fights as "not ready".
        session, stats, _ = self.run_archive(self.recent(100), login_ok=False)
        self.assertTrue(stats["interrupted"])
        self.assertEqual((stats["archived"], stats["logs_not_ready"]), (3, 0))
        self.assertEqual(session.logs_requests, 3)
        self.assertTrue(all(f["relogin_refused"] and not f["not_ready"]
                            for f in stats["log_failures"]))

    def test_refused_api_key_relogin_on_recent_fights_is_reported_as_session_loss(self):
        class KeyRefusedSession(RoutedSession):
            def get(self, url, **kwargs):
                if url.endswith(Uri.get_self) and self.self_calls >= 1:
                    self.requests += 1
                    self.self_calls += 1
                    return Reply(401, {"error": "invalid key"})
                return super().get(url, **kwargs)

        api = LWApi()
        session = KeyRefusedSession(self.recent(100))
        api._LWApi__session = session
        self.assertTrue(api.connect_with_api_key("key"))
        with tempfile.TemporaryDirectory() as data:
            stats = FightArchive.archive_fights(api, data, 7, "me", now=NOW)
        self.assertTrue(api.relogin_refused())
        self.assertTrue(stats["interrupted"])
        self.assertEqual((stats["archived"], stats["logs_not_ready"]), (3, 0))

    def test_bearer_token_echoed_in_an_error_body_is_stored_and_printed(self):
        body = {"error": "invalid token", "token": "Bearer abc.def.ghi"}
        session, stats, metas = self.run_archive(self.old(1), logs_body=body)
        printed = Garden.describe_log_failure(stats["log_failures"][0])
        self.assertNotIn("abc.def.ghi", metas[0]["logs_error"])
        self.assertNotIn("abc.def.ghi", printed)

    def test_non_json_error_body_uses_the_text_and_is_truncated(self):
        class Html(Reply):
            text = "<html>" + "y" * 1000
            def json(self):
                raise ValueError("not json")

        self.assertEqual(len(FightArchive._error_excerpt(Html(401))),
                         FightArchive.MAX_ERROR_EXCERPT)
        self.assertEqual(FightArchive._error_excerpt(Reply(401, "")), "")


class HistoricalMetaMigrationTests(unittest.TestCase):
    """meta.json written before the diagnostic fields existed."""

    OLD_FIELDS = ("fight_id", "date", "account", "farmer_id", "fetched_at", "logs_status")

    def write_legacy(self, data, fight_id, status, date=NOW - 5000):
        folder = os.path.join(data, "fights", str(fight_id))
        os.makedirs(folder)
        fight = make_fight(fight_id, date)
        for name, payload in (
                ("fight.json", fight), ("logs.json", {"1": ["old"]} if status == "ok" else None),
                ("meta.json", {"fight_id": fight_id, "date": date, "account": "me",
                               "farmer_id": 7, "fetched_at": date + 10, "logs_status": status})):
            with open(os.path.join(folder, name), "w", encoding="utf-8") as handle:
                json.dump(payload, handle)

    def test_ok_meta_is_complete_listed_exported_and_has_the_same_keys_as_before(self):
        with tempfile.TemporaryDirectory() as data:
            self.write_legacy(data, 1, "ok")
            self.assertTrue(FightArchive._is_complete(data, 1, 7, "me"))
            self.assertEqual(len(FightArchive.list_archived_fights(data)), 1)
            exported = FightArchive.export_for_analysis(data)
            with open(next(iter(exported.values()))[0], encoding="utf-8") as handle:
                entry = json.load(handle)["fights"][0]
            self.assertEqual((entry["logs_status"], entry["debug_logs"]), ("ok", {"1": ["old"]}))
            self.assertNotIn("logs_error", entry)

            # a fresh "ok" archive keeps exactly the historical key set
            class Api:
                def get_farmer_history(self, _id):
                    return Reply(200, {"fights": [{"id": 2}]})

                def get_fight(self, _id):
                    return Reply(200, make_fight(2, NOW - 10))

                def get_fight_logs(self, _id):
                    return Reply(200, {"logs": {}})

            FightArchive.archive_fights(Api(), data, 7, "me", now=NOW)
            fresh = [m for m in FightArchive.list_archived_fights(data) if m["fight_id"] == 2][0]
            self.assertEqual(set(fresh), set(self.OLD_FIELDS))

    def test_legacy_http_401_meta_is_retried_and_upgraded_without_the_new_fields_blocking(self):
        class Api:
            def __init__(self):
                self.logs = 0

            def get_farmer_history(self, _id):
                return Reply(200, {"fights": [{"id": 1}]})

            def get_fight(self, _id):
                return Reply(200, make_fight(1, NOW - 5000))

            def get_fight_logs(self, _id):
                self.logs += 1
                return Reply(200, {"logs": {"1": ["new"]}})

        with tempfile.TemporaryDirectory() as data:
            self.write_legacy(data, 1, "http_401")
            self.assertFalse(FightArchive._is_complete(data, 1, 7, "me"))
            api = Api()
            stats = FightArchive.archive_fights(api, data, 7, "me", now=NOW)  # api has no auth_diagnostics
            self.assertEqual((api.logs, stats["archived"], stats["skipped"]), (1, 1, 0))
            meta = FightArchive.list_archived_fights(data)[0]
            self.assertEqual(meta["logs_status"], "ok")
            self.assertNotIn("logs_error", meta)
            self.assertNotIn("logs_not_ready", meta)

    def test_failure_without_auth_diagnostics_api_still_works_and_prints(self):
        class Api:
            def get_farmer_history(self, _id):
                return Reply(200, {"fights": [{"id": 1}]})

            def get_fight(self, _id):
                return Reply(200, make_fight(1, NOW - 5000))

            def get_fight_logs(self, _id):
                return Reply(401, "")

        with tempfile.TemporaryDirectory() as data:
            stats = FightArchive.archive_fights(Api(), data, 7, "me", now=NOW)
        line = Garden.describe_log_failure(stats["log_failures"][0])
        self.assertIn("auth unknown", line)
        self.assertIn("(empty)", line)

    def test_console_prints_at_most_ten_failure_lines(self):
        failures = [{"fight_id": i, "status": 401, "age_seconds": 5000, "error": "e"}
                    for i in range(25)]
        stats = {"listed": 25, "archived": 25, "skipped": 0, "pending": 0, "expired": 0,
                 "logs_missing": 25, "logs_not_ready": 0, "errors": 0, "interrupted": False,
                 "log_failures": failures, "pruned": {"publications": 0, "fights": 0}}
        with patch.object(FightArchive, "archive_fights", return_value=stats), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            Garden.archive_recent_fights(None, {"data_folder": "data"}, {"id": 7, "login": "me"})
        text = output.getvalue()
        self.assertEqual(text.count("Logs of fight "), Garden.MAX_PRINTED_LOG_FAILURES)
        self.assertIn("... and 15 more", text)


if __name__ == "__main__":
    unittest.main()
