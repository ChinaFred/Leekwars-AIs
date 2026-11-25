import contextlib
import io
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import FightArchive
import Garden
import Uri
from LWApi import LWApi
from test_fight_archive import FakeApi as ArchiveFakeApi, make_fight


class Reply:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self.ok = status_code < 400
        self.payload = payload if payload is not None else {}

    def json(self):
        return self.payload


class ScriptedSession:
    """Stands in for requests.Session: logins and API calls answered by handlers."""

    def __init__(self, login_replies, api_replies):
        self.headers = {}
        self.login_replies = list(login_replies)
        self.api_replies = list(api_replies)
        self.calls = []  # (method, path, Authorization, kwargs)

    def _answer(self, method, url, kwargs):
        self.calls.append((method, url, self.headers.get("Authorization"), dict(kwargs)))
        replies = self.login_replies if url.endswith(Uri.login) else self.api_replies
        reply = replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply

    def get(self, url, **kwargs):
        return self._answer("get", url, kwargs)

    def post(self, url, **kwargs):
        return self._answer("post", url, kwargs)

    def delete(self, url, **kwargs):
        return self._answer("delete", url, kwargs)

    def api_calls(self):
        return [call for call in self.calls if not call[1].endswith(Uri.login)]

    def logins(self):
        return [call for call in self.calls if call[1].endswith(Uri.login)]


def login_ok(token):
    return Reply(200, {"token": token})


