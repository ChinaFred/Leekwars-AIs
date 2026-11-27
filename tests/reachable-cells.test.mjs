import assert from "node:assert/strict"
import { makeTurnWorld } from "./helpers/turn-world.mjs"
import test from "node:test"

globalThis.Color = { rgb: () => 0 }
const debugLogs = []
globalThis.Debug = { log: (message) => debugLogs.push(message), pause() {} }
globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4, POISON: 5, BUFF_STRENGTH: 6 }
globalThis.Fight = { turn: 1 }

const { computeReachableCells, ReachableCells, MAX_REACHABLE_CELLS, MOVE_NEIGHBOR_OFFSETS } =
	await import("../dist/Classes/Context/ReachableCells.js")
const { EnemyMemory } = await import("../dist/Classes/Context/EnemyMemory.js")
const { EnemyProfile } = await import("../dist/Classes/Context/EnemyProfile.js")
const { EntityProfile } = await import("../dist/Classes/Context/EntityProfile.js")

/** Nombre de cases à distance de Manhattan <= m dans une grille sans bord : 2m(m+1) + 1. */
const diamond = (m) => 2 * m * (m + 1) + 1

/** Grille mockée [0,width) x [0,height) ; installe `Field.cellFromXY` (null hors grille) et trace les appels. */
function makeGrid(width, height, obstacles = []) {
	const cells = new Map()
	const calls = []
	for (let x = 0; x < width; x++) {
		for (let y = 0; y < height; y++) {
			cells.set(`${x},${y}`, { id: y * width + x, x, y, empty: true, obstacle: false, entity: null })
		}
	}
	for (const [x, y] of obstacles) {
		const cell = cells.get(`${x},${y}`)
		cell.obstacle = true
		cell.empty = false
	}
	globalThis.Field = {
		cellFromXY(x, y) {
			calls.push(`${x},${y}`)
			return cells.get(`${x},${y}`) ?? null
		}
	}
	const grid = {
		cells,
		calls,
		cell: (x, y) => cells.get(`${x},${y}`),
		place(entity, x, y) {
			const cell = cells.get(`${x},${y}`)
			cell.entity = entity
			cell.empty = false
			entity.cell = cell
			return entity
		},
		move(entity, x, y) {
			entity.cell.entity = null
			entity.cell.empty = true
			return grid.place(entity, x, y)
		}
	}
	return grid
}

function makeEntity(id, mp, life = 100) {
	return { id, name: `e${id}`, level: 10, life, maxLife: 100, mp, tp: 10, cell: null, weapons: [], chips: [], effects: [], launchedEffects: [] }
}

const costOf = (reachable, grid, x, y) => reachable.costTo(grid.cell(x, y))

test("the neighbourhood is the 4-connected one, isolated in a single constant", () => {
	assert.deepEqual([...MOVE_NEIGHBOR_OFFSETS].map(([dx, dy]) => `${dx},${dy}`).sort(), ["-1,0", "0,-1", "0,1", "1,0"])
})

test("without obstacles the reachable set is the Manhattan diamond, with cost = Manhattan distance", () => {
	const grid = makeGrid(21, 21)
	const entity = grid.place(makeEntity(1, 3), 10, 10)
	for (const [mp, expected] of [[0, 1], [1, 5], [2, 13], [3, 25]]) {
		const reachable = computeReachableCells(entity, mp, 4)
		assert.equal(reachable.size, expected, `mp=${mp}`)
		assert.equal(reachable.size, diamond(mp))
		assert.equal(reachable.mp, mp)
		assert.equal(reachable.turn, 4)
		assert.equal(reachable.truncated, false)
		for (const { cell, cost } of reachable.entries()) {
			assert.equal(cost, Math.abs(cell.x - 10) + Math.abs(cell.y - 10))
		}
	}
	const three = computeReachableCells(entity, 3, 4)
	assert.equal(costOf(three, grid, 10, 10), 0)
	assert.equal(costOf(three, grid, 11, 10), 1)
	assert.equal(costOf(three, grid, 12, 11), 3)
	assert.equal(three.canReach(grid.cell(13, 10)), true)
	assert.equal(three.canReach(grid.cell(13, 11)), false)
	assert.equal(costOf(three, grid, 13, 11), null)
	assert.equal(three.cells().length, 25)
	assert.equal(three.startCell, entity.cell)
	assert.equal(three.entityId, 1)
})

