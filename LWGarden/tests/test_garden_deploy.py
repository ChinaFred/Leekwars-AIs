import os
import tempfile
import unittest
from unittest.mock import patch

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from Garden import (
    confirm_remote_deletions,
    connect_primary,
    deploy_local_ais,
    get_all_ais,
    is_yes_confirmation,
    load_config
)


class FakeResponse:
    def __init__(self, payload=None, ok=True, content=""):
        self.payload = payload or {}
        self.ok = ok
        self.content = content

    def json(self):
        return self.payload


class FakeApi:
    def __init__(self, folders=None, ais=None, codes=None):
        self.folders = folders or []
        self.ais = ais or []
        self.codes = codes or {}
        self.created_folders = []
        self.created_ais = []
        self.writes = []
        self.deleted_ais = []
        self.deleted_folders = []

    def get_ai_tree(self):
        return {"folders": self.folders, "files": self.ais}

    def new_folder(self, path):
        self.created_folders.append(path)
        self.folders.append(path)
        return FakeResponse()

    def create_ai(self, folder, name, version=4):
        path = "/".join(part for part in (folder, name) if part)
        self.created_ais.append((folder, name, version))
        return FakeResponse({"path": path})

    def read_ai(self, path):
        return {"code": self.codes[path]}

    def write_ai(self, path, code):
        self.writes.append((path, code))
        self.codes[path] = code
        if not any(ai["path"] == path for ai in self.ais):
            self.ais.append({"path": path})
        return FakeResponse()

    def delete_ai(self, path):
        self.deleted_ais.append(path)
        self.ais = [ai for ai in self.ais if ai["path"] != path]
        return FakeResponse()

    def delete_folder(self, path):
        self.deleted_folders.append(path)
        self.folders = [folder for folder in self.folders if folder != path]
        return FakeResponse()


