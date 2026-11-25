import assert from "node:assert/strict"
import test from "node:test"
import { evaluateTacticalPlans } from "../dist/Classes/Plannification/TacticalPlanner.js"
import { EnemyMemory } from "../dist/Classes/Context/EnemyMemory.js"
import { LeekProfile } from "../dist/Classes/LeekProfile.js"
import { initLeekLogging, LogConfig } from "../dist/Toolbox/Logger.js"

// Combat 54939649, tour 5 (déployé : 22612f3). Kassbi en 446 (4 PM, 10 PT, 339 PV), asdfgleek en 362 (pistolet :
// portée 1-7, 3 PM, 3 tirs de ~49). Le journal de combat montre `fallback: operations reserve` aux tours 4 et 5 : la
// recherche tactique, arrêtée à 150 000 des 1 000 000 d'ops, laissait au plan B une attaque à danger 147 alors que la
// recherche complète choisit la case sûre 394 sans tirer. Carte, obstacles, ligne de vue et distances : règles du
// générateur officiel (Map.java/Cell.java), reconstruites ici ; objets : API officielle (relevés le 2026-11-25).
// Les coûts en opérations sont SYNTHÉTIQUES (aucune mesure moteur).

const WIDTH = 18, HEIGHT = 18
const OBSTACLES = {
	8: 1, 9: 2, 50: 1, 59: 2, 65: 1, 78: 2, 88: 1, 98: 1, 115: 2, 118: 1, 125: 2, 127: 1, 136: 1, 153: 2, 163: 1,
	177: 2, 221: 1, 233: 1, 240: 1, 244: 1, 264: 1, 288: 1, 294: 1, 296: 2, 311: 2, 326: 2, 335: 2, 337: 1, 354: 1,
	360: 2, 363: 2, 371: 2, 375: 1, 385: 1, 386: 1, 397: 1, 403: 1, 416: 2, 436: 1, 444: 1, 468: 1, 472: 1, 490: 1,
	515: 1, 523: 1, 546: 1, 547: 2, 556: 2, 563: 1, 575: 2, 605: 1, 612: 1
}
const KASSBI_CELL = 446, ENEMY_CELL = 362, SAFE_CELL = 394

const rows = WIDTH * 2 - 1
const cells = []
for (let id = 0; id < rows * HEIGHT - (WIDTH - 1); id++) {
	const column = id % rows, line = Math.floor(id / rows)
	const y = line - (column % WIDTH)
	cells.push({ id, x: (id - (WIDTH - 1) * y) / WIDTH, y, obstacle: false, empty: true, entity: null,
		north: !(line === 0 && column < WIDTH) && column + 1 !== WIDTH,
		south: !(line + 1 === HEIGHT && column >= WIDTH) && column !== 0,
		west: !(line === 0 && column < WIDTH) && column !== 0,
		east: !(line + 1 === HEIGHT && column >= WIDTH) && column + 1 !== WIDTH })
}
const byXY = new Map(cells.map(cell => [`${cell.x},${cell.y}`, cell]))
const at = (x, y) => byXY.get(`${x},${y}`) ?? null
const neighbor = (cell, dir) => dir === "N" && cell.north ? cells[cell.id - WIDTH + 1] :
	dir === "W" && cell.west ? cells[cell.id - WIDTH] :
	dir === "E" && cell.east ? cells[cell.id + WIDTH] :
	dir === "S" && cell.south ? cells[cell.id + WIDTH - 1] : null
for (const [anchor, size] of Object.entries(OBSTACLES)) {
	const cell = cells[Number(anchor)]
	cell.obstacle = true; cell.empty = false
	if (size === 2) {
		const south = neighbor(cell, "S")
		for (const covered of [neighbor(cell, "E"), south, south && neighbor(south, "E")]) {
			covered.obstacle = true; covered.empty = false
		}
	}
}
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)

/** Ligne de vue du générateur (Map.verifyLoS) : obstacles seulement (les deux entités sont aux extrémités). */
function lineOfSight(start, end) {
	const a = Math.abs(start.y - end.y), b = Math.abs(start.x - end.x)
	const dx = start.x > end.x ? -1 : 1, dy = start.y < end.y ? 1 : -1
	const path = []
	if (b === 0) path.push(0, a + 1)
	else {
		const d = a / b / 2
		let h = 0
		for (let i = 0; i < b; i++) {
			const y = 0.5 + (i * 2 + 1) * d
			path.push(h, Math.ceil(y - 0.00001) - h)
			h = Math.floor(y + 0.00001)
		}
		path.push(h, a + 1 - h)
	}
	for (let p = 0; p < path.length; p += 2) for (let i = 0; i < path[p + 1]; i++) {
		const cell = at(start.x + (p / 2) * dx, start.y + (path[p] + i) * dy)
		if (!cell || cell.obstacle) return false
	}
	return true
}