def make_api(login_replies, api_replies, clock=None):
    api = LWApi(clock=clock) if clock else LWApi()
    session = ScriptedSession(login_replies, api_replies)
    api._LWApi__session = session
    return api, session


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class ReauthenticationTests(unittest.TestCase):
    def setUp(self):
        sleeper = patch("LWApi.time.sleep")
        sleeper.start()
        self.addCleanup(sleeper.stop)
        printer = patch("builtins.print")
        printer.start()
        self.addCleanup(printer.stop)

    def test_401_authenticates_again_once_and_replays_the_get(self):
        api, session = make_api([login_ok("t1"), login_ok("t2")],
                                [Reply(401), Reply(200, {"logs": {}})])
        api.connect("me", "pw")
        response = api.get_fight_logs(5)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(session.logins()), 2)
        first, second = session.api_calls()
        self.assertEqual((first[1], first[2]), (second[1], "Bearer t1"))
        self.assertEqual(second[2], "Bearer t2")
        self.assertEqual(session.logins()[1][3]["json"], {"login": "me", "password": "pw"})

    def test_json_and_legacy_token_bodies_are_replayed_with_the_new_token(self):
        api, session = make_api([login_ok("t1"), login_ok("t2"), login_ok("t3")],
                                [Reply(401), Reply(200), Reply(401), Reply(200, {})])
        api.connect("me", "pw")
        self.assertEqual(api.write_ai("a.ts", "code").status_code, 200)
        first, second = session.api_calls()
        self.assertEqual(first[3]["json"], {"path": "a.ts", "code": "code"})
        self.assertEqual(second[3]["json"], first[3]["json"])

        api.get_scheme()
        legacy_first, legacy_second = session.api_calls()[2:]
        self.assertEqual(legacy_first[3]["data"], {"token": "t2"})
        self.assertEqual(legacy_second[3]["data"], {"token": "t3"})
        self.assertEqual(len(session.logins()), 3)

    def test_failed_reauthentication_returns_the_original_response_without_looping(self):
        api, session = make_api([login_ok("t1"), Reply(401)], [Reply(401), Reply(401)])
        api.connect("me", "pw")
        response = api.get_fight_logs(5)
        self.assertEqual(response.status_code, 401)
        self.assertEqual(len(session.api_calls()), 1)
        self.assertEqual(len(session.logins()), 2)
        self.assertEqual(session.headers["Authorization"], "Bearer t1")
        # circuit breaker: after a failed re-login, later 401 do not try to log in again
        self.assertEqual(api.get_fight_logs(6).status_code, 401)
        self.assertEqual(len(session.logins()), 2)

    def test_failed_reauthentication_is_logged_without_secrets(self):
        api, session = make_api([login_ok("t1"), Reply(401)], [Reply(401)])
        api.connect("me", "s3cret-pw")
        with patch("builtins.print") as printed:
            api.get_fight_logs(5)
        output = " ".join(str(arg) for call in printed.call_args_list for arg in call.args)
        self.assertIn("re-authentication failed; not retrying", output)
        for secret in ("s3cret-pw", "t1"):
            self.assertNotIn(secret, output)

    def test_refused_credentials_do_not_cause_a_login_burst(self):
        fights = 100  # DEFAULT_MAX_NEW_FIGHTS of the archive
        api, session = make_api([login_ok("t1")] + [Reply(401)] * fights, [Reply(401)] * fights)
        api.connect("me", "pw")
        for fight_id in range(fights):
            self.assertEqual(api.get_fight_logs(fight_id).status_code, 401)
        # the initial login plus a few re-login attempts at most, not one per fight
        self.assertLessEqual(len(session.logins()), 4)
        self.assertEqual(len(session.logins()), 2)
        self.assertEqual(len(session.api_calls()), fights)

    def test_endpoint_still_401_after_a_good_relogin_is_not_a_login_burst(self):
        fights = 100
        # fight/get answers 200 even with a bad token (public); get-logs keeps answering 401
        replies = [Reply(200, {}), Reply(401), Reply(401)] + [Reply(200, {}), Reply(401)] * (fights - 1)
        api, session = make_api([login_ok("t1"), login_ok("t2")], replies)
        api.connect("me", "pw")
        for fight_id in range(fights):
            self.assertEqual(api.get_fight(fight_id).status_code, 200)
            self.assertEqual(api.get_fight_logs(fight_id).status_code, 401)
        self.assertEqual(len(session.logins()), 2)
        self.assertEqual(len(session.api_calls()), 1 + 2 + 2 * (fights - 1))

    def test_a_rejected_endpoint_can_trigger_a_relogin_again_once_it_succeeds(self):
        api, session = make_api([login_ok("t1"), login_ok("t2"), login_ok("t3")],
                                [Reply(401), Reply(401), Reply(200, {}), Reply(401), Reply(200, {})])
        api.connect("me", "pw")
        self.assertEqual(api.get_fight_logs(1).status_code, 401)   # re-login 1, replay still 401
        self.assertEqual(api.get_fight_logs(2).status_code, 200)   # endpoint works again
        self.assertEqual(api.get_fight_logs(3).status_code, 200)   # 401, re-login 2, replay ok
        self.assertEqual(len(session.logins()), 3)

    def test_successful_connect_resets_the_circuit_breaker(self):
        api, session = make_api([login_ok("t1"), Reply(401), login_ok("t3"), login_ok("t4")],
                                [Reply(401), Reply(401), Reply(200, {})])
        api.connect("me", "pw")
        self.assertEqual(api.get_fight_logs(1).status_code, 401)   # re-login refused: breaker
        self.assertTrue(api.connect("me", "pw"))
        self.assertEqual(api.get_fight_logs(2).status_code, 200)   # 401, re-login, replay ok
        self.assertEqual(len(session.logins()), 4)

    def test_successful_api_key_connect_resets_the_circuit_breaker(self):
        farmer = Reply(200, {"farmer": {"id": 1}})
        api, session = make_api([], [farmer, Reply(401), Reply(401), farmer, Reply(401),
                                     farmer, Reply(200, {})])
        api.connect_with_api_key("key")
        api.get_fight_logs(1)  # re-validation returns 401: breaker
        self.assertTrue(api.connect_with_api_key("key"))
        self.assertEqual(api.get_fight_logs(2).status_code, 200)

    def test_network_error_during_reauthentication_returns_the_original_response(self):
        api, session = make_api([login_ok("t1"), requests.ConnectionError("down")], [Reply(401)])
        api.connect("me", "pw")
        self.assertEqual(api.get_fight_logs(5).status_code, 401)
        self.assertEqual(session.headers["Authorization"], "Bearer t1")

    def test_malformed_relogin_payload_returns_the_original_response_and_keeps_the_session(self):
        for payload in ([], None, "oops"):
            class Malformed(Reply):
                def json(self):
                    return payload
            clock = FakeClock()
            api, session = make_api([login_ok("t1"), Malformed(200), login_ok("t3")],
                                    [Reply(401), Reply(401), Reply(401), Reply(200, {})], clock)
            api.connect("me", "pw")
            self.assertEqual(api.get_fight_logs(5).status_code, 401)  # no exception
            self.assertEqual(session.headers["Authorization"], "Bearer t1")
            # classed as transient: paused for the cooldown, then retried
            api.get_fight_logs(6)
            self.assertEqual(len(session.logins()), 2)
            clock.now += LWApi.REAUTH_COOLDOWN_SECONDS
            self.assertEqual(api.get_fight_logs(7).status_code, 200)
            self.assertEqual(len(session.logins()), 3)

    def test_connect_treats_a_non_object_payload_as_a_failed_connection(self):
        for payload in ([], None, "oops", {"token": 5}, {"token": ""}):
            class Malformed(Reply):
                def json(self):
                    return payload
            api, session = make_api([Malformed(200)], [Malformed(200)])
            self.assertFalse(api.connect("me", "pw"))
            self.assertNotIn("Authorization", session.headers)
            self.assertFalse(api.connect_with_api_key("key"))
            self.assertNotIn("Authorization", session.headers)

    TRANSIENT_FAILURES = (requests.ConnectionError("blip"), Reply(503), Reply(429))

    def test_transient_relogin_failure_does_not_block_a_later_real_expiration(self):
        for failure in self.TRANSIENT_FAILURES:
            clock = FakeClock()
            api, session = make_api([login_ok("t1"), failure, login_ok("t3")],
                                    [Reply(401), Reply(401), Reply(200, {})], clock)
            api.connect("me", "pw")
            self.assertEqual(api.get_fight_logs(1).status_code, 401)  # re-login failed
            clock.now += LWApi.REAUTH_COOLDOWN_SECONDS
            self.assertEqual(api.get_fight_logs(2).status_code, 200)  # later expiry: recovers
            self.assertEqual(len(session.logins()), 3)

    def test_transient_relogin_failures_are_paused_during_the_cooldown(self):
        fights = 100
        for failure in self.TRANSIENT_FAILURES:
            clock = FakeClock()
            api, session = make_api([login_ok("t1"), failure, failure],
                                    [Reply(401)] * (fights + 2), clock)
            api.connect("me", "pw")
            for fight_id in range(fights):
                self.assertEqual(api.get_fight_logs(fight_id).status_code, 401)
            self.assertEqual(len(session.logins()), 2)  # login + a single re-login attempt
            clock.now += LWApi.REAUTH_COOLDOWN_SECONDS - 1
            api.get_fight_logs(0)
            self.assertEqual(len(session.logins()), 2)
            clock.now += 1  # cooldown elapsed: one new attempt, still bounded
            api.get_fight_logs(0)
            self.assertEqual(len(session.logins()), 3)

    def test_explicit_login_refusals_stop_re_logins_whatever_the_elapsed_time(self):
        for refusal in (Reply(401), Reply(403), Reply(200, {})):  # last: 200 without token
            clock = FakeClock()
            api, session = make_api([login_ok("t1"), refusal], [Reply(401)] * 3, clock)
            api.connect("me", "pw")
            api.get_fight_logs(1)
            clock.now += 10 * LWApi.REAUTH_COOLDOWN_SECONDS
            api.get_fight_logs(2)
            self.assertEqual(len(session.logins()), 2)

    def test_api_key_rejection_stops_re_logins_but_a_5xx_only_pauses_them(self):
        farmer = Reply(200, {"farmer": {"id": 1}})

        def self_calls(session):
            return len([call for call in session.calls if call[1].endswith(Uri.get_self)])

        clock = FakeClock()
        api, session = make_api([], [farmer, Reply(401), Reply(401), Reply(401)], clock)
        api.connect_with_api_key("key")
        api.get_fight_logs(1)  # key rejected on re-validation
        clock.now += 10 * LWApi.REAUTH_COOLDOWN_SECONDS
        self.assertEqual(api.get_fight_logs(2).status_code, 401)
        self.assertEqual(self_calls(session), 2)

        clock = FakeClock()
        api, session = make_api([], [farmer, Reply(401)] + [Reply(503)] * 3
                                + [Reply(401), farmer, Reply(200, {})], clock)
        api.connect_with_api_key("key")
        api.get_fight_logs(1)  # re-validation: 503 (GET retried by the transient policy)
        clock.now += LWApi.REAUTH_COOLDOWN_SECONDS
        self.assertEqual(api.get_fight_logs(2).status_code, 200)

    def test_a_replay_that_is_still_401_is_not_replayed_again(self):
        api, session = make_api([login_ok("t1"), login_ok("t2")], [Reply(401), Reply(401)])
        api.connect("me", "pw")
        self.assertEqual(api.get_fight_logs(5).status_code, 401)
        self.assertEqual(len(session.api_calls()), 2)
        self.assertEqual(len(session.logins()), 2)

    def test_login_calls_are_never_replayed(self):
        api, session = make_api([Reply(401)], [])
        self.assertFalse(api.connect("me", "bad"))
        self.assertEqual(len(session.logins()), 1)
        self.assertEqual(session.api_calls(), [])

        api, session = make_api([], [Reply(401)])
        self.assertFalse(api.connect_with_api_key("bad-key"))
        self.assertEqual(len(session.calls), 1)
        self.assertNotIn("Authorization", session.headers)

    def test_no_replay_without_authorization_or_credentials(self):
        api, session = make_api([], [Reply(401)])
        self.assertEqual(api.get_fight(5).status_code, 401)
        self.assertEqual(len(session.calls), 1)

    def test_api_key_session_authenticates_again_with_the_same_key(self):
        farmer = Reply(200, {"farmer": {"id": 1}})
        api, session = make_api([], [farmer, Reply(401), farmer, Reply(200, {})])
        self.assertTrue(api.connect_with_api_key(" key "))
        self.assertEqual(api.get_fight_logs(5).status_code, 200)
        self.assertEqual([call[2] for call in session.calls], ["Bearer key"] * 4)

    def test_credentials_follow_the_last_successful_connection(self):
        api, session = make_api([login_ok("main"), login_ok("second"), login_ok("second2")],
                                [Reply(401), Reply(200)])
        api.connect("main", "pw1")
        api.connect("second", "pw2")
        api.get_fight_logs(5)
        self.assertEqual(session.logins()[-1][3]["json"], {"login": "second", "password": "pw2"})

    def test_rate_limit_retry_is_kept(self):
        limited = Reply(429, {"error": "rate_limit", "retry_after": 2})
        api, session = make_api([], [limited, Reply(200, {})])
        self.assertEqual(api.get_fight(5).status_code, 200)
        self.assertEqual(len(session.calls), 2)

    def test_get_is_retried_on_network_error_and_5xx_with_a_bound(self):
        api, session = make_api([], [requests.ConnectionError("x"), Reply(502), Reply(200, {})])
        self.assertEqual(api.get_fight(5).status_code, 200)
        self.assertEqual(len(session.calls), 3)

        api, session = make_api([], [Reply(503)] * 5)
        self.assertEqual(api.get_fight(5).status_code, 503)
        self.assertEqual(len(session.calls), 1 + LWApi.TRANSIENT_RETRIES)

        api, session = make_api([], [requests.Timeout("x")] * 5)
        with self.assertRaises(requests.Timeout):
            api.get_fight(5)
        self.assertEqual(len(session.calls), 1 + LWApi.TRANSIENT_RETRIES)

    def test_writes_are_not_retried_on_network_error_or_5xx(self):
        api, session = make_api([], [requests.ConnectionError("x")])
        with self.assertRaises(requests.ConnectionError):
            api.write_ai("a.ts", "code")
        api, session = make_api([], [Reply(500), Reply(200)])
        self.assertEqual(api.write_ai("a.ts", "code").status_code, 500)
        self.assertEqual(len(session.calls), 1)


