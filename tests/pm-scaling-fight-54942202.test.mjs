import assert from "node:assert/strict"
import test from "node:test"
import { TACTICAL_LIMITS } from "../dist/Classes/Plannification/TacticalTypes.js"
import { evaluateTacticalPlans } from "../dist/Classes/Plannification/TacticalPlanner.js"
import { executeTacticalPlan } from "../dist/Classes/Plannification/TacticalExecution.js"
import { EnemyMemory } from "../dist/Classes/Context/EnemyMemory.js"
import { computeReachableCells } from "../dist/Classes/Context/ReachableCells.js"
import { buildThreatMap, GeometricShotCells, MAX_THREAT_PAIRS } from "../dist/Classes/Context/ThreatMap.js"
import { LeekProfile } from "../dist/Classes/LeekProfile.js"
import { initLeekLogging, LogConfig } from "../dist/Toolbox/Logger.js"

// Combat 54942202 : Kassbi (niveau 18, 351 PV, 10 PT) vient de gagner 1 PM (4 -> 5) et a consommé ~4,1 M d'ops en 7 tours
// (erreurs d'exécution aux tours 5 et 6, ACTION_BUG 1002), contre ~0,2 M pour Shangrill. Carte 18x18 et obstacles : relevés
// du combat (règles du générateur Map.java/Cell.java reconstruites) ; objets : API officielle (armes 182 neutrino et 41
// shotgun ; puces ice, bandage, rock, protein, motivation, helmet ; ennemi : machine_gun, pistol, shock, ice, bandage,
// protein, pebble, force 66, 4 PM). Les puces de Kassbi sont ASSUMÉES identiques à celles du combat 54940819 (ids 2, 3, 7, 8,
// 15, 21). Les positions des tours 3 à 6 viennent de l'action MOVE_TO du combat. Aucun coût moteur n'est mesuré ici : les
// décisions attendues ont été relevées AVANT l'optimisation (même code qu'au commit précédent) et doivent rester identiques.
// Barème natif (documentation officielle LeekScript, non vérifié pour l'API TypeScript) : getCellsToUseWeapon/Chip = 25 834 ops.

const WIDTH = 18, HEIGHT = 18
const FIGHT_OBSTACLES = {
	16: 2, 28: 1, 42: 1, 43: 1, 82: 1, 120: 1, 133: 1, 137: 2, 152: 2, 157: 1, 160: 1, 161: 1, 163: 1, 165: 2, 175: 1, 190: 2,
	198: 1, 236: 1, 258: 1, 266: 1, 267: 1, 272: 2, 293: 1, 298: 1, 315: 1, 318: 1, 320: 2, 331: 2, 335: 2, 343: 1, 373: 2,
	378: 2, 381: 1, 382: 1, 394: 2, 427: 1, 442: 2, 450: 1, 453: 2, 456: 1, 457: 2, 461: 1, 467: 2, 469: 1, 478: 1, 496: 1,
	498: 2, 530: 2, 542: 1, 564: 2, 612: 1
}
const NATIVE_PROVIDER_OPS = 25834

