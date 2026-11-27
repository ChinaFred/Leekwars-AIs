import assert from "node:assert/strict"
import test from "node:test"
import { captureLines, installGlobals, makeTurnWorld } from "./helpers/turn-world.mjs"

installGlobals()
const { turn } = await import("../dist/Main/Kassbi_Class.js")
const { observeTurn, refreshMaps, stagnation } = await import("../dist/Brain/TurnObservation.js")

const errors = (lines) => lines.filter((text) => text.includes('"level":"ERROR"'))

test("a failing greeting or taunt (me.say) is reported and the turn still observes, plans and shoots", () => {
	// Premier tour du module : salutation. Ennemi à 10 % de PV : provocation aux tours suivants.
	const silent = makeTurnWorld({ turnNumber: 1, enemyLife: 30, say: () => { throw new Error("say exploded") } })
	const first = captureLines(turn)
	assert.equal(errors(first).filter((text) => text.includes('"function":"announceTurn"')).length, 1, first.join("\n"))
	assert.match(errors(first)[0], /"function":"announceTurn".*say exploded/)
	assert.ok(first.some((text) => text.includes("[Reachable] me:")))
	assert.ok(first.some((text) => text.includes("[Tactical] plan before execution")))
	assert.deepEqual(silent.actions, ["shoot", "shoot"])

	const taunted = makeTurnWorld({ turnNumber: 2, enemyLife: 30, say: () => { throw new Error("say exploded") } })
	const second = captureLines(turn)
	assert.match(errors(second)[0] ?? "", /"function":"announceTurn".*say exploded/)
	assert.deepEqual(taunted.actions, ["shoot", "shoot"])
	assert.ok(second.some((text) => text.includes("=== KASSBI TURN END ===")))
})

test("end of turn: one leek-life say per unspent TP, at most 2 says a turn, resuming at the next line", async () => {
	const { SPEECH_LEEK_LIFE } = await import("../dist/Toolbox/Speeches.js")
	const play = (turnNumber, enemyLife) => {
		const said = []
		const w = makeTurnWorld({ turnNumber, enemyLife, say: (message) => { said.push(message) } })
		captureLines(turn)
		return { said, tp: w.me.tp }
	}
	const lifeLines = (said) => said.filter((message) => SPEECH_LEEK_LIFE.includes(message))
	const index = (message) => SPEECH_LEEK_LIFE.indexOf(message)

	play(9, 300) // consomme la salutation du premier tour
	// 2 PT non utilisés (10 - 2 tirs de 4) ; la provocation (ennemi à 10 % de PV) compte dans la limite de 2.
	const first = play(10, 30)
	assert.equal(first.tp, 2)
	assert.equal(first.said.length, 2)
	const taunted = lifeLines(first.said)
	assert.equal(taunted.length, 1)

	const second = play(11, 300)
	const lines = lifeLines(second.said)
	assert.equal(lines.length, 2)
	assert.equal(index(lines[0]), (index(taunted[0]) + 1) % SPEECH_LEEK_LIFE.length)
	assert.equal(index(lines[1]), (index(lines[0]) + 1) % SPEECH_LEEK_LIFE.length)
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

test("observeTurn and refreshMaps each ask the game for the living enemies once", () => {
	const w = makeTurnWorld({ turnNumber: 4 })
	captureLines(() => observeTurn(w.me))
	assert.equal(w.calls.aliveEnemies, 1)
	w.calls.aliveEnemies = 0
	captureLines(() => refreshMaps(w.me))
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
