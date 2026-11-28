import assert from "node:assert/strict"
import test from "node:test"

globalThis.Color = { rgb: () => 0 }
globalThis.Debug = { log() {}, pause() {} }

// Paroles partagées par `Kassbi_Class` et `Kassbi_Book` : salutation au premier tour, récit avec les PT restants.
const { greetOnce, startTurnSpeech, tellLeekLife } = await import("../dist/Brain/TurnSpeech.js")

const makeMe = (tp) => ({ tp, said: [], say(message) { this.said.push(message) } })

test("greets once, then tells the leek life with the unused TP within 2 says per turn", () => {
	startTurnSpeech()
	const first = makeMe(5)
	assert.equal(greetOnce(first), true)
	tellLeekLife(first)
	assert.equal(first.said.length, 2, "greeting + 1 line (2 says max)")

	startTurnSpeech()
	const second = makeMe(5)
	assert.equal(greetOnce(second), false)
	tellLeekLife(second)
	assert.equal(second.said.length, 2)

	startTurnSpeech()
	const noTp = makeMe(0)
	tellLeekLife(noTp)
	assert.equal(noTp.said.length, 0, "no TP left: nothing said")
})
