import assert from "node:assert/strict"
import test from "node:test"

const colors = []
globalThis.Color = {
	rgb: (red, green, blue) => {
		const color = (red << 16) | (green << 8) | blue
		colors.push(color)
		return color
	}
}

const logs = []
let pauses = 0
globalThis.Debug = {
	log: (...args) => logs.push(args),
	pause: () => { pauses++ }
}
globalThis.System = { operations: 10, maxOperations: 100 }
globalThis.Effect = { DAMAGE: 1 }
globalThis.Fight = {
	turn: 3,
	me: { id: 7, name: "Kassbi", level: 40, strength: 100 }
}

const constants = await import("../dist/Toolbox/Constants.js")
const debug = await import("../dist/Toolbox/Debug.js")
const computations = await import("../dist/Toolbox/Computations.js")
const speeches = await import("../dist/Toolbox/Speeches.js")

test("combat computations retain damage, shield, and field-boundary rules", () => {
	const actor = { strength: 100 }
	const target = { agility: 50, absoluteShield: 2, relativeShield: 20 }
	const gear = {
		features: [{ type: 1, minValue: 4, maxValue: 8 }]
	}

	assert.equal(computations.getDamagesFromEffect(gear.features), 10)
	assert.equal(computations.computePossibleDealtDamages(actor, target, gear), 13)
	assert.equal(computations.getAbsoluteShield(target), 2)
	assert.equal(computations.isInsideWorld(17, 0), true)
	assert.equal(computations.isInsideWorld(17, 1), false)
})

test("debug helpers report operation use and preserve debug color constants", () => {
	assert.equal(constants.COLORS.DEBUG, colors.at(-1))

	debug.DEBUGS.OPERATIONS = true
	const operations = new debug.Operations("planner", true)
	globalThis.System.operations = 40
	operations.debugOperations()
	debug.DEBUGS.OPERATIONS = false

	assert.equal(logs.length, 2)
	assert.match(logs[0][0], /planner - # Operations: 30/)
	assert.match(logs[1][0], /40\/100 \(40%\)/)
	assert.equal(pauses, 1)

	const beforeTurn = logs.length
	debug.debugBeginTurn()
	debug.debugEndTurn()
	assert.equal(logs.length - beforeTurn, 7)
})

test("error reporting logs structured context and rethrows the original error", () => {
	const failure = new TypeError("broken target")
	assert.throws(
		() => debug.withErrorReporting("src/Brain/PlanActScenario.ts", "planAct", () => {
			throw failure
		}),
		(error) => error === failure
	)

	const report = JSON.parse(logs.at(-1)[0])
	assert.deepEqual(
		{
			level: report.level,
			file: report.file,
			function: report.function,
			name: report.error.name,
			message: report.error.message
		},
		{
			level: "ERROR",
			file: "src/Brain/PlanActScenario.ts",
			function: "planAct",
			name: "TypeError",
			message: "broken target"
		}
	)
	assert.match(report.error.stack, /TypeError: broken target/)
})

test("speech selection is deterministic for the supplied random value and rejects invalid input", () => {
	const originalRandom = Math.random
	Math.random = () => 0.99
	try {
		assert.equal(speeches.getRandomMessage(speeches.SPEECH.RIP), speeches.SPEECH_RIP.at(-1))
		assert.throws(() => speeches.getRandomMessage(99), RangeError)
		assert.throws(() => speeches.getRandomMessageFromArr([]), RangeError)
	} finally {
		Math.random = originalRandom
	}
})
