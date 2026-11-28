import { evaluateTacticalPlans } from "../../dist/Classes/Plannification/TacticalPlanner.js"
import { EnemyMemory } from "../../dist/Classes/Context/EnemyMemory.js"
import { computeReachableCells } from "../../dist/Classes/Context/ReachableCells.js"
import { LeekProfile } from "../../dist/Classes/LeekProfile.js"
import { initLeekLogging, LogConfig, LOG_CONTEXT } from "../../dist/Toolbox/Logger.js"

// Monde reconstruit du combat 54940819 (version jouée : 22612f3). Carte 18x18, obstacles, ligne de vue, motifs de
// lancer et distances : règles du générateur officiel (Map.java/Cell.java). Objets : API officielle (2026-11-25).
// Kassbi (339 PV, 4 PM, 10 PT, force 10) : machine_gun (item 38), neutrino (182), puces ice, bandage, rock, protein,
// motivation, helmet. dv3 (189 PV max, force 116, 4 PM) : pistol, machine_gun ; puces shock, ice, bandage, pebble,
// helmet. Les coûts en opérations ne sont PAS mesurés.

const WIDTH = 18, HEIGHT = 18
const OBSTACLES = {
	1: 2, 3: 1, 8: 2, 12: 2, 54: 2, 59: 1, 64: 1, 74: 1, 78: 2, 85: 2, 109: 1, 115: 1, 134: 1, 135: 1, 146: 1, 147: 1,
	153: 2, 158: 1, 159: 1, 161: 2, 165: 1, 181: 1, 189: 2, 193: 1, 202: 2, 208: 1, 210: 1, 218: 2, 223: 1, 233: 1,
	242: 1, 261: 1, 276: 2, 280: 1, 283: 2, 285: 2, 307: 2, 329: 1, 349: 2, 376: 1, 383: 1, 385: 1, 395: 2, 415: 1,
	423: 2, 429: 2, 442: 2, 449: 1, 455: 1, 472: 1, 473: 1, 479: 2, 526: 1, 552: 2, 553: 1, 554: 2, 555: 1, 556: 1,
	565: 1, 575: 1, 583: 1, 585: 1, 588: 1, 591: 1, 605: 1
}
export const KASSBI_STUCK = 187, ENEMY_CORNER = 17, KASSBI_BEFORE = 205

const rows = WIDTH * 2 - 1
export const cells = []
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
export const at = (x, y) => byXY.get(`${x},${y}`) ?? null
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
export const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)

