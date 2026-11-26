"""Compact, git-tracked summary of the archived fights (Data/resume.md).

Written by Garden after options 7 and 8, or on demand:
    python LWGarden/src/FightSummary.py                 rewrite Data/resume.md
    python LWGarden/src/FightSummary.py --fight 123     one fight: result, ops per turn
    python LWGarden/src/FightSummary.py --fight 123 --grep PLANNING   matching log lines

The summary is the entry point of the analysis: read it first, then open only the
fights it points to.
"""

import argparse
import os
import re
import statistics
import sys

import FightArchive

SUMMARY_FILE = "resume.md"
MAX_LISTED_LOSSES = 15
# Line written at the end of each turn by logTurnOperations (src/Toolbox/Debug.ts).
TURN_OPERATIONS = re.compile(r"\bOperations: (\d+)/(\d+) \(")
STRATEGY_LINE = re.compile(r"^Strat[eé]gie[ \t]*:[ \t]*(.+)$", re.IGNORECASE | re.MULTILINE)


def iter_strings(node):
    """Every string of a JSON tree, in document order (the log format is not relied on)."""
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for value in node.values():
            yield from iter_strings(value)
    elif isinstance(node, (list, tuple)):
        for value in node:
            yield from iter_strings(value)


def turn_operations(logs):
    """Percentage of the operation budget used at the end of each logged turn."""
    percentages = []
    for text in iter_strings(logs):
        for used, maximum in TURN_OPERATIONS.findall(text):
            if int(maximum) > 0:
                percentages.append(100.0 * int(used) / int(maximum))
    return percentages


def _names(leeks):
    if isinstance(leeks, dict):
        leeks = list(leeks.values())
    return [str(leek["name"]) for leek in leeks or []
            if isinstance(leek, dict) and leek.get("name")]


def opponents(fight, farmer_id):
    """Names of the leeks of the other side ([] when the sides cannot be told apart)."""
    farmer_id = FightArchive._as_int(farmer_id)
    for mine, other in ((1, 2), (2, 1)):
        farmers = fight.get("farmers{0}".format(mine))
        ids = {FightArchive._as_int(key) for key in farmers} if isinstance(farmers, dict) else set()
        ids.add(FightArchive._as_int(fight.get("farmer{0}".format(mine))))
        if farmer_id is not None and farmer_id in ids:
            return _names(fight.get("leeks{0}".format(other)))
    return []


def describe_fight(data_dir, meta):
    folder = FightArchive._fight_folder(
        data_dir, meta["fight_id"], meta.get("farmer_id"), meta["account"])
    fight = FightArchive._read_json(os.path.join(folder, "fight.json"), {})
    logs = FightArchive._read_json(os.path.join(folder, "logs.json"), None)
    report = fight.get("report")
    operations = turn_operations(logs)
    return {
        "fight_id": meta["fight_id"],
        "account": meta["account"],
        "date": FightArchive._as_int(meta.get("date")),
        "outcome": FightArchive.fight_outcome(fight, meta.get("farmer_id")),
        "turns": FightArchive._as_int(report.get("duration")) if isinstance(report, dict) else None,
        "opponents": opponents(fight, meta.get("farmer_id")),
        "has_logs": meta.get("logs_status") == "ok",
        "operations": operations,
        "peak": max(operations) if operations else None,
    }


def collect(data_dir):
    """Fights grouped by version: [(version id, publication or None, [fight])], newest first."""
    publications = FightArchive.load_publications(data_dir)
    groups = {}
    for meta in FightArchive.list_archived_fights(data_dir):
        entry = describe_fight(data_dir, meta)
        record = (FightArchive.version_for_fight(publications, meta.get("account"), entry["date"])
                  if entry["date"] is not None else None)
        key = record["id"] if record else FightArchive.UNKNOWN_VERSION
        groups.setdefault(key, (record, []))[1].append(entry)
    ordered = sorted(
        groups.items(),
        key=lambda item: item[1][0]["published_at"] if item[1][0] else 0, reverse=True)
    return [(key, record, sorted(fights, key=lambda f: f["fight_id"]))
            for key, (record, fights) in ordered]


