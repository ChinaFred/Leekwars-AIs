#!/usr/bin/env python3
"""Cherche la meilleure combinaison d'armes et de puces pour un poireau, hors ligne, sans plafond d'opérations.

Exemples (depuis la racine du dépôt) :
    python ExternalTooling/loadout/best_loadout.py                       # Kassbi, tout ce que son niveau permet
    python ExternalTooling/loadout/best_loadout.py --pool owned --owned-file mes_items.json
    python ExternalTooling/loadout/best_loadout.py --sweep-def-weight 0,0.5,1 --top 10
    python ExternalTooling/loadout/best_loadout.py --compare "magnum,laser|protein,rock,motivation,spark,cure,leather_boots"

Méthode : toutes les paires d'armes × tous les ensembles de puces (recherche exhaustive, tous les cœurs). Chaque
combinaison est jouée sur un horizon de N tours à plusieurs distances (voir `turn_model.py` pour ce qui est modélisé).
Phase 1 : politique simple (chaque puce à cooldown lancée dès qu'elle est prête et utile) sur toutes les combinaisons ;
phase 2 : les meilleures sont rejouées avec TOUTES les politiques de lancer (`--exhaustive-policies` : pour toutes).

Le score est « dégâts infligés par tour + poids × dégâts évités » (`--def-weight`, 0 = attaque pure). Ce n'est pas une
prédiction de victoire : l'ennemi, les déplacements et la ligne de vue ne sont pas simulés.
"""
from __future__ import annotations

import argparse
import itertools
import json
import multiprocessing as mp
import os
import sys
import time
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import lw_items as L  # noqa: E402
import turn_model as M  # noqa: E402

_G: dict = {}  # état des processus de calcul


@dataclass(frozen=True)
class Result:
    score: float  # selon la métrique choisie
    damage: float
    avoided: float
    worst: float  # plus mauvais score de classe de distance
    weapons: tuple[str, ...]
    chips: tuple[str, ...]


def _init(settings, weapon_profiles, chip_profiles, classes, metric):
    _G.update(settings=settings, weapons=weapon_profiles, chips=chip_profiles, classes=classes, metric=metric)


def _useful(p: M.Profile, w: float) -> bool:
    return (p.damage > 0 or p.fixed > 0 or p.strength > 0 or p.agility > 0 or p.tp > 0
            or (w > 0 and (p.heal > 0 or p.absolute_shield > 0 or p.relative_shield > 0)))


def evaluate(weapon_names, chip_names, policies: str):
    """policies : 'fast' (une politique) ou 'all' (tous les masques de lancer)."""
    settings, metric, classes = _G["settings"], _G["metric"], _G["classes"]
    weapons = [_G["weapons"][n] for n in weapon_names]
    chips = [_G["chips"][n] for n in chip_names]
    stateless = [c for c in chips if not c.item.stateful]
    stateful = [c for c in chips if c.item.stateful]
    table = M.ChipTable(stateless, settings)
    useful = [i for i, c in enumerate(stateful) if _useful(c, settings.def_weight)]
    if policies == "all":
        masks = []
        for bits in itertools.product((False, True), repeat=len(useful)):
            mask = [False] * len(stateful)
            for i, b in zip(useful, bits):
                mask[i] = b
            masks.append(mask)
    else:
        masks = [[i in useful for i in range(len(stateful))]]
    best = None
    for mask in masks:
        total_d = total_a = total_w = 0.0
        worst = float("inf")
        for distance, weight in classes:
            d, a = M.simulate(weapons, stateful, table, settings, distance, mask)
            total_d, total_a, total_w = total_d + weight * d, total_a + weight * a, total_w + weight
            worst = min(worst, d + settings.def_weight * a)
        mean_d, mean_a = total_d / total_w, total_a / total_w
        mean_score = mean_d + settings.def_weight * mean_a
        score = worst if metric == "min" else mean_score
        if best is None or score > best.score:
            best = Result(score, mean_d, mean_a, worst, tuple(weapon_names), tuple(chip_names))
    return best