test("canReach and costTo match by coordinates, not by object identity", () => {
	const grid = makeGrid(9, 9)
	const entity = grid.place(makeEntity(1, 2), 4, 4)
	const reachable = computeReachableCells(entity, 2, 1)
	assert.equal(reachable.canReach({ id: -1, x: 5, y: 5, empty: true, obstacle: false, entity: null }), true)
	assert.equal(reachable.costTo({ id: -1, x: 5, y: 5 }), 2)
})

test("mp 0, negative, NaN or missing gives only the start cell; a fraction is floored", () => {
	const grid = makeGrid(9, 9)
	const entity = grid.place(makeEntity(1, 0), 4, 4)
	for (const mp of [0, -3, Number.NaN, undefined, Number.POSITIVE_INFINITY * -1]) {
		const reachable = computeReachableCells(entity, mp, 1)
		assert.equal(reachable.size, 1)
		assert.equal(reachable.mp, 0)
		assert.equal(reachable.canReach(entity.cell), true)
		assert.equal(reachable.costTo(entity.cell), 0)
	}
	// mp = 0 ne demande aucune case à la grille
	grid.calls.length = 0
	computeReachableCells(entity, 0, 1)
	assert.equal(grid.calls.length, 0)
	assert.equal(computeReachableCells(entity, 2.9, 1).mp, 2)
	assert.equal(computeReachableCells(entity, 2.9, 1).size, 13)
})

test("an obstacle blocks its cell and forces a detour for the cells behind it", () => {
	const grid = makeGrid(21, 21, [[11, 10]])
	const entity = grid.place(makeEntity(1, 4), 10, 10)

	const two = computeReachableCells(entity, 2, 1)
	assert.equal(two.canReach(grid.cell(11, 10)), false)
	// (12,10) était à 2 en ligne droite ; contourné il coûte 4 : hors de portée à mp=2
	assert.equal(two.canReach(grid.cell(12, 10)), false)
	assert.equal(two.size, diamond(2) - 2)

	const four = computeReachableCells(entity, 4, 1)
	assert.equal(costOf(four, grid, 12, 10), 4)
	assert.equal(costOf(four, grid, 11, 11), 2)
	assert.equal(four.canReach(grid.cell(11, 10)), false)
})

test("a closed ring of obstacles leaves only the start cell", () => {
	const grid = makeGrid(9, 9, [[3, 4], [5, 4], [4, 3], [4, 5]])
	const entity = grid.place(makeEntity(1, 6), 4, 4)
	const reachable = computeReachableCells(entity, 6, 1)
	assert.equal(reachable.size, 1)
	assert.equal(reachable.canReach(entity.cell), true)
})

test("another entity (ally or enemy) blocks passage; the start cell is not blocked by the entity itself", () => {
	const grid = makeGrid(21, 21)
	const entity = grid.place(makeEntity(1, 3), 10, 10)
	grid.place(makeEntity(2, 3), 11, 10)
	grid.place(makeEntity(3, 3), 10, 12)

	const reachable = computeReachableCells(entity, 2, 1)
	assert.equal(reachable.canReach(entity.cell), true)
	assert.equal(reachable.canReach(grid.cell(11, 10)), false)
	assert.equal(reachable.canReach(grid.cell(10, 12)), false)
	assert.equal(reachable.canReach(grid.cell(12, 10)), false) // derrière l'entité, coût 4 en contournant
	assert.equal(reachable.canReach(grid.cell(11, 11)), true)
	assert.equal(reachable.size, diamond(2) - 3)
})

test("a cell returned as null by cellFromXY (grid edge) is never reachable", () => {
	const grid = makeGrid(5, 5)
	const entity = grid.place(makeEntity(1, 2), 0, 0)
	const reachable = computeReachableCells(entity, 2, 1)
	assert.deepEqual(
		reachable.cells().map((cell) => `${cell.x},${cell.y}`).sort(),
		["0,0", "0,1", "0,2", "1,0", "1,1", "2,0"]
	)
	assert.equal(reachable.size, 6)
})

