import assert from "node:assert/strict"
import test from "node:test"
import { LETHAL_PENALTY } from "../dist/Classes/Plannification/TacticalScore.js"
import { NEXT_TURN_WEIGHT } from "../dist/Classes/Plannification/TacticalNextTurn.js"
import { evaluateTacticalPlans } from "../dist/Classes/Plannification/TacticalPlanner.js"
import { EnemyMemory } from "../dist/Classes/Context/EnemyMemory.js"
import { computeReachableCells } from "../dist/Classes/Context/ReachableCells.js"
import { ThreatMap } from "../dist/Classes/Context/ThreatMap.js"
import { LeekProfile } from "../dist/Classes/LeekProfile.js"
import { initLeekLogging, LogConfig, LOG_CONTEXT } from "../dist/Toolbox/Logger.js"

// Combat 54965081 (LWGarden/Data/fights/54965081) : aux tours 3 et 4, à pleine vie, Kassbi lance une puce puis recule sur
// la case de moindre danger (distance 11 puis 12) ; l'ennemi (4 PM) le rattrape et, au tour 5, Kassbi doit dépenser PM et
// PT pour revenir à portée. Carte 18x18, obstacles, positions (action MOVE_TO), PV, force et effets : relevés du combat.
// Objets : API officielle et ligne [Chips] du combat (spark : portée 0-10, SANS ligne de vue : supposé). Profil de
// production (AGGRESSIVE, agressivité 50). La carte de danger est celle du dépôt, calculée ici (pas celle du combat).

const WIDTH = 18, HEIGHT = 18
const OBSTACLES = {
	3: 1, 4: 1, 8: 1, 19: 1, 20: 2, 24: 2, 50: 2, 92: 2, 115: 1, 122: 1, 124: 1, 145: 1, 147: 1, 154: 2, 159: 2, 175: 1,
	179: 1, 186: 1, 197: 1, 198: 1, 224: 2, 225: 1, 236: 1, 239: 1, 248: 2, 250: 2, 254: 2, 262: 1, 305: 2, 317: 1, 320: 1,
	321: 2, 324: 1, 346: 1, 369: 1, 374: 2, 389: 1, 406: 1, 410: 1, 441: 1, 448: 1, 456: 1, 462: 1, 469: 1, 472: 1, 473: 2,
	480: 1, 481: 1, 484: 2, 487: 1, 500: 1, 503: 1, 525: 1, 529: 1, 548: 1, 552: 1, 554: 1, 570: 2, 603: 1, 604: 1
}

function buildGrid() {
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
				if (covered) { covered.obstacle = true; covered.empty = false }
			}
		}
	}
	return { cells, at }
}

const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
const feature = (type, min, max, turns = 0) => ({ type, minValue: min, maxValue: max, turns, targets: 31, modifiers: 0 })
const weapon = (id, name, cost, minRange, maxRange, launchType, maxUses, features) =>
	({ id, name, cost, minRange, maxRange, launchType, maxUses, needsLos: true, area: 1, features })
const chip = (id, name, cost, cooldown, minRange, maxRange, features, extra = {}) =>
	({ id, name, cost, cooldown, currentCooldown: 0, minRange, maxRange, launchType: 7, maxUses: -1, needsLos: true, area: 1,
		features, ...extra })

// État au début du tour de Kassbi. Tour 3 : protein (+93 de force, lancé au tour 2) vit son dernier tour.
const TURNS = {
	3: { k: 565, e: 499, enemyLife: 221, enemyStrength: 200, enemyWeapon: "machine_gun", strengthBoost: 93, proteinCooldown: 2 },
	4: { k: 546, e: 567, enemyLife: 197, enemyStrength: 295, enemyWeapon: "pistol", strengthBoost: 0, proteinCooldown: 1 }
}

