import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import FightArchive
import FightSummary


class SummaryTests(unittest.TestCase):
    def test_summary_counts_outcomes_and_operation_peaks_per_version(self):
        with tempfile.TemporaryDirectory() as data:
            FightArchive.record_publication(
                data, "me",
                {"commit": "a" * 40, "committed_at": 1, "subject": "feat: x",
                 "message": "feat: x\n\nStratégie: repli à 30 %", "dirty": False, "dirty_files": []},
                "ab" * 20, {"updated": 1}, now=100)
            logs = {1: ["Operations: 100/1000 (10.0%)", "Scan - # Operations: 999"],
                    2: [[0, "Operations: 850/1000 (85.0%)"]]}
            for fight_id, winner in ((1, 1), (2, 2)):
                folder = os.path.join(data, "fights", str(fight_id))
                FightArchive._write_json(os.path.join(folder, "fight.json"), {
                    "id": fight_id, "date": 200, "winner": winner, "report": {"duration": 9},
                    "farmers1": {"7": {}}, "farmers2": {"8": {}},
                    "leeks1": [{"name": "Kassbi"}], "leeks2": [{"name": "Rival"}]})
                FightArchive._write_json(os.path.join(folder, "logs.json"), logs[fight_id])
                FightArchive._write_json(os.path.join(folder, "meta.json"), {
                    "fight_id": fight_id, "date": 200, "account": "me", "farmer_id": 7,
                    "logs_status": "ok"})

            with open(FightSummary.write_summary(data), encoding="utf-8") as infile:
                text = infile.read()

        self.assertIn("Stratégie : repli à 30 %", text)
        self.assertIn("2 — 1 victoires, 1 défaites, 0 nuls (50 % de victoires)", text)
        self.assertIn("pic maximal 85 % (combat 2), médiane des pics 48 %", text)
        self.assertIn("- 2 : 9 tours · vs Rival · pic ops 85 %", text)


class TimelineTests(unittest.TestCase):
    def test_turns_report_distance_unused_resources_and_questionable_retreat(self):
        fight = {"data": {
            "leeks": [{"id": 0, "farmer": 7, "team": 1, "name": "Kassbi", "cellPos": 35},
                      {"id": 1, "farmer": 8, "team": 2, "name": "Rival", "cellPos": 125}],
            "actions": [
                [0],
                [7, 0], [10, 0, 71, [53, 71]], [16, 125, 1], [101, 1, 40, 0], [8, 0, 10, 5],
                [7, 1], [10, 1, 143, [143]], [8, 1, 10, 4],
                [6, 2],
                [7, 0], [10, 0, 53, [53]], [8, 0, 10, 5],
            ]}}
        logs = {"7": {"1": [[0, 1, "Enemy: Rival, HP: 1/1, Distance: 5"], [0, 4, [35], "ff", 1]],
                      "5": [[0, 1, "=== KASSBI TURN END ==="], [0, 1, "Operations: 50/100 (50.0%)"]]}}

        first, second = FightSummary.timeline(fight, logs, 7)

        self.assertEqual((first["distance_start"], first["distance_end"]), (5, 3))
        self.assertEqual((first["mp_used"], first["mp_total"], first["shots"], first["dealt"]),
                         (2, 5, 1, 40))
        self.assertEqual((first["flags"], first["operations"]), (["PM inutilisés"], 50.0))
        self.assertEqual(first["logs"], ["Enemy: Rival, HP: 1/1, Distance: 5"])
        self.assertEqual(second["enemy_shift"], 1)
        self.assertEqual(second["flags"], ["aucune action payante : PT tous perdus", "PM inutilisés",
                                           "recule alors que l'ennemi s'éloignait"])


if __name__ == "__main__":
    unittest.main()