class DeployLocalAIsTests(unittest.TestCase):
    def test_remote_deletions_require_the_exact_confirmation_word(self):
        with patch("builtins.input") as prompt:
            self.assertFalse(confirm_remote_deletions([], []))
            prompt.assert_not_called()
        with patch("builtins.input", return_value="y"):
            self.assertFalse(confirm_remote_deletions(["Old/ai.leek"], []))
        with patch("builtins.input", return_value=" DELETE "):
            self.assertTrue(confirm_remote_deletions(["Old/ai.leek"], []))

    def test_yes_confirmation_ignores_surrounding_whitespace(self):
        self.assertTrue(is_yes_confirmation(" y "))
        self.assertTrue(is_yes_confirmation(" YES "))
        self.assertFalse(is_yes_confirmation("no"))

    def test_config_paths_are_resolved_relative_to_garden_script(self):
        with tempfile.TemporaryDirectory() as root:
            garden_directory = os.path.join(root, "LWGarden", "src")
            os.makedirs(garden_directory)
            source_directory = os.path.join(root, "src")
            os.makedirs(source_directory)
            config_path = os.path.join(garden_directory, "config.json")
            with open(config_path, "w") as configfile:
                configfile.write('{"AIs_folder": "../../src/", "accounts": []}')

            garden_script = os.path.join(garden_directory, "Garden.py")
            with patch("Garden.__file__", garden_script):
                config = load_config()

            self.assertEqual(config["AIs_folder"], os.path.abspath(source_directory))

    def test_pull_adds_leek_extension_to_local_files(self):
        with tempfile.TemporaryDirectory() as root:
            api = FakeApi(
                folders=["Main"],
                ais=[{"path": "Main/Kassbi_Class"}],
                codes={"Main/Kassbi_Class": "class Kassbi {}"}
            )

            get_all_ais(api, root)

            local_file = os.path.join(root, "Main", "Kassbi_Class.leek")
            with open(local_file, "r", encoding="utf-8") as source:
                self.assertEqual(source.read(), "class Kassbi {}")

    def test_pull_preserves_typescript_extension(self):
        with tempfile.TemporaryDirectory() as root:
            api = FakeApi(
                folders=["Classes"],
                ais=[{"path": "Classes/IaDeBaseTS.ts"}],
                codes={"Classes/IaDeBaseTS.ts": "export function turn(): void {}"}
            )

            get_all_ais(api, root)

            local_file = os.path.join(root, "Classes", "IaDeBaseTS.ts")
            with open(local_file, "r", encoding="utf-8") as source:
                self.assertEqual(source.read(), "export function turn(): void {}")

    def test_primary_uses_the_api_key_instead_of_password_credentials(self):
        class FakeApi:
            def connect_with_api_key(self, api_key):
                return api_key == "test-key"

            def connect(self, login, password):
                raise AssertionError("Password login should not be used when an API key is set")

        self.assertTrue(connect_primary(
            FakeApi(),
            {"username": "unused", "password": "unused"},
            "test-key"
        ))

    def test_creates_nested_source_files_without_deleting_remote_content(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, "Classes", "Items"))
            with open(os.path.join(root, "Classes", "Items", "Chip.leek"), "w") as source:
                source.write("class Chip {}")
            with open(os.path.join(root, "README.txt"), "w") as source:
                source.write("not an AI")

            api = FakeApi()
            deploy_local_ais(api, root)

            self.assertEqual(api.created_folders, ["Classes", "Classes/Items"])
            self.assertEqual(api.created_ais, [("Classes/Items", "Chip", 4)])
            self.assertEqual(api.writes, [("Classes/Items/Chip", "class Chip {}")])

    def test_deploys_typescript_with_extension(self):
        with tempfile.TemporaryDirectory() as root:
            with open(os.path.join(root, "main.ts"), "w", encoding="utf-8") as source:
                source.write("export function turn(): void {}")

            api = FakeApi()
            deploy_local_ais(api, root)

            self.assertEqual(api.created_ais, [("", "main.ts", 4)])
            self.assertEqual(api.writes, [("main.ts", "export function turn(): void {}")])

    def test_does_not_deploy_archived_leekscript_sources(self):
        with tempfile.TemporaryDirectory() as root:
            archive = os.path.join(root, "_oldLeekScript", "Brain")
            os.makedirs(archive)
            with open(os.path.join(root, "main.ts"), "w", encoding="utf-8") as source:
                source.write("export function turn(): void {}")
            with open(os.path.join(archive, "legacy.leek"), "w", encoding="utf-8") as source:
                source.write("void turn() {}")

            api = FakeApi()
            deploy_local_ais(api, root)

            self.assertEqual(api.created_ais, [("", "main.ts", 4)])
            self.assertEqual(api.writes, [("main.ts", "export function turn(): void {}")])

    def test_refuses_local_files_that_map_to_the_same_remote_ai(self):
        with tempfile.TemporaryDirectory() as root:
            with open(os.path.join(root, "brain.ts"), "w", encoding="utf-8") as source:
                source.write("export function turn(): void {}")
            with open(os.path.join(root, "brain.ts.leek"), "w", encoding="utf-8") as source:
                source.write("void")

            with self.assertRaisesRegex(ValueError, "same remote AI path"):
                deploy_local_ais(FakeApi(), root)

    def test_updates_matching_ai_in_existing_folder(self):
        with tempfile.TemporaryDirectory() as root:
            main_folder = os.path.join(root, "Main")
            os.makedirs(main_folder)
            with open(os.path.join(main_folder, "Kassbi_Class.leek"), "w") as source:
                source.write("new code")

            api = FakeApi(
                folders=["Main"],
                ais=[{"path": "Main/Kassbi_Class"}],
                codes={"Main/Kassbi_Class": "old code"}
            )
            deploy_local_ais(api, root)

            self.assertEqual(api.writes, [("Main/Kassbi_Class", "new code")])
            self.assertEqual(len(api.ais), 1)

    def test_confirmed_push_moves_remote_only_ais_and_folders_to_trash(self):
        with tempfile.TemporaryDirectory() as root:
            main_folder = os.path.join(root, "Main")
            os.makedirs(main_folder)
            with open(os.path.join(main_folder, "Kassbi_Class.leek"), "w") as source:
                source.write("same code")

            api = FakeApi(
                folders=["Main", "Old", "Old/Sub"],
                ais=[
                    {"path": "Main/Kassbi_Class"},
                    {"path": "Old/stale"},
                    {"path": "Old/Sub/staler"}
                ],
                codes={"Main/Kassbi_Class": "same code"}
            )

            def confirm_delete(files, folders):
                self.assertEqual(files, ["Old/Sub/staler", "Old/stale"])
                self.assertEqual(folders, ["Old/Sub", "Old"])
                return True

            deploy_local_ais(api, root, confirm_delete)

            self.assertEqual(
                api.deleted_ais,
                ["Old/Sub/staler", "Old/stale"]
            )
            self.assertEqual(api.deleted_folders, ["Old/Sub", "Old"])
            self.assertEqual(api.ais, [{"path": "Main/Kassbi_Class"}])
            self.assertEqual(api.folders, ["Main"])

    def test_declined_remote_deletions_leave_remote_only_items_untouched(self):
        with tempfile.TemporaryDirectory() as root:
            with open(os.path.join(root, "local.leek"), "w") as source:
                source.write("local")

            api = FakeApi(
                ais=[{"path": "remote-only"}],
                codes={}
            )
            deploy_local_ais(api, root, lambda files, folders: False)

            self.assertEqual(api.deleted_ais, [])
            self.assertEqual(
                {ai["path"] for ai in api.ais},
                {"remote-only", "local"}
            )

    def test_remote_deletion_api_errors_are_reported(self):
        class FailedDeleteApi(FakeApi):
            def delete_ai(self, path):
                return FakeResponse(ok=False, content="forbidden")

        with tempfile.TemporaryDirectory() as root:
            with open(os.path.join(root, "local.leek"), "w") as source:
                source.write("local")

            api = FailedDeleteApi(ais=[{"path": "remote-only"}])
            with self.assertRaisesRegex(RuntimeError, "Could not delete remote AI"):
                deploy_local_ais(api, root, lambda files, folders: True)

    def test_deploys_windows_1252_source_without_losing_accents(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "accented.leek")
            with open(path, "wb") as source:
                source.write("// Caf\xe9".encode("cp1252"))

            api = FakeApi()
            with patch("builtins.print") as print_mock:
                deploy_local_ais(api, root)

            self.assertEqual(api.writes, [("accented", "// Café")])
            messages = [call.args[0] for call in print_mock.call_args_list if call.args]
            self.assertIn(
                "Info: accented.leek uses Windows-1252; decoding for API upload.",
                messages
            )
            self.assertFalse(any(message.startswith("Warning:") for message in messages))

    def test_deploy_normalizes_crlf_without_rewriting_local_source(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "local.leek")
            source_content = b"first line\r\nsecond line\r\n"
            with open(path, "wb") as source:
                source.write(source_content)

            api = FakeApi()
            deploy_local_ais(api, root)

            self.assertEqual(api.writes, [("local", "first line\nsecond line\n")])
            with open(path, "rb") as source:
                self.assertEqual(source.read(), source_content)

    def test_refuses_to_deploy_when_source_folder_has_no_supported_files(self):
        with tempfile.TemporaryDirectory() as root:
            api = FakeApi()
            with self.assertRaisesRegex(ValueError, "No .leek or .ts files"):
                deploy_local_ais(api, root)

    def test_api_client_uses_bearer_auth_and_current_path_endpoints(self):
        class FakeSession:
            def __init__(self):
                self.headers = {}
                self.calls = []

            def post(self, url, **kwargs):
                self.calls.append(("POST", url, kwargs))
                if url.endswith("/farmer/login-token"):
                    return FakeResponse({"token": "test-token"})
                return FakeResponse({"modified": 1})

            def get(self, url, **kwargs):
                self.calls.append(("GET", url, kwargs))
                return FakeResponse({"folders": [], "files": []})

            def delete(self, url, **kwargs):
                self.calls.append(("DELETE", url, kwargs))
                return FakeResponse({"deleted": 1})

        import LWApi

        session = FakeSession()
        with patch("LWApi.requests.Session", return_value=session):
            with patch("LWApi.time.sleep"):
                api = LWApi.LWApi()
                self.assertTrue(api.connect("login", "password"))
                api.get_ai_tree()
                api.create_ai("Main", "brain.leek")
                api.write_ai("Main/brain.leek", "code")
                api.delete_ai("Main/old.leek")
                api.delete_folder("Old")

        self.assertEqual(session.headers["Authorization"], "Bearer test-token")
        self.assertEqual(session.calls[1][1].endswith("/ai/get-farmer-tree"), True)
        self.assertEqual(session.calls[2][1].endswith("/ai/create"), True)
        self.assertEqual(
            session.calls[2][2]["json"],
            {"folder": "Main", "name": "brain.leek", "version": 4}
        )
        self.assertEqual(session.calls[3][1].endswith("/ai/write"), True)
        self.assertEqual(session.calls[3][2]["json"], {"path": "Main/brain.leek", "code": "code"})
        self.assertEqual(session.calls[4][0], "DELETE")
        self.assertTrue(session.calls[4][1].endswith("/ai/delete"))
        self.assertEqual(session.calls[4][2]["json"], {"path": "Main/old.leek"})
        self.assertEqual(session.calls[5][0], "DELETE")
        self.assertTrue(session.calls[5][1].endswith("/ai-folder/delete"))
        self.assertEqual(session.calls[5][2]["json"], {"path": "Old"})

    def test_api_client_spaces_requests_below_five_per_second(self):
        class FakeClock:
            def __init__(self):
                self.now = 0.0
                self.sleeps = []

            def monotonic(self):
                return self.now

            def sleep(self, duration):
                self.sleeps.append(duration)
                self.now += duration

        class FakeSession:
            def __init__(self, clock):
                self.headers = {}
                self.clock = clock
                self.call_times = []

            def get(self, url, **kwargs):
                self.call_times.append(self.clock.now)
                return FakeResponse({"folders": [], "files": []})

        import LWApi

        clock = FakeClock()
        session = FakeSession(clock)
        with patch("LWApi.requests.Session", return_value=session):
            with patch("LWApi.time.monotonic", side_effect=clock.monotonic):
                with patch("LWApi.time.sleep", side_effect=clock.sleep):
                    api = LWApi.LWApi()
                    for _ in range(6):
                        api.get_ai_tree()

        intervals = [
            later - earlier
            for earlier, later in zip(session.call_times, session.call_times[1:])
        ]
        self.assertEqual(len(session.call_times), 6)
        self.assertTrue(all(
            interval + 1e-9 >= LWApi.LWApi.MIN_REQUEST_INTERVAL_SECONDS
            for interval in intervals
        ))
        self.assertEqual(len(clock.sleeps), 5)

    def test_api_client_retries_rate_limited_writes_after_server_delay(self):
        class FakeSession:
            def __init__(self):
                self.headers = {}
                self.calls = []
                self.responses = [
                    FakeResponse(
                        {"error": "rate_limit", "retry_after": 1},
                        ok=False,
                        content=b'{"error":"rate_limit","retry_after":1}'
                    ),
                    FakeResponse({"modified": 1})
                ]

            def post(self, url, **kwargs):
                self.calls.append((url, kwargs))
                return self.responses.pop(0)

        import LWApi

        session = FakeSession()
        with patch("LWApi.requests.Session", return_value=session):
            with patch("LWApi.time.sleep") as sleep:
                api = LWApi.LWApi()
                result = api.write_ai("Main/brain.leek", "code")

        self.assertTrue(result.ok)
        self.assertEqual(len(session.calls), 2)
        self.assertEqual(session.calls[0], session.calls[1])
        sleep.assert_called_once_with(1)

    def test_api_client_retries_rate_limited_deletes_after_server_delay(self):
        class FakeSession:
            def __init__(self):
                self.headers = {}
                self.calls = []
                self.responses = [
                    FakeResponse(
                        {"error": "rate_limit", "retry_after": 1},
                        ok=False,
                        content=b'{"error":"rate_limit","retry_after":1}'
                    ),
                    FakeResponse({"deleted": 1})
                ]

            def delete(self, url, **kwargs):
                self.calls.append((url, kwargs))
                return self.responses.pop(0)

        import LWApi

        session = FakeSession()
        with patch("LWApi.requests.Session", return_value=session):
            with patch("LWApi.time.sleep") as sleep:
                api = LWApi.LWApi()
                result = api.delete_ai("Old/stale.leek")

        self.assertTrue(result.ok)
        self.assertEqual(len(session.calls), 2)
        self.assertEqual(session.calls[0], session.calls[1])
        sleep.assert_called_once_with(1)

    def test_api_client_returns_rate_limit_error_after_retry_limit(self):
        class FakeSession:
            def __init__(self):
                self.headers = {}
                self.calls = []
                self.response = FakeResponse(
                    {"error": "rate_limit", "retry_after": 1},
                    ok=False,
                    content=b'{"error":"rate_limit","retry_after":1}'
                )

            def post(self, url, **kwargs):
                self.calls.append((url, kwargs))
                return self.response

        import LWApi

        session = FakeSession()
        with patch("LWApi.requests.Session", return_value=session):
            with patch("LWApi.time.sleep") as sleep:
                api = LWApi.LWApi()
                result = api.write_ai("Main/brain.leek", "code")

        self.assertFalse(result.ok)
        self.assertEqual(len(session.calls), LWApi.LWApi.RATE_LIMIT_RETRIES + 1)
        self.assertEqual(sleep.call_count, LWApi.LWApi.RATE_LIMIT_RETRIES)

    def test_api_key_auth_validates_the_key_without_logging_in_with_password(self):
        class FakeSession:
            def __init__(self):
                self.headers = {}
                self.calls = []

            def get(self, url, **kwargs):
                self.calls.append((url, kwargs))
                return FakeResponse({"farmer": {"login": "test"}})

        import LWApi

        session = FakeSession()
        with patch("LWApi.requests.Session", return_value=session):
            api = LWApi.LWApi()
            self.assertTrue(api.connect_with_api_key("test-api-key"))

        self.assertEqual(session.headers["Authorization"], "Bearer test-api-key")
        self.assertTrue(session.calls[0][0].endswith("/farmer/get-from-token"))

    def test_api_key_auth_clears_an_invalid_key(self):
        class FakeSession:
            def __init__(self):
                self.headers = {}

            def get(self, url, **kwargs):
                return FakeResponse({"error": "unauthorized"})

        import LWApi

        session = FakeSession()
        with patch("LWApi.requests.Session", return_value=session):
            api = LWApi.LWApi()
            self.assertFalse(api.connect_with_api_key("invalid-key"))

        self.assertNotIn("Authorization", session.headers)


if __name__ == "__main__":
    unittest.main()