class ArchiveLogsAfter401Tests(unittest.TestCase):
    def test_logs_rejected_with_401_are_flagged_then_retried_on_the_next_archive(self):
        class Api(ArchiveFakeApi):
            def get_fight_logs(self, fight_id):
                if not self.logs_ok:
                    return Reply(401)
                return super().get_fight_logs(fight_id)

        with tempfile.TemporaryDirectory() as data:
            api = Api({10: make_fight(10, 500)}, logs_ok=False)
            stats = FightArchive.archive_fights(api, data, 7, "me")
            self.assertEqual(stats["logs_missing"], 1)
            self.assertEqual(FightArchive.list_archived_fights(data)[0]["logs_status"], "http_401")
            api.logs_ok = True
            self.assertEqual(FightArchive.archive_fights(api, data, 7, "me")["archived"], 1)
            self.assertEqual(FightArchive.list_archived_fights(data)[0]["logs_status"], "ok")

    def run_archive(self, data, statuses, count):
        """Archive `count` fights whose logs answer the scripted HTTP statuses in call order."""
        class Api(ArchiveFakeApi):
            def __init__(self, fights):
                super().__init__(fights)
                self.log_calls = []

            def get_fight_logs(self, fight_id):
                self.log_calls.append(fight_id)
                status = statuses[len(self.log_calls) - 1] if len(self.log_calls) <= len(statuses) else 200
                if status == 200:
                    return super().get_fight_logs(fight_id)
                return Reply(status)

        api = Api({i: make_fight(i, 500 + i) for i in range(1, count + 1)})
        return api, FightArchive.archive_fights(api, data, 7, "me")

    def test_archive_stops_after_consecutive_401_and_retries_the_rest_next_time(self):
        with tempfile.TemporaryDirectory() as data:
            api, stats = self.run_archive(data, [401] * 100, 10)
            self.assertTrue(stats["interrupted"])
            self.assertEqual(len(api.log_calls), FightArchive.MAX_CONSECUTIVE_LOGS_401)
            self.assertEqual((stats["archived"], stats["logs_missing"]),
                             (FightArchive.MAX_CONSECUTIVE_LOGS_401,) * 2)
            self.assertEqual(len(FightArchive.list_archived_fights(data)), 3)

            api, stats = self.run_archive(data, [], 10)  # session fixed: everything is retried
            self.assertFalse(stats["interrupted"])
            self.assertEqual(stats["archived"], 10)
            self.assertTrue(all(meta["logs_status"] == "ok"
                                for meta in FightArchive.list_archived_fights(data)))

    def test_isolated_or_non_consecutive_401_do_not_interrupt_the_archive(self):
        with tempfile.TemporaryDirectory() as data:
            api, stats = self.run_archive(data, [401, 401, 200, 401, 401, 403, 401, 401], 10)
            self.assertFalse(stats["interrupted"])
            self.assertEqual(len(api.log_calls), 10)
            self.assertEqual(stats["logs_missing"], 7)