test("every coordinate is requested from the grid at most once", () => {
	const grid = makeGrid(21, 21, [[11, 10]])
	const entity = grid.place(makeEntity(1, 5), 10, 10)
	grid.calls.length = 0
	const reachable = computeReachableCells(entity, 5, 1)
	assert.equal(new Set(grid.calls).size, grid.calls.length)
	assert.ok(grid.calls.length <= 4 * reachable.size)
})

test("the safety cap truncates the search, keeping the nearest cells first and flagging the result", () => {
	const grid = makeGrid(80, 80)
	const entity = grid.place(makeEntity(1, 1000), 40, 40)
	grid.calls.length = 0
	const reachable = computeReachableCells(entity, 1000, 1)

	assert.equal(MAX_REACHABLE_CELLS, 500)
	assert.equal(reachable.size, MAX_REACHABLE_CELLS)
	assert.equal(reachable.truncated, true)
	assert.ok(grid.calls.length <= 4 * MAX_REACHABLE_CELLS)

	let previous = 0
	let withinFifteen = 0
	let maxCost = 0
	for (const { cost } of reachable.entries()) {
		assert.ok(cost >= previous, "costs are non-decreasing")
		previous = cost
		maxCost = Math.max(maxCost, cost)
		if (cost <= 15) {
			withinFifteen++
		}
	}
	// diamond(15) = 481 <= 500 < diamond(16) : tout jusqu'au coût 15 est présent, le reste est du coût 16
	assert.equal(withinFifteen, diamond(15))
	assert.equal(maxCost, 16)
})

test("a full search that exactly fits is not flagged as truncated", () => {
	const grid = makeGrid(60, 60)
	const entity = grid.place(makeEntity(1, 15), 30, 30)
	const reachable = computeReachableCells(entity, 15, 1)
	assert.equal(reachable.size, diamond(15))
	assert.equal(reachable.truncated, false)
})

test("the default turn is Fight.turn", () => {
	const grid = makeGrid(9, 9)
	const entity = grid.place(makeEntity(1, 1), 4, 4)
	globalThis.Fight = { turn: 7 }
	try {
		assert.equal(computeReachableCells(entity, 1).turn, 7)
	} finally {
		globalThis.Fight = { turn: 1 }
	}
})

test("isUpToDate compares entity, start cell, sanitized mp and turn", () => {
	const grid = makeGrid(9, 9)
	const entity = grid.place(makeEntity(1, 2), 4, 4)
	const reachable = computeReachableCells(entity, 2, 3)
	assert.equal(reachable instanceof ReachableCells, true)
	assert.equal(reachable.isUpToDate(1, grid.cell(4, 4), 2, 3), true)
	assert.equal(reachable.isUpToDate(1, grid.cell(4, 4), 2.5, 3), true)
	assert.equal(reachable.isUpToDate(2, grid.cell(4, 4), 2, 3), false)
	assert.equal(reachable.isUpToDate(1, grid.cell(5, 4), 2, 3), false)
	assert.equal(reachable.isUpToDate(1, grid.cell(4, 4), 3, 3), false)
	assert.equal(reachable.isUpToDate(1, grid.cell(4, 4), 2, 4), false)
})

// --- profils ---------------------------------------------------------------

function makeScene() {
	const grid = makeGrid(21, 21)
	const me = grid.place({ ...makeEntity(1, 3), strength: 0, wisdom: 0 }, 5, 5)
	const ally = grid.place(makeEntity(5, 2), 5, 7)
	const enemy = grid.place(makeEntity(2, 2), 9, 5)
	return { grid, me, ally, enemy }
}

