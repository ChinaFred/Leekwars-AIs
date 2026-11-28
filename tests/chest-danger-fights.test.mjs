import assert from "node:assert/strict"
import test from "node:test"

globalThis.Effect = { DAMAGE: 1, HEAL: 2, BUFF_STRENGTH: 3, BUFF_AGILITY: 4, RELATIVE_SHIELD: 5, ABSOLUTE_SHIELD: 6, BUFF_MP: 7, BUFF_TP: 8, RAW_BUFF_TP: 32, RAW_BUFF_STRENGTH: 38 }
globalThis.Color = { rgb: () => 0 }
globalThis.Debug = { log() {}, pause() {} }
globalThis.Chest = class {}
const { planBeam } = await import("../dist/Classes/Plannification/BookPlanner.js")
const { evaluateTacticalPlans } = await import("../dist/Classes/Plannification/TacticalPlanner.js")
const { chestDangerOf, CHEST_REACH, CHEST_FLAT_DANGER } = await import("../dist/Classes/Context/ChestDanger.js")
const { resetBookCache } = await import("../dist/Classes/Plannification/BookCatalog.js")
const { computeReachableCells } = await import("../dist/Classes/Context/ReachableCells.js")
const { buildThreatMap } = await import("../dist/Classes/Context/ThreatMap.js")
const { EnemyMemory } = await import("../dist/Classes/Context/EnemyMemory.js")
const { aliveEnemies, nearestEnemy } = await import("../dist/Classes/Context/Targets.js")
const { observeTurn, enemyMemory } = await import("../dist/Brain/TurnObservation.js")
const { LeekProfile } = await import("../dist/Classes/LeekProfile.js")
const { initLeekLogging, LogConfig } = await import("../dist/Toolbox/Logger.js")

const config = new LogConfig(); config.setAll(false); initLeekLogging(config)

// Rejeux des tours où le coffre (iron_chest, force 1000, un coup tue Kassbi : 396 PV) a tué Kassbi :
//  - 55005891, tour 2 : Kassbi finit en 551, à 2 cases du coffre (517) ; tué par un coup de l'entité 2 ;
//  - 55005881, tour 4 : Kassbi finit en 358, à 7 cases du coffre (478), coffre intact à la décision ; l'ennemi le blesse puis il tue.
// Carte 18 x 18, obstacles, positions : fight.json (LWGarden/Data/fights/<id>). Zone atteignable et danger du jeu (ennemi seul, le
// jeu ignorait le coffre) : marques de logs.json ; 86,4 et 82,8 des lignes [Book]. Chip 14 de Kassbi : inconnue, omise.
const WIDTH = 18, HEIGHT = 18
const FIGHTS = {
	55005891: { turn: 2, me: 479, enemy: 416, enemyLife: 316, enemyMp: 3, chest: 517, chestLife: 4903, chestMax: 4995, played: 551,
		obstacles: { 2: 2, 3: 1, 10: 1, 18: 1, 31: 2, 33: 1, 50: 2, 65: 1, 71: 1, 75: 2, 77: 1, 78: 1, 95: 1, 98: 2, 100: 1, 123: 2, 126: 2,
			134: 2, 137: 1, 142: 1, 175: 1, 179: 1, 188: 2, 201: 1, 214: 2, 217: 1, 230: 1, 234: 1, 243: 1, 251: 1, 267: 1, 272: 1, 275: 1, 290: 1,
			295: 2, 303: 1, 314: 1, 318: 1, 341: 1, 353: 1, 383: 1, 387: 2, 397: 1, 407: 2, 411: 1, 412: 2, 414: 2, 428: 2, 434: 2, 489: 1, 491: 1,
			495: 1, 496: 1, 527: 2, 530: 2, 531: 1, 552: 1, 572: 2, 592: 1, 608: 1, 609: 1 },
		danger: { 0: [479, 461, 514, 443, 478, 444, 460, 426, 549, 477, 408, 409, 566, 459, 494, 390, 391],
			86.4: [497, 462, 515, 480, 533, 532, 498, 427, 551, 550, 516, 410, 569, 568, 534, 567, 392, 393], 126: [481, 499, 464] } },
	55005881: { turn: 4, me: 286, enemy: 536, enemyLife: 296, enemyMp: 3, chest: 478, chestLife: 5000, chestMax: 5000, played: 358,
		obstacles: { 34: 1, 45: 2, 51: 1, 54: 2, 87: 1, 100: 2, 101: 1, 120: 1, 124: 2, 158: 1, 165: 1, 175: 1, 185: 1, 186: 2, 200: 2, 207: 1,
			210: 1, 222: 2, 225: 1, 248: 2, 252: 2, 256: 1, 275: 1, 279: 1, 289: 1, 291: 2, 311: 2, 312: 1, 339: 2, 345: 1, 350: 1, 364: 2, 422: 1,
			425: 2, 429: 2, 457: 2, 466: 1, 467: 1, 487: 2, 498: 2, 512: 2, 523: 1, 540: 2, 552: 1, 563: 1, 570: 1, 571: 1, 580: 1, 584: 1, 605: 1,
			606: 1, 608: 1 },
		danger: { 0: [286, 268, 250, 285, 251, 232, 267, 233, 234, 288, 214, 249, 215, 284, 216, 319, 354, 271, 196, 231, 197, 198, 301, 199, 336, 371],
			82.8: [304, 303, 322, 321, 320, 340, 305, 338, 302, 337, 358, 323, 355, 376, 375, 341, 306, 373, 372] } }
}

