"""Modèle de combat d'un poireau seul face à une cible à distance fixe, pour comparer des équipements.

Ce que le modèle SIMULE : TP du tour (dont boosts de PT), coût d'équipement d'arme (1 PT par changement, 1 PT au tout
premier tir si aucune arme n'est en main), portée de chaque item à la distance testée, `max_uses` par tour, cooldowns
des puces (suivis d'un tour à l'autre), force et agilité boostées (durée comptée comme le moteur : le tour du lancer
compte pour 1), poison, boucliers et soins valorisés en dégâts évités.

Ce qu'il NE simule PAS (voir `--help`) : déplacements et PM, ligne de vue, motif de lancer, zones d'effet, riposte
adverse détaillée, critiques aléatoires (espérance seulement), vol de vie, effets inconnus (id 27, 26…).
"""
from __future__ import annotations

from dataclasses import dataclass
from itertools import product
from typing import Sequence

import lw_items as L
from lw_items import Item, Leek

TP_CAP = 60  # borne des tables ; bien au-delà de 10 PT + tous les boosts


@dataclass(frozen=True)
class Settings:
    leek: Leek
    horizon: int = 6  # tours simulés
    def_weight: float = 0.5  # valeur d'un point de dégât évité, en points de dégât infligé
    enemy_damage: float = 120.0  # dégâts reçus par tour (plafonne ce qu'un bouclier ou un soin peut éviter)
    start_equipped: bool = False  # vrai : une arme est déjà en main au tour 1
    line_factor: float = 1.0  # part des tirs réellement faisables pour un item limité en ligne ou en diagonale


@dataclass(frozen=True)
class Profile:
    """Ce qu'un item apporte, déjà mis à l'échelle des caractéristiques du poireau (hors force et agilité)."""
    item: Item
    damage: float  # moyenne des effets DAMAGE visant l'ennemi, avant multiplicateur de force
    fixed: float  # poison total (non lié à la force)
    strength: float  # bonus de force sur soi
    agility: float
    tp: float
    mp: float
    buff_turns: int
    absolute_shield: float
    relative_shield: float  # fraction (0,05 = 5 %)
    shield_turns: int
    heal: float

    @property
    def self_buff(self) -> bool:
        return self.strength > 0 or self.agility > 0 or self.tp > 0 or self.mp > 0


def profile(item: Item, leek: Leek, line_factor: float = 1.0) -> Profile:
    damage = fixed = strength = agility = tp = mp = absolute = relative = heal = 0.0
    buff_turns = shield_turns = 0
    sci, res, wis, mag = 1 + leek.science / 100, 1 + leek.resistance / 100, 1 + leek.wisdom / 100, 1 + leek.magic / 100
    for e in item.effects:
        a = e.average
        if e.type == L.E_DAMAGE and e.on_enemy:
            damage += a
        elif e.type == L.E_POISON and e.on_enemy:
            fixed += a * mag * e.turns
        elif e.type == L.E_HEAL and e.on_caster:
            heal += a * wis
        elif e.type == L.E_ABSOLUTE_SHIELD and e.on_caster:
            absolute, shield_turns = absolute + a * res, max(shield_turns, e.turns)
        elif e.type == L.E_RELATIVE_SHIELD and e.on_caster:
            relative, shield_turns = relative + a * res / 100, max(shield_turns, e.turns)
        elif e.on_caster and e.type in (L.E_RAW_BUFF_STRENGTH, L.E_BUFF_STRENGTH):
            strength, buff_turns = strength + a * (sci if e.type == L.E_BUFF_STRENGTH else 1), max(buff_turns, e.turns)
        elif e.on_caster and e.type in (L.E_RAW_BUFF_AGILITY, L.E_BUFF_AGILITY):
            agility, buff_turns = agility + a * (sci if e.type == L.E_BUFF_AGILITY else 1), max(buff_turns, e.turns)
        elif e.on_caster and e.type in (L.E_RAW_BUFF_TP, L.E_BUFF_TP):
            tp, buff_turns = tp + a * (sci if e.type == L.E_BUFF_TP else 1), max(buff_turns, e.turns)
        elif e.on_caster and e.type in (L.E_RAW_BUFF_MP, L.E_BUFF_MP):
            mp, buff_turns = mp + a * (sci if e.type == L.E_BUFF_MP else 1), max(buff_turns, e.turns)
    if item.launch_type != 7:  # ligne, diagonale… : il faut être aligné avec la cible (mouvement, obstacles)
        damage, fixed = damage * line_factor, fixed * line_factor
    return Profile(item, damage, fixed, strength, agility, tp, mp, buff_turns, absolute, relative, shield_turns, heal)