/** Masque de lancer du générateur (Map.verifyRange) : 1 lignes, 2 diagonales, 4 autres. */
function hits(from, to, item) {
	const dx = from.x - to.x, dy = from.y - to.y, d = Math.abs(dx) + Math.abs(dy)
	if (d > item.maxRange || d < item.minRange) return false
	if (from === to) return true
	if ((item.launchType & 1) === 0 && (dx === 0 || dy === 0)) return false
	if ((item.launchType & 2) === 0 && Math.abs(dx) === Math.abs(dy)) return false
	if ((item.launchType & 4) === 0 && Math.abs(dx) !== Math.abs(dy) && dx !== 0 && dy !== 0) return false
	return !item.needsLos || lineOfSight(from, to)
}

const feature = (type, min, max, turns = 0) => ({ type, minValue: min, maxValue: max, turns, targets: 31, modifiers: 0 })
const weapon = (name, cost, minRange, maxRange, launchType, maxUses, features) =>
	({ id: name.length, name, cost, minRange, maxRange, launchType, maxUses, needsLos: true, area: 1, features })
const chip = (name, cost, cooldown, minRange, maxRange, features, currentCooldown = 0) =>
	({ id: name.length, name, cost, cooldown, currentCooldown, minRange, maxRange, launchType: 7, maxUses: -1,
		needsLos: true, area: 1, features })

/**
 * Tour 5 : `searchCost` ops ajoutés par le premier fournisseur natif (la recherche tactique démarre à `startOps`).
 * `startOps` = coût déjà dépensé avant la recherche (observé : 59 000 au tour 4, 103 000 au tour 5).
 */
function turn5({ startOps = 100000, searchCost = 0, withSystem = true } = {}) {
	delete globalThis.System
	globalThis.Effect = { DAMAGE: 1, HEAL: 2, BUFF_STRENGTH: 3, BUFF_AGILITY: 4, RELATIVE_SHIELD: 5,
		ABSOLUTE_SHIELD: 6, BUFF_MP: 7, BUFF_TP: 8, DEBUFF: 9, POISON: 13, RAW_BUFF_TP: 32, RAW_BUFF_STRENGTH: 38 }
	const config = new LogConfig(); config.setAll(false); initLeekLogging(config)
	const pistol = weapon("pistol", 3, 1, 7, 7, 4, [feature(1, 15, 20)])
	const machineGun = weapon("machine_gun", 4, 1, 6, 1, 3, [feature(1, 10, 15), feature(1, 10, 15), feature(1, 10, 15)])
	const neutrino = weapon("neutrino", 4, 2, 6, 2, 3, [feature(1, 25, 30), feature(26, 8, 8, 2)])
	const chips = [
		chip("ice", 4, 0, 0, 8, [feature(1, 17, 19)]),
		chip("bandage", 2, 1, 0, 6, [feature(2, 23, 28)]),
		chip("rock", 5, 1, 2, 6, [feature(1, 38, 39)]),
		chip("protein", 3, 3, 0, 4, [feature(38, 80, 100, 2)], 1),
		chip("motivation", 4, 6, 0, 5, [feature(32, 2, 2, 3)]),
		chip("helmet", 3, 3, 0, 4, [feature(6, 15, 15, 2)])
	]
	const me = {
		id: 103947, name: "Kassbi", cell: cells[KASSBI_CELL], life: 339, maxLife: 339, strength: 10, wisdom: 0,
		agility: 10, resistance: 10, science: 0, magic: 0, level: 14, absoluteShield: 0, relativeShield: 0,
		tp: 10, mp: 4, weapon: machineGun, weapons: [machineGun, neutrino], chips, effects: [], launchedEffects: [],
		say() {}, distance(other) { return distance(this.cell, other.cell) },
		canUseWeapon(target, item = this.weapon) { return !!item && this.tp >= item.cost && target.life > 0 && hits(this.cell, target.cell, item) },
		canUseChip(item, target) { return item.currentCooldown === 0 && this.tp >= item.cost && target.life > 0 && hits(this.cell, target.cell, item) },
		chipCells(item, target) { return cells.filter(cell => !cell.obstacle && hits(cell, target.cell, item)) }
	}
	const enemy = {
		id: 135160, name: "asdfgleek", cell: cells[ENEMY_CELL], life: 199, maxLife: 199, mp: 3, tp: 10, strength: 180,
		agility: 0, wisdom: 0, resistance: 0, science: 0, magic: 0, level: 14, weapon: pistol, weapons: [pistol],
		chips: [], absoluteShield: 0, relativeShield: 0, effects: [], launchedEffects: [], frequency: 100, cores: 1, ram: 6
	}
	for (const cell of cells) cell.entity = null
	me.cell.entity = me; me.cell.empty = false; enemy.cell.entity = enemy; enemy.cell.empty = false
	let providerCalls = 0
	let ops = startOps
	globalThis.Fight = { turn: 5, me, getNearestEnemy: () => enemy, getAliveEnemies: () => [enemy], getEnemies: () => [enemy],
		getAllies: () => [me],
		weaponCells(target, item) {
			if (providerCalls++ === 0) ops += searchCost
			return cells.filter(cell => !cell.obstacle && hits(cell, (target.cell ?? target), item))
		} }
	globalThis.Field = { cellFromXY: at, getObstacles: () => cells.filter(cell => cell.obstacle), distance,
		lineOfSight, pathLength: () => 0 }
	const memory = new EnemyMemory()
	memory.identify(enemy, 5); memory.update(enemy, me, 5, 1)
	memory.updateReachable(me, [], [enemy], 5)
	memory.updateThreatMap(me, [enemy], 5)
	const profile = new LeekProfile()
	profile.setRole("BALANCED"); profile.setAggression(50); profile.setPreferredRange(3, 8)
	profile.setSupportOptions(true, true, true)
	if (withSystem) globalThis.System = { get operations() { return ops }, maxOperations: 1000000 }
	try {
		const result = evaluateTacticalPlans(me, profile, { reachable: memory.getReachable(me.id), threat: memory.getThreatMap() })
		return { ...result, memory, me, getOps: () => ops }
	} finally { delete globalThis.System }
}