function arena(turn, { ops, role = "AGGRESSIVE" } = {}) {
	const state = TURNS[turn]
	delete globalThis.System
	globalThis.Effect = { DAMAGE: 1, HEAL: 2, BUFF_STRENGTH: 3, BUFF_AGILITY: 4, RELATIVE_SHIELD: 5,
		ABSOLUTE_SHIELD: 6, BUFF_MP: 7, BUFF_TP: 8, DEBUFF: 9, POISON: 13, RAW_BUFF_TP: 32, RAW_BUFF_STRENGTH: 38 }
	const { cells, at } = buildGrid()
	const lineOfSight = (start, end) => {
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
	const hits = (from, to, item) => {
		const dx = from.x - to.x, dy = from.y - to.y, d = Math.abs(dx) + Math.abs(dy)
		if (d > item.maxRange || d < item.minRange) return false
		if (from === to) return true
		if ((item.launchType & 1) === 0 && (dx === 0 || dy === 0)) return false
		if ((item.launchType & 2) === 0 && Math.abs(dx) === Math.abs(dy)) return false
		if ((item.launchType & 4) === 0 && Math.abs(dx) !== Math.abs(dy) && dx !== 0 && dy !== 0) return false
		return !item.needsLos || lineOfSight(from, to)
	}
	const pistol = weapon(37, "pistol", 3, 1, 7, 7, 4, [feature(1, 15, 20)])
	const machineGun = weapon(38, "machine_gun", 4, 1, 6, 1, 3, [feature(1, 10, 15), feature(1, 10, 15), feature(1, 10, 15)])
	const neutrino = weapon(182, "neutrino", 4, 2, 6, 2, 3, [feature(1, 25, 30), feature(26, 8, 8, 2)])
	const shotgun = weapon(41, "shotgun", 5, 1, 5, 1, 2, [feature(1, 33, 43), feature(27, 25, 25, 1)])
	const protein = () => chip(8, "protein", 3, 3, 0, 4, [feature(38, 80, 100, 2)])
	const myChips = [
		chip(4, "cure", 4, 2, 0, 5, [feature(2, 38, 46)]), chip(7, "rock", 5, 1, 2, 6, [feature(1, 38, 39)]),
		{ ...protein(), currentCooldown: state.proteinCooldown }, chip(15, "motivation", 4, 6, 0, 5, [feature(32, 2, 2, 3)]),
		chip(18, "spark", 3, 0, 0, 10, [feature(1, 8, 16)], { needsLos: false }),
		chip(21, "helmet", 3, 3, 0, 4, [feature(6, 15, 15, 2)])
	]
	const enemyChips = [
		chip(1, "shock", 2, 0, 0, 6, [feature(1, 7, 9)]), chip(2, "ice", 4, 0, 0, 8, [feature(1, 17, 19)]),
		chip(3, "bandage", 2, 1, 0, 6, [feature(2, 23, 28)]), chip(7, "rock", 5, 1, 2, 6, [feature(1, 38, 39)]), protein(),
		chip(19, "pebble", 2, 1, 0, 5, [feature(1, 2, 34)]), chip(21, "helmet", 3, 3, 0, 4, [feature(6, 15, 15, 2)])
	]
	const me = {
		id: 103947, name: "Kassbi", cell: cells[state.k], life: 369, maxLife: 369, strength: 20 + state.strengthBoost, wisdom: 0,
		agility: 10, resistance: 10, science: 0, magic: 0, level: 24, absoluteShield: 0, relativeShield: 0, tp: 10, mp: 5,
		weapon: shotgun, weapons: [neutrino, shotgun], chips: myChips, launchedEffects: [],
		effects: state.strengthBoost ? [{ type: 38, value: state.strengthBoost, turns: 1 }] : [],
		say() {}, distance(other) { return distance(this.cell, other.cell) },
		canUseWeapon(target, item = this.weapon) { return !!item && this.tp >= item.cost && target.life > 0 && hits(this.cell, target.cell, item) },
		canUseChip(item, target) { return item.currentCooldown === 0 && this.tp >= item.cost && target.life > 0 && hits(this.cell, target.cell, item) },
		chipCells(item, target) { return cells.filter(cell => !cell.obstacle && hits(cell, target.cell, item)) }
	}
	const enemy = {
		id: 136242, name: "degrpiohtk", cell: cells[state.e], life: state.enemyLife, maxLife: 221, mp: 4, tp: 10,
		strength: state.enemyStrength, agility: 0, wisdom: 20, resistance: 2, science: 0, magic: 0, level: 24,
		weapon: state.enemyWeapon === "pistol" ? pistol : machineGun, weapons: [pistol, machineGun], chips: enemyChips,
		absoluteShield: 0, relativeShield: 0, effects: [], launchedEffects: [], frequency: 101, cores: 1, ram: 7
	}
	me.cell.entity = me; me.cell.empty = false; enemy.cell.entity = enemy; enemy.cell.empty = false
	let clock = ops?.start ?? 0
	globalThis.Fight = { turn, me, getNearestEnemy: () => enemy, getAliveEnemies: () => [enemy], getEnemies: () => [enemy],
		getAllies: () => [me],
		weaponCells: (target, item) => cells.filter(cell => !cell.obstacle && hits(cell, target.cell ?? target, item)) }
	globalThis.Field = {
		cellFromXY(x, y) { clock += ops?.perCellLookup ?? 0; return at(x, y) },
		getObstacles: () => cells.filter(cell => cell.obstacle), distance, lineOfSight, pathLength: () => 0
	}
	const logs = []
	const config = new LogConfig(); config.setAll(false); config.setEnabled(LOG_CONTEXT.PLANNING, true)
	initLeekLogging(config)
	const memory = new EnemyMemory()
	memory.identify(enemy, 1); memory.update(enemy, me, turn, 1)
	memory.getProfile(enemy.id).startCooldown(enemyChips[4]) // protein adverse lancé aux tours 1 et 4 : pas prêt
	memory.updateReachable(me, [], [enemy], turn)
	memory.updateThreatMap(me, [enemy], turn)
	if (ops) globalThis.System = { get operations() { return clock }, maxOperations: 1000000 }
	const profile = new LeekProfile()
	profile.setRole(role); profile.setAggression(50)
	profile.setSupportOptions(true, true, true)
	const context = { reachable: memory.getReachable(me.id), threat: memory.getThreatMap() }
	const usableNextTurn = (cell, item) => {
		const zone = computeReachableCells({ ...me, cell }, me.mp, turn)
		return [...zone.entries()].some(entry => hits(entry.cell, enemy.cell, item))
	}
	return { me, enemy, cells, logs, context, neutrino, rock: myChips[1], usableNextTurn,
		evaluate() {
			const print = console.log
			console.log = text => logs.push(String(text))
			try { return evaluateTacticalPlans(me, profile, context) } finally { console.log = print }
		} }
}
const done = () => { delete globalThis.System }
const describe = (w, plan) => ({
	destination: plan.destination.id, distance: distance(plan.destination, w.enemy.cell), shotCell: plan.shotCell.id,
	weapon: plan.weapon?.name ?? null, shots: plan.weaponShots, chips: plan.chips.map(item => item.name),
	boost: (plan.boost?.chips ?? []).map(item => item.name), protection: plan.protection.map(item => item.name),
	usefulDamage: Number(plan.usefulDamage.toFixed(2)), danger: Number(plan.danger.toFixed(2)),
	nextTurn: Number((plan.nextTurn ?? 0).toFixed(2)), score: Number(plan.score.toFixed(2))
})

// Valeurs relevées sur cette reconstruction ; aux deux tours la décision est celle d'avant le terme N, seul le score change.
// Tour 3 : spark x 3 puis 546 (danger 0, distance 11 ; des cases de danger 0 existent à 13), d'où neutrino et rock sont
// utilisables au tour suivant. N = 0,75 x 58,05 : plafonné par les PV restants après le MEILLEUR tour possible (toutes
// cases de tir, puces créditées après déplacement comprises), pas après ce plan. Tour 4 : CARACTÉRISATION d'un objectif NON
// atteint au poids 0,75 : le repli en 526 (danger 142,2 ; seul spark y reste utilisable, N = 0,75 x 43,2) garde l'avantage
// sur motivation + neutrino + spark depuis 564 puis 527 (danger 252,8) ; bascule mesurée entre 0,8 et 0,85.
// POSTURE DU RÔLE (profil du combat : AGGRESSIVE, `w` 0,75 -> 0,5, poids d'approche `a` = 1,25, soit N à 0,9375) : tour 3,
// même plan, N et score recalculés (43,54 x 1,25) ; tour 4, la DÉCISION CHANGE et atteint l'objectif : motivation +
// neutrino + spark depuis 564, fin en 527 (danger 252,8 < 369 PV), neutrino et rock utilisables au tour suivant. `BALANCED`
// (`w` = 1, `a` = 1) garde le repli en 526 (test ci-dessous). Effet en combat non mesuré.
const RECORDED = {
	3: { destination: 546, distance: 11, shotCell: 565, weapon: null, shots: 0, chips: ["spark", "spark", "spark"], boost: [],
		protection: [], usefulDamage: 76.68, danger: 0, nextTurn: 54.43, score: 131.11, neutrino: true, rock: true },
	4: { destination: 527, distance: 10, shotCell: 564, weapon: "neutrino", shots: 1, chips: ["spark"], boost: ["motivation"],
		protection: [], usefulDamage: 47.4, danger: 252.8, nextTurn: 74.25, score: 44.75, neutrino: true, rock: true }
}

test("combat 54965081, turns 3 and 4: the final cell is credited with next turn's damage (AGGRESSIVE: N weighted 0.75 x a)", () => {
	try {
		assert.equal(NEXT_TURN_WEIGHT, 0.75)
		for (const turn of [3, 4]) {
			const w = arena(turn)
			const { plan, reason } = w.evaluate()
			assert.equal(reason, "complete search", `turn ${turn}`)
			assert.deepEqual({ ...describe(w, plan), neutrino: w.usableNextTurn(plan.destination, w.neutrino),
				rock: w.usableNextTurn(plan.destination, w.rock) }, RECORDED[turn], `turn ${turn}`)
			assert.ok(plan.danger < w.me.life, "never a lethal cell")
			assert.deepEqual(w.logs, [], "N computed for every cell: no fallback line")
		}
	} finally { done() }
})

test("posture, combat 54965081 turn 4: AGGRESSIVE moves in to shoot the neutrino, BALANCED and DEFENSIVE keep the spark retreat", () => {
	try {
		const seen = (role) => {
			const w = arena(4, { role })
			const { plan } = w.evaluate()
			return [plan.shotCell.id, plan.destination.id, plan.weapon?.name ?? null, Number(plan.danger.toFixed(2))]
		}
		assert.deepEqual(seen("AGGRESSIVE"), [564, 527, "neutrino", 252.8])
		assert.deepEqual(seen("BALANCED"), [546, 526, null, 142.2])
		assert.deepEqual(seen("DEFENSIVE"), [546, 526, null, 142.2])
	} finally { done() }
})

test("N falls back to 0 for every cell when its operations allowance (5 %) is exceeded, and says so", () => {
	try {
		// Tour 3 : 29 recherches de case hors zone. À 1 000 ops chacune (29 000 < 50 000) N est calculé ; à 2 000 (58 000),
		// N = 0 partout : même plan et même score qu'avant le terme N, et une ligne PLANNING.
		const within = arena(3, { ops: { perCellLookup: 1000 } })
		assert.equal(Number(within.evaluate().plan.nextTurn.toFixed(2)), 54.43) // 1,25 x 43,54 (poids d'approche AGGRESSIVE)
		const beyond = arena(3, { ops: { perCellLookup: 2000 } })
		const { plan, reason } = beyond.evaluate()
		assert.equal(reason, "complete search")
		assert.deepEqual([plan.destination.id, plan.nextTurn, Number(plan.score.toFixed(2))], [546, 0, 76.68])
		assert.deepEqual(beyond.logs, ["[Tactical] next-turn value unavailable (operations reserve): N = 0 for every cell"])
	} finally { done() }
})

// Monde minimal : moi en (0,0), 1 PM, ennemi en (0,3) ; l'arme (portée 1-5) ne touche que depuis (2,0) (liste native).
// (1,0) et (-1,0) sont à la même distance de l'ennemi (4, donc G = -1) ; seule (1,0) est à 1 PM de la case de tir.
function duel({ danger, enemyLife = 100, damage = 60 }) {
	delete globalThis.System
	globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4 }
	const grid = new Map()
	for (let x = -2; x <= 2; x++) for (let y = 0; y <= 3; y++) grid.set(`${x},${y}`, { id: grid.size, x, y, entity: null, obstacle: false })
	const at = (x, y) => grid.get(`${x},${y}`) ?? null
	at(0, 1).obstacle = true // pas d'approche directe : seules (1,0) et (-1,0) sont à 1 PM
	const gun = { name: "gun", cost: 4, minRange: 1, maxRange: 5, maxUses: -1, needsLos: false,
		features: [{ type: 1, minValue: damage, maxValue: damage }] }
	const enemy = { id: 2, cell: at(0, 3), life: enemyLife, maxLife: enemyLife, absoluteShield: 0, relativeShield: 0, mp: 0 }
	const me = { id: 1, cell: at(0, 0), life: 100, maxLife: 100, strength: 0, wisdom: 0, tp: 4, mp: 1, weapon: gun,
		weapons: [gun], chips: [], effects: [], canUseWeapon: () => false, canUseChip: () => false }
	me.cell.entity = me; enemy.cell.entity = enemy
	globalThis.Field = { cellFromXY: at, lineOfSight: () => true }
	globalThis.Fight = { turn: 1, me, getAliveEnemies: () => [enemy], weaponCells: () => [at(2, 0)] }
	const config = new LogConfig(); config.setAll(false); initLeekLogging(config)
	const reachable = computeReachableCells(me, me.mp)
	const threat = new ThreatMap(me.id, 1, new Map([...reachable.entries()].map(({ cell, cost }) =>
		[cell.x * 4096 + cell.y, { cell, mpCost: cost, danger: danger(cell), breakdown: [] }])),
	{ candidateCells: reachable.size, truncated: false, inputsTruncated: false, enemyCount: 1, pairsEvaluated: 0, lineOfSightCalls: 0 })
	return evaluateTacticalPlans(me, new LeekProfile(), { reachable, threat }).plan
}