class RecentFightLogsTests(unittest.TestCase):
    NOW = 10000
    YOUNG, OLD = NOW - 100, 100

    class Api(ArchiveFakeApi):
        def __init__(self, fights, reply):
            super().__init__(fights)
            self.reply = reply
            self.log_calls = 0

        def get_fight_logs(self, fight_id):
            self.log_calls += 1
            return self.reply(fight_id)

        def auth_diagnostics(self):
            return {"mode": "api_key", "reauthentication": "blocked"}

    def archive(self, data, dates, reply):
        api = self.Api({i: make_fight(i, date) for i, date in dates.items()}, reply)
        return api, FightArchive.archive_fights(api, data, 7, "me", now=self.NOW)

    def test_recent_fights_without_logs_are_flagged_not_ready_and_never_interrupt(self):
        with tempfile.TemporaryDirectory() as data:
            dates = {i: self.YOUNG for i in range(1, 11)}
            for status in (401, 403, 404):
                api, stats = self.archive(os.path.join(data, str(status)), dates,
                                          lambda _id, s=status: Reply(s))
                self.assertFalse(stats["interrupted"])
                self.assertEqual(api.log_calls, 10)
                self.assertEqual((stats["logs_not_ready"], stats["logs_missing"]), (10, 10))
            meta = FightArchive.list_archived_fights(os.path.join(data, "401"))[0]
            self.assertEqual(meta["logs_status"], "http_401")  # compatibility kept
            self.assertTrue(meta["logs_not_ready"])
            self.assertEqual(meta["logs_age_seconds"], 100)

    def test_not_ready_fights_are_retried_and_complete_once_logs_exist(self):
        with tempfile.TemporaryDirectory() as data:
            self.archive(data, {1: self.YOUNG}, lambda _id: Reply(401))
            api, stats = self.archive(data, {1: self.YOUNG}, lambda _id: Reply(200, {"logs": {"1": ["x"]}}))
            self.assertEqual(stats["archived"], 1)
            meta = FightArchive.list_archived_fights(data)[0]
            self.assertEqual(meta["logs_status"], "ok")
            self.assertNotIn("logs_error", meta)
            self.assertNotIn("logs_not_ready", meta)

    def test_old_fights_and_other_statuses_keep_their_previous_meaning(self):
        age = FightArchive.LOGS_NOT_READY_SECONDS
        with tempfile.TemporaryDirectory() as data:
            _, stats = self.archive(data, {1: self.NOW - age}, lambda _id: Reply(401))
            self.assertEqual(stats["logs_not_ready"], 0)  # exactly at the threshold: not recent
            _, stats = self.archive(os.path.join(data, "x"), {1: self.YOUNG}, lambda _id: Reply(500))
            self.assertEqual((stats["logs_not_ready"], stats["logs_missing"]), (0, 1))
            self.assertFalse(stats["log_failures"][0]["not_ready"])

    def test_recent_fights_do_not_count_towards_the_session_interruption(self):
        # ids are processed from the newest: young, old, old, young, old, old
        dates = {6: self.YOUNG, 5: self.OLD, 4: self.OLD, 3: self.YOUNG, 2: self.OLD, 1: self.OLD}
        with tempfile.TemporaryDirectory() as data:
            api, stats = self.archive(data, dates, lambda _id: Reply(401))
            self.assertTrue(stats["interrupted"])
            self.assertEqual(api.log_calls, 5)  # stopped at the 3rd old 401, fight 1 untouched
            self.assertEqual(stats["logs_not_ready"], 2)

    def test_error_excerpt_is_truncated_and_headers_are_never_stored(self):
        class Secretive(Reply):
            headers = {"Authorization": "Bearer super-secret-token"}

        long_error = {"error": "x" * 500}
        with tempfile.TemporaryDirectory() as data:
            self.archive(data, {1: self.OLD}, lambda _id: Secretive(401, long_error))
            meta = FightArchive.list_archived_fights(data)[0]
            self.assertLessEqual(len(meta["logs_error"]), FightArchive.MAX_ERROR_EXCERPT)
            self.assertIn("xxxx", meta["logs_error"])
            for root, _, files in os.walk(data):
                for name in files:
                    with open(os.path.join(root, name), encoding="utf-8") as handle:
                        self.assertNotIn("super-secret-token", handle.read())

    def test_failures_carry_age_error_and_authentication_diagnostics(self):
        with tempfile.TemporaryDirectory() as data:
            _, stats = self.archive(data, {1: self.OLD}, lambda _id: Reply(401, {"error": "nope"}))
        failure = stats["log_failures"][0]
        self.assertEqual((failure["fight_id"], failure["status"], failure["age_seconds"]),
                         (1, 401, self.NOW - self.OLD))
        self.assertEqual((failure["mode"], failure["reauthentication"]), ("api_key", "blocked"))
        line = Garden.describe_log_failure(failure)
        for expected in ("fight 1", "HTTP 401", "9900 s", "auth api_key",
                         "re-authentication blocked", "nope"):
            self.assertIn(expected, line)
        self.assertNotIn("not available yet", line)
        self.assertIn("not available yet",
                      Garden.describe_log_failure(dict(failure, not_ready=True)))

    def test_garden_tells_to_run_the_archive_again_for_recent_fights(self):
        stats = {"listed": 3, "archived": 3, "skipped": 0, "pending": 0, "expired": 0,
                 "logs_missing": 3, "logs_not_ready": 2, "errors": 0, "interrupted": False,
                 "log_failures": [], "pruned": {"publications": 0, "fights": 0}}
        with patch.object(FightArchive, "archive_fights", return_value=stats), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            Garden.archive_recent_fights(None, {"data_folder": "data"}, {"id": 7, "login": "me"})
        text = output.getvalue()
        self.assertIn("2 recent fight(s)", text)
        self.assertIn("run the archive again in a few minutes", text)
        self.assertIn("1 fight(s) archived without debug logs", text)


