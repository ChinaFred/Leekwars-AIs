import os
import tempfile
import unittest
from unittest.mock import patch

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from Garden import connect_primary, deploy_local_ais, load_config


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


class DeployLocalAIsTests(unittest.TestCase):
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
            with patch("Garden.time.sleep"):
                deploy_local_ais(api, root)

            self.assertEqual(api.created_folders, ["Classes", "Classes/Items"])
            self.assertEqual(api.created_ais, [("Classes/Items", "Chip.leek", 4)])
            self.assertEqual(api.writes, [("Classes/Items/Chip.leek", "class Chip {}")])

    def test_updates_matching_ai_in_existing_folder(self):
        with tempfile.TemporaryDirectory() as root:
            main_folder = os.path.join(root, "Main")
            os.makedirs(main_folder)
            with open(os.path.join(main_folder, "Kassbi_Class.leek"), "w") as source:
                source.write("new code")

            api = FakeApi(
                folders=["Main"],
                ais=[{"path": "Main/Kassbi_Class.leek"}],
                codes={"Main/Kassbi_Class.leek": "old code"}
            )
            with patch("Garden.time.sleep"):
                deploy_local_ais(api, root)

            self.assertEqual(api.writes, [("Main/Kassbi_Class.leek", "new code")])
            self.assertEqual(len(api.ais), 1)

    def test_deploys_windows_1252_source_without_losing_accents(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "accented.leek")
            with open(path, "wb") as source:
                source.write("// Caf\xe9".encode("cp1252"))

            api = FakeApi()
            with patch("Garden.time.sleep"):
                deploy_local_ais(api, root)

            self.assertEqual(api.writes, [("accented.leek", "// Café")])

    def test_refuses_to_deploy_when_source_folder_has_no_leek_files(self):
        with tempfile.TemporaryDirectory() as root:
            api = FakeApi()
            with self.assertRaisesRegex(ValueError, "No .leek files"):
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

        import LWApi

        session = FakeSession()
        with patch("LWApi.requests.Session", return_value=session):
            api = LWApi.LWApi()
            self.assertTrue(api.connect("login", "password"))
            api.get_ai_tree()
            api.create_ai("Main", "brain.leek")
            api.write_ai("Main/brain.leek", "code")

        self.assertEqual(session.headers["Authorization"], "Bearer test-token")
        self.assertEqual(session.calls[1][1].endswith("/ai/get-farmer-tree"), True)
        self.assertEqual(session.calls[2][1].endswith("/ai/create"), True)
        self.assertEqual(
            session.calls[2][2]["json"],
            {"folder": "Main", "name": "brain.leek", "version": 4}
        )
        self.assertEqual(session.calls[3][1].endswith("/ai/write"), True)
        self.assertEqual(session.calls[3][2]["json"], {"path": "Main/brain.leek", "code": "code"})

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