/** Ligne de vue du générateur (Map.verifyLoS) : obstacles seulement (les deux entités sont aux extrémités). */
export function lineOfSight(start, end) {
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
export function hits(from, to, item) {
	const dx = from.x - to.x, dy = from.y - to.y, d = Math.abs(dx) + Math.abs(dy)
	if (d > item.maxRange || d < item.minRange) return false
	if (from === to) return true
	if ((item.launchType & 1) === 0 && (dx === 0 || dy === 0)) return false
	if ((item.launchType & 2) === 0 && Math.abs(dx) === Math.abs(dy)) return false
	if ((item.launchType & 4) === 0 && Math.abs(dx) !== Math.abs(dy) && dx !== 0 && dy !== 0) return false
	return !item.needsLos || lineOfSight(from, to)
}

/** Distance de marche (nombre de cases, obstacles et ennemi bloquants) de chaque case vers un ensemble d'objectifs. */
export function walkDistances(goalIds, blockedIds = []) {
	const blocked = new Set(blockedIds), dist = new Map(), queue = []
	for (const id of goalIds) if (!cells[id].obstacle && !blocked.has(id)) { dist.set(id, 0); queue.push(id) }
	for (let head = 0; head < queue.length; head++) {
		const cell = cells[queue[head]]
		for (const dir of ["S", "W", "N", "E"]) {
			const next = neighbor(cell, dir)
			if (!next || next.obstacle || blocked.has(next.id) || dist.has(next.id)) continue
			dist.set(next.id, dist.get(cell.id) + 1); queue.push(next.id)
		}
	}
	return dist
}

const feature = (type, min, max, turns = 0) => ({ type, minValue: min, maxValue: max, turns, targets: 31, modifiers: 0 })
const weapon = (name, cost, minRange, maxRange, launchType, maxUses, features) =>
	({ id: name.length, name, cost, minRange, maxRange, launchType, maxUses, needsLos: true, area: 1, features })
const chip = (name, cost, cooldown, minRange, maxRange, features, currentCooldown = 0) =>
	({ id: name.length * 7, name, cost, cooldown, currentCooldown, minRange, maxRange, launchType: 7, maxUses: -1,
		needsLos: true, area: 1, features })

/** Zones de tir de Kassbi vers `enemyCell` : cases d'où machine_gun, neutrino, ice ou rock touchent. */
export function firingZone(enemyCell = ENEMY_CORNER) {
	const items = [
		weapon("machine_gun", 4, 1, 6, 1, 3, []), weapon("neutrino", 4, 2, 6, 2, 3, []),
		chip("ice", 4, 0, 0, 8, []), chip("rock", 5, 1, 2, 6, [])
	]
	return cells.filter(cell => !cell.obstacle && items.some(item => hits(cell, cells[enemyCell], item))).map(cell => cell.id)
}

/**
 * Un tour de Kassbi : `k` = sa case, `e` = celle de dv3 (PV `enemyLife`), PM 4, PT 10. Construit la mémoire, la carte
 * de danger réelle du dépôt, puis évalue le plan tactique. `stagnation` = compteur transmis au planificateur.
 */
export function world({ turn = 12, k = KASSBI_STUCK, e = ENEMY_CORNER, enemyLife = 60, stagnation, dangerOverride,
	boosts = false, life = 339, enemyMp = 4 } = {}) {
	delete globalThis.System
	globalThis.Effect = { DAMAGE: 1, HEAL: 2, BUFF_STRENGTH: 3, BUFF_AGILITY: 4, RELATIVE_SHIELD: 5,
		ABSOLUTE_SHIELD: 6, BUFF_MP: 7, BUFF_TP: 8, DEBUFF: 9, POISON: 13, RAW_BUFF_TP: 32, RAW_BUFF_STRENGTH: 38 }
	const pistol = weapon("pistol", 3, 1, 7, 7, 4, [feature(1, 15, 20)])
	const machineGun = weapon("machine_gun", 4, 1, 6, 1, 3, [feature(1, 10, 15), feature(1, 10, 15), feature(1, 10, 15)])
	const neutrino = weapon("neutrino", 4, 2, 6, 2, 3, [feature(1, 25, 30), feature(26, 8, 8, 2)])
	const myChips = [
		chip("ice", 4, 0, 0, 8, [feature(1, 17, 19)]), chip("bandage", 2, 1, 0, 6, [feature(2, 23, 28)]),
		chip("rock", 5, 1, 2, 6, [feature(1, 38, 39)]),
		// Boosts en délai par défaut : depuis que le boost est une composante du plan, un boost prêt s'ajoute à chaque
		// plan (y compris à un maintien). `boosts: true` les rend prêts pour les tests qui portent sur cette interaction.
		chip("protein", 3, 3, 0, 4, [feature(38, 80, 100, 2)], boosts ? 0 : 1),
		chip("motivation", 4, 6, 0, 5, [feature(32, 2, 2, 3)], boosts ? 0 : 1), chip("helmet", 3, 3, 0, 4, [feature(6, 15, 15, 2)])
	]
	const enemyChips = [
		chip("shock", 2, 0, 0, 6, [feature(1, 7, 9)]), chip("ice", 4, 0, 0, 8, [feature(1, 17, 19)]),
		chip("bandage", 2, 1, 0, 6, [feature(2, 23, 28)]), chip("pebble", 2, 1, 0, 5, [feature(1, 2, 34)]),
		chip("helmet", 3, 3, 0, 4, [feature(6, 15, 15, 2)])
	]
	for (const cell of cells) { cell.entity = null; cell.empty = !cell.obstacle }
	const me = {
		id: 103947, name: "Kassbi", cell: cells[k], life, maxLife: 339, strength: 10, wisdom: 0, agility: 10,
		resistance: 10, science: 0, magic: 0, level: 14, absoluteShield: 0, relativeShield: 0, tp: 10, mp: 4,
		weapon: machineGun, weapons: [machineGun, neutrino], chips: myChips, effects: [], launchedEffects: [],
		events: [], say() {}, distance(other) { return distance(this.cell, other.cell) },
		canUseWeapon(target, item = this.weapon) { return !!item && this.tp >= item.cost && target.life > 0 && hits(this.cell, target.cell, item) },
		canUseChip(item, target) { return item.currentCooldown === 0 && this.tp >= item.cost && target.life > 0 && hits(this.cell, target.cell, item) },
		chipCells(item, target) { return cells.filter(cell => !cell.obstacle && hits(cell, target.cell, item)) },
		setWeapon() { return true }, moveAwayFrom() { return 0 },
		moveToward(destination, limit = this.mp) {
			const target = destination.cell ?? destination
			const cost = computeReachableCells(this, Math.min(this.mp, limit), Fight.turn).costTo(target)
			if (cost === null) return 0
			this.cell.entity = null; this.cell.empty = true
			this.cell = target; target.entity = this; target.empty = false
			this.mp -= cost; this.events.push(`move:${target.id}`)
			return cost
		},
		useWeapon() { this.events.push("shoot"); return 1 }, useChip(item) { this.events.push(`chip:${item.name}`); return 1 }
	}
	const enemy = {
		id: 76599, name: "dv3", cell: cells[e], life: enemyLife, maxLife: 189, mp: enemyMp, tp: 10, strength: 116, agility: 10,
		wisdom: 0, resistance: 26, science: 0, magic: 0, level: 14, weapon: machineGun, weapons: [pistol, machineGun],
		chips: enemyChips, absoluteShield: 0, relativeShield: 0, effects: [], launchedEffects: [], frequency: 100,
		cores: 1, ram: 6
	}
	me.cell.entity = me; me.cell.empty = false; enemy.cell.entity = enemy; enemy.cell.empty = false
	globalThis.Fight = { turn, me, getNearestEnemy: () => enemy, getAliveEnemies: () => [enemy], getEnemies: () => [enemy],
		getAllies: () => [me],
		weaponCells: (target, item) => cells.filter(cell => !cell.obstacle && hits(cell, target.cell ?? target, item)) }
	globalThis.Field = { cellFromXY: at, getObstacles: () => cells.filter(cell => cell.obstacle), distance,
		lineOfSight, pathLength: () => 0 }
	const config = new LogConfig(); config.setAll(false); config.setEnabled(LOG_CONTEXT.PLANNING, true)
	initLeekLogging(config)
	const memory = new EnemyMemory()
	memory.identify(enemy, 1); memory.update(enemy, me, turn, 1)
	memory.updateReachable(me, [], [enemy], turn)
	memory.updateThreatMap(me, [enemy], turn)
	const threat = memory.getThreatMap()
	if (dangerOverride) {
		const native = threat.dangerAt.bind(threat)
		threat.dangerAt = (cell) => dangerOverride(cell, native(cell)) ?? native(cell)
	}
	const profile = new LeekProfile()
	const context = { reachable: memory.getReachable(me.id), threat, ...(stagnation ? { stagnation } : {}) }
	return { me, enemy, memory, context, profile, threat,
		evaluate: () => evaluateTacticalPlans(me, profile, context) }
}
