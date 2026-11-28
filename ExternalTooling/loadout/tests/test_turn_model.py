"""Tests du modèle de tour. Lancer : python -m unittest discover -s ExternalTooling/loadout/tests -p "test*.py"

Items synthétiques (aucun appel réseau) : les valeurs sont calculables à la main."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import lw_items as L  # noqa: E402
import turn_model as M  # noqa: E402

LEEK = L.Leek("T", 10, 100, 100, 0, 0, 0, 0, 0, 10, 3, 2, 6, (), ())


def effect(kind, v1, v2=0, turns=0, targets=31, modifiers=0):
    return L.Effect(kind, v1, v2, turns, targets, modifiers)


def weapon(name, cost, dmg, uses=-1, lo=1, hi=8, launch=7, extra=()):
    return L.Item(name, "weapon", 1, cost, lo, hi, 0, uses, (effect(1, dmg), *extra), False, 1, launch)


def chip(name, cost, effects, cooldown=0, uses=-1, lo=0, hi=8):
    return L.Item(name, "chip", 1, cost, lo, hi, cooldown, uses, tuple(effects), False, 1, 7)


def sim(weapons, chips, settings, distance=3, mask=None):
    wp = [M.profile(i, settings.leek, settings.line_factor) for i in weapons]
    cp = [M.profile(i, settings.leek, settings.line_factor) for i in chips]
    stateless = [c for c in cp if not c.item.stateful]
    stateful = [c for c in cp if c.item.stateful]
    table = M.ChipTable(stateless, settings)
    return M.simulate(wp, stateful, table, settings, distance, mask or [True] * len(stateful))


class ProfileTests(unittest.TestCase):
    def test_damage_average_and_multiplier(self):
        p = M.profile(chip("c", 3, [effect(1, 8, 8)]), LEEK)
        self.assertEqual(p.damage, 12)
        self.assertAlmostEqual(M.multiplier(LEEK, 0, 0), 2.0)  # 100 de force, agilité nulle
        self.assertAlmostEqual(M.multiplier(LEEK, 100, 0), 3.0)

    def test_shield_scales_with_resistance(self):
        leek = L.Leek(**{**LEEK.__dict__, "resistance": 50})
        p = M.profile(chip("s", 4, [effect(6, 20, 0, 3, targets=30)]), leek)
        self.assertAlmostEqual(p.absolute_shield, 30)

    def test_line_factor_only_on_restricted_launch(self):
        line = L.Item("l", "weapon", 1, 5, 1, 8, 0, 1, (effect(1, 10),), False, 1, 1)
        self.assertAlmostEqual(M.profile(line, LEEK, 0.5).damage, 5)
        self.assertAlmostEqual(M.profile(weapon("w", 5, 10), LEEK, 0.5).damage, 10)


class SimulationTests(unittest.TestCase):
    settings = M.Settings(LEEK, horizon=1, def_weight=0.5, start_equipped=True)

    def test_single_weapon_uses_all_tp(self):
        # 10 PT, arme à 5 PT, 2 tirs max, 10 de dégâts × 2 : 2 tirs
        damage, _ = sim([weapon("w", 5, 10, uses=2)], [], self.settings)
        self.assertAlmostEqual(damage, 2 * 10 * 2.0)

    def test_first_shot_pays_equip_when_nothing_in_hand(self):
        cold = M.Settings(LEEK, horizon=1, start_equipped=False)
        damage, _ = sim([weapon("w", 5, 10, uses=2)], [], cold)
        self.assertAlmostEqual(damage, 1 * 10 * 2.0)  # 1 PT d'équipement : un seul tir de 5 PT

    def test_out_of_range_weapon_does_nothing(self):
        damage, _ = sim([weapon("w", 5, 10, lo=5, hi=8)], [], self.settings, distance=2)
        self.assertEqual(damage, 0)

    def test_strength_buff_pays_off_over_two_turns(self):
        protein = chip("protein", 3, [effect(38, 100, 0, 2, targets=30)], cooldown=3)
        spark = chip("spark", 3, [effect(1, 10)])
        two = M.Settings(LEEK, horizon=2, start_equipped=True)
        with_buff, _ = sim([], [protein, spark], two)
        without, _ = sim([], [protein, spark], two, mask=[False])
        self.assertGreater(with_buff, without)

    def test_cooldown_limits_a_stateful_chip(self):
        big = chip("big", 2, [effect(1, 50)], cooldown=3)
        two = M.Settings(LEEK, horizon=4, start_equipped=True)
        damage, _ = sim([], [big], two)  # lancé aux tours 1 et 4 seulement
        self.assertAlmostEqual(damage, 2 * 50 * 2.0 / 4)

    def test_absolute_shield_is_a_reservoir(self):
        shield = chip("sh", 4, [effect(6, 20, 0, 3, targets=30)], cooldown=4)
        _, avoided = sim([], [shield], M.Settings(LEEK, horizon=1, def_weight=1.0))
        self.assertAlmostEqual(avoided, 20)  # 20 absorbés une fois, pas 20 × 3 tours

    def test_distance_classes_cover_the_range(self):
        items = [weapon("a", 1, 1, lo=2, hi=4), weapon("b", 1, 1, lo=1, hi=6)]
        classes = M.distance_classes(items, 1, 8)
        self.assertEqual(sum(w for _, w in classes), 8)
        self.assertEqual([d for d, _ in classes], [1, 2, 5, 7])


if __name__ == "__main__":
    unittest.main()
