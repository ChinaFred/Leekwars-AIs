import assert from "node:assert/strict"
import test from "node:test"
import { captureLines, installGlobals, makeTurnWorld } from "./helpers/turn-world.mjs"

// Fichier à part : `Kassbi_test` partage les singletons de `TurnObservation` (mémoire, stagnation, historique) avec
// `Kassbi_Class` s'ils sont importés dans le même processus.
installGlobals()
const { turn } = await import("../dist/Main/Kassbi_test.js")

test("Kassbi_test.turn(): observes the turn, plans with the turn's maps (joint plan) and closes the history", () => {
	const w = makeTurnWorld({ turnNumber: 1 })
	const lines = captureLines(turn)
	const report = lines.join("\n")
	assert.equal(lines.some((text) => text.includes('"level":"ERROR"') || text.includes("fallback")), false, report)
	const index = (part) => lines.findIndex((text) => text.includes(part))
	assert.ok(index("[Reachable] me:25 (3 MP)") >= 0, report)
	assert.ok(index("[Reachable] me:") < index("[Threat] "), report)
	assert.ok(index("[Threat] ") < index("[Tactical] plan before execution"), report)
	assert.deepEqual(w.actions, ["shoot", "shoot"])
	assert.match(lines.at(-1), /\[History\] T1 TP 8\/10 MP 0\/3 dealt 44 taken 0 passive 0 \| machine_gun:1:22; machine_gun:1:22/)

	// Tour suivant : les PV de fin de tour ont été mémorisés (dégâts subis entre-temps dans l'historique).
	const next = makeTurnWorld({ turnNumber: 2 })
	next.me.life = 290
	assert.match(captureLines(turn).at(-1), /\[History\] T2 .* taken 10 /)
})
