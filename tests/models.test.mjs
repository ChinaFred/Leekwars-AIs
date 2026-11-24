import assert from "node:assert/strict"
import test from "node:test"

import { DangerInfo } from "../dist/Classes/Context/DangerInfo.js"
import { copyArray } from "../dist/Toolbox/Helpers.js"

test("copyArray returns a shallow copy", () => {
	const item = { id: 1 }
	const original = [item]
	const copy = copyArray(original)

	assert.notEqual(copy, original)
	assert.equal(copy[0], item)
})

test("DangerInfo preserves defaults and adds only weights", () => {
	const first = new DangerInfo(4, 12, 3, 5, 2)
	const second = new DangerInfo(9, 8, 7, 11, 6)

	assert.deepEqual({ ...new DangerInfo(1) }, {
		key: 1,
		weight: 0,
		distance: 0,
		pathLength: 0,
		distanceToObstacle: 10_000
	})
	assert.deepEqual({ ...first.add(first, second) }, {
		key: 4,
		weight: 20,
		distance: 3,
		pathLength: 5,
		distanceToObstacle: 2
	})
})
