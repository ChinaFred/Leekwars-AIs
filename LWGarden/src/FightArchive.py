"""Local archive of fights, debug logs and publications, for later AI analysis.

Layout under the data folder (git-ignored):
    publications.json            one record per Garden PUSH (version = commit)
    fights/<id>/fight.json       full fight as returned by fight/get
    fights/<id>/logs.json        debug logs as returned by fight/get-logs
    fights/<id>/meta.json        fight date, account, log retrieval status
    fights/<id>--<farmer>/      additional accounts' copies of the same fight
    exports/<version>.json       fights of one version, ready to give to an AI

A fight belongs to the latest publication of its account that is not later
than the fight date. The publication holds the commit message of that version.
"""

import hashlib
import json
import os
import shutil
import subprocess
import time
from datetime import datetime, timezone

DEFAULT_RETENTION = 10
DEFAULT_MAX_NEW_FIGHTS = 100
PUBLICATIONS_FILE = "publications.json"
FIGHTS_FOLDER = "fights"
EXPORTS_FOLDER = "exports"
MAX_DIRTY_FILES = 50
FINISHED_FIGHT_STATUS = 2
UNKNOWN_VERSION = "unknown-version"
SUMMARY_KEYS = (
    "id", "date", "type", "context", "status", "winner", "leeks1", "leeks2",
    "farmers1", "farmers2", "report", "tournament", "starter", "seed",
    "team1_name", "team2_name",
)


def _read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as infile:
            return json.load(infile)
    except FileNotFoundError:
        return default


