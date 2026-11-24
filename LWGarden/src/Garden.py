import os, json, hashlib
from LWApi import LWApi
from shutil import rmtree


SUPPORTED_AI_SOURCE_EXTENSIONS = {".leek", ".ts"}
ARCHIVED_SOURCE_FOLDER = "_oldLeekScript"


def connect_primary(api, principal, api_key):
    if api_key:
        return api.connect_with_api_key(api_key)
    return api.connect(principal["username"], principal["password"])


def load_config():
    garden_directory = os.path.dirname(os.path.abspath(__file__))
    config_path = os.path.join(garden_directory, "config.json")
    with open(config_path, "r") as configfile:
        config = json.load(configfile)
    config["AIs_folder"] = os.path.abspath(
        os.path.join(garden_directory, config["AIs_folder"])
    )
    return config


def confirm_remote_deletions(remote_files, remote_folders):
    if not remote_files and not remote_folders:
        return False

    print("\nRemote-only items to move to the Leek Wars trash:")
    for path in remote_files:
        print("\tAI: " + path)
    for path in remote_folders:
        print("\tFolder: " + path)
    return input("Type DELETE to remove these remote-only items: ").strip() == "DELETE"


def is_yes_confirmation(value):
    return value.strip().lower() in ("y", "yes")


def main():
    """Main function, it constites of a Menu where you can select
    an action to perform:
    """
    print("▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁")
    print("▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁██████▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁")
    print("▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁████▓▓▓▓▓▓████▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁")
    print("▁▁▁▁▁▁▁▁▁▁▁▁▁▁████▁▁██▓▓▓▓▓▓▓▓▓▓██▁▁████▁▁▁▁▁▁▁▁▁▁")
    print("▁▁▁▁▁▁▁▁▁▁▁▁██▓▓▓▓████▓▓▓▓▓▓▓▓▓▓████▓▓▓▓██▁▁▁▁▁▁▁▁")
    print("▁▁▁▁▁▁▁▁▁▁██▓▓▓▓▓▓▓▓██▓▓▓▓▓▓▓▓▓▓██▓▓▓▓▓▓▓▓██▁▁▁▁▁▁")
    print("▁▁▁▁▁▁▁▁██▓▓▓▓▓▓▓▓▓▓██▓▓▓▓▓▓▓▓▓▓██▓▓▓▓▓▓▓▓▓▓██▁▁▁▁")
    print("▁▁▁▁▁▁▁▁██▓▓▓▓▓▓▓▓▓▓▓▓██▓▓▓▓▓▓██▓▓▓▓▓▓▓▓▓▓▓▓██▁▁▁▁")
    print("▁▁▁▁▁▁▁▁▁▁██▓▓▓▓▓▓▓▓▓▓██▓▓▓▓▓▓██▓▓▓▓▓▓▓▓▓▓██▁▁▁▁▁▁")
    print("▁▁▁▁▁▁▁▁▁▁▁▁██▓▓▓▓▓▓▓▓▓▓██▓▓██▓▓▓▓▓▓▓▓▓▓██▁▁▁▁▁▁▁▁")
    print("▁▁▁▁▁▁▁▁▁▁▁▁▁▁██▓▓▓▓▓▓▓▓██▓▓██▓▓▓▓▓▓▓▓██▁▁▁▁▁▁▁▁▁▁")
    print("▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁██▓▓▓▓▓▓▓▓██▓▓▓▓▓▓▓▓██▁▁▁▁▁▁▁▁▁▁▁▁")
    print("▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁██▁▁▁▁▁▁██▁▁▁▁▁▁██▁▁▁▁▁▁▁▁▁▁▁▁▁▁")
    print("▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁██▁▁▁▁▁▁▁▁▁▁██▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁")
    print("▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁██▁▁▁▁▁▁▁▁▁▁██▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁")
    print("▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁██▁▁██▁▁██▁▁██▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁")
    print("▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁██▁▁██▁▁██▁▁██▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁")
    print("▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁██▒▒▒▒▁▁▒▒▒▒██▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁")
    print("▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁██▁▁▁▁▁▁▁▁▁▁██▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁")
    print("▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁██▁▁██▁▁▁▁▁▁██▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁")
    print("▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁██▁▁▁▁▁▁██▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁")
    print("▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁██████▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁")
    print("▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁")
    print("▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁")
    print("▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁")

    print("\nWelcome to the Leek Garden, a tool to empower your leeks on LeekWars!")
    print(
        "\nTry to login on the LeekWars Api, please ensure that LWGarden/src/config.json is present, with your username and password")
    config = load_config()
    api = LWApi()
    accounts = config["accounts"]
    principal = next(p for p in accounts if p["primary"] == 'true')
    secondaries = list(p for p in accounts if p["primary"] == 'false')
    api_key = os.environ.get("LEEKWARS_API_KEY", "").strip()
    if api_key:
        print("\nConnecting to the primary account with LEEKWARS_API_KEY")
    else:
        print(principal["username"])
    if connect_primary(api, principal, api_key):
        farmer = api.get_farmer_self()["farmer"]
        print("\nYou are connected as {farmer_name}".format(farmer_name=farmer["login"]))
    else:
        print("\nCannot authenticate to the configured primary Leek Wars account.\n")
        exit()

    menu = {
        '1': "PULL (Leek Wars -> local): download AIs and replace the local source folder.",
        '2': "Launch fight",
        '3': "Get Register",
        '4': "Get Farmer's Throphies",
        '5': "PUSH local .leek/.ts sources to primary account; optionally delete remote-only items.",
        '6': "PUSH local .leek/.ts sources to secondary accounts; optionally delete remote-only items.",
        '7': "Exit"
    }
    while True:
        options = sorted(menu.keys())

        print("\n")

        for entry in options:
            print(entry, menu[entry])

        selection = input("Please Select:")
        if selection == '1':
            confirmation = input(
                "PULL will replace the configured local AI folder. Type OVERWRITE to continue: ")
            if confirmation.strip() == "OVERWRITE":
                get_all_ais(api, config["AIs_folder"])
            else:
                print("PULL cancelled.")
        elif selection == '2':
            print("delete")
        elif selection == '3':
            get_register(api, config)
        elif selection == '4':
            get_farmer_trophies(api, config["AIs_folder"])
        elif selection == '5':
            confirmation = input(
                "PUSH local .leek/.ts source files to primary account {0}? [y/N]: ".format(farmer["login"]))
            if is_yes_confirmation(confirmation):
                deploy_local_ais(api, config["AIs_folder"], confirm_remote_deletions)
            else:
                print("PUSH cancelled.")
        elif selection == '6':
            confirmation = input(
                "PUSH local .leek/.ts source files to secondary accounts? [y/N]: ")
            if is_yes_confirmation(confirmation):
                push_all_ais(
                    api, secondaries, config["AIs_folder"], confirm_remote_deletions
                )
                # reconnect to the main
                if not connect_primary(api, principal, api_key):
                    raise RuntimeError("Could not reconnect to the primary account.")
            else:
                print("PUSH cancelled.")
        elif selection == '7':
            break
        else:
            print("Unknown Option Selected!")


