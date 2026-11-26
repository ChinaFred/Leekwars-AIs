"""Compact, git-tracked summary of the archived fights (Data/resume.md).

Written by Garden after options 7 and 8, or on demand:
    python LWGarden/src/FightSummary.py                 rewrite Data/resume.md
    python LWGarden/src/FightSummary.py --fight 123     one fight: result, ops per turn
    python LWGarden/src/FightSummary.py --fight 123 --turns   turn by turn: distance, MP and
                                                        paid actions used, damage, decisions logged
    python LWGarden/src/FightSummary.py --fight 123 --grep PLANNING   matching log lines

The summary is the entry point of the analysis: read it first, then open only the
fights it points to.
"""

import argparse
import json
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


MAP_WIDTH = 18
ACTION_NEW_TURN, ACTION_LEEK_TURN, ACTION_END_TURN = 6, 7, 8
ACTION_MOVE, ACTION_DEAD, ACTION_USE_CHIP, ACTION_SET_WEAPON, ACTION_USE_WEAPON = 10, 11, 12, 13, 16
ACTION_LOST_LIFE, ACTION_AI_ERROR = 101, 1002
LOG_TEXT_TYPES = (1, 2, 3)
# Lines repeated every turn that carry no decision.
LOG_NOISE = ("Accessible zone", "Danger zone", "[Reachable]", "===", "\n===", "Enemy HP",
             "[Chips]", "[Speech]", "Operations:")
PLAN_LINE = re.compile(r"^\[(Tactical|Reserve)\] plan before execution (\{.*)$", re.DOTALL)
PLAN_KEYS = ("tp", "tpAvailable", "mp", "mpAvailable", "weapon", "chips", "protection", "attack",
             "usefulDamage", "danger", "nextTurn", "score", "searchStatus")
MAX_LOG_LINE = 240
# End-of-turn line written by src/Classes/Context/ActionHistory.ts: exact TP/MP and results.
HISTORY_LINE = re.compile(
    r"^\[History\] T\d+ TP (-?\d+)/(-?\d+) MP (-?\d+)/(-?\d+) dealt (-?\d+) taken (-?\d+) passive (\d+)")


def cell_distance(first, second):
    """Number of moves between two cells of the diamond map (ids differ by 17 or 18 per step)."""
    def position(cell):
        row, column = divmod(cell, 2 * MAP_WIDTH - 1)
        x, y = (2 * column, 2 * row) if column < MAP_WIDTH else (2 * (column - MAP_WIDTH) + 1, 2 * row + 1)
        return (x + y) // 2, (y - x) // 2
    (x1, y1), (x2, y2) = position(first), position(second)
    return abs(x1 - x2) + abs(y1 - y2)


def _compact_log(text):
    plan = PLAN_LINE.match(text)
    if plan:
        try:
            payload = json.loads(plan.group(2))
            kept = {key: payload[key] for key in PLAN_KEYS if payload.get(key) not in (None, [], {})}
            return "[{0}] plan {1}".format(plan.group(1), json.dumps(kept, ensure_ascii=False))
        except ValueError:
            pass
    text = " ".join(text.split())
    return text if len(text) <= MAX_LOG_LINE else text[:MAX_LOG_LINE] + "…"


def _turn_logs(logs):
    """{action index: [text lines]} for our leeks, without map marks."""
    by_index = {}
    for farmer_logs in (logs.values() if isinstance(logs, dict) else []):
        if not isinstance(farmer_logs, dict):
            continue
        for index, entries in farmer_logs.items():
            for entry in entries if isinstance(entries, list) else []:
                if (isinstance(entry, list) and len(entry) > 2 and entry[1] in LOG_TEXT_TYPES
                        and isinstance(entry[2], str)):
                    by_index.setdefault(FightArchive._as_int(index), []).append(entry[2])
    return by_index


