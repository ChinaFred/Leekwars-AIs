import assert from "node:assert/strict"
import test from "node:test"

import { Leek } from "../dist/Classes/Leek.js"
import { Coordinates } from "../dist/Classes/Context/Coordinates.js"
import { LeekProfile } from "../dist/Classes/LeekProfile.js"

test("Leek adapter filters unreachable cells and exposes native target actions", () => {
	const start = { id: 1, x: 0, y: 0, empty: false, obstacle: false, entity: null }
	const reachable = { id: 2, x: 1, y: 0, empty: true, obstacle: false, entity: null }
	const unreachable = { id: 3, x: 0, y: 1, empty: true, obstacle: false, entity: null }
	const obstacle = { id: 4, x: -1, y: 0, empty: false, obstacle: true, entity: null }
	const target = { id: 8, name: "target", cell: reachable }
	const weapon = { id: 5, name: "weapon", cost: 1, features: [] }
	const chip = { id: 6, name: "chip", cost: 2, features: [], currentCooldown: 0 }
	let moved = 0
	let shots = 0

	globalThis.Field = {
		pathLength(from, to) {
			if (to === unreachable) return 0
			return from === to ? 0 : 1
		}
	}

	const me = {
		id: 1,
		name: "me",
		life: 50,
		maxLife: 100,
		cell: start,
		mp: 2,
		tp: 3,
		weapon,
		weapons: [weapon],
		chips: [chip],
		setWeapon() { return true },
		moveToward() { moved++; return 1 },
		moveAwayFrom() { return 1 },
		canUseWeapon() { return true },
		useWeapon() { shots++; return 1 },
		canUseChip() { return true },
		useChip() { return 1 },
		chipCells() { return [start] }
	}
	const world = { cells: [start, reachable, unreachable, obstacle], obstacles: [obstacle] }
	const leek = new Leek(me, new LeekProfile(), world)
	leek.setTarget(target)

	assert.deepEqual([...leek.getReachableCells()].map((cell) => cell.id), [1, 2])
	assert.deepEqual(
		[...leek.getReachableCoordinatesFromCell(new Coordinates(start), 2)]
			.map((coordinates) => coordinates.cell.id),
		[1, 2]
	)
	assert.equal(leek.shootOnTarget(), 1)
	assert.equal(leek.canUseWeaponOnTarget(target, 0), false)
	assert.equal(leek.canUseChipOnTarget(chip, target, 1), false)
	assert.equal(leek.canUseChipOnTarget(chip, target, 2), true)
	assert.equal(leek.moveTowardTarget(target), 1)
	assert.equal(moved, 1)
	assert.equal(shots, 1)
})