test("two cells of equal danger: the one that allows the weapon shot next turn wins; danger is still traded, never survival", () => {
	// Profil par défaut : w = 1. N = 0,75 x 60 = 45 en (1,0), 0 en (-1,0) ; score de (1,0) = G (-1) - danger + 45.
	for (const [useful, other, expected] of [
		[0, 0, [1, 0, 45]], // même danger : la case utile gagne (sans N : aucun plan, rester sur place)
		[43, 0, [1, 0, 45]], // -1 - 43 + 45 = 1 > 0 : le danger est accepté
		[45, 0, null], // -1 - 45 + 45 = -1 < 0 : rester
		[100, 0, null] // danger = mes PV : létal
	]) {
		const plan = duel({ danger: cell => cell.x === 1 ? useful : cell.x === -1 ? other : 0 })
		assert.deepEqual(plan && [plan.destination.x, plan.destination.y, plan.nextTurn], expected, `danger ${useful}`)
	}
	// Létal même quand N dépasserait LETHAL_PENALTY (cible à 3 000 PV, 3 000 de dégâts : N = 2 250 à 99 de danger).
	const rich = { enemyLife: 3000, damage: 3000 }
	assert.ok(0.75 * 3000 > LETHAL_PENALTY)
	assert.equal(duel({ ...rich, danger: cell => cell.x === 1 ? 99 : 0 }).nextTurn, 2250)
	assert.equal(duel({ ...rich, danger: cell => cell.x === 1 ? 100 : 0 }), null)
})
