import time
from urllib.parse import urlsplit

import requests
import Uri


class LWApi:
    """Client for the Leek Wars API."""

    RATE_LIMIT_RETRIES = 3
    TRANSIENT_RETRIES = 2
    TRANSIENT_BACKOFF_SECONDS = 0.5
    REAUTH_COOLDOWN_SECONDS = 30
    MIN_REQUEST_INTERVAL_SECONDS = 0.21

    def __init__(self, clock=time.monotonic):
        self.__root_url = Uri.root
        self.__token = ""
        self.__session = requests.Session()
        self.__last_request_at = None
        self.__clock = clock
        # How to log in again after a 401: set by the last successful connection.
        self.__reconnect = None
        # Limits on re-logins, all reset by a successful connection:
        # - a login explicitly refused stops all re-logins;
        # - a temporary login failure (network error, 5xx, 429) pauses them for a cooldown;
        # - endpoints still answering 401 after a successful re-login (e.g. get-logs)
        #   stop triggering new ones until they succeed.
        self.__reauth_failed = False
        self.__reauth_retry_at = None
        self.__rejected_endpoints = set()
        self.__login_transient = False

    def connect(self, login, password):
        """Authenticate and store the API bearer token."""
        self.__clear_authentication()
        self.__login_transient = False
        response = self.__request_with_rate_limit_retry(
            self.__session.post,
            self.__root_url + Uri.login,
            reauthenticate=False,
            json={"login": login, "password": password}
        )
        if not response.ok:
            self.__login_transient = self.__is_transient(response)
            return False
        payload = response.json()
        if not isinstance(payload, dict):
            self.__login_transient = True  # malformed answer: says nothing about the credentials
            return False
        token = payload.get("token")
        if not isinstance(token, str) or not token:
            return False
        self.__token = token
        self.__set_authentication(token)
        self.__connection_succeeded(lambda: self.connect(login, password))
        return True

    def connect_with_api_key(self, api_key):
        """Authenticate with an existing Leek Wars API key."""
        api_key = api_key.strip()
        if not api_key:
            return False
        self.__clear_authentication()
        self.__login_transient = False
        self.__set_authentication(api_key)
        response = self.__request_with_rate_limit_retry(
            self.__session.get, self.__root_url + Uri.get_self, reauthenticate=False
        )
        farmer_response = response.json() if response.ok else {}
        if not isinstance(farmer_response, dict) or "farmer" not in farmer_response:
            self.__login_transient = (self.__is_transient(response) if not response.ok
                                      else not isinstance(farmer_response, dict))
            self.__clear_authentication()
            return False
        self.__connection_succeeded(lambda: self.connect_with_api_key(api_key))
        return True

    def __connection_succeeded(self, reconnect):
        self.__reconnect = reconnect
        self.__reauth_failed = False
        self.__reauth_retry_at = None
        self.__rejected_endpoints.clear()

    def __set_authentication(self, token):
        self.__token = token
        self.__session.headers["Authorization"] = "Bearer " + token

    def __clear_authentication(self):
        self.__token = ""
        self.__reconnect = None
        self.__session.headers.pop("Authorization", None)

    def __reauthenticate(self):
        """Log in again with the last successful credentials.

        On failure the previous (rejected) state is restored. A refused login stops
        re-logins until a connection succeeds; a temporary failure only pauses them.
        """
        previous_token, previous_reconnect = self.__token, self.__reconnect
        try:
            renewed = self.__reconnect()
        except (requests.RequestException, ValueError, AttributeError, TypeError):
            renewed = False
            self.__login_transient = True
        if not renewed:
            self.__clear_authentication()
            self.__set_authentication(previous_token)
            self.__reconnect = previous_reconnect
            if self.__login_transient:
                self.__reauth_retry_at = self.__clock() + self.REAUTH_COOLDOWN_SECONDS
                print("API re-authentication failed (temporary error); "
                      "retrying later, not before {0} s.".format(self.REAUTH_COOLDOWN_SECONDS))
            else:
                self.__reauth_failed = True
                print("API re-authentication failed; not retrying.")
        return renewed

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

    def __request_with_rate_limit_retry(self, request, url, reauthenticate=True, **kwargs):
        """Send a request; on a 401 of an authenticated call, log in again once and replay it."""
        response = self.__send(request, url, **kwargs)
        if not reauthenticate:
            return response
        endpoint = urlsplit(url).path.rstrip("0123456789")
        if response.ok:
            self.__rejected_endpoints.discard(endpoint)
        elif (self.__status(response) == 401
                and "Authorization" in self.__session.headers
                and self.__reconnect is not None
                and not self.__reauth_failed
                and (self.__reauth_retry_at is None
                     or self.__clock() >= self.__reauth_retry_at)
                and endpoint not in self.__rejected_endpoints):
            print("API session rejected (HTTP 401); authenticating again.")
            if self.__reauthenticate():
                data = kwargs.get("data")
                if isinstance(data, dict) and "token" in data:
                    kwargs["data"] = dict(data, token=self.__token)
                response = self.__send(request, url, **kwargs)
                if self.__status(response) == 401:
                    self.__rejected_endpoints.add(endpoint)
        return response

    @staticmethod
    def __is_transient(response):
        """A login answer that says nothing about the credentials: 5xx or rate limit."""
        status = LWApi.__status(response)
        return status >= 500 or status == 429

    @staticmethod
    def __status(response):
        status = getattr(response, "status_code", None)
        return status if isinstance(status, int) else 0

    def __send(self, request, url, **kwargs):
        # Only GETs are replayed after network errors or 5xx: they are idempotent.
        idempotent = getattr(request, "__name__", "") == "get"
        retries = 0
        transient_retries = 0
        while True:
            self.__wait_for_request_slot()
            try:
                response = request(url, **kwargs)
            except requests.RequestException:
                if not idempotent or transient_retries >= self.TRANSIENT_RETRIES:
                    raise
                response = None
            if response is None or (idempotent and self.__status(response) >= 500):
                if transient_retries >= self.TRANSIENT_RETRIES:
                    return response
                time.sleep(self.TRANSIENT_BACKOFF_SECONDS * 2 ** transient_retries)
                transient_retries += 1
                continue
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