def normalize_ai_path(path):
    """Validate and normalize a path relative to the AI filesystem root."""
    normalized = path.replace("\\", "/").strip("/")
    parts = normalized.split("/")
    if not normalized or any(part in ("", ".", "..") for part in parts):
        raise ValueError("Invalid AI path: " + path)
    return "/".join(parts)


def local_path_for_ai(root_folder, ai_path):
    return os.path.join(root_folder, *normalize_ai_path(ai_path).split("/"))


def get_all_ais(api, root_folder: str):
    """Download all AI files, preserving their paths in the local source folder."""
    print("\nget_all_ais()\n")
    ai_tree = api.get_ai_tree()

    root_folder = os.path.abspath(root_folder)
    print("Delete previous files & folder under " + root_folder)
    if os.path.exists(root_folder):
        rmtree(root_folder)
    os.makedirs(root_folder)

    for folder in sorted(ai_tree["folders"], key=lambda path: path.count("/")):
        os.makedirs(local_path_for_ai(root_folder, folder), exist_ok=True)

    for ai in ai_tree["files"]:
        path = normalize_ai_path(ai["path"])
        extension = os.path.splitext(path)[1].lower()
        local_path = path if extension in SUPPORTED_AI_SOURCE_EXTENSIONS else path + ".leek"
        destination = local_path_for_ai(root_folder, local_path)
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        code = api.read_ai(path)["code"]
        with open(destination, "w", encoding="utf-8") as outfile:
            outfile.write(code)