def multiplier(leek: Leek, strength_bonus: float, agility_bonus: float) -> float:
    """Dégâts moyens = base × (1 + force/100) × espérance de critique (chance agilité/1000, dégâts × 1,3)."""
    crit = min(1.0, (leek.agility + agility_bonus) / 1000)
    return (1 + (leek.strength + strength_bonus) / 100) * (1 + 0.3 * crit)


def in_range(item: Item, distance: int, p: Profile) -> bool:
    """Un item lancé sur soi (boost, bouclier, soin) ne dépend pas de la distance à la cible."""
    if p.damage <= 0 and p.fixed <= 0 and (p.self_buff or p.absolute_shield or p.relative_shield or p.heal):
        return True
    return item.min_range <= distance <= item.max_range


def mitigation(p: Profile, settings: Settings, turn: int) -> float:
    """Dégâts évités par un lancer : un bouclier absolu est un réservoir (consommé), un relatif agit sur chaque tour."""
    e, left = settings.enemy_damage, settings.horizon - turn
    turns = min(p.shield_turns, left)
    shield = min(p.absolute_shield, e * turns) + p.relative_shield * e * turns
    return shield + min(p.heal, e)


class ChipTable:
    """Meilleure suite de lancers des puces SANS état (cooldown 0 ou 1) pour chaque budget de PT, à distance donnée."""

    def __init__(self, chips: Sequence[Profile], settings: Settings):
        self.chips, self.settings, self._cache = tuple(chips), settings, {}

    def best(self, distance: int, mult: float, tp: int) -> tuple[float, float, float]:
        """(score, dégâts, évités) avec au plus `tp` PT."""
        key = (distance, round(mult, 4))
        table = self._cache.get(key)
        if table is None:
            table = self._cache[key] = self._build(distance, mult)
        return table[min(max(tp, 0), TP_CAP)]

    def _build(self, distance: int, mult: float):
        w = self.settings.def_weight
        best = [(0.0, 0.0, 0.0)] * (TP_CAP + 1)
        for p in self.chips:
            if not in_range(p.item, distance, p):
                continue
            damage = p.damage * mult + p.fixed
            avoided = mitigation(p, self.settings, 0) if (p.heal or p.absolute_shield or p.relative_shield) else 0.0
            value = damage + w * avoided
            if value <= 0:
                continue
            nxt = list(best)
            for t in range(TP_CAP + 1):
                for n in range(1, p.item.uses_per_turn(t) + 1):
                    cost = n * p.item.cost
                    if cost > t:
                        break
                    base = best[t - cost]
                    cand = (base[0] + n * value, base[1] + n * damage, base[2] + n * avoided)
                    if cand[0] > nxt[t][0]:
                        nxt[t] = cand
            best = nxt
        # monotone : disposer de plus de PT n'est jamais pire
        for t in range(1, TP_CAP + 1):
            if best[t - 1][0] > best[t][0]:
                best[t] = best[t - 1]
        return best


def weapon_options(weapons: Sequence[Profile], current: int | None, distance: int, tp: int):
    """Plans d'armes d'un tour : (PT dépensés, dégâts avant multiplicateur, poison, bonus de force posé, arme finale).

    Une arme compte un lancer de plus quand les PT le permettent ; chaque changement d'arme coûte 1 PT."""
    options = [(0, 0.0, 0.0, 0.0, 0, current)]
    usable = [i for i, p in enumerate(weapons) if in_range(p.item, distance, p)]
    for i in usable:
        p = weapons[i]
        swap = 0 if current == i else 1
        for n in range(1, p.item.uses_per_turn(tp - swap) + 1):
            spent = swap + n * p.item.cost
            if spent > tp:
                break
            options.append((spent, n * p.damage, n * p.fixed, p.strength, buff_turns_of(p), i))
    for i, j in product(usable, usable):
        if i >= j:
            continue
        first, second = (i, j) if current != j else (j, i)
        swaps = (0 if current == first else 1) + 1
        for n1 in range(1, weapons[first].item.uses_per_turn(tp) + 1):
            for n2 in range(1, weapons[second].item.uses_per_turn(tp) + 1):
                spent = swaps + n1 * weapons[first].item.cost + n2 * weapons[second].item.cost
                if spent > tp:
                    continue
                dmg = n1 * weapons[first].damage + n2 * weapons[second].damage
                fixed = n1 * weapons[first].fixed + n2 * weapons[second].fixed
                strength = max(weapons[first].strength, weapons[second].strength)
                options.append((spent, dmg, fixed, strength, max(buff_turns_of(weapons[first]), buff_turns_of(weapons[second])), second))
    return options