def _loss_line(fight):
    details = []
    if fight["turns"] is not None:
        details.append("{0} tours".format(fight["turns"]))
    if fight["opponents"]:
        details.append("vs " + ", ".join(fight["opponents"]))
    if fight["peak"] is not None:
        details.append("pic ops {0:.0f} %".format(fight["peak"]))
    if not fight["has_logs"]:
        details.append("sans logs")
    return "- {0} : {1}".format(fight["fight_id"], " · ".join(details) or "aucun détail")


def render(groups):
    lines = [
        "# Résumé des combats archivés",
        "",
        "Généré par Garden (options 7 et 8) ou `python LWGarden/src/FightSummary.py` ; "
        "ne pas modifier à la main. Détail d'un combat : `--fight <id>`.",
    ]
    if not groups:
        lines += ["", "Aucun combat archivé."]
    for key, record, fights in groups:
        counts = {name: sum(1 for f in fights if f["outcome"] == name)
                  for name in ("win", "loss", "draw")}
        decided = counts["win"] + counts["loss"] + counts["draw"]
        rate = "{0:.0f} %".format(100.0 * counts["win"] / decided) if decided else "n/a"
        lines += ["", "## {0} — {1}".format(key, record["subject"] if record else "version inconnue")]
        if record:
            strategy = STRATEGY_LINE.search(record.get("message", ""))
            lines.append("Compte {0}, publié le {1}{2}.".format(
                record["account"], record.get("published_at_iso", "?"),
                ", sources modifiées par rapport au commit" if record.get("dirty") else ""))
            if strategy:
                lines.append("Stratégie : " + strategy.group(1).strip())
        lines.append("Combats : {0} — {1} victoires, {2} défaites, {3} nuls ({4} de victoires), "
                     "{5} sans logs.".format(
                         len(fights), counts["win"], counts["loss"], counts["draw"], rate,
                         sum(1 for f in fights if not f["has_logs"])))
        peaks = [f["peak"] for f in fights if f["peak"] is not None]
        if peaks:
            worst = max((f for f in fights if f["peak"] is not None), key=lambda f: f["peak"])
            lines.append("Ops : pic maximal {0:.0f} % (combat {1}), médiane des pics {2:.0f} %.".format(
                worst["peak"], worst["fight_id"], statistics.median(peaks)))
        losses = [f for f in fights if f["outcome"] == "loss"]
        if losses:
            lines += ["", "Défaites :"] + [_loss_line(f) for f in losses[-MAX_LISTED_LOSSES:]]
            if len(losses) > MAX_LISTED_LOSSES:
                lines.append("- … et {0} plus anciennes.".format(len(losses) - MAX_LISTED_LOSSES))
    return "\n".join(lines) + "\n"


def write_summary(data_dir):
    """Rewrite Data/resume.md. Returns its path."""
    path = os.path.join(data_dir, SUMMARY_FILE)
    os.makedirs(data_dir, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as outfile:
        outfile.write(render(collect(data_dir)))
    return path


def print_fight(data_dir, fight_id, pattern=None):
    metas = [m for m in FightArchive.list_archived_fights(data_dir) if m["fight_id"] == fight_id]
    if not metas:
        print("Combat {0} absent de l'archive.".format(fight_id))
        return 1
    for meta in metas:
        fight = describe_fight(data_dir, meta)
        print("Combat {fight_id} ({account}) : {outcome}, {turns} tours, vs {0}".format(
            ", ".join(fight["opponents"]) or "?", **fight))
        print("Ops par tour (%) : " + (" ".join("{0:.0f}".format(p) for p in fight["operations"])
                                       or "aucune ligne d'opérations dans les logs"))
        if pattern:
            folder = FightArchive._fight_folder(
                data_dir, fight_id, meta.get("farmer_id"), meta["account"])
            logs = FightArchive._read_json(os.path.join(folder, "logs.json"), None)
            matcher = re.compile(pattern, re.IGNORECASE)
            for text in iter_strings(logs):
                if matcher.search(text):
                    print(text)
    return 0


def main(arguments=None):
    default_data = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "Data")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", default=default_data, help="dossier de l'archive (LWGarden/Data)")
    parser.add_argument("--fight", type=int, help="affiche un combat au lieu de réécrire le résumé")
    parser.add_argument("--grep", help="avec --fight : lignes de log correspondant à cette regex")
    options = parser.parse_args(arguments)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if options.fight is not None:
        return print_fight(options.data, options.fight, options.grep)
    print("Résumé écrit : " + write_summary(options.data))
    return 0


if __name__ == "__main__":
    sys.exit(main())