def push_all_ais(api, secondaries, root_folder, confirm_delete=None):
    """Deploy local AI files to each secondary account."""
    print("\npush_all_ais()\n")
    for secondary in secondaries:
        if not api.connect(secondary["username"], secondary["password"]):
            raise RuntimeError("Could not connect to a secondary account.")
        farmer2 = api.get_farmer_self()["farmer"]
        print("\nDeploy to the account {farmer_name}\n".format(farmer_name=farmer2["login"]))
        deploy_local_ais(api, root_folder, confirm_delete)


def deploy_local_ais(api, root_folder, confirm_delete=None):
    """Create or update local LeekScript and TypeScript files on the account."""
    local_entries = get_local_ais(root_folder)
    local_folders = [entry for entry in local_entries if entry.type == "folder"]
    local_files = [entry for entry in local_entries if entry.type == "file"]
    if not local_files:
        raise ValueError("No .leek or .ts files found under " + root_folder)

    local_file_paths = []
    for local_file in local_files:
        remote_name = local_file.name
        if local_file.extension == ".ts":
            remote_name += ".ts"
        local_path = "/".join(
            part for part in (local_file.relative_path, remote_name) if part
        )
        local_file_paths.append((normalize_ai_path(local_path), local_file))
    if len({path for path, _ in local_file_paths}) != len(local_file_paths):
        raise ValueError("Multiple local source files map to the same remote AI path.")
    local_file_path_set = {path for path, _ in local_file_paths}
    local_folder_paths = {
        normalize_ai_path(entry.relative_path) for entry in local_folders
    }

    remote_tree = api.get_ai_tree()
    existing_folders = {normalize_ai_path(path) for path in remote_tree["folders"]}
    existing_files = {normalize_ai_path(ai["path"]) for ai in remote_tree["files"]}
    remote_only_files = sorted(existing_files - local_file_path_set)
    remote_only_folders = sorted(
        existing_folders - local_folder_paths,
        key=lambda path: (path.count("/"), path),
        reverse=True
    )
    delete_remote_only = False
    if remote_only_files or remote_only_folders:
        if confirm_delete is None:
            print("Remote-only items were kept; no deletion confirmation was provided.")
        else:
            delete_remote_only = confirm_delete(remote_only_files, remote_only_folders)

    for local_folder in sorted(local_folders, key=lambda entry: entry.relative_path.count("/")):
        path = normalize_ai_path(local_folder.relative_path)
        if path not in existing_folders:
            print("\tCreate folder: " + path, end="")
            result = api.new_folder(path)
            if not result.ok:
                raise RuntimeError("Could not create folder {0}: {1}".format(path, result.content))
            existing_folders.add(path)
            print(" -> Done!")

    created = 0
    updated = 0
    unchanged = 0
    for local_path, local_file in local_file_paths:
        if local_path in existing_files:
            remote_code = api.read_ai(local_path)["code"]
            remote_hash = hashlib.sha512(remote_code.encode("utf-8")).hexdigest()
            if remote_hash == local_file.hash:
                unchanged += 1
                continue
            action = "Update"
        else:
            action = "Create"
            folder_path, _, name = local_path.rpartition("/")
            result = api.create_ai(folder_path, name, version=4)
            if not result.ok:
                raise RuntimeError("Could not create AI {0}: {1}".format(local_path, result.content))
            created_path = result.json().get("path")
            if not created_path:
                raise RuntimeError("The API did not return a path for the new AI " + local_path)
            local_path = normalize_ai_path(created_path)

        print("\t{0} AI: {1}".format(action, local_path), end="")
        result = api.write_ai(local_path, local_file.content)
        if not result.ok:
            raise RuntimeError("Could not write AI {0}: {1}".format(local_path, result.content))
        if action == "Create":
            created += 1
            existing_files.add(local_path)
        else:
            updated += 1
        print(" -> Done!")

    deleted_files = 0
    deleted_folders = 0
    if delete_remote_only:
        for path in remote_only_files:
            print("\tMove remote-only AI to trash: " + path)
            result = api.delete_ai(path)
            if not result.ok:
                raise RuntimeError("Could not delete remote AI {0}: {1}".format(path, result.content))
            deleted_files += 1
            print("\t -> Done!")

        for path in remote_only_folders:
            print("\tMove remote-only folder to trash: " + path)
            result = api.delete_folder(path)
            if not result.ok:
                raise RuntimeError("Could not delete remote folder {0}: {1}".format(path, result.content))
            deleted_folders += 1
            print("\t -> Done!")

    print("\nDeployment complete: {0} created, {1} updated, {2} unchanged, "
          "{3} remote AIs and {4} folders moved to trash."
          .format(created, updated, unchanged, deleted_files, deleted_folders))


