"""The `DEPLOYED.ts` file Garden writes at the root of the Leek Wars AI tree.

It is generated at each PUSH (never stored in Git) and holds only comments: the
deployed commit, its branch and tag, and the release summary, so that the game
site itself tells which version is live.
"""
import os
import time

import FightArchive


RELEASE_FILE = "DEPLOYED.ts"
MAX_SUMMARY_LINES = 30
TRAILERS = ("co-authored-by:", "claude-session:", "signed-off-by:")
DEFAULT_BRANCHES = ("master", "main")


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


def summary_lines(message):
    """The commit message without its trailers, capped."""
    lines = [line.rstrip() for line in message.splitlines()
             if not line.strip().lower().startswith(TRAILERS)]
    while lines and not lines[-1]:
        lines.pop()
    if len(lines) > MAX_SUMMARY_LINES:
        lines = lines[:MAX_SUMMARY_LINES] + ["[...]"]
    return lines


def build_content(head, source_state, branch, tag, account, now=None):
    """Comment-only TypeScript: every variable line is prefixed, so nothing can run."""
    now = time.time() if now is None else now
    lines = [
        "Fichier généré par LWGarden à chaque PUSH : ne pas modifier, ne pas inclure.",
        "",
        "Commit déployé : {0}".format(head.get("commit") or "inconnu (git indisponible)"),
        "Branche : {0}".format(branch or "inconnue"),
        "Tag : {0}".format(tag or "aucun"),
        "Compte : {0}".format(account),
        "Déployé le : {0}".format(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))),
    ]
    if source_state.get("dirty"):
        lines.append("ATTENTION : sources modifiées localement, différentes de ce commit : "
                     + (", ".join(source_state.get("dirty_files") or []) or "?"))
    lines += ["", "Résumé de la release :"] + summary_lines(head.get("message", ""))
    source_commit = source_state.get("commit")
    if source_commit and source_commit != head.get("commit"):
        lines += ["", "Dernier commit modifiant les sources ({0}) :".format(source_commit)]
        lines += summary_lines(source_state.get("message", ""))
    body = "\n".join(("// " + line).rstrip() for line in lines)
    return "// @version:5.8\n" + body + "\n"


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
        path = RELEASE_FILE
        if not any(ai.get("path", "").strip("/") == RELEASE_FILE for ai in files):
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
