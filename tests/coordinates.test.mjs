import assert from "node:assert/strict"
import test from "node:test"

import { Coordinates } from "../dist/Classes/Context/Coordinates.js"

const originCell = { id: 0, x: 0, y: 0, empty: true, obstacle: false, entity: null }
const nearCell = { id: 1, x: 1, y: 0, empty: true, obstacle: false, entity: null }
const farCell = { id: 2, x: 0, y: 2, empty: true, obstacle: false, entity: null }
const obstacleCell = { id: 3, x: 0, y: 3, empty: false, obstacle: true, entity: null }
const cells = new Map([
	["0,0", originCell],
	["1,0", nearCell],
	["0,2", farCell],
	["0,3", obstacleCell]
])

globalThis.Field = {
	cellFromXY(x, y) {
		return cells.get(`${x},${y}`) ?? null
	},
	getObstacles() {
		return [obstacleCell]
	},
	distance(from, to) {
		return Math.abs(from.x - to.x) + Math.abs(from.y - to.y)
	},
	pathLength(from, to) {
		if (to === obstacleCell) {
			return null
		}
		return Math.abs(from.x - to.x) + Math.abs(from.y - to.y)
	}
}

globalThis.Debug = {
	mark() {}
}

test("coordinates adapt native cells and Field distance methods", () => {
	const origin = new Coordinates(0, 0)
	const near = new Coordinates(nearCell)
	const far = new Coordinates(0, 2)

	assert.equal(origin.cell, originCell)
	assert.equal(origin.getDistance(near), 1)
	assert.equal(origin.getPathLength(far), 2)
	assert.equal(Coordinates.getClosestCellFromSet(origin, [far, near]), near)
	assert.equal(
		Coordinates.getFurthestCellFromSet(origin, [near, far, new Coordinates(obstacleCell)]),
		far
	)
})

test("coordinates reject distance operations for off-field positions", () => {
	const outside = new Coordinates(20, 20)

	assert.throws(() => outside.getDistance(new Coordinates(originCell)), RangeError)
})