def buff_turns_of(p: Profile) -> int:
    return p.buff_turns if p.strength > 0 else 0


def simulate(
    weapons: Sequence[Profile], stateful: Sequence[Profile], table: ChipTable, settings: Settings,
    distance: int, mask: Sequence[bool],
) -> tuple[float, float]:
    """(dégâts infligés par tour, dégâts évités par tour), en moyenne sur l'horizon."""
    leek, horizon, w = settings.leek, settings.horizon, settings.def_weight
    cooldown = [0] * len(stateful)
    buffs: list[list[float]] = []  # [force, agilité, PT, tours restants]
    current = 0 if (settings.start_equipped and weapons) else None
    order = sorted(
        range(len(stateful)),
        key=lambda i: (-(stateful[i].tp > 0), -(stateful[i].strength > 0), -(stateful[i].agility > 0), -stateful[i].damage),
    )
    total_damage = total_avoided = 0.0
    for turn in range(horizon):
        tp = leek.tp + int(sum(b[2] for b in buffs if b[3] > 0))
        strength = sum(b[0] for b in buffs if b[3] > 0)
        agility = sum(b[1] for b in buffs if b[3] > 0)
        damage = avoided = 0.0
        for i in order:
            p = stateful[i]
            if not mask[i] or cooldown[i] > 0 or not in_range(p.item, distance, p) or p.item.cost > tp:
                continue
            tp -= p.item.cost
            cooldown[i] = p.item.cooldown if p.item.cooldown > 0 else horizon + 1
            if p.self_buff:
                buffs.append([p.strength, p.agility, p.tp, p.buff_turns])
                tp, strength, agility = tp + int(p.tp), strength + p.strength, agility + p.agility
            damage += p.damage * multiplier(leek, strength, agility) + p.fixed
            avoided += mitigation(p, settings, turn)
        mult = multiplier(leek, strength, agility)
        best = (-1.0, 0.0, 0.0, None, 0.0, 0)
        for spent, wdmg, wfixed, wstrength, wturns, final in weapon_options(weapons, current, distance, tp):
            m_after = multiplier(leek, strength + wstrength, agility)
            chips = table.best(distance, m_after if wstrength else mult, tp - spent)
            dmg = wdmg * mult + wfixed + chips[1]
            score = dmg + w * chips[2]
            if score > best[0]:
                best = (score, dmg, chips[2], final, wstrength, wturns)
        _, dmg, avo, final, wstrength, wturns = best
        damage, avoided, current = damage + dmg, avoided + avo, final
        if wstrength and wturns > 1:
            buffs.append([wstrength, 0.0, 0.0, wturns - 1])  # posé par un tir : actif dès le tour suivant
        for b in buffs:
            b[3] -= 1
        cooldown = [max(0, c - 1) for c in cooldown]
        total_damage += damage
        total_avoided += avoided
    return total_damage / horizon, total_avoided / horizon


def distance_classes(items: Sequence[Item], lo: int, hi: int) -> list[tuple[int, int]]:
    """Distances [lo, hi] regroupées en classes où la disponibilité de TOUS les items est identique : (représentant, poids)."""
    cuts = {lo, hi + 1}
    for it in items:
        for c in (it.min_range, it.max_range + 1):
            if lo < c <= hi:
                cuts.add(c)
    edges = sorted(cuts)
    return [(a, b - a) for a, b in zip(edges, edges[1:])]
