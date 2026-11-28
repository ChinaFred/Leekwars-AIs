"""The `DEPLOYED.ts` file Garden writes at the root of the Leek Wars AI tree.

It is generated at each PUSH (never stored in Git) and holds comments and one constant, `DEPLOYED_VERSION`, read by the AI to log its version: the
version (last commit that changed the AI sources), when and from which branch or
tag it was deployed, and its `Stratégie:` line, so that the game site itself tells
which version is live.
"""
import json
import os
import re
import time

import FightArchive


RELEASE_FILE = "DEPLOYED.ts"
DEFAULT_BRANCHES = ("master", "main")


def is_release_file(path):
    """True for the release file at the root of the remote tree, however the editor
    spelled it when it was created by hand (`deployed.ts`, `DEPLOYED`...)."""
    name = str(path).replace("\\", "/").strip("/").lower()
    return name in (RELEASE_FILE.lower(), os.path.splitext(RELEASE_FILE)[0].lower())


def _git_lines(folder, *args):
    try:
        output = FightArchive._git(folder, *args)
    except (OSError, RuntimeError):
        return []
    return [line.strip() for line in output.splitlines() if line.strip()]


def read_head(folder):
    """HEAD of the repository (not only of the AI sources): commit, subject, message."""
    try:
        commit, subject, message = FightArchive._git(
            folder, "log", "-1", "--format=%H%x00%s%x00%B").split("\x00", 2)
    except (OSError, RuntimeError, ValueError):
        return {"commit": None, "subject": "", "message": ""}
    return {"commit": commit.strip(), "subject": subject.strip(), "message": message.strip()}


def read_branch(folder, environ=None):
    """Branch of the deployed commit. On a detached HEAD (a tag checked out by CI),
    the remote branches that contain the commit, the default branch first."""
    environ = os.environ if environ is None else environ
    if environ.get("GITHUB_REF_TYPE") == "branch" and environ.get("GITHUB_REF_NAME"):
        return environ["GITHUB_REF_NAME"]
    current = _git_lines(folder, "rev-parse", "--abbrev-ref", "HEAD")
    if current and current[0] != "HEAD":
        return current[0]
    branches = []
    for name in _git_lines(folder, "branch", "-r", "--contains", "HEAD",
                           "--format=%(refname:short)"):
        name = name.split("/", 1)[1] if "/" in name else name
        if name != "HEAD" and name not in branches:
            branches.append(name)
    branches.sort(key=lambda name: (name not in DEFAULT_BRANCHES, name))
    return ", ".join(branches) or "inconnue (HEAD détaché)"


def read_tag(folder, environ=None):
    environ = os.environ if environ is None else environ
    if environ.get("GITHUB_REF_TYPE") == "tag" and environ.get("GITHUB_REF_NAME"):
        return environ["GITHUB_REF_NAME"]
    return ", ".join(_git_lines(folder, "tag", "--points-at", "HEAD"))


STRATEGY_LINE = re.compile(r"^Strat[eé]gie[ \t]*:[ \t]*(.+)$", re.IGNORECASE | re.MULTILINE)


def build_content(head, source_state, branch, tag, account, now=None):
    """Comment-only TypeScript, kept to what tells which version fights: the last commit
    that changed the AI sources (the version id of the fight archive), when and from
    where it was deployed, and its `Stratégie:` line. Every line is prefixed, so nothing
    can run. `head` and `account` are not shown: the merge commit and the account name
    say nothing about the behaviour in a fight."""
    now = time.time() if now is None else now
    commit = source_state.get("commit")
    strategy = STRATEGY_LINE.search(source_state.get("message") or "")
    origin = (branch or "branche inconnue") + (", tag {0}".format(tag) if tag else "")
    lines = [
        "Généré par LWGarden à chaque PUSH : ne pas modifier. Seule la constante DEPLOYED_VERSION est lue par l'IA.",
        "",
        "Version : {0}".format("{0} — {1}".format(commit[:7], source_state.get("subject", ""))
                               if commit else "inconnue (git indisponible)"),
        "Déployée le : {0} depuis {1}".format(
            time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(now)), origin),
        "Stratégie : {0}".format(strategy.group(1).strip() if strategy else "non renseignée"),
    ]
    if source_state.get("dirty"):
        lines.append("ATTENTION : sources modifiées localement, différentes de ce commit : "
                     + (", ".join(source_state.get("dirty_files") or []) or "?"))
    body = "\n".join(("// " + " ".join(line.split())).rstrip() for line in lines)
    version = ("{0} — {1}".format(commit[:7], source_state.get("subject", "")).strip(" —")
               if commit else "inconnue")
    constant = "export const DEPLOYED_VERSION = {0}".format(json.dumps(" ".join(version.split()), ensure_ascii=False))
    return "// @version:5.8\n" + body + "\n" + constant + "\n"


def publish(api, source_folder, account, environ=None, now=None):
    """Write the release file on the connected account. Best effort: a failure is
    reported and returns False, it never undoes or fails the deployment itself."""
    head = read_head(source_folder)
    content = build_content(
        head, FightArchive.read_git_state(source_folder),
        read_branch(source_folder, environ), read_tag(source_folder, environ), account, now)
    try:
        tree = api.get_ai_tree()
        files = tree.get("files") if isinstance(tree, dict) else None
        if not isinstance(files, list):
            raise RuntimeError("could not read the remote AI tree")
        path = next((ai["path"].strip("/") for ai in files
                     if is_release_file(ai.get("path", ""))), None)
        if path is None:
            created = api.create_ai("", RELEASE_FILE, version=4)
            if not created.ok:
                raise RuntimeError("could not create it ({0}); create an AI named {1} at the "
                                   "root of the Leek Wars editor once, Garden will then keep "
                                   "it up to date".format(created.content, RELEASE_FILE))
            path = (created.json().get("path") or RELEASE_FILE).strip("/")
        written = api.write_ai(path, content)
        if not written.ok:
            raise RuntimeError("could not write it ({0})".format(written.content))
    except (RuntimeError, ValueError, KeyError, AttributeError, OSError) as error:
        print("Warning: release file {0} not updated: {1}".format(RELEASE_FILE, error))
        if (os.environ if environ is None else environ).get("GITHUB_ACTIONS") == "true":
            print("::warning title={0}::not updated on Leek Wars: {1}".format(RELEASE_FILE, error))
        return False
    print("Release file {0} updated: {1} on {2}".format(
        RELEASE_FILE, (head.get("commit") or "unknown")[:12],
        read_branch(source_folder, environ)))
    return True