function buildGrid(OBSTACLES) {
	const rows = WIDTH * 2 - 1
	const cells = []
	for (let id = 0; id < rows * HEIGHT - (WIDTH - 1); id++) {
		const column = id % rows, line = Math.floor(id / rows)
		const y = line - (column % WIDTH)
		cells.push({ id, x: (id - (WIDTH - 1) * y) / WIDTH, y, obstacle: false, empty: true, entity: null,
			north: !(line === 0 && column < WIDTH) && column + 1 !== WIDTH, south: !(line + 1 === HEIGHT && column >= WIDTH) && column !== 0,
			west: !(line === 0 && column < WIDTH) && column !== 0, east: !(line + 1 === HEIGHT && column >= WIDTH) && column + 1 !== WIDTH })
	}
	const byXY = new Map(cells.map(cell => [`${cell.x},${cell.y}`, cell]))
	const at = (x, y) => byXY.get(`${x},${y}`) ?? null
	const neighbor = (cell, dir) => dir === "N" && cell.north ? cells[cell.id - WIDTH + 1] : dir === "W" && cell.west ? cells[cell.id - WIDTH] :
		dir === "E" && cell.east ? cells[cell.id + WIDTH] : dir === "S" && cell.south ? cells[cell.id + WIDTH - 1] : null
	for (const [anchor, size] of Object.entries(OBSTACLES)) {
		const cell = cells[Number(anchor)]
		cell.obstacle = true; cell.empty = false
		if (size === 2) {
			const south = neighbor(cell, "S")
			for (const covered of [neighbor(cell, "E"), south, south && neighbor(south, "E")]) if (covered) { covered.obstacle = true; covered.empty = false }
		}
	}
	return { cells, at }
}

const feature = (type, min, max, turns = 0) => ({ type, minValue: min, maxValue: max, turns, targets: 31, modifiers: 0 })
const chip = (id, name, cost, cooldown, minRange, maxRange, features, extra = {}) => ({ id, name, cost, cooldown, currentCooldown: 0, minRange, maxRange,
	launchType: 7, maxUses: -1, needsLos: true, area: 1, features, ...extra })

/**
 * `noChest` : le même tour sans coffre dans la liste (contrôle : ce que le jeu a joué). La carte de danger passe par
 * `buildThreatMap` avec l'option `extraDanger` de la couche commune : danger du jeu (logs) + `chestDangerOf` (la règle du coffre).
 */