def timeline(fight, logs, farmer_id):
    """One record per turn of each of our leeks: what was available, used and decided.

    MP used is exact (path lengths). TP is not in the archive: `paid_actions` counts the
    weapon shots, chips and weapon changes, and a turn with none wasted all its TP.
    """
    data = fight.get("data") if isinstance(fight.get("data"), dict) else {}
    leeks = {leek["id"]: leek for leek in data.get("leeks") or [] if isinstance(leek, dict)}
    farmer_id = FightArchive._as_int(farmer_id)
    mine = {i for i, leek in leeks.items() if FightArchive._as_int(leek.get("farmer")) == farmer_id}
    my_teams = {leeks[i].get("team") for i in mine}
    cells = {i: leek.get("cellPos") for i, leek in leeks.items()}
    alive = set(leeks)
    logs_by_index = _turn_logs(logs)

    def nearest_enemy(leek):
        distances = [cell_distance(cells[leek], cells[other]) for other in alive
                     if leeks[other].get("team") not in my_teams
                     and cells.get(other) is not None and cells.get(leek) is not None]
        return min(distances) if distances else None

    turns, current, actor, turn_number = [], None, None, 1
    last_enemy_shift = {}
    for index, action in enumerate(data.get("actions") or []):
        if not isinstance(action, list) or not action:
            continue
        kind = action[0]
        if kind == ACTION_NEW_TURN and len(action) > 1:
            turn_number = action[1]
        elif kind == ACTION_LEEK_TURN and len(action) > 1:
            actor = action[1]
            if actor in mine:
                current = {"turn": turn_number, "leek": leeks[actor].get("name"), "start": index,
                           "distance_start": nearest_enemy(actor), "mp_total": None, "tp_total": None,
                           "mp_used": 0, "shots": 0, "chips": 0, "weapon_changes": 0,
                           "dealt": 0, "taken": 0, "error": False, "complete": False,
                           "enemy_shift": last_enemy_shift.get(actor), "logs": []}
                turns.append(current)
            else:
                current = None
                before = {leek: nearest_enemy(leek) for leek in mine & alive}
        elif kind == ACTION_MOVE and len(action) > 3:
            cells[action[1]] = action[2]
            if current is not None and action[1] == actor:
                current["mp_used"] += len(action[3])
        elif kind == ACTION_DEAD and len(action) > 1:
            alive.discard(action[1])
        elif kind == ACTION_LOST_LIFE and len(action) > 2:
            if action[1] in mine:
                if turns:
                    turns[-1]["taken"] += action[2]
            elif current is not None:
                current["dealt"] += action[2]
        elif current is not None and kind == ACTION_USE_WEAPON:
            current["shots"] += 1
        elif current is not None and kind == ACTION_USE_CHIP:
            current["chips"] += 1
        elif current is not None and kind == ACTION_SET_WEAPON:
            current["weapon_changes"] += 1
        elif current is not None and kind == ACTION_AI_ERROR:
            current["error"] = True
        elif kind == ACTION_END_TURN and len(action) > 3:
            if current is not None and action[1] == actor:
                current.update(end=index, tp_total=action[2], mp_total=action[3],
                               distance_end=nearest_enemy(actor))
            elif actor not in mine:
                for leek, distance in before.items():
                    after = nearest_enemy(leek) if leek in alive else None
                    if distance is not None and after is not None:
                        last_enemy_shift[leek] = after - distance
    for turn in turns:
        end = turn.get("end", turn["start"] + 1)
        lines = [text for index in sorted(i for i in logs_by_index if i is not None)
                 if turn["start"] <= index <= end + 1 for text in logs_by_index[index]]
        turn["complete"] = any("TURN END" in text for text in lines) or not lines
        operations = turn_operations(lines)
        turn["operations"] = operations[-1] if operations else None
        turn["logs"] = [_compact_log(text) for text in lines
                        if not text.strip().startswith(LOG_NOISE)]
        turn["paid_actions"] = turn["shots"] + turn["chips"] + turn["weapon_changes"]
        turn["tp_used"] = turn["tp_available"] = turn["passive"] = None
        for text in lines:
            history = HISTORY_LINE.match(text.strip())
            if history:
                values = [int(value) for value in history.groups()]
                turn["tp_used"], turn["tp_available"], turn["passive"] = values[0], values[1], values[6]
        turn.setdefault("distance_end", None)
        own_shift = (turn["distance_end"] - turn["distance_start"]
                     if None not in (turn["distance_end"], turn["distance_start"]) else None)
        turn["flags"] = [flag for flag, raised in (
            ("tour interrompu ou erreur d'IA", turn["error"] or not turn["complete"]),
            ("aucune action payante : PT tous perdus",
             turn["paid_actions"] == 0 and turn["tp_used"] is None),
            ("PT inutilisés : {0}".format((turn["tp_available"] or 0) - (turn["tp_used"] or 0)),
             turn["tp_used"] is not None and turn["tp_used"] < turn["tp_available"]),
            ("PM inutilisés", turn["mp_total"] is not None and turn["mp_used"] < turn["mp_total"]),
            ("recule alors que l'ennemi s'éloignait",
             own_shift is not None and own_shift > 0 and (turn["enemy_shift"] or 0) > 0),
        ) if raised]
    return turns