def _chunk(job):
    chipsets, weapon_sets, keep = job
    top: list[Result] = []
    for chips in chipsets:
        for weapons in weapon_sets:
            top.append(evaluate(weapons, chips, "fast"))
        if len(top) > 4 * keep:
            top = sorted(top, key=lambda r: -r.score)[:keep]
    return sorted(top, key=lambda r: -r.score)[:keep]


def _refine(job):
    return evaluate(job[0], job[1], "all")


def search(settings, weapon_pool, chip_pool, forced_weapons, forced_chips, slots_w, slots_c, classes, metric,
           workers, keep, exhaustive_policies, quiet=False):
    wp = {i.name: M.profile(i, settings.leek, settings.line_factor) for i in weapon_pool}
    cp = {i.name: M.profile(i, settings.leek, settings.line_factor) for i in chip_pool}
    free_w = [n for n in sorted(wp) if n not in forced_weapons]
    free_c = [n for n in sorted(cp) if n not in forced_chips]
    k_w, k_c = min(slots_w, len(wp)) - len(forced_weapons), min(slots_c, len(cp)) - len(forced_chips)
    weapon_sets = [tuple(sorted(forced_weapons + c)) for c in itertools.combinations(free_w, max(k_w, 0))]
    chipsets = [tuple(sorted(forced_chips + c)) for c in itertools.combinations(free_c, max(k_c, 0))]
    total = len(weapon_sets) * len(chipsets)
    if not quiet:
        print(f"  {len(weapon_sets)} jeux d'armes × {len(chipsets)} jeux de puces = {total:,} combinaisons, "
              f"{len(classes)} classes de distance, {workers} processus", file=sys.stderr)
    size = max(1, len(chipsets) // (workers * 40))
    jobs = [(chipsets[i:i + size], weapon_sets, keep) for i in range(0, len(chipsets), size)]
    started = time.time()
    with mp.Pool(workers, _init, (settings, wp, cp, classes, metric)) as pool:
        merged: list[Result] = []
        for n, part in enumerate(pool.imap_unordered(_chunk, jobs), 1):
            merged = sorted(merged + part, key=lambda r: -r.score)[:keep]
            if not quiet and (n % max(1, len(jobs) // 10) == 0):
                print(f"  phase 1 : {n}/{len(jobs)} blocs, {time.time() - started:.0f} s", file=sys.stderr)
        if exhaustive_policies:
            refine = [(w, c) for c in chipsets for w in weapon_sets]
        else:
            refine = [(r.weapons, r.chips) for r in merged]
        refined = sorted(pool.imap_unordered(_refine, refine, chunksize=16), key=lambda r: -r.score)
    if not quiet:
        print(f"  phase 2 : {len(refine):,} combinaisons rejouées avec toutes les politiques ({time.time() - started:.0f} s au total)",
              file=sys.stderr)
    return refined


def breakdown(settings, weapons, chips, distances, policies="all"):
    """Dégâts moyens par tour à chaque distance pour une combinaison, politique optimale par distance."""
    wp = {i.name: M.profile(i, settings.leek, settings.line_factor) for i in weapons}
    cp = {i.name: M.profile(i, settings.leek, settings.line_factor) for i in chips}
    _init(settings, wp, cp, [(d, 1) for d in distances], "mean")
    rows = []
    for d in distances:
        _G["classes"] = [(d, 1)]
        r = evaluate(tuple(wp), tuple(cp), policies)
        rows.append((d, r.damage, r.avoided))
    return rows


def describe(it: L.Item) -> str:
    cd = f", cd {it.cooldown}" if it.kind == "chip" and it.cooldown else ""
    return f"{it.name} (niv {it.level}, {it.cost} PT, portée {it.min_range}-{it.max_range}{cd})"


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__.split("\n\n", 1)[1])
    ap.add_argument("--leek-id", type=int, default=103947, help="poireau lu sur l'API publique (défaut : Kassbi)")
    ap.add_argument("--pool", choices=("level", "owned", "all"), default="level",
                    help="items candidats : niveau du poireau (défaut), inventaire (--owned-file ou LW_LOGIN/LW_PASSWORD), tout le jeu")
    ap.add_argument("--owned-file", help='JSON {"weapons": [...], "chips": [...]} (noms de l\'API, ex. "magnum", "spark")')
    ap.add_argument("--horizon", type=int, default=6, help="tours simulés par combinaison (défaut 6)")
    ap.add_argument("--dist-min", type=int, default=1)
    ap.add_argument("--dist-max", type=int, default=10, help="distances testées, poids égal par case (défaut 1-10)")
    ap.add_argument("--def-weight", type=float, default=0.5, help="valeur d'un dégât évité (bouclier, soin) ; 0 = attaque pure")
    ap.add_argument("--sweep-def-weight", help="liste de poids à comparer, ex. 0,0.5,1 (une recherche complète par poids)")
    ap.add_argument("--enemy-damage", type=float, default=120.0, help="dégâts reçus par tour : plafonne boucliers et soins")
    ap.add_argument("--metric", choices=("mean", "min"), default="mean",
                    help="mean : moyenne sur les distances ; min : la pire distance (combinaison la plus régulière)")
    ap.add_argument("--line-factor", type=float, default=0.7,
                    help="part des tirs faisables pour les items en ligne/diagonale (Laser, Éclair, Fusil à pompe, Neutrino) ; "
                         "1 = toujours alignable. Non mesuré en combat : à faire varier")
    ap.add_argument("--start-equipped", action="store_true", help="une arme est déjà en main au tour 1")
    ap.add_argument("--force", default="", help="items imposés, séparés par des virgules (armes et puces)")
    ap.add_argument("--exclude", default="", help="items écartés, séparés par des virgules")
    ap.add_argument("--max-weapons", type=int, help="emplacements d'armes (défaut : ceux du poireau)")
    ap.add_argument("--max-chips", type=int, help="emplacements de puces (défaut : ceux du poireau)")
    ap.add_argument("--compare", help='combinaisons à chiffrer, "armes|puces" séparées par ";" (noms séparés par des virgules)')
    ap.add_argument("--top", type=int, default=8, help="combinaisons affichées (défaut 8)")
    ap.add_argument("--keep", type=int, default=3000, help="combinaisons gardées de la phase 1 pour la phase 2")
    ap.add_argument("--exhaustive-policies", action="store_true", help="phase 2 sur TOUTES les combinaisons (lent)")
    ap.add_argument("--workers", type=int, default=os.cpu_count() or 1)
    ap.add_argument("--refresh", action="store_true", help="relit l'API au lieu du cache")
    ap.add_argument("--json", action="store_true", help="sortie JSON sur la sortie standard")
    return ap.parse_args(argv)


def load_owned(args, leek):
    if args.owned_file:
        data = json.load(open(args.owned_file, encoding="utf-8"))
        return list(data.get("weapons", [])), list(data.get("chips", []))
    if os.environ.get("LW_LOGIN") and os.environ.get("LW_PASSWORD"):
        return L.owned_from_account(os.environ["LW_LOGIN"], os.environ["LW_PASSWORD"], args.leek_id)
    return None


def run(args):
    weapons, chips, _, _ = L.load_catalog(args.refresh)
    leek = L.load_leek(args.leek_id, args.refresh)
    owned = load_owned(args, leek) if args.pool == "owned" else None
    exclude = [x for x in args.exclude.split(",") if x]
    weapon_pool, chip_pool = L.pool_items(args.pool, leek, weapons, chips, owned, exclude)
    wanted = [x for x in args.force.split(",") if x]
    forced_w = tuple(n for n in wanted if n in {i.name for i in weapon_pool})
    forced_c = tuple(n for n in wanted if n in {i.name for i in chip_pool})
    unknown = set(wanted) - set(forced_w) - set(forced_c)
    if unknown:
        raise SystemExit(f"items imposés introuvables dans le pool : {', '.join(sorted(unknown))}")
    slots_w, slots_c = args.max_weapons or leek.max_weapons, args.max_chips or leek.max_chips
    classes = M.distance_classes(weapon_pool + chip_pool, args.dist_min, args.dist_max)
    weights = [float(x) for x in args.sweep_def_weight.split(",")] if args.sweep_def_weight else [args.def_weight]
    report = {"leek": leek.__dict__, "pool": {"weapons": [i.name for i in weapon_pool], "chips": [i.name for i in chip_pool]},
              "runs": []}
    out = sys.stderr if args.json else sys.stdout

    def say(text=""):
        print(text, file=out)

    say(f"{leek.name} niv {leek.level} : force {leek.strength}, agilité {leek.agility}, sagesse {leek.wisdom}, "
        f"résistance {leek.resistance}, magie {leek.magic}, science {leek.science}, {leek.tp} PT, {leek.mp} PM, "
        f"{slots_w} armes / {slots_c} puces")
    say(f"Équipé : {', '.join(leek.equipped_weapons)} | {', '.join(leek.equipped_chips)}")
    say(f"Pool « {args.pool} » : {len(weapon_pool)} armes ({', '.join(i.name for i in weapon_pool)})")
    say(f"                 {len(chip_pool)} puces ({', '.join(i.name for i in chip_pool)})")
    say(f"Distances {args.dist_min}-{args.dist_max}, horizon {args.horizon} tours, métrique {args.metric}, facteur ligne {args.line_factor}")

    for w in weights:
        settings = M.Settings(leek, args.horizon, w, args.enemy_damage, args.start_equipped, args.line_factor)
        say(f"\n=== poids des dégâts évités = {w} ===")
        compare = []
        if args.compare:
            for spec in args.compare.split(";"):
                ws, cs = spec.split("|")
                compare.append((tuple(x for x in ws.split(",") if x), tuple(x for x in cs.split(",") if x)))
        else:
            compare.append((leek.equipped_weapons, leek.equipped_chips))
        ranked = search(settings, weapon_pool, chip_pool, forced_w, forced_c, slots_w, slots_c, classes, args.metric,
                        args.workers, args.keep, args.exhaustive_policies)
        say(f"{'#':>2}  {'score':>7} {'dégâts':>7} {'évités':>7} {'pire':>7}  armes | puces")
        for n, r in enumerate(ranked[:args.top], 1):
            say(f"{n:>2}  {r.score:7.1f} {r.damage:7.1f} {r.avoided:7.1f} {r.worst:7.1f}  {', '.join(r.weapons)} | {', '.join(r.chips)}")
        best = ranked[0]
        say("\nComparaison (même modèle, même politique optimale) :")
        rows = []
        for ws, cs in compare:
            if not all(x in {i.name for i in weapon_pool} for x in ws) or not all(x in {i.name for i in chip_pool} for x in cs):
                say(f"  hors pool : {', '.join(ws)} | {', '.join(cs)}")
                continue
            _init(settings, {i.name: M.profile(i, leek, settings.line_factor) for i in weapon_pool}, {i.name: M.profile(i, leek, settings.line_factor) for i in chip_pool},
                  classes, args.metric)
            r = evaluate(tuple(sorted(ws)), tuple(sorted(cs)), "all")
            rows.append(r)
            say(f"  {r.score:7.1f}  ({100 * r.score / best.score:5.1f} % du meilleur)  {', '.join(r.weapons)} | {', '.join(r.chips)}")
        say("\nProfil par distance (dégâts par tour / évités par tour) :")
        distances = list(range(args.dist_min, args.dist_max + 1))
        for label, r in [("meilleur", best)] + [("comparé", x) for x in rows[:1]]:
            profile_rows = breakdown(settings, [i for i in weapon_pool if i.name in r.weapons],
                                     [i for i in chip_pool if i.name in r.chips], distances)
            say(f"  {label:8s} " + " ".join(f"d{d}:{dmg:5.0f}" for d, dmg, _ in profile_rows))
        say("\nItems du meilleur :")
        for it in [i for i in weapon_pool if i.name in best.weapons] + [i for i in chip_pool if i.name in best.chips]:
            say("  " + describe(it))
        report["runs"].append({"def_weight": w, "top": [r.__dict__ for r in ranked[:args.top]],
                               "compared": [r.__dict__ for r in rows]})
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=1))
    return report


if __name__ == "__main__":
    run(parse_args())
