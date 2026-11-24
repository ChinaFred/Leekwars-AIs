import assert from "node:assert/strict"
import test from "node:test"

import { World } from "../dist/Classes/Context/World.js"

const enemies = [{ id: 1, name: "enemy", cell: null }]
const allies = [{ id: 2, name: "ally", cell: null }]
const obstacle = { id: 1, x: 1, y: 0, empty: false, obstacle: true, entity: null }
const center = { id: 0, x: 0, y: 0, empty: true, obstacle: false, entity: null }

globalThis.Fight = {
	me: {},
	getNearestEnemy: () => enemies[0],
	getEnemies: () => enemies,
	getAliveEnemies: () => enemies,
	getAllies: () => allies
}

globalThis.Field = {
	cellFromXY(x, y) {
		if (x === 0 && y === 0) return center
		if (x === 1 && y === 0) return obstacle
		return null
	},
	getObstacles: () => [obstacle],
	distance: () => 0,
	pathLength: () => 0
}

test("world delegates combat entities and filters the field's cells", () => {
	const world = new World()

	assert.equal(world.enemies, enemies)
	assert.equal(world.aliveEnemies, enemies)
	assert.equal(world.allies, allies)
	assert.deepEqual(world.cells, [center, obstacle])
	assert.deepEqual(world.obstacles, [obstacle])
	assert.deepEqual(world.cellsWithoutObstacles, [center])
	assert.deepEqual(world.getEnemiesById(1), enemies)
	assert.deepEqual(world.getEnemiesById(9), [])
})