function replay(id, { noChest = false, chestLife, enemyLife, enemyAt } = {}) {
	const spec = FIGHTS[id]
	delete globalThis.System
	resetBookCache()
	const { cells, at } = buildGrid(spec.obstacles)
	const lineOfSight = (start, end) => {
		const a = Math.abs(start.y - end.y), b = Math.abs(start.x - end.x)
		const dx = start.x > end.x ? -1 : 1, dy = start.y < end.y ? 1 : -1
		const path = []
		if (b === 0) path.push(0, a + 1)
		else {
			const d = a / b / 2
			let h = 0
			for (let i = 0; i < b; i++) { const y = 0.5 + (i * 2 + 1) * d; path.push(h, Math.ceil(y - 0.00001) - h); h = Math.floor(y + 0.00001) }
			path.push(h, a + 1 - h)
		}
		for (let p = 0; p < path.length; p += 2) for (let i = 0; i < path[p + 1]; i++) {
			const cell = at(start.x + (p / 2) * dx, start.y + (path[p] + i) * dy)
			if (!cell || cell.obstacle) return false
		}
		return true
	}
	const hits = (from, to, item) => {
		const dx = from.x - to.x, dy = from.y - to.y, d = Math.abs(dx) + Math.abs(dy)
		if (d > item.maxRange || d < item.minRange) return false
		return !item.needsLos || lineOfSight(from, to)
	}
	const chips = [chip(7, "rock", 5, 1, 2, 6, [feature(1, 38, 39)]), chip(8, "protein", 3, 3, 0, 4, [feature(38, 80, 100, 2)]),
		chip(15, "motivation", 4, 6, 0, 5, [feature(32, 2, 2, 3)]), chip(18, "spark", 3, 0, 0, 10, [feature(1, 8, 16)], { needsLos: false })]
	const me = { id: 0, name: "Kassbi", level: 33, life: 396, maxLife: 396, mp: 5, tp: 10, strength: 60, magic: 0, agility: 10, wisdom: 0, science: 0,
		resistance: 10, absoluteShield: 0, relativeShield: 0, weapon: null, weapons: [], chips, effects: [], launchedEffects: [], cell: cells[spec.me],
		distance(other) { return Math.abs(this.cell.x - other.cell.x) + Math.abs(this.cell.y - other.cell.y) },
		canUseWeapon: () => false, canUseChip(item, target) { return item.currentCooldown === 0 && this.tp >= item.cost && target.life > 0 && hits(this.cell, target.cell, item) },
		chipCells(item, target) { return cells.filter((cell) => !cell.obstacle && hits(cell, target.cell, item)) } }
	me.cell.entity = me
	const enemy = { id: 1, name: "enemy", life: enemyLife ?? spec.enemyLife, maxLife: spec.enemyLife, mp: spec.enemyMp, tp: 10, weapon: { maxRange: 7 }, weapons: [], chips: [],
		absoluteShield: 0, relativeShield: 0, effects: [], launchedEffects: [], cell: enemyAt ? at(...enemyAt) : cells[spec.enemy] }
	enemy.cell.entity = enemy
	const life = chestLife ?? spec.chestLife
	const iron = Object.assign(Object.create(Chest.prototype), { id: 2, name: "iron_chest", life, maxLife: spec.chestMax, cell: cells[spec.chest], mp: 0, strength: 1000, weapons: [], chips: [], effects: [], launchedEffects: [] })
	iron.cell.entity = iron
	const alive = noChest ? [enemy] : [enemy, iron]
	globalThis.Fight = { turn: spec.turn, me, getAliveEnemies: () => alive, getNearestEnemy: () => alive[0], getEnemies: () => alive, getAllies: () => [me],
		weaponCells: () => [] }
	globalThis.Field = { cellFromXY: at, lineOfSight, distance: (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y), getObstacles: () => [] }
	const reachable = computeReachableCells(me, me.mp, spec.turn)
	const game = new Map()
	for (const [value, ids] of Object.entries(spec.danger)) for (const cellId of ids) game.set(cellId, Number(value))
	const chestDanger = chestDangerOf(noChest ? [] : [iron], me.maxLife)
	// Un ennemi sans item connu (compté, aucun danger propre : le danger du jeu vient des logs) : `enemyCount` = 1 comme en combat.
	const known = { id: 1, name: "enemy", strength: 140, tp: 10, weapon: null, otherWeapons: [], chips: [], boosts: [], science: 0,
		reachable: computeReachableCells(enemy, enemy.mp, spec.turn, { ignoreEntityId: me.id }) }
	const threat = buildThreatMap(me, reachable, [known], spec.turn, { extraDanger: (cell) => (game.get(cell.id) ?? 0) + chestDanger(cell) })
	const profile = new LeekProfile(50)
	return { spec, me, enemy, iron, profile, reachable, threat, context: { reachable, threat }, cells, zone: [...reachable.entries()].map(({ cell }) => cell.id).sort((a, b) => a - b) }
}
const reach = (w, cell) => Math.abs(cell.x - w.iron.cell.x) + Math.abs(cell.y - w.iron.cell.y)
const first = (run) => run.result.best.steps[0]