class AuthDiagnosticsTests(unittest.TestCase):
    def test_secrets_are_masked_before_truncation(self):
        jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc_DEF-123"
        samples = [
            "Authorization: Bearer abc.def.ghi rejected",
            "bad token " + jwt,
            '{"password": "hunter2", "error": "no"}',
            "api_key=k-12345&x=1",
            "x" * 190 + " Bearer " + "s3cr3t" * 20,  # a token straddling the cut
        ]
        for text in samples:
            masked = FightArchive.redact_secrets(text)
            for leaked in ("abc.def.ghi", jwt, "hunter2", "k-12345", "s3cr3t"):
                self.assertNotIn(leaked, masked)
            self.assertNotIn("s3cr3t", FightArchive._error_excerpt(Reply(401, text)))
        self.assertEqual(FightArchive.redact_secrets("invalid token, session expired"),
                         "invalid token, session expired")

    def test_relogin_refused_is_persistent_until_a_new_connection(self):
        api, _ = make_api([login_ok("t1"), Reply(401), login_ok("t3")], [Reply(401), Reply(401)])
        self.assertFalse(api.relogin_refused())
        api.connect("me", "pw")
        api.get_fight_logs(1)
        self.assertTrue(api.relogin_refused())
        api.get_fight_logs(2)  # blocked, but still told apart from a rejected endpoint
        self.assertTrue(api.relogin_refused())
        api.connect("me", "pw")
        self.assertFalse(api.relogin_refused())

    def test_future_dates_are_tolerated_only_within_the_clock_skew(self):
        skew = FightArchive.LOGS_CLOCK_SKEW_SECONDS
        for offset, expected_not_ready in ((skew, True), (skew + 1, False)):
            with tempfile.TemporaryDirectory() as data:
                api = RecentFightLogsTests.Api({1: make_fight(1, 10000 + offset)},
                                               lambda _id: Reply(401))
                stats = FightArchive.archive_fights(api, data, 7, "me", now=10000)
            failure = stats["log_failures"][0]
            self.assertEqual(failure["not_ready"], expected_not_ready)
            self.assertEqual(failure["future_date"], not expected_not_ready)
            self.assertEqual("clock skew" in Garden.describe_log_failure(failure),
                             not expected_not_ready)

    def setUp(self):
        for target in ("LWApi.time.sleep", "builtins.print"):
            patcher = patch(target)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_mode_is_reported_without_any_credential(self):
        api, _ = make_api([login_ok("secret-token")], [])
        self.assertEqual(api.auth_diagnostics()["mode"], "none")
        api.connect("me", "secret-pw")
        self.assertEqual(api.auth_diagnostics(), {"mode": "login", "reauthentication": "not_attempted"})
        api, _ = make_api([], [Reply(200, {"farmer": {}})])
        api.connect_with_api_key("secret-key")
        self.assertEqual(api.auth_diagnostics()["mode"], "api_key")
        self.assertNotIn("secret", str(api.auth_diagnostics()))

    def test_reauthentication_outcomes_of_the_last_request(self):
        clock = FakeClock()
        api, _ = make_api([login_ok("t1"), login_ok("t2")], [Reply(401), Reply(200), Reply(200)], clock)
        api.connect("me", "pw")
        api.get_fight_logs(1)
        self.assertEqual(api.auth_diagnostics()["reauthentication"], "succeeded")
        api.get_fight_logs(2)
        self.assertEqual(api.auth_diagnostics()["reauthentication"], "not_attempted")

        api, _ = make_api([login_ok("t1"), Reply(401)], [Reply(401), Reply(401)], clock)
        api.connect("me", "pw")
        api.get_fight_logs(1)
        self.assertEqual(api.auth_diagnostics()["reauthentication"], "refused")
        api.get_fight_logs(2)
        self.assertEqual(api.auth_diagnostics()["reauthentication"], "blocked")

        api, _ = make_api([login_ok("t1"), requests.ConnectionError("x")], [Reply(401), Reply(401)], clock)
        api.connect("me", "pw")
        api.get_fight_logs(1)
        self.assertEqual(api.auth_diagnostics()["reauthentication"], "transient")
        api.get_fight_logs(2)
        self.assertEqual(api.auth_diagnostics()["reauthentication"], "blocked")  # cooldown

    def test_an_endpoint_rejected_after_a_good_relogin_is_reported_blocked(self):
        api, _ = make_api([login_ok("t1"), login_ok("t2")], [Reply(401), Reply(401), Reply(401)])
        api.connect("me", "pw")
        api.get_fight_logs(1)
        self.assertEqual(api.auth_diagnostics()["reauthentication"], "succeeded")  # replay still 401
        api.get_fight_logs(2)
        self.assertEqual(api.auth_diagnostics()["reauthentication"], "blocked")