def Fight(api, config):
    print("\nFight()\n")


def get_register(api, config):
    print("\nRegister()\n")
    registers = api.get_registers("82210")
    menu = {}
    i = 0
    for register in registers["registers"]:
        menu[str(i)] = register["key"]
        i += 1

    while True:
        options = sorted(menu.keys())
        for entry in options:
            print(entry, menu[entry])
        selection = input("Please Select: (input any other key to exit)")
        if options.__contains__(selection):
            selected_register = next(filter(lambda x: x["key"] == menu[selection], registers["registers"]))
            last = sorted(json.loads(selected_register["value"]).values(), reverse=True)
            print(last)
            somme = sum(last)
            total = len(last)
            print(somme / total)
            print(last[0])
        else:
            break
        print("\n")


def get_farmer_trophies(api, config):
    selection = input("Please enter farmer id: ")
    trophies = api.get_farmer_trophies(selection)
    pyro = next(filter(lambda x: x["code"] == "explorator", trophies["trophies"]))
    print(pyro)


def get_local_ais(root_folder, local_ais=None):
    """recursive function to get all AIs"""
    if local_ais is None:
        local_ais = []
    root_folder = os.path.abspath(root_folder)
    if not os.path.isdir(root_folder):
        raise ValueError("AI source folder does not exist: " + root_folder)

    # walk() is working recursively
    for (dirpath, dirnames, filenames) in os.walk(root_folder):
        relative_dir = os.path.relpath(dirpath, root_folder)
        relative_dir = "" if relative_dir == "." else relative_dir.replace(os.sep, "/")
        if not relative_dir:
            dirnames[:] = [
                dirname for dirname in dirnames
                if dirname != ARCHIVED_SOURCE_FOLDER
            ]
        for filename in filenames:
            extension = os.path.splitext(filename)[1].lower()
            if extension not in SUPPORTED_AI_SOURCE_EXTENSIONS:
                continue
            with open(os.path.join(dirpath, filename), 'rb') as file:
                filecontent = file.read()
            try:
                filecontent = filecontent.decode("utf-8")
            except UnicodeDecodeError:
                print("Info: {0} uses Windows-1252; decoding for API upload."
                      .format("/".join(part for part in (relative_dir, filename) if part)))
                filecontent = filecontent.decode("cp1252")
            filecontent = filecontent.replace("\r\n", "\n").replace("\r", "\n")
            local_ais.append(type('', (object,), {
                "name": os.path.splitext(filename)[0],
                "extension": extension,
                "content": filecontent,
                "hash": hashlib.sha512(filecontent.encode('utf-8')).hexdigest(),
                "folder": os.path.basename(dirpath.replace(root_folder, '')),
                "relative_path": relative_dir,
                "type": "file"
            })())
        for dirname in dirnames:
            relative_path = "/".join(part for part in (relative_dir, dirname) if part)
            local_ais.append(type('', (object,), {
                "name": dirname,
                "content": "",
                "hash": "",
                "folder": os.path.basename(dirpath.replace(root_folder, '')),
                "relative_path": relative_path,
                "type": "folder"
            })())
    return local_ais


# Here goes all the magic
if __name__ == "__main__":
    main()