def _write_json(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as outfile:
        json.dump(payload, outfile, ensure_ascii=False, indent=1)
    os.replace(temporary, path)


def _as_int(value):
    if isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _fight_folder(data_dir, fight_id, farmer_id, account):
    root = os.path.join(data_dir, FIGHTS_FOLDER, str(int(fight_id)))
    if farmer_id is None:
        meta = _read_json(os.path.join(root, "meta.json"), None)
        if isinstance(meta, dict) and meta.get("account") == account:
            return root
        raise ValueError("Fight archive has no farmer id: {0}".format(root))
    alternate = root + "--" + str(int(farmer_id))
    for folder in (root, alternate):
        meta = _read_json(os.path.join(folder, "meta.json"), None)
        if (isinstance(meta, dict) and meta.get("account") == account
                and _as_int(meta.get("farmer_id")) in (None, int(farmer_id))):
            return folder
    if not os.path.exists(root):
        return root
    if not os.path.exists(os.path.join(root, "meta.json")):
        return root
    if os.path.exists(os.path.join(alternate, "meta.json")):
        raise ValueError("Fight archive belongs to a different account: {0}".format(alternate))
    return alternate


def _git(folder, *args):
    result = subprocess.run(
        ["git", "-C", folder] + list(args),
        capture_output=True, text=True, encoding="utf-8"
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip())
    return result.stdout


def read_git_state(source_folder):
    """Describe HEAD and whether the AI sources differ from it."""
    state = {
        "commit": None, "committed_at": None, "subject": "", "message": "",
        "dirty": True, "dirty_files": [],
    }
    try:
        head = _git(source_folder, "log", "-1", "--format=%H%x00%ct%x00%s%x00%B", "--", ".")
        commit, committed_at, subject, message = head.split("\x00", 3)
        porcelain = _git(source_folder, "status", "--porcelain=v1", "-z",
                         "--untracked-files=all", "--", ".")
    except (OSError, RuntimeError, ValueError):
        return state
    entries = iter(porcelain.split("\0"))
    paths = []
    for entry in entries:
        if not entry:
            continue
        paths.append(entry[3:])
        if "R" in entry[:2] or "C" in entry[:2]:
            paths.append(next(entries))
    dirty_files = [
        path for path in paths
        if os.path.splitext(path)[1].lower() in (".ts", ".leek")
        and "_oldLeekScript" not in path.replace("\\", "/").split("/")
    ]
    state.update({
        "commit": commit.strip(),
        "committed_at": _as_int(committed_at),
        "subject": subject.strip(),
        "message": message.strip(),
        "dirty": bool(dirty_files),
        "dirty_files": dirty_files[:MAX_DIRTY_FILES],
    })
    return state


def message_has_strategy_section(message):
    """True when the commit message has a non-empty "Stratégie:" line."""
    for line in message.splitlines():
        label, separator, content = line.partition(":")
        if (separator and label.strip().lower() in ("stratégie", "strategie")
                and len(content.strip()) >= 3):
            return True
    return False


def hash_sources(file_hashes):
    """Stable hash of (remote path, content hash) pairs of a deployment."""
    digest = hashlib.sha256()
    for path, content_hash in sorted(file_hashes):
        digest.update("{0}:{1}\n".format(path, content_hash).encode("utf-8"))
    return digest.hexdigest()


def build_version_id(git_state, source_hash):
    """Commit short hash; uncommitted sources get a suffix tied to their content."""
    commit = git_state.get("commit")
    if not commit:
        return "nogit-" + source_hash[:6]
    short = commit[:7]
    if git_state.get("dirty"):
        return "{0}-dirty-{1}".format(short, source_hash[:6])
    return short


def load_publications(data_dir):
    publications = _read_json(os.path.join(data_dir, PUBLICATIONS_FILE), [])
    return sorted(publications, key=lambda record: record["published_at"])


def record_publication(data_dir, account, git_state, source_hash, changes,
                       now=None, retention=DEFAULT_RETENTION):
    """Store a PUSH. Returns the record, or None if the version is unchanged."""
    published_at = int(time.time() if now is None else now)
    version_id = build_version_id(git_state, source_hash)
    publications = load_publications(data_dir)
    previous = [r for r in publications if r["account"] == account]
    if previous and previous[-1]["id"] == version_id:
        return None
    record = {
        "id": version_id,
        "account": account,
        "published_at": published_at,
        "published_at_iso": _iso(published_at),
        "commit": git_state.get("commit"),
        "committed_at": git_state.get("committed_at"),
        "subject": git_state.get("subject", ""),
        "message": git_state.get("message", ""),
        "has_strategy_section": message_has_strategy_section(git_state.get("message", "")),
        "dirty": bool(git_state.get("dirty")),
        "dirty_files": git_state.get("dirty_files", []),
        "changes": changes,
    }
    publications.append(record)
    _write_json(os.path.join(data_dir, PUBLICATIONS_FILE), publications)
    prune(data_dir, retention)
    return record


def version_for_fight(publications, account, fight_date):
    """Latest publication of the account that is not later than the fight."""
    selected = None
    for record in sorted(publications, key=lambda r: r["published_at"]):
        if record["account"] == account and record["published_at"] <= fight_date:
            selected = record
    return selected


def _retention_cutoffs(publications, retention):
    """Per account, the date of the oldest retained publication.

    Fights older than that date belong to versions outside the retention window.
    """
    cutoffs = {}
    for account in {record["account"] for record in publications}:
        mine = [r for r in publications if r["account"] == account]
        if len(mine) >= retention:
            cutoffs[account] = mine[-retention]["published_at"]
    return cutoffs


def prune(data_dir, retention=DEFAULT_RETENTION):
    """Keep the last `retention` publications per account and the fights since."""
    retention = max(1, int(retention))
    publications = load_publications(data_dir)
    cutoffs = _retention_cutoffs(publications, retention)
    dropped = []
    for account in cutoffs:
        mine = [r for r in publications if r["account"] == account]
        dropped.extend(id(record) for record in mine[:-retention])

    removed_fights = 0
    for meta in list_archived_fights(data_dir):
        cutoff = cutoffs.get(meta.get("account"))
        date = _as_int(meta.get("date"))
        if cutoff is not None and date is not None and date < cutoff:
            shutil.rmtree(_fight_folder(data_dir, meta["fight_id"],
                                        meta.get("farmer_id"), meta["account"]))
            removed_fights += 1
    if dropped:
        kept = [record for record in publications if id(record) not in dropped]
        _write_json(os.path.join(data_dir, PUBLICATIONS_FILE), kept)
    return {"publications": len(dropped), "fights": removed_fights}


def list_archived_fights(data_dir):
    root = os.path.join(data_dir, FIGHTS_FOLDER)
    if not os.path.isdir(root):
        return []
    archived = []
    for name in sorted(os.listdir(root)):
        meta = _read_json(os.path.join(root, name, "meta.json"), None)
        if isinstance(meta, dict) and "fight_id" in meta:
            archived.append(meta)
    return archived


def extract_history_entries(history_payload):
    """Map fight id -> date (None when absent) from a history response."""
    fights = history_payload.get("fights") if isinstance(history_payload, dict) else history_payload
    entries = {}
    for entry in fights or []:
        is_dict = isinstance(entry, dict)
        fight_id = _as_int(entry.get("id") if is_dict else entry)
        if fight_id is not None:
            entries[fight_id] = _as_int(entry.get("date")) if is_dict else None
    return entries


def _unwrap(payload, key):
    if isinstance(payload, dict) and isinstance(payload.get(key), (dict, list)):
        return payload[key]
    return payload


def _is_complete(data_dir, fight_id, farmer_id, account):
    meta = _read_json(os.path.join(
        _fight_folder(data_dir, fight_id, farmer_id, account), "meta.json"), None)
    return isinstance(meta, dict) and meta.get("logs_status") == "ok"


def archive_fights(api, data_dir, farmer_id, account,
                   max_new=DEFAULT_MAX_NEW_FIGHTS, retention=DEFAULT_RETENTION):
    """Download recent fights and their debug logs that are not archived yet.

    Fights whose logs could not be read are fetched again on the next run.
    """
    history = api.get_farmer_history(farmer_id)
    if not history.ok:
        raise RuntimeError("Could not read the fight history (HTTP {0})."
                           .format(getattr(history, "status_code", "?")))
    stats = {"listed": 0, "archived": 0, "skipped": 0, "pending": 0,
             "expired": 0, "logs_missing": 0, "errors": 0}
    entries = extract_history_entries(history.json())
    cutoffs = _retention_cutoffs(load_publications(data_dir), max(1, int(retention)))
    cutoff = cutoffs.get(account)
    stats["listed"] = len(entries)
    processed = 0
    for fight_id in sorted(entries, reverse=True):
        if _is_complete(data_dir, fight_id, farmer_id, account):
            stats["skipped"] += 1
            continue
        if cutoff is not None and entries[fight_id] is not None and entries[fight_id] < cutoff:
            stats["expired"] += 1
            continue
        if processed >= max_new:
            break
        processed += 1
        fight_response = api.get_fight(fight_id)
        if not fight_response.ok:
            stats["errors"] += 1
            continue
        fight = _unwrap(fight_response.json(), "fight")
        if not isinstance(fight, dict) or fight.get("status") != FINISHED_FIGHT_STATUS:
            stats["pending"] += 1
            continue
        fight_date = _as_int(fight.get("date"))
        if cutoff is not None and fight_date is not None and fight_date < cutoff:
            stats["expired"] += 1
            continue
        logs_response = api.get_fight_logs(fight_id)
        if logs_response.ok:
            logs_status = "ok"
            logs = _unwrap(logs_response.json(), "logs")
        else:
            logs_status = "http_{0}".format(getattr(logs_response, "status_code", "error"))
            logs = None
            stats["logs_missing"] += 1
        folder = _fight_folder(data_dir, fight_id, farmer_id, account)
        _write_json(os.path.join(folder, "fight.json"), fight)
        _write_json(os.path.join(folder, "logs.json"), logs)
        _write_json(os.path.join(folder, "meta.json"), {
            "fight_id": fight_id,
            "date": fight_date,
            "account": account,
            "farmer_id": _as_int(farmer_id),
            "fetched_at": int(time.time()),
            "logs_status": logs_status,
        })
        stats["archived"] += 1
    stats["pruned"] = prune(data_dir, retention)
    return stats


def fight_outcome(fight, farmer_id):
    """win, loss or draw for the farmer, None when it cannot be determined."""
    farmer_id = _as_int(farmer_id)
    if farmer_id is None:
        return None
    sides = {1: set(), 2: set()}
    for side in sides:
        farmers = fight.get("farmers{0}".format(side))
        if isinstance(farmers, dict):
            sides[side].update(_as_int(key) for key in farmers)
        sides[side].add(_as_int(fight.get("farmer{0}".format(side))))
    mine = next((side for side, ids in sides.items() if farmer_id in ids), None)
    winner = _as_int(fight.get("winner"))
    if mine is None or winner is None:
        return None
    if winner == 0:
        return "draw"
    return "win" if winner == mine else "loss"


def export_for_analysis(data_dir, version_id=None):
    """Write one JSON file per version with its fights and debug logs.

    Returns {version id: (path, fight count)}.
    """
    publications = load_publications(data_dir)
    groups = {}
    for meta in list_archived_fights(data_dir):
        date = _as_int(meta.get("date"))
        record = (version_for_fight(publications, meta.get("account"), date)
                  if date is not None else None)
        key = record["id"] if record else UNKNOWN_VERSION
        if version_id and key != version_id:
            continue
        folder = _fight_folder(data_dir, meta["fight_id"],
                               meta.get("farmer_id"), meta["account"])
        fight = _read_json(os.path.join(folder, "fight.json"), {})
        entry = {
            "fight_id": meta["fight_id"],
            "account": meta["account"],
            "publication": record,
            "date": date,
            "date_iso": _iso(date) if date is not None else None,
            "outcome": fight_outcome(fight, meta.get("farmer_id")),
            "logs_status": meta.get("logs_status"),
            "fight": {name: fight[name] for name in SUMMARY_KEYS if name in fight},
            "debug_logs": _read_json(os.path.join(folder, "logs.json"), None),
        }
        group = groups.setdefault(key, {"version": record, "publications": [], "fights": []})
        if record is not None and record not in group["publications"]:
            group["publications"].append(record)
            if len(group["publications"]) > 1:
                group["version"] = None
        group["fights"].append(entry)

    exported = {}
    for key, group in groups.items():
        group["fights"].sort(key=lambda entry: entry["fight_id"])
        path = os.path.join(data_dir, EXPORTS_FOLDER, key + ".json")
        _write_json(path, group)
        exported[key] = (path, len(group["fights"]))
    return exported