test("updateReachable fills the profiles of me, an ally and an enemy", () => {
	const { me, ally, enemy } = makeScene()
	const memory = new EnemyMemory()

	const updates = memory.updateReachable(me, [ally], [enemy], 1)

	assert.deepEqual(updates.map((u) => [u.side, u.entityId, u.mp, u.size, u.truncated, u.recomputed]), [
		["me", 1, 3, 23, false, true], // diamant 25 moins l'allié (5,7) et la case (5,8) qu'il masque
		["ally", 5, 2, 12, false, true], // diamant 13 moins moi (5,5)
		["enemy", 2, 2, 13, false, true]
	])
	const mine = memory.getEntityProfile(1)
	assert.equal(mine instanceof EntityProfile, true)
	assert.equal(mine instanceof EnemyProfile, false)
	assert.equal(mine.reachable.size, 23)
	assert.equal(mine.reachableMp, 3)
	assert.equal(mine.reachableTurn, 1)
	assert.equal(memory.getReachable(5).size, 12)
	assert.equal(memory.getReachable(2).size, 13)
	// l'ennemi est identifié au passage : son profil est un EnemyProfile avec les mêmes champs
	const profile = memory.getProfile(2)
	assert.equal(profile instanceof EnemyProfile, true)
	assert.equal(profile.reachable, memory.getReachable(2))
	assert.equal(profile.reachableMp, 2)
	assert.equal(profile.reachableTurn, 1)
	// les profils alliés ne sont pas des profils d'ennemi
	assert.equal(memory.getProfile(5), null)
	assert.equal(memory.getProfile(1), null)
	assert.equal(memory.has(1), false)
	// inconnu
	assert.equal(memory.getReachable(99), null)
	assert.equal(memory.getEntityProfile(99), null)
})

test("I am excluded from the allies list when included, and duplicates are ignored", () => {
	const { me, ally, enemy } = makeScene()
	const memory = new EnemyMemory()
	const updates = memory.updateReachable(me, [me, ally, ally], [enemy, enemy], 1)
	assert.deepEqual(updates.map((u) => u.entityId), [1, 5, 2])
})

test("the reachable set is replaced every turn (one entry per entity) and follows moves", () => {
	const { grid, me, ally, enemy } = makeScene()
	const memory = new EnemyMemory()
	memory.updateReachable(me, [ally], [enemy], 1)
	const first = memory.getReachable(1)
	const profileBefore = memory.getEntityProfile(1)

	grid.move(me, 7, 12)
	memory.updateReachable(me, [ally], [enemy], 2)

	const second = memory.getReachable(1)
	assert.notEqual(second, first)
	assert.equal(second.turn, 2)
	assert.equal(second.startCell.x, 7)
	assert.equal(second.startCell.y, 12)
	assert.equal(memory.getEntityProfile(1), profileBefore) // même profil, `reachable` remplacé
	assert.equal(memory.getReachable(2).turn, 2)
	assert.equal(memory.getReachable(5).turn, 2)
})

test("an identical computation within the same turn is not repeated, a new turn or new mp is", () => {
	const { grid, me, ally, enemy } = makeScene()
	const memory = new EnemyMemory()
	memory.updateReachable(me, [ally], [enemy], 1)
	const before = grid.calls.length
	const kept = memory.getReachable(1)

	const again = memory.updateReachable(me, [ally], [enemy], 1)
	assert.equal(grid.calls.length, before)
	assert.deepEqual(again.map((u) => u.recomputed), [false, false, false])
	assert.equal(memory.getReachable(1), kept)

	me.mp = 2
	const changed = memory.updateReachable(me, [ally], [enemy], 1)
	assert.deepEqual(changed.map((u) => u.recomputed), [true, false, false])
	assert.equal(memory.getReachable(1).mp, 2)

	const next = memory.updateReachable(me, [ally], [enemy], 2)
	assert.deepEqual(next.map((u) => u.recomputed), [true, true, true])
})

test("my mp is the current mp, another entity's mp is the maximum observed", () => {
	const { me, ally, enemy } = makeScene()
	const memory = new EnemyMemory()

	enemy.mp = 3
	ally.mp = 4
	me.mp = 5
	memory.updateReachable(me, [ally], [enemy], 1)
	assert.equal(memory.getReachable(2).mp, 3)
	assert.equal(memory.getReachable(5).mp, 4)
	assert.equal(memory.getReachable(1).mp, 5)

	// PM restants d'un dernier tour (0) ou plus bas : le maximum vu est conservé pour les autres, pas pour moi
	enemy.mp = 0
	ally.mp = 1
	me.mp = 2
	memory.updateReachable(me, [ally], [enemy], 2)
	assert.equal(memory.getReachable(2).mp, 3)
	assert.equal(memory.getEntityProfile(2).reachableMp, 3)
	assert.equal(memory.getEntityProfile(2).maxMpSeen, 3)
	assert.equal(memory.getReachable(5).mp, 4)
	assert.equal(memory.getReachable(1).mp, 2)
	assert.equal(memory.getEntityProfile(1).maxMpSeen, 5)

	enemy.mp = 6
	memory.updateReachable(me, [ally], [enemy], 3)
	assert.equal(memory.getReachable(2).mp, 6)
})

