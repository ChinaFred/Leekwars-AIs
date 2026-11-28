import assert from "node:assert/strict"
import test from "node:test"
import { captureLines, installGlobals, makeTurnWorld } from "./helpers/turn-world.mjs"

installGlobals()
const { turn } = await import("../dist/Main/Kassbi_Book.js")
const { observeTurn, stagnation } = await import("../dist/Brain/TurnObservation.js")

const errors = (lines) => lines.filter((text) => text.includes('"level":"ERROR"'))

test("a failing greeting or leek-life say (me.say) is reported and the turn still observes, plans and shoots", () => {
	// Premier tour du module : salutation. Chaque tour : récit du poireau avec les PT restants.
	const silent = makeTurnWorld({ turnNumber: 1, say: () => { throw new Error("say exploded") } })
	const first = captureLines(turn)
	assert.equal(errors(first).filter((text) => text.includes('"function":"greeting"')).length, 1, first.join("\n"))
	assert.match(errors(first)[0], /"function":"greeting".*say exploded/)
	assert.ok(first.some((text) => text.includes("[Reachable] me:")))
	assert.ok(first.some((text) => text.includes("[Tactical] plan before execution")))
	assert.deepEqual(silent.actions, ["shoot", "shoot"])

	const second = makeTurnWorld({ turnNumber: 2, say: () => { throw new Error("say exploded") } })
	const lines = captureLines(turn)
	assert.equal(errors(lines).length, 1, lines.join("\n"))
	assert.match(errors(lines)[0], /"function":"tellLeekLife".*say exploded/)
	assert.deepEqual(second.actions, ["shoot", "shoot"])
	assert.ok(lines.some((text) => text.includes("=== KASSBI BOOK TURN END ===")))
})

test("end of turn: one leek-life say per unspent TP, at most 2 says a turn, resuming at the next line", async () => {
	const { SPEECH_LEEK_LIFE } = await import("../dist/Toolbox/Speeches.js")
	const play = (turnNumber) => {
		const said = []
		const w = makeTurnWorld({ turnNumber, say: (message) => { said.push(message) } })
		captureLines(turn)
		return { said, tp: w.me.tp }
	}
	const index = (message) => SPEECH_LEEK_LIFE.indexOf(message)

	play(9) // consomme la salutation du premier tour
	// 2 PT non utilisés (10 - 2 tirs de 4) : 2 lignes du récit.
	const first = play(10)
	assert.equal(first.tp, 2)
	assert.equal(first.said.length, 2)
	assert.ok(first.said.every((message) => index(message) >= 0))

	const second = play(11)
	assert.equal(second.said.length, 2)
	assert.equal(index(second.said[0]), (index(first.said[1]) + 1) % SPEECH_LEEK_LIFE.length)
	assert.equal(index(second.said[1]), (index(second.said[0]) + 1) % SPEECH_LEEK_LIFE.length)
})

test("an error in the stagnation update is reported and the action history of the turn is still opened and closed", () => {
	const w = makeTurnWorld({ turnNumber: 3 })
	const observe = stagnation.observe
	stagnation.observe = () => { throw new Error("stagnation exploded") }
	let lines
	try {
		lines = captureLines(turn)
	} finally {
		stagnation.observe = observe
	}
	assert.equal(errors(lines).length, 1, lines.join("\n"))
	assert.match(errors(lines)[0], /"function":"observeStagnation".*stagnation exploded/)
	assert.deepEqual(w.actions, ["shoot", "shoot"])
	const history = lines.find((text) => text.includes("[History] T3 "))
	assert.match(history ?? "", /TP 8\/10 MP 0\/3 dealt 44 .*\| machine_gun:1:22; machine_gun:1:22/)
})

test("observeTurn asks the game for the living enemies once", () => {
	const w = makeTurnWorld({ turnNumber: 4 })
	captureLines(() => observeTurn(w.me))
	assert.equal(w.calls.aliveEnemies, 1)
})

test("no living enemy: the stagnation update gets an infinite distance and counts a turn without progress, no error", () => {
	const w = makeTurnWorld({ turnNumber: 5 })
	captureLines(() => observeTurn(w.me))
	w.enemy.life = 0
	Fight.turn = 6
	const lines = captureLines(() => observeTurn(w.me))
	assert.deepEqual(errors(lines), [])
	// PV ennemis en baisse (mort) : compteur remis à zéro, record de proximité à +∞.
	assert.equal(stagnation.turns, 0)
	Fight.turn = 7
	assert.deepEqual(errors(captureLines(() => observeTurn(w.me))), [])
	assert.equal(stagnation.turns, 1)
	assert.equal(stagnation.beatsRecord(1000), true)
})
