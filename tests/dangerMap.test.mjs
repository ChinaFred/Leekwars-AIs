import assert from "node:assert/strict"
import test from "node:test"

import {
	DANGER,
	DANGER_COMPARISON,
	DangerMap
} from "../dist/Classes/Context/DangerMap.js"

test("danger map initializes cells and accumulates weapon threats", () => {
	const dangerMap = new DangerMap()
	dangerMap.initialize([-1, 1, 2, 3])
	dangerMap.buildDangerMap([
		{ cells: [1, 2], meanDamage: 14 },
		{ cells: [2], meanDamage: 6 }
	])

	assert.equal(dangerMap.map.size, 3)
	assert.equal(dangerMap.map.get(1).weight, DANGER.INITIAL_DANGER + 14)
	assert.equal(dangerMap.map.get(2).weight, DANGER.INITIAL_DANGER + 20)
	assert.equal(dangerMap.maxDamage, 14)
	assert.deepEqual(
		[...dangerMap.getCellsFromWeight(DANGER.INITIAL_DANGER + 14, DANGER_COMPARISON.SUP_OR_EQUAL)],
		[1, 2]
	)
	assert.deepEqual(
		[...dangerMap.getCellsFromWeight(DANGER.INITIAL_DANGER + 14, DANGER_COMPARISON.SUP)],
		[2]
	)
})

test("danger map chooses the furthest safe cell and excludes obstacles", () => {
	const dangerMap = new DangerMap()
	dangerMap.initialize([1, 2, 3, 4])
	dangerMap.buildDangerMap([{ cells: [1], meanDamage: 25 }])
	const distances = new Map([[1, 1], [2, 2], [3, 3], [4, 4]])
	const pathLength = (_from, to) => distances.get(to)

	assert.equal(dangerMap.getPlaceToHide([1, 2, 3, 4], 1, pathLength, [4]), 3)
})

test("danger map falls back to the furthest cell at minimum danger", () => {
	const dangerMap = new DangerMap()
	dangerMap.initialize([1, 2, 3])
	dangerMap.buildDangerMap([
		{ cells: [1, 2, 3], meanDamage: 10 }
	])
	const distances = new Map([[1, 1], [2, 2], [3, 3]])

	assert.equal(dangerMap.getPlaceToHide([1, 2, 3], 1, (_from, to) => distances.get(to)), 3)
})

test("danger map ignores duplicate and empty threat cells and inaccessible paths", () => {
	const dangerMap = new DangerMap()
	dangerMap.initialize([1, 2, 3])
	dangerMap.buildDangerMap([
		{ cells: [1, 1], meanDamage: 20 },
		{ cells: [], meanDamage: 100 }
	])
	const info = dangerMap.map.get(1)

	assert.equal(info.weight, DANGER.INITIAL_DANGER + 20)
	assert.equal(dangerMap.maxDamage, 20)
	assert.equal(
		dangerMap.getFurthestLessDangerous(1, [1, 2, 3], (_from, to) => to === 3 ? 1 : null),
		3
	)
})