test("a first sight with 0 mp gives only the start cell until a higher value is observed", () => {
	const { me, ally, enemy } = makeScene()
	const memory = new EnemyMemory()
	enemy.mp = 0
	memory.updateReachable(me, [ally], [enemy], 1)
	assert.equal(memory.getReachable(2).size, 1)
	enemy.mp = 3
	memory.updateReachable(me, [ally], [enemy], 2)
	assert.equal(memory.getReachable(2).size, 25)
})

test("dead entities are ignored: allied profile removed, enemy reachable cleared (profile kept)", () => {
	const { me, ally, enemy } = makeScene()
	const memory = new EnemyMemory()
	memory.updateReachable(me, [ally], [enemy], 1)
	assert.notEqual(memory.getEntityProfile(5), null)

	// un allié mort listé par getAllies est ignoré ; un ennemi absent de la liste des vivants perd ses cases
	ally.life = 0
	let updates = memory.updateReachable(me, [ally], [], 2)
	assert.deepEqual(updates.map((u) => u.entityId), [1])
	assert.equal(memory.getEntityProfile(5), null)
	assert.equal(memory.getReachable(5), null)
	assert.equal(memory.getReachable(2), null)
	assert.notEqual(memory.getProfile(2), null)
	assert.equal(memory.getProfile(2).reachableMp, null)
	assert.equal(memory.getProfile(2).reachableTurn, null)

	// un ennemi à 0 PV présent dans la liste est ignoré aussi
	enemy.life = 0
	updates = memory.updateReachable(me, [], [enemy], 3)
	assert.deepEqual(updates.map((u) => u.entityId), [1])
	assert.equal(memory.getReachable(2), null)

	// il revient (PV > 0) : recalculé
	enemy.life = 50
	enemy.mp = 2
	memory.updateReachable(me, [], [enemy], 4)
	assert.equal(memory.getReachable(2).turn, 4)
})

test("existing EnemyProfile data is unchanged by the base class refactoring", () => {
	const { enemy } = makeScene()
	const profile = new EnemyProfile({ ...enemy, strength: 1, agility: 2, wisdom: 3, resistance: 4, science: 5, magic: 6 }, 9)
	assert.equal(profile instanceof EntityProfile, true)
	assert.equal(profile.id, 2)
	assert.equal(profile.name, "e2")
	assert.equal(profile.level, 10)
	assert.equal(profile.identifiedTurn, 9)
	assert.equal(profile.lastTurn, 9)
	assert.equal(profile.reachable, null)
	assert.equal(profile.reachableMp, null)
	assert.equal(profile.reachableTurn, null)
})

// --- intégration dans turn() ----------------------------------------------

/** Monde jouable par les plans actuels (`helpers/turn-world.mjs`) sur la grille de ce fichier : alliée en (5,7). */
function makeCombatWorld(ids) {
	const grid = makeGrid(21, 21)
	const world = makeTurnWorld({
		turnNumber: 1, grid, enemyId: ids.enemy, enemyAt: [9, 5], enemyMp: 2, enemyTp: 5,
		enemyWeapon: { id: 90, name: "enemy gun", cost: 3, minRange: 0, maxRange: 3, features: [] },
		ally: makeEntity(ids.ally, 2)
	})
	return { ...world, grid }
}

/** Tirs effectués : le plan a joué (deux tirs à 4 PT sur 10 PT), quel que soit le plan retenu pour le reste. */
const shots = (actions) => actions.filter((action) => action === "shoot").length

async function runTurnCapturingLogs(turn) {
	const lines = []
	const original = console.log
	console.log = (...args) => lines.push(args.join(" "))
	try {
		turn()
	} finally {
		console.log = original
	}
	return lines
}