def waste(turns):
    """Aggregate of a list of turns, for the summary."""
    counted = [turn for turn in turns if turn["mp_total"]]
    return {
        "turns": len(turns),
        "idle": sum(1 for turn in turns if turn["paid_actions"] == 0),
        "broken": sum(1 for turn in turns if turn["error"] or not turn["complete"]),
        "mp_unused": sum(turn["mp_total"] - turn["mp_used"] for turn in counted),
        "mp_total": sum(turn["mp_total"] for turn in counted),
        "tp_unused": sum(t["tp_available"] - t["tp_used"] for t in turns if t["tp_used"] is not None),
        "tp_total": sum(t["tp_available"] for t in turns if t["tp_used"] is not None),
    }


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
        "turn_records": timeline(fight, logs, meta.get("farmer_id")),
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
        totals = waste([turn for f in fights for turn in f["turn_records"]])
        if totals["turns"]:
            lines.append("Ressources : {0} tours joués, {1} sans aucune action payante ({2:.0f} %), "
                         "{3:.0f} % des PM inutilisés, {4} tours interrompus ou en erreur.".format(
                             totals["turns"], totals["idle"], 100.0 * totals["idle"] / totals["turns"],
                             100.0 * totals["mp_unused"] / totals["mp_total"] if totals["mp_total"] else 0,
                             totals["broken"]))
            if totals["tp_total"]:
                lines.append("PT (ligne [History]) : {0:.0f} % inutilisés sur {1} disponibles.".format(
                    100.0 * totals["tp_unused"] / totals["tp_total"], totals["tp_total"]))
            worst = sorted((f for f in fights if f["turn_records"]), reverse=True,
                           key=lambda f: waste(f["turn_records"])["idle"] / len(f["turn_records"]))[:5]
            lines.append("Combats les plus gaspilleurs (tours sans action payante) : " + ", ".join(
                "{0} ({1}/{2}, {3})".format(
                    f["fight_id"], waste(f["turn_records"])["idle"], len(f["turn_records"]),
                    {"win": "victoire", "loss": "défaite", "draw": "nul"}.get(f["outcome"], "?"))
                for f in worst) + ".")
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


def print_fight(data_dir, fight_id, pattern=None, turns=False):
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
        for turn in fight["turn_records"] if turns else []:
            def shift(value):
                if value is None:
                    return "inconnu"
                return ("s'est rapproché de {0}".format(-value) if value < 0
                        else "s'est éloigné de {0}".format(value) if value > 0 else "n'a pas bougé")
            print("\nTour {turn} — {leek} : distance {distance_start} → {distance_end}, "
                  "PM {mp_used}/{mp_total}, PT {tp}, "
                  "{shots} tirs, {chips} puces, {weapon_changes} changements d'arme".format(
                      tp=("{0}/{1} utilisés".format(turn["tp_used"], turn["tp_available"])
                          if turn["tp_used"] is not None
                          else "disponibles {0}".format(turn["tp_total"])), **turn))
            print("  ennemi juste avant : {0} ; dégâts infligés {1}, subis ensuite {2} ; "
                  "ops {3}".format(shift(turn["enemy_shift"]), turn["dealt"], turn["taken"],
                                   "?" if turn["operations"] is None
                                   else "{0:.0f} %".format(turn["operations"])))
            if turn["flags"]:
                print("  À examiner : " + " ; ".join(turn["flags"]))
            for line in turn["logs"]:
                print("  | " + line)
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
    parser.add_argument("--turns", action="store_true",
                        help="avec --fight : déroulé tour par tour (ressources, décisions)")
    options = parser.parse_args(arguments)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if options.fight is not None:
        return print_fight(options.data, options.fight, options.grep, options.turns)
    print("Résumé écrit : " + write_summary(options.data))
    return 0


if __name__ == "__main__":
    sys.exit(main())