class GardenSessionTests(unittest.TestCase):
    PRINCIPAL = {"username": "main", "password": "pw"}

    class Api:
        def __init__(self, primary_ok=True):
            self.connections = []
            self.primary_ok = primary_ok

        def connect(self, login, password):
            self.connections.append(login)
            return login != "main" or self.primary_ok

    def test_primary_is_reconnected_after_a_failed_secondary_push(self):
        api = self.Api()
        with patch.object(Garden, "push_all_ais", side_effect=RuntimeError("boom")), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            Garden.push_secondaries_then_reconnect(api, self.PRINCIPAL, "", [], "root")
        self.assertEqual(api.connections, ["main"])
        self.assertIn("boom", output.getvalue())

    def test_primary_is_reconnected_after_an_unexpected_error(self):
        api = self.Api()
        with patch.object(Garden, "push_all_ais", side_effect=KeyError("x")):
            with self.assertRaises(KeyError):
                Garden.push_secondaries_then_reconnect(api, self.PRINCIPAL, "", [], "root")
        self.assertEqual(api.connections, ["main"])

    def test_reconnection_failure_is_reported(self):
        api = self.Api(primary_ok=False)
        with patch.object(Garden, "push_all_ais"):
            with self.assertRaisesRegex(RuntimeError, "reconnect"):
                Garden.push_secondaries_then_reconnect(api, self.PRINCIPAL, "", [], "root")

    def test_reconnection_failure_keeps_the_original_cause_visible(self):
        for original in (RuntimeError("secondary refused"), KeyError("x")):
            api = self.Api(primary_ok=False)
            with patch.object(Garden, "push_all_ais", side_effect=original), \
                    contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(RuntimeError) as raised:
                    Garden.push_secondaries_then_reconnect(api, self.PRINCIPAL, "", [], "root")
            self.assertIs(raised.exception.__cause__, original)
            self.assertIn(type(original).__name__, str(raised.exception))

    def test_archive_warns_when_interrupted_by_repeated_401(self):
        stats = {"listed": 9, "archived": 3, "skipped": 0, "pending": 0, "expired": 0,
                 "logs_missing": 3, "errors": 0, "interrupted": True,
                 "pruned": {"publications": 0, "fights": 0}}
        with patch.object(FightArchive, "archive_fights", return_value=stats), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            Garden.archive_recent_fights(None, {"data_folder": "data"}, {"id": 7, "login": "me"})
        self.assertIn("archive interrupted after repeated HTTP 401", output.getvalue())

    def test_archive_warns_when_logs_are_missing(self):
        stats = {"listed": 1, "archived": 1, "skipped": 0, "pending": 0, "expired": 0,
                 "logs_missing": 2, "errors": 0, "pruned": {"publications": 0, "fights": 0}}
        config = {"data_folder": "data"}
        farmer = {"id": 7, "login": "me"}
        for missing, expected in ((2, True), (0, False)):
            with patch.object(FightArchive, "archive_fights",
                              return_value=dict(stats, logs_missing=missing)), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                Garden.archive_recent_fights(None, config, farmer)
            self.assertEqual("retried on the next archive" in output.getvalue(), expected)


if __name__ == "__main__":
    unittest.main()