function buildGrid(obstacles) {
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
	for (const [anchor, size] of Object.entries(obstacles)) {
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
const chip = (id, name, cost, cooldown, minRange, maxRange, features) =>
	({ id, name, cost, cooldown, currentCooldown: 0, minRange, maxRange, launchType: 7, maxUses: -1, needsLos: true, area: 1, features })

/** Un tour de Kassbi (`mp` PM) : mémoire, cases atteignables, carte de danger, puis plan tactique. */
function arena({ mp = 5, k = 164, e = 255, turn = 4, obstacles = FIGHT_OBSTACLES, ops } = {}) {
	delete globalThis.System
	globalThis.Effect = { DAMAGE: 1, HEAL: 2, BUFF_STRENGTH: 3, BUFF_AGILITY: 4, RELATIVE_SHIELD: 5,
		ABSOLUTE_SHIELD: 6, BUFF_MP: 7, BUFF_TP: 8, DEBUFF: 9, POISON: 13, RAW_BUFF_TP: 32, RAW_BUFF_STRENGTH: 38 }
	const { cells, at } = buildGrid(obstacles)
	const lineOfSightRaw = (start, end) => {
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
		return !item.needsLos || lineOfSightRaw(from, to)
	}
	const stats = { weaponCells: 0, chipCells: 0, cellFromXY: 0, lineOfSight: 0, firstMoveCellFromXY: null }
	const pistol = weapon(37, "pistol", 3, 1, 7, 7, 4, [feature(1, 15, 20)])
	const machineGun = weapon(38, "machine_gun", 4, 1, 6, 1, 3, [feature(1, 10, 15), feature(1, 10, 15), feature(1, 10, 15)])
	const neutrino = weapon(182, "neutrino", 4, 2, 6, 2, 3, [feature(1, 25, 30), feature(26, 8, 8, 2)])
	const shotgun = weapon(41, "shotgun", 5, 1, 5, 1, 2, [feature(1, 33, 43), feature(27, 25, 25, 1)])
	const myChips = [
		chip(2, "ice", 4, 0, 0, 8, [feature(1, 17, 19)]), chip(3, "bandage", 2, 1, 0, 6, [feature(2, 23, 28)]),
		chip(7, "rock", 5, 1, 2, 6, [feature(1, 38, 39)]), chip(8, "protein", 3, 3, 0, 4, [feature(38, 80, 100, 2)]),
		chip(15, "motivation", 4, 6, 0, 5, [feature(32, 2, 2, 3)]), chip(21, "helmet", 3, 3, 0, 4, [feature(6, 15, 15, 2)])
	]
	const enemyChips = [
		chip(1, "shock", 2, 0, 0, 6, [feature(1, 7, 9)]), chip(2, "ice", 4, 0, 0, 8, [feature(1, 17, 19)]),
		chip(3, "bandage", 2, 1, 0, 6, [feature(2, 23, 28)]), chip(8, "protein", 3, 3, 0, 4, [feature(38, 80, 100, 2)]),
		chip(19, "pebble", 2, 1, 0, 5, [feature(1, 2, 34)])
	]
	const me = {
		id: 103947, name: "Kassbi", cell: cells[k], life: 351, maxLife: 351, strength: 10, wisdom: 0, agility: 10,
		resistance: 10, science: 0, magic: 0, level: 18, absoluteShield: 0, relativeShield: 0, tp: 10, mp,
		weapon: shotgun, weapons: [shotgun, neutrino], chips: myChips, effects: [], launchedEffects: [], events: [],
		say() {}, distance(other) { return distance(this.cell, other.cell) },
		canUseWeapon(target, item = this.weapon) { return !!item && this.tp >= item.cost && target.life > 0 && hits(this.cell, target.cell, item) },
		canUseChip(item, target) { return item.currentCooldown === 0 && this.tp >= item.cost && target.life > 0 && hits(this.cell, target.cell, item) },
		chipCells(item, target) { stats.chipCells++; return cells.filter(cell => !cell.obstacle && hits(cell, target.cell, item)) },
		setWeapon() { return true },
		moveToward(destination, limit = this.mp) {
			stats.firstMoveCellFromXY ??= stats.cellFromXY
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
		id: 134917, name: "Shangrill", cell: cells[e], life: 339, maxLife: 339, mp: 4, tp: 10, strength: 66, agility: 0, wisdom: 0,
		resistance: 0, science: 0, magic: 0, level: 18, weapon: machineGun, weapons: [machineGun, pistol], chips: enemyChips,
		absoluteShield: 0, relativeShield: 0, effects: [], launchedEffects: [], frequency: 100, cores: 1, ram: 6
	}
	me.cell.entity = me; me.cell.empty = false; enemy.cell.entity = enemy; enemy.cell.empty = false
	let clock = ops?.start ?? 0
	globalThis.Fight = { turn, me, getNearestEnemy: () => enemy, getAliveEnemies: () => [enemy], getEnemies: () => [enemy],
		getAllies: () => [me],
		weaponCells(target, item) {
			stats.weaponCells++
			return cells.filter(cell => !cell.obstacle && hits(cell, target.cell ?? target, item))
		} }
	globalThis.Field = {
		cellFromXY(x, y) { stats.cellFromXY++; return at(x, y) },
		getObstacles: () => cells.filter(cell => cell.obstacle), distance,
		lineOfSight(a, b) { stats.lineOfSight++; clock += ops?.perLineOfSight ?? 0; return lineOfSightRaw(a, b) }, pathLength: () => 0
	}
	if (ops) globalThis.System = { get operations() { return clock }, maxOperations: ops.max ?? 1000000 }
	const config = new LogConfig(); config.setAll(false); initLeekLogging(config)
	const memory = new EnemyMemory()
	memory.identify(enemy, 1); memory.update(enemy, me, turn, 1)
	memory.updateReachable(me, [], [enemy], turn)
	memory.updateThreatMap(me, [enemy], turn)
	const profile = new LeekProfile()
	const context = { reachable: memory.getReachable(me.id), threat: memory.getThreatMap() }
	return { me, enemy, cells, stats, memory, context, profile, nativeOps: () => stats.weaponCells * NATIVE_PROVIDER_OPS +
		stats.chipCells * NATIVE_PROVIDER_OPS + stats.lineOfSight * 31 + stats.cellFromXY * 5,
		evaluate: () => evaluateTacticalPlans(me, profile, context),
		execute: (plan) => executeTacticalPlan(me, plan) }
}

const describe = (plan) => plan === null ? null : {
	destination: plan.destination.id, shotCell: plan.shotCell.id, weapon: plan.weapon?.name ?? null, weaponShots: plan.weaponShots,
	chips: plan.chips.map(item => item.name), protection: plan.protection.map(item => item.name),
	danger: Number(plan.danger.toFixed(3)), score: Number(plan.score.toFixed(3)),
	nextTurn: Number((plan.nextTurn ?? 0).toFixed(3)), tpUsed: plan.tpUsed,
	boost: (plan.boost?.chips ?? []).map(item => item.name)
}
const done = () => { delete globalThis.System }

// Décisions aux positions réelles des tours 3 à 6 (Kassbi 180 puis 164 ; Shangrill 326, 255, 218, 199), à 4 comme à 5 PM.
// Relevées de nouveau quand le boost est devenu une composante du plan et que le bouclier a été soumis au seuil du rôle
// (avant : aucun boost dans le plan, score 2/3/1/1 aux tours 3-4, deux tirs de shotgun ou repli + helmet au tour 5,
// neutrino + rock au tour 6). À pleine vie, helmet n'est plus candidat ; protein (+90 force, 2 tours) et motivation
// (+2 PT, 3 tours) sont crédités de leurs tours suivants. Les optimisations d'opérations ne changent aucune décision.
// Tour 4 relevé de nouveau quand une puce offensive est devenue créditée après déplacement (avant : protein seul, score
// 52,3, sans quitter 164 avant le tir) : aller-retour vers une case de tir de ice (4 PM, case 130) ou de rock (5 PM, case 148).
// Relevées de nouveau quand la carte de danger a compté plusieurs fois les puces sans cooldown de l'ennemi (shock, ice),
// avec le maximum exact arme + puces : tour 6, danger 90,88 -> 92,16 (score 46,62 -> 45,34), décision inchangée ; tour 5,
// danger de la case 217 : 124,5 -> 154,38. À 4 PM le tir est gardé (score 13 -> -16,88) ; à 5 PM la DÉCISION CHANGE :
// avant, neutrino depuis 217 (score 13) ; maintenant protein seul et repli en 74 (danger 59,76, score -8,46).
// Relevées de nouveau avec le terme N (`nextTurn` : valeur de la case finale au tour suivant, qui ne dépend que de cette
// case et de l'arme en main à la fin du plan), sur le code qui crédite aussi les puces après déplacement. Tours 3, 4 et 6 :
// mêmes décisions, scores + N (tour 4 : 87,3 -> 133,913 à 4 PM, 128,3 -> 191,413 à 5 PM ; tour 6 : 45,34 -> 99,79). Tour 5 à
// 4 PM : même décision (score -16,88 -> 37,57). Tour 5 à 5 PM, la DÉCISION CHANGE : avant, protein seul et repli en 74
// (danger 59,76, score -8,46, aucun item utilisable de là au tour suivant) ; maintenant, comme à 4 PM, motivation + protein
// + neutrino depuis 217 (danger 154,38, N = 0,75 x 72,6 : neutrino + rock, score 37,57).
// Rejoué avec le comportement unique (`LeekBehavior`, poids du risque 0,5, approche 1,25 ; avant : profil BALANCED, poids 1) :
// destinations et dangers inchangés, scores et N plus hauts ; aux tours 5 (4 et 5 PM) et 6 (5 PM) le plan lance rock + protein
// au lieu de motivation + protein + neutrino (danger identique, 154,38 au tour 5).
const EXPECTED = {
	"4PM T3 180/326": { destination: 146, shotCell: 180, weapon: null, weaponShots: 0, chips: [], protection: [], danger: 0, score: 53.8, nextTurn: 0, tpUsed: 3, boost: ["protein"] },
	"4PM T4 164/255": { destination: 147, shotCell: 130, weapon: null, weaponShots: 0, chips: ["ice"], protection: [], danger: 0, score: 145.566, nextTurn: 58.266, tpUsed: 7, boost: ["protein"] },
	"4PM T5 164/218": { destination: 217, shotCell: 217, weapon: null, weaponShots: 0, chips: ["rock"], protection: [], danger: 154.38, score: 130.001, nextTurn: 78.891, tpUsed: 8, boost: ["protein"] },
	"4PM T6 164/199": { destination: 127, shotCell: 164, weapon: "neutrino", weaponShots: 1, chips: [], protection: [], danger: 92.16, score: 159.483, nextTurn: 68.063, tpUsed: 12, boost: ["motivation", "protein"] },
	"5PM T3 180/326": { destination: 164, shotCell: 180, weapon: null, weaponShots: 0, chips: [], protection: [], danger: 0, score: 55.05, nextTurn: 0, tpUsed: 3, boost: ["protein"] },
	"5PM T4 164/255": { destination: 147, shotCell: 148, weapon: null, weaponShots: 0, chips: ["rock"], protection: [], danger: 0, score: 207.191, nextTurn: 78.891, tpUsed: 8, boost: ["protein"] },
	"5PM T5 164/218": { destination: 217, shotCell: 217, weapon: null, weaponShots: 0, chips: ["rock"], protection: [], danger: 154.38, score: 130.001, nextTurn: 78.891, tpUsed: 8, boost: ["protein"] },
	"5PM T6 164/199": { destination: 127, shotCell: 164, weapon: null, weaponShots: 0, chips: ["rock"], protection: [], danger: 92.16, score: 161.111, nextTurn: 78.891, tpUsed: 8, boost: ["protein"] }
}

test("combat 54942202 at 4 and 5 MP: the tactical decisions are exactly the recorded ones (boost in the plan)", () => {
	try {
		for (const mp of [4, 5]) for (const [turn, k, e] of [[3, 180, 326], [4, 164, 255], [5, 164, 218], [6, 164, 199]]) {
			const name = `${mp}PM T${turn} ${k}/${e}`
			const result = arena({ mp, k, e, turn }).evaluate()
			assert.equal(result.reason, "complete search", name)
			assert.deepEqual(describe(result.plan), EXPECTED[name], name)
		}
	} finally { done() }
})

test("the extra MP adds reachable cells but never a native shot-cell provider call for an unreachable item", () => {
	try {
		const four = arena({ mp: 4, k: 180, e: 326, turn: 3 })
		const five = arena({ mp: 5, k: 180, e: 326, turn: 3 })
		assert.ok(five.context.reachable.size > four.context.reachable.size * 1.4, "cells grow strongly with the MP")
		for (const w of [four, five]) {
			w.evaluate()
			// Cible à 10 de ma case : aucune case atteignable (4 ou 5 PM) n'est à portée du shotgun (1-5), du neutrino (2-6),
			// de la glace (0-8) ni du rock (2-6) : aucun fournisseur natif (25 834 ops l'appel), 1 avant l'optimisation.
			assert.equal(w.stats.weaponCells + w.stats.chipCells, 0)
		}
	} finally { done() }
})

test("a native provider is called exactly for the items some reachable cell can fire from (Manhattan range), at 4 and 5 MP", () => {
	try {
		let checked = 0, called = 0, skippedByTighterGate = 0
		const probe = arena({ mp: 5, k: 164, turn: 4 })
		const free = probe.cells.filter(cell => !cell.obstacle && cell.id !== 164 && distance(cell, probe.cells[164]) <= 14)
		for (const mp of [4, 5]) for (const target of free.filter((_, i) => i % 5 === 0)) {
			const w = arena({ mp, k: 164, e: target.id, turn: 4 })
			const reachable = w.context.reachable
			const fromReachable = (item) => [...reachable.entries()].some(({ cell }) => {
				const range = distance(cell, target)
				return range >= item.minRange && range <= item.maxRange
			})
			const loose = (item) => distance(w.me.cell, target) <= item.maxRange + mp
			const items = [...w.me.weapons, ...w.me.chips.filter(item => item.name === "ice" || item.name === "rock")]
			w.evaluate()
			assert.equal(w.stats.weaponCells + w.stats.chipCells, items.filter(fromReachable).length, `${mp} MP, enemy ${target.id}`)
			checked++
			called += w.stats.weaponCells + w.stats.chipCells
			skippedByTighterGate += items.filter(item => loose(item) && !fromReachable(item)).length
		}
		assert.ok(checked > 30 && called > 30, `checked ${checked}, provider calls ${called}`)
		assert.ok(skippedByTighterGate > 0, "the sample contains items the old distance-plus-MP gate still loaded")
	} finally { done() }
})

test("the approach computes only cells within the planned approach cost, not the whole zone of this turn's MP", () => {
	try {
		const w = arena({ mp: 5, k: 164, e: 56, turn: 4 })
		// Boosts en délai : avec eux, le plan tire sur place (protein + rock) et ce test n'aurait plus d'approche à mesurer.
		for (const item of w.me.chips) if (item.name === "protein" || item.name === "motivation") item.currentCooldown = 1
		const { plan } = w.evaluate()
		assert.deepEqual([plan.shotCell.id, plan.beforeMp, plan.destination.id, plan.weaponShots, plan.chips.map(c => c.name)],
			[146, 1, 181, 1, ["rock"]])
		const before = w.stats.cellFromXY
		w.execute(plan)
		// Avant : un parcours à 5 PM (la zone entière) pour lire le coût d'une case à 1 pas. Maintenant : rayon 1, au plus 5 cases × 4 voisins.
		assert.ok(w.stats.firstMoveCellFromXY - before <= 4 * 5, `${w.stats.firstMoveCellFromXY - before} cellFromXY calls before the approach`)
		assert.deepEqual(w.me.events.slice(0, 1), ["move:146"])
		assert.equal(w.me.cell.id, 181)
	} finally { done() }
})

test("the threat map stops at the global search ceiling instead of exhausting the turn", () => {
	try {
		const free = arena({ mp: 5, k: 164, e: 218, turn: 5, ops: { start: 0, perLineOfSight: 0 } })
		assert.equal(free.memory.getThreatMap().truncated, false)
		// Chaque ligne de vue coûte 4 000 ops (synthétique) : 		depuis 790 000, le plafond de 800 000 est franchi à la 3e.
				const costly = arena({ mp: 5, k: 164, e: 218, turn: 5, ops: { start: 790000, perLineOfSight: 4000 } })
		const map = costly.memory.getThreatMap()
		assert.equal(map.truncated, true)
		assert.ok(map.size < map.candidateCells, `${map.size}/${map.candidateCells} cells`)
		assert.ok(costly.stats.lineOfSight <= free.stats.lineOfSight / 4, `${costly.stats.lineOfSight} vs ${free.stats.lineOfSight} LoS`)
		const result = costly.evaluate()
		assert.equal(result.plan, null)
		assert.equal(result.reason, "operations reserve")
	} finally { done() }
})

test("the grouped threat-map provider path gives the same map, pairs and line-of-sight calls as item-by-item canHit", () => {
	try {
		for (const [mp, k, e, turn] of [[5, 164, 218, 5], [5, 164, 199, 6], [4, 164, 255, 4], [5, 180, 326, 3]]) {
			const w = arena({ mp, k, e, turn })
			const enemy = w.enemy
			const input = {
				id: enemy.id, name: enemy.name, strength: enemy.strength, tp: enemy.tp, weapon: enemy.weapon,
				otherWeapons: [enemy.weapons[1]], chips: enemy.chips, boosts: [enemy.chips[3]], science: 0,
				reachable: computeReachableCells(enemy, 4, turn, { ignoreEntityId: w.me.id })
			}
			const grouped = buildThreatMap(w.me, w.context.reachable, [input], turn)
			const base = new GeometricShotCells()
			const single = buildThreatMap(w.me, w.context.reachable, [input], turn, { provider: { canHit: (a, b, c) => base.canHit(a, b, c) } })
			assert.equal(grouped.pairsEvaluated, single.pairsEvaluated)
			assert.equal(grouped.lineOfSightCalls, base.lineOfSightCalls)
			assert.equal(grouped.size, single.size)
			for (const entry of single.entries()) {
				assert.equal(grouped.dangerAt(entry.cell), entry.danger, `${mp} MP, cell ${entry.cell.id}`)
				assert.deepEqual(grouped.breakdownAt(entry.cell), entry.breakdown, `${mp} MP, cell ${entry.cell.id}`)
			}
			assert.ok(grouped.maxDanger > 0, "the scenario exposes real danger")
		}
	} finally { done() }
})

test("budget guards on an open arena: 7 MP (113 cells) stays in the joint plan, 8 MP falls back with a known reason, pairs bounded", () => {
	try {
		const sizes = []
		for (const mp of [4, 5, 6, 7, 8]) {
			const w = arena({ mp, k: 306, e: 468, turn: 4, obstacles: {} })
			const map = w.memory.getThreatMap()
			sizes.push(w.context.reachable.size)
			assert.ok(map.pairsEvaluated <= MAX_THREAT_PAIRS, `${mp} MP: ${map.pairsEvaluated} pairs`)
			const result = w.evaluate()
			// Jusqu'à 7 PM (5 PM + bottes) : carte de danger complète et recherche conjointe menée à son terme.
			if (mp <= 7) {
				assert.equal(map.truncated, false, `${mp} MP`)
				assert.equal(result.reason, "complete search", `${mp} MP`)
				assert.ok(result.plan, `${mp} MP`)
			} else {
				assert.ok(w.context.reachable.size > TACTICAL_LIMITS.cells, `${mp} MP`)
				assert.equal(result.reason, "cells/PT bound", `${mp} MP`)
				assert.equal(result.plan, null, `${mp} MP`)
			}
		}
		assert.equal(TACTICAL_LIMITS.cells, 113)
		// Un losange complet : 2 mp² + 2 mp + 1 cases (41, 61, 85, 113, 145) tant que la carte ne le coupe pas.
		assert.deepEqual(sizes, [41, 61, 85, 113, 145])
	} finally { done() }
})