test("turn 5 reconstructed: the threat map sees 8 safe cells and the complete search retreats to 394 without shooting", () => {
	const { plan, memory, me } = turn5({ withSystem: false })
	const threat = memory.getThreatMap()
	assert.equal(threat.dangerAt(me.cell), 147, "three pistol shots on the current cell")
	const safe = [...threat.entries()].filter(entry => entry.danger === 0).map(entry => entry.cell.id).sort((a, b) => a - b)
	assert.deepEqual(safe, [374, 376, 392, 393, 394, 409, 479, 514])
	assert.equal(threat.dangerAt(cells[464]), 147, "the shot cell of the real fight is fully exposed")
	assert.equal(plan.destination.id, SAFE_CELL)
	assert.equal(plan.weaponShots, 0)
	assert.equal(plan.danger, 0)
	assert.ok(plan.score > 0)
})

test("a search finishing between 150 000 and 300 000 operations is no longer abandoned and keeps the retreat", () => {
	for (const searchCost of [149000, 151000, 200000, 250000, 299000]) {
		const result = turn5({ startOps: 100000, searchCost })
		assert.equal(result.reason, "complete search", `search cost ${searchCost}`)
		assert.equal(result.plan.destination.id, SAFE_CELL, `search cost ${searchCost}`)
		assert.equal(result.plan.weaponShots, 0)
		assert.equal(result.plan.danger, 0)
		assert.ok(result.getOps() < 700000)
	}
})

test("the relative ceiling is 30 % of the total: 300 000 abandons, with the plan B fallback reason", () => {
	for (const searchCost of [300000, 310000]) {
		const result = turn5({ startOps: 100000, searchCost })
		assert.equal(result.reason, "operations reserve", `search cost ${searchCost}`)
		assert.equal(result.plan, null, "the safe progress plan is not retained once weapon cells are loaded")
	}
})

test("the global 70 % ceiling is unchanged: a late start stops the search before the relative ceiling", () => {
	const result = turn5({ startOps: 450000, searchCost: 260000 })
	assert.equal(result.reason, "operations reserve")
	const kept = turn5({ startOps: 400000, searchCost: 250000 })
	assert.equal(kept.reason, "complete search")
	assert.equal(kept.plan.destination.id, SAFE_CELL)
})