for (const id of [55005891, 55005881]) {
	test(`combat ${id}: the replayed turn matches the fight (zone = logged danger cells, played cell ${FIGHTS[id].played} is inside the chest reach)`, () => {
		const w = replay(id)
		assert.deepEqual(w.zone, Object.values(FIGHTS[id].danger).flat().sort((a, b) => a - b))
		assert.ok(reach(w, w.cells[FIGHTS[id].played]) <= CHEST_REACH, "the cell the game played was within reach of the chest")
	})

	test(`combat ${id}: BookPlanner does not end its turn within the reach of the armed chest`, () => {
		const w = replay(id)
		const run = planBeam(w.me, w.context, w.profile, { depth: 1 })
		const step = first(run)
		assert.ok(reach(w, step.finalCell) > CHEST_REACH, `final cell ${step.finalCell.id} is ${reach(w, step.finalCell)} from the chest`)
		assert.equal(step.lethal, false)
		for (const candidate of run.trace.candidates) if (reach(w, candidate.finalCell) <= CHEST_REACH && !candidate.outcome.won) assert.equal(candidate.lethal, true)
		assert.notEqual(step.target?.enemy.id, 2, "the chest is never a target")
	})

	test(`combat ${id}: the joint plan (Kassbi_Class) does not end its turn within the reach of the armed chest`, () => {
		const w = replay(id)
		const result = evaluateTacticalPlans(w.me, w.profile, w.context)
		assert.notEqual(result.plan, null, result.reason)
		assert.ok(reach(w, result.plan.destination) > CHEST_REACH, `destination ${result.plan.destination.id} is ${reach(w, result.plan.destination)} from the chest`)
		assert.equal(result.plan.target.id, 1, "the target is the enemy")
	})

	test(`combat ${id}: control without the chest - the plans end inside the reach (what the game played): the replay discriminates`, () => {
		const w = replay(id, { noChest: true })
		const run = planBeam(w.me, w.context, w.profile, { depth: 1 })
		assert.equal(first(run).finalCell.id, FIGHTS[id].played)
		const joint = evaluateTacticalPlans(w.me, w.profile, w.context)
		assert.ok(reach(w, joint.plan.destination) <= CHEST_REACH, `joint plan ends ${reach(w, joint.plan.destination)} from the chest`)
	})
}

test("simulated turns: the chest danger also covers cells outside the turn-1 zone (BookPlanner, level 2)", () => {
	const w = replay(55005891)
	const run = planBeam(w.me, w.context, w.profile, { depth: 2, deepen: true })
	assert.equal(run.result.depth, 2)
	let checked = 0
	for (const node of run.result.beam) {
		const step = node.steps[1]
		if (!step || w.zone.includes(step.finalCell.id)) continue
		checked++
		if (reach(w, step.finalCell) <= CHEST_REACH) assert.equal(step.lethal || step.outcome.won, true, `cell ${step.finalCell.id}`)
	}
	assert.ok(checked > 0, "some level-2 plans end outside the turn-1 zone")
})

test("chest danger rule: flat and lethal inside the reach, zero outside, nothing for a dead chest", () => {
	const view = (life) => ({ life, cell: { x: 10, y: 10 } })
	const danger = chestDangerOf([view(4903)], 396)
	assert.equal(danger({ x: 10 + CHEST_REACH, y: 10 }), Math.max(CHEST_FLAT_DANGER, 3 * 396))
	assert.equal(danger({ x: 10 + CHEST_REACH + 1, y: 10 }), 0)
	assert.equal(chestDangerOf([view(5000)], 396)({ x: 10, y: 10 }), CHEST_FLAT_DANGER * 1.188, "an intact chest has the same reach (an enemy may wake it)")
	assert.equal(chestDangerOf([view(0)], 396)({ x: 10, y: 10 }), 0)
	assert.ok(CHEST_FLAT_DANGER >= 396)
})

test("wiring: EnemyMemory.updateThreatMap adds the chest danger without counting the chest as an enemy", () => {
	const w = replay(55005891)
	const memory = new EnemyMemory()
	memory.updateReachable(w.me, [], aliveEnemies(), Fight.turn)
	const withChest = memory.updateThreatMap(w.me, aliveEnemies(), Fight.turn, [w.iron])
	const map = memory.getThreatMap()
	assert.equal(map.enemyCount, 0, "the enemy has no known item here; the chest is not an enemy")
	const flat = Math.max(CHEST_FLAT_DANGER, 3 * w.me.maxLife)
	for (const { cell } of w.reachable.entries()) assert.equal(map.dangerAt(cell), reach(w, cell) <= CHEST_REACH ? flat : 0, `cell ${cell.id}`)
	assert.ok(withChest.maxDanger >= flat)
	memory.updateThreatMap(w.me, aliveEnemies(), Fight.turn)
	assert.equal(memory.getThreatMap().maxDanger, 0, "without chests: unchanged")
})

test("wiring: observeTurn gives the live chests to the danger map (the active AI path)", () => {
	const w = replay(55005891)
	observeTurn(w.me)
	const map = enemyMemory.getThreatMap()
	assert.ok(map !== null)
	for (const { cell } of w.reachable.entries()) {
		if (reach(w, cell) <= CHEST_REACH) assert.ok(map.dangerAt(cell) >= CHEST_FLAT_DANGER, `cell ${cell.id}`)
		else assert.equal(map.dangerAt(cell), 0)
	}
})

test("a chest is never an enemy: not listed, not nearest, not counted", () => {
	const w = replay(55005891)
	w.me.cell = w.cells[517 - 1 > 0 ? 516 : 517] // proche du coffre : le plus proche des deux
	assert.ok(w.me.distance(w.iron) < w.me.distance(w.enemy))
	assert.deepEqual(aliveEnemies().map((e) => e.id), [1])
	assert.equal(nearestEnemy().id, 1)
})