test("turn() computes the reachable cells of me, my ally and the enemy, logs one short line, and the plan fires", async () => {
	const { turn, leekProfile } = await import("../dist/Main/Kassbi_Class.js")
	const { enemyMemory } = await import("../dist/Brain/TurnObservation.js")
	// Scénario écrit pour les seuils BALANCED (soin, bouclier) ; le rôle par défaut réel est vérifié dans strength-boost-turn.test.mjs.
	leekProfile.setRole("BALANCED")
	const { actions } = makeCombatWorld({ enemy: 20, ally: 21 })
	debugLogs.length = 0

	const lines = await runTurnCapturingLogs(turn)

	assert.equal(shots(actions), 2)
	assert.equal(enemyMemory.getReachable(1).size, 23)
	assert.equal(enemyMemory.getReachable(21).size, 12)
	assert.equal(enemyMemory.getReachable(20).size, 13)
	assert.equal(enemyMemory.getEntityProfile(1).reachableTurn, 1)
	const reachableLines = lines.filter((line) => line.startsWith("[Reachable]"))
	assert.equal(reachableLines.length, 1)
	assert.equal(reachableLines[0], "[Reachable] me:23 (3 MP), ally#21:12 (2 MP), enemy#20:13 (2 MP)")
	assert.equal(debugLogs.some((entry) => entry.includes("observeReachableCells")), false)
})

test("turn() still plays when the reachable-cells computation fails, and reports the error", async () => {
	const { turn, leekProfile } = await import("../dist/Main/Kassbi_Class.js")
	const { enemyMemory } = await import("../dist/Brain/TurnObservation.js")
	// Scénario écrit pour les seuils BALANCED (soin, bouclier) ; le rôle par défaut réel est vérifié dans strength-boost-turn.test.mjs.
	leekProfile.setRole("BALANCED")
	const { actions } = makeCombatWorld({ enemy: 30, ally: 31 })
	globalThis.Field = { cellFromXY() { throw new Error("grid down") } }
	debugLogs.length = 0

	await runTurnCapturingLogs(turn)

	assert.equal(shots(actions), 2)
	assert.equal(enemyMemory.has(30), true) // observeEnemies a quand même fonctionné
	assert.equal(debugLogs.some((entry) => entry.includes("observeReachableCells") && entry.includes("grid down")), true)
})

test("turn() logs the operations line after TURN END, and still works when System is undefined", async () => {
	const { turn, leekProfile } = await import("../dist/Main/Kassbi_Class.js")
	// Scénario écrit pour les seuils BALANCED (soin, bouclier) ; le rôle par défaut réel est vérifié dans strength-boost-turn.test.mjs.
	leekProfile.setRole("BALANCED")

	makeCombatWorld({ enemy: 50, ally: 51 })
	assert.equal(typeof globalThis.System, "undefined")
	const withoutSystem = await runTurnCapturingLogs(turn)
	assert.equal(withoutSystem.at(-1), "Operations: 0/0 (0.0%)")

	globalThis.System = { operations: 1234567, maxOperations: 20000000 }
	try {
		const { actions } = makeCombatWorld({ enemy: 52, ally: 53 })
		const lines = await runTurnCapturingLogs(turn)
		const endIndex = lines.findIndex((line) => line.includes("=== KASSBI TURN END ==="))
		const operationsIndex = lines.findIndex((line) => line.startsWith("Operations:"))
		assert.notEqual(endIndex, -1)
		assert.equal(operationsIndex, endIndex + 1)
		assert.equal(operationsIndex, lines.length - 1)
		assert.equal(lines[operationsIndex], "Operations: 1234567/20000000 (6.2%)")
		assert.equal(shots(actions), 2)
	} finally {
		delete globalThis.System
	}
})

test("turn() still fires when a ring of obstacles leaves me no reachable cell but my own", async () => {
	const { turn, leekProfile } = await import("../dist/Main/Kassbi_Class.js")
	// Scénario écrit pour les seuils BALANCED (soin, bouclier) ; le rôle par défaut réel est vérifié dans strength-boost-turn.test.mjs.
	leekProfile.setRole("BALANCED")
	const { actions, grid } = makeCombatWorld({ enemy: 40, ally: 41 })
	for (const [x, y] of [[4, 5], [6, 5], [5, 4], [5, 6]]) {
		grid.cell(x, y).obstacle = true
	}
	await runTurnCapturingLogs(turn)
	assert.equal(shots(actions), 2)
})
