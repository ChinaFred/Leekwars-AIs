import time

import requests
import Uri


class LWApi:
    """Client for the Leek Wars API."""

    RATE_LIMIT_RETRIES = 3
    MIN_REQUEST_INTERVAL_SECONDS = 0.21

    def __init__(self):
        self.__root_url = Uri.root
        self.__token = ""
        self.__session = requests.Session()
        self.__last_request_at = None

    def connect(self, login, password):
        """Authenticate and store the API bearer token."""
        self.__clear_authentication()
        response = self.__request_with_rate_limit_retry(
            self.__session.post,
            self.__root_url + Uri.login,
            json={"login": login, "password": password}
        )
        if not response.ok:
            return False
        self.__token = response.json().get("token", "")
        if not self.__token:
            return False
        self.__set_authentication(self.__token)
        return True

    def connect_with_api_key(self, api_key):
        """Authenticate with an existing Leek Wars API key."""
        api_key = api_key.strip()
        if not api_key:
            return False
        self.__clear_authentication()
        self.__set_authentication(api_key)
        response = self.__request_with_rate_limit_retry(
            self.__session.get, self.__root_url + Uri.get_self
        )
        farmer_response = response.json() if response.ok else {}
        if not isinstance(farmer_response, dict) or "farmer" not in farmer_response:
            self.__clear_authentication()
            return False
        return True

    def __set_authentication(self, token):
        self.__token = token
        self.__session.headers["Authorization"] = "Bearer " + token

    def __clear_authentication(self):
        self.__token = ""
        self.__session.headers.pop("Authorization", None)

    def get_farmer_self(self):
        """Get the connected farmer."""
        return self.__request_with_rate_limit_retry(
            self.__session.get, self.__root_url + Uri.get_self
        ).json()

    def get_ai_tree(self):
        """Get the path-based AI filesystem for the connected farmer."""
        return self.__request_with_rate_limit_retry(
            self.__session.get, self.__root_url + Uri.get_ai_tree
        ).json()

    def __wait_for_request_slot(self):
        now = time.monotonic()
        if self.__last_request_at is not None:
            wait = self.MIN_REQUEST_INTERVAL_SECONDS - (now - self.__last_request_at)
            if wait > 0:
                time.sleep(wait)
        self.__last_request_at = time.monotonic()

    def __request_with_rate_limit_retry(self, request, url, **kwargs):
        retries = 0
        while True:
            self.__wait_for_request_slot()
            response = request(url, **kwargs)
            if response.ok or retries >= self.RATE_LIMIT_RETRIES:
                return response
            try:
                payload = response.json()
            except ValueError:
                return response
            if not isinstance(payload, dict) or payload.get("error") != "rate_limit":
                return response
            retry_after = payload.get("retry_after")
            if (not isinstance(retry_after, int) or isinstance(retry_after, bool)
                    or retry_after <= 0):
                return response
            print("API rate limit reached; retrying in {0} second(s).".format(retry_after))
            time.sleep(retry_after)
            self.__last_request_at = None
            retries += 1

    def create_ai(self, folder, name, version=4):
        """Create an AI file and return its server path."""
        return self.__request_with_rate_limit_retry(
            self.__session.post,
            self.__root_url + Uri.create_ai,
            json={"folder": folder, "name": name, "version": version}
        )

    def read_ai(self, path):
        """Read an AI file by its server-relative path."""
        return self.__request_with_rate_limit_retry(
            self.__session.post,
            self.__root_url + Uri.read_ai,
            json={"path": path}
        ).json()

    def write_ai(self, path, code):
        """Create or update an AI file by its server-relative path."""
        return self.__request_with_rate_limit_retry(
            self.__session.post,
            self.__root_url + Uri.write_ai,
            json={"path": path, "code": code}
        )

    def new_folder(self, path):
        """Create a folder by its server-relative path."""
        return self.__request_with_rate_limit_retry(
            self.__session.post,
            self.__root_url + Uri.new_folder_ai,
            json={"path": path}
        )

    def delete_ai(self, path):
        """Move an AI file to the server trash by path."""
        return self.__request_with_rate_limit_retry(
            self.__session.delete,
            self.__root_url + Uri.delete_ai,
            json={"path": path}
        )

    def delete_folder(self, path):
        """Move a folder to the server trash by path."""
        return self.__request_with_rate_limit_retry(
            self.__session.delete,
            self.__root_url + Uri.delete_folder,
            json={"path": path}
        )

    def get_scheme(self):
        return self.__request_with_rate_limit_retry(
            self.__session.get,
            self.__root_url + Uri.get_scheme,
            data={"token": self.__token}
        ).json()

    def get_services(self):
        return self.__request_with_rate_limit_retry(
            self.__session.get,
            self.__root_url + Uri.get_services,
            data={"token": self.__token}
        ).json()

    def get_functions(self):
        return self.__request_with_rate_limit_retry(
            self.__session.get,
            self.__root_url + Uri.get_functions,
            data={"token": self.__token}
        ).json()

    def get_fullmoon(self):
        return self.__request_with_rate_limit_retry(
            self.__session.get,
            self.__root_url + Uri.get_fullmoon,
            data={"token": self.__token}
        ).json()

    def get_farmer_history(self, farmer_id):
        """Return the raw response listing a farmer's recent fights."""
        return self.__request_with_rate_limit_retry(
            self.__session.get,
            self.__root_url + Uri.get_farmer_history + str(int(farmer_id))
        )

    def get_fight(self, fight_id):
        """Return the raw response holding a whole fight (report and actions)."""
        return self.__request_with_rate_limit_retry(
            self.__session.get,
            self.__root_url + Uri.get_fight + str(int(fight_id))
        )

    def get_fight_logs(self, fight_id):
        """Return the raw response holding the debug logs of the farmer's leeks."""
        return self.__request_with_rate_limit_retry(
            self.__session.get,
            self.__root_url + Uri.get_fight_logs + str(int(fight_id))
        )

    def get_doc_functions(self, langue):
        uri = Uri.get_doc_functions.replace("locale", langue)
        return self.__request_with_rate_limit_retry(
            self.__session.get,
            self.__root_url + uri,
            data={"token": self.__token}
        ).json()

    def get_registers(self, leek_id):
        return self.__request_with_rate_limit_retry(
            self.__session.get,
            self.__root_url + Uri.get_registers,
            data={"token": self.__token, "leek_id": leek_id}
        ).json()

    def delete_register(self, leek_id, register_key):
        return self.__request_with_rate_limit_retry(
            self.__session.post,
            self.__root_url + Uri.delete_register,
            data={"token": self.__token, "leek_id": leek_id, "key": register_key}
        ).json()

    def set_register(self, leek_id, register_key, register_value):
        uri = (
            Uri.set_register
            .replace("leek_id", leek_id)
            .replace("key", register_key)
            .replace("value", register_value)
        )
        return self.__request_with_rate_limit_retry(
            self.__session.post,
            self.__root_url + uri,
            data={"token": self.__token}
        ).json()

    def get_farmer_trophies(self, farmer_id):
        uri = (
            Uri.get_farmer_trophies
            .replace("farmer_id", str(farmer_id))
            .replace("lang", "fr")
        )
        return self.__request_with_rate_limit_retry(
            self.__session.get,
            self.__root_url + uri,
            data={"token": self.__token, "farmer_id": farmer_id, "lang": "fr"}
        ).json()
