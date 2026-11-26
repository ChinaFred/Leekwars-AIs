import assert from "node:assert/strict"
import test from "node:test"
import { evaluateTacticalPlans } from "../dist/Classes/Plannification/TacticalPlanner.js"
import { computeReachableCells } from "../dist/Classes/Context/ReachableCells.js"
import { ThreatMap } from "../dist/Classes/Context/ThreatMap.js"
import { LeekProfile } from "../dist/Classes/LeekProfile.js"
import { initLeekLogging, LogConfig, LOG_CONTEXT } from "../dist/Toolbox/Logger.js"

// Tours « condamnés » des combats 54969530, 54969527 et 54969622 (LWGarden/Data/fights/<id>) : le danger atteint mes PV
// (soin compris) sur toute case atteignable. Carte 18x18, obstacles, positions, PV, cooldowns et bouclier adverse :
// relevés du combat (fight.json). Carte de danger : celle du COMBAT (marques « Danger zone » de logs.json, arrondies à
// l'entier ; décimales reprises de la ligne [Threat] et du plan joué quand elles y figurent), pas recalculée. La zone
// atteignable est recalculée et comparée à celle du journal. Objets : mêmes définitions que
// next-turn-value-fight-54965081.test.mjs (spark sans ligne de vue : supposé). Ligne de vue : obstacles seulement.

const WIDTH = 18, HEIGHT = 18
const FIGHTS = {
	54969530: { enemyMp: 4, chest: 373, obstacles: { 6: 2, 26: 1, 28: 2, 37: 1, 43: 1, 48: 2, 75: 2, 81: 1, 146: 1, 159: 1,
		172: 2, 173: 1, 183: 1, 193: 2, 196: 1, 203: 1, 204: 2, 208: 1, 213: 2, 214: 1, 245: 1, 247: 2, 253: 1, 256: 1, 257: 2,
		263: 2, 270: 2, 276: 2, 325: 2, 333: 1, 337: 1, 345: 2, 348: 2, 351: 2, 381: 1, 391: 1, 400: 1, 409: 2, 417: 1, 441: 2,
		455: 1, 484: 1, 501: 1, 508: 2, 512: 1, 549: 1, 552: 1, 561: 2, 572: 1, 597: 1, 598: 1, 600: 1, 601: 1, 605: 1 } },
	54969527: { enemyMp: 4, obstacles: { 14: 2, 33: 2, 39: 1, 56: 1, 67: 1, 74: 1, 77: 2, 96: 2, 99: 2, 101: 2, 105: 1,
		108: 2, 161: 2, 172: 2, 177: 2, 200: 1, 209: 2, 214: 1, 221: 1, 225: 1, 231: 1, 233: 1, 235: 1, 260: 2, 275: 1, 283: 1,
		284: 1, 290: 1, 291: 2, 292: 1, 321: 2, 327: 1, 341: 1, 345: 2, 348: 2, 354: 2, 360: 1, 374: 1, 386: 2, 415: 2, 420: 1,
		441: 1, 447: 2, 451: 2, 458: 2, 462: 2, 470: 1, 474: 1, 483: 2, 511: 1, 512: 1, 521: 1, 527: 1, 529: 1, 532: 2, 533: 1,
		538: 2, 545: 2, 551: 1, 581: 1, 582: 1, 592: 1, 595: 1, 597: 1 } },
	54969622: { enemyMp: 5, obstacles: { 14: 2, 40: 2, 62: 2, 64: 2, 70: 1, 77: 2, 88: 2, 90: 2, 96: 1, 102: 1, 104: 1,
		114: 1, 139: 1, 148: 2, 157: 1, 170: 1, 172: 2, 188: 2, 211: 1, 218: 2, 228: 1, 242: 1, 250: 1, 259: 2, 263: 1, 264: 2,
		278: 2, 283: 1, 285: 2, 327: 2, 350: 1, 351: 2, 365: 1, 379: 1, 388: 1, 420: 1, 421: 2, 433: 2, 442: 1, 454: 1, 465: 2,
		479: 1, 486: 1, 487: 1, 488: 2, 494: 2, 504: 2, 510: 1, 520: 1, 527: 2, 550: 1, 567: 1, 585: 1, 600: 1, 606: 1 } }
}

// État au début du tour de Kassbi. `cooldowns` : puces pas prêtes ; `shield` : bouclier absolu de l'ennemi (helmet) ;
// `danger` : valeur → cases.
const TURNS = {
	"54969530:8": { me: 57, life: 96, maxLife: 360, enemy: 76, enemyLife: 86, shield: 15, cooldowns: { protein: 1 },
		danger: { 177.975: [126, 143, 144], 236.25: [57, 127], 239.4: [2, 3, 4, 5, 20, 21, 22, 38, 39, 40, 55, 56, 58, 72, 73,
			74, 90, 91, 107, 108, 109, 125, 142, 145] } },
	"54969530:10": { me: 163, life: 135, maxLife: 360, enemy: 111, enemyLife: 83, shield: 15, cooldowns: { helmet: 1 },
		danger: { 234.75: [164], 237.9: [73, 74, 91, 108, 109, 112, 113, 126, 127, 128, 129, 130, 143, 144, 145, 147, 148, 161,
			162, 163, 165, 178, 179, 180, 181, 182, 197, 198, 199, 200, 215, 216, 217, 218, 232, 233, 234, 235, 249, 250, 251, 252] } },
	"54969527:6": { me: 414, life: 189, maxLife: 363, enemy: 361, enemyLife: 241, shield: 15, cooldowns: {},
		danger: { 361.125: [359, 377, 378, 379, 394, 395, 396, 397, 412, 413, 414, 429, 430, 431, 448, 449, 466, 467, 484, 485,
			502, 503] } },
	"54969622:7": { me: 175, life: 72, maxLife: 360, enemy: 233, enemyLife: 169, shield: 0, cooldowns: { protein: 1 },
		danger: { 222: [175, 193, 210], 325.5: [124, 140, 141, 142, 158, 159, 160, 176, 177, 194, 195, 212, 229, 230] } },
	"54969622:8": { me: 193, life: 77, maxLife: 358, enemy: 287, enemyLife: 171, shield: 0, cooldowns: { cure: 1, helmet: 2 },
		danger: { 144: [140, 175, 210], 162: [158, 193], 210: [141, 176, 246], 222: [159, 177, 194, 195, 212, 213, 229, 230, 247],
			325.5: [124, 142, 143, 160, 178, 248] } }
}

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

const feature = (type, min, max, turns = 0) => ({ type, minValue: min, maxValue: max, turns, targets: 31, modifiers: 0 })
const weapon = (id, name, cost, minRange, maxRange, launchType, maxUses, features) =>
	({ id, name, cost, minRange, maxRange, launchType, maxUses, needsLos: true, area: 1, features })
const chip = (id, name, cost, cooldown, minRange, maxRange, features, extra = {}) =>
	({ id, name, cost, cooldown, currentCooldown: 0, minRange, maxRange, launchType: 7, maxUses: -1, needsLos: true, area: 1,
		features, ...extra })

function arena(name, dangerOverride = {}) {
	const turn = Number(name.split(":")[1])
	const fight = FIGHTS[name.split(":")[0]], state = TURNS[name]
	delete globalThis.System
	globalThis.Effect = { DAMAGE: 1, HEAL: 2, BUFF_STRENGTH: 3, BUFF_AGILITY: 4, RELATIVE_SHIELD: 5,
		ABSOLUTE_SHIELD: 6, BUFF_MP: 7, BUFF_TP: 8, DEBUFF: 9, POISON: 13, RAW_BUFF_TP: 32, RAW_BUFF_STRENGTH: 38 }
	const { cells, at } = buildGrid(fight.obstacles)
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
	const neutrino = weapon(182, "neutrino", 4, 2, 6, 2, 3, [feature(1, 25, 30), feature(26, 8, 8, 2)])
	const shotgun = weapon(41, "shotgun", 5, 1, 5, 1, 2, [feature(1, 33, 43), feature(27, 25, 25, 1)])
	const myChips = [
		chip(4, "cure", 4, 2, 0, 5, [feature(2, 38, 46)]), chip(7, "rock", 5, 1, 2, 6, [feature(1, 38, 39)]),
		chip(8, "protein", 3, 3, 0, 4, [feature(38, 80, 100, 2)]), chip(15, "motivation", 4, 6, 0, 5, [feature(32, 2, 2, 3)]),
		chip(18, "spark", 3, 0, 0, 10, [feature(1, 8, 16)], { needsLos: false }),
		chip(21, "helmet", 3, 3, 0, 4, [feature(6, 15, 15, 2)])
	]
	for (const item of myChips) item.currentCooldown = state.cooldowns[item.name] ?? 0
	const me = {
		id: 103947, name: "Kassbi", cell: cells[state.me], life: state.life, maxLife: state.maxLife, strength: 20, wisdom: 0,
		agility: 10, resistance: 10, science: 0, magic: 0, level: 25, absoluteShield: 0, relativeShield: 0, tp: 10, mp: 5,
		weapon: shotgun, weapons: [neutrino, shotgun], chips: myChips, launchedEffects: [], effects: [],
		canUseWeapon(target, item = this.weapon) { return !!item && this.tp >= item.cost && target.life > 0 && hits(this.cell, target.cell, item) },
		canUseChip(item, target) { return item.currentCooldown === 0 && this.tp >= item.cost && target.life > 0 && hits(this.cell, target.cell, item) },
		chipCells(item, target) { return cells.filter(cell => !cell.obstacle && hits(cell, target.cell, item)) }
	}
	const enemy = { id: 1, name: "enemy", cell: cells[state.enemy], life: state.enemyLife, maxLife: state.enemyLife,
		mp: fight.enemyMp, tp: 10, weapon: weapon(38, "machine_gun", 4, 1, 6, 1, 3, [feature(1, 10, 15)]), weapons: [], chips: [],
		absoluteShield: state.shield, relativeShield: 0, effects: [], launchedEffects: [] }
	for (const entity of [me, enemy]) { entity.cell.entity = entity; entity.cell.empty = false }
	if (fight.chest !== undefined) { cells[fight.chest].entity = { id: 2, name: "iron_chest" }; cells[fight.chest].empty = false }
	globalThis.Fight = { turn, me, getNearestEnemy: () => enemy, getAliveEnemies: () => [enemy], getEnemies: () => [enemy],
		getAllies: () => [me],
		weaponCells: (target, item) => cells.filter(cell => !cell.obstacle && hits(cell, target.cell ?? target, item)) }
	globalThis.Field = { cellFromXY: at, lineOfSight }
	const config = new LogConfig(); config.setAll(false); config.setEnabled(LOG_CONTEXT.PLANNING, true)
	initLeekLogging(config)
	const reachable = computeReachableCells(me, me.mp, turn)
	const dangerOf = new Map()
	for (const [value, ids] of Object.entries(state.danger)) for (const id of ids) dangerOf.set(id, Number(value))
	for (const [id, value] of Object.entries(dangerOverride)) dangerOf.set(Number(id), value)
	const zone = [...reachable.entries()].map(({ cell }) => cell.id).sort((a, b) => a - b)
	const threat = new ThreatMap(me.id, turn, new Map([...reachable.entries()].map(({ cell, cost }) =>
		[cell.x * 4096 + cell.y, { cell, mpCost: cost, danger: dangerOf.get(cell.id), breakdown: [] }])),
	{ candidateCells: reachable.size, truncated: false, inputsTruncated: false, enemyCount: 1, pairsEvaluated: 0, lineOfSightCalls: 0 })
	const profile = new LeekProfile()
	profile.setRole("AGGRESSIVE"); profile.setAggression(50); profile.setPreferredRange(3, 8)
	profile.setSupportOptions(true, true, true)
	const logs = []
	const print = console.log
	console.log = text => logs.push(String(text))
	let result
	try { result = evaluateTacticalPlans(me, profile, { reachable, threat }) } finally { console.log = print }
	const plan = result.plan
	return { zone, logged: [...dangerOf.keys()].sort((a, b) => a - b), logs, reason: result.reason, me, enemy, plan: plan && {
		shotCell: plan.shotCell.id, destination: plan.destination.id, weapon: plan.weapon?.name ?? null, shots: plan.weaponShots,
		chips: plan.chips.map(item => item.name), boost: (plan.boost?.chips ?? []).map(item => item.name),
		protection: plan.protection.map(item => item.name), tpUsed: plan.tpUsed,
		usefulDamage: Number(plan.usefulDamage.toFixed(2)), danger: plan.danger, score: Number(plan.score.toFixed(2)) } }
}

const DOOMED = /^\[Tactical\] doomed turn: /
const plan = (shotCell, destination, weapon, shots, chips, boost, protection, tpUsed, usefulDamage, danger, score) =>
	({ shotCell, destination, weapon, shots, chips, boost, protection, tpUsed, usefulDamage, danger, score })

// Plan joué dans le combat (version 28942a4) ; cette reconstruction le reproduisait avant le changement, score compris :
//   54969530:8  cure + helmet, repli en 126 (danger 177,975), 0 dégât, score -1115,71 (survie réelle : INCHANGÉ)
//   54969530:10 protein + cure, repli en 164, 0 dégât, score -1151,01
//   54969527:6  motivation + protein + neutrino x 1 depuis 396 : 42,75, score -1313,59
//   54969622:7  cure + helmet + spark x 1 depuis 193 (danger 222) : 14,4, score -1202,35 (survie réelle : INCHANGÉ)
//   54969622:8  protein, repli en 175 (danger 144), 0 dégât, score -1123,7
// Maintenant, en tour condamné : plus aucun crédit des tours suivants d'un boost (F = 0) ; le score existant décide du
// reste. 54969530:10 : rock depuis 145 à la place de protein, cure gardé (pas de coup fatal possible : cible à 83 PV sous
// casque 15, maximum rock + shotgun = 61,8). 54969527:6 : protein + rock (65,85), sans motivation. 54969622:8 : plus de
// protein ; spark x 3 (43,2) demanderait de finir en 176 (danger 210 au lieu de 144) : le score garde le repli, 10 PT libres.
const EXPECTED = {
	"54969530:8": plan(57, 126, null, 0, [], [], ["cure", "helmet"], 7, 0, 177.975, -1115.71),
	"54969530:10": plan(145, 164, null, 0, ["rock"], [], ["cure"], 9, 31.2, 234.75, -1171.11),
	"54969527:6": plan(414, 396, null, 0, ["rock"], ["protein"], [], 8, 65.85, 361.125, -1377.12),
	"54969622:7": plan(193, 193, null, 0, ["spark"], [], ["cure", "helmet"], 10, 14.4, 222, -1202.35),
	"54969622:8": plan(193, 175, null, 0, [], [], [], 0, 0, 144, -1175)
}

for (const name of Object.keys(TURNS)) {
	test(`combat ${name.replace(":", ", turn ")}: every plan is lethal, no boost is credited for later turns, the score decides the rest`, () => {
		const w = arena(name)
		assert.deepEqual(w.zone, w.logged, "reachable zone = the one logged in the fight")
		assert.equal(w.reason, "complete search")
		assert.equal(w.logs.filter(line => DOOMED.test(line)).length, 1, "doomed turn announced once")
		assert.ok(w.plan.danger >= w.me.life, "the danger model still says lethal: nothing was hidden")
		assert.deepEqual(w.plan, EXPECTED[name])
	})
}

test("doomed turn: a kill of the target (mean damage >= its life, under KILL_MARGIN) beats every other plan", () => {
	// 54969530, tour 10, cible ramenée de 83 à 60 PV : rock + shotgun = 61,8 >= 60 mais < 1,1 x 60 (le danger n'est pas
	// annulé). Sans la priorité, le score préférait cure + rock (31,2).
	TURNS["kill:10"] = { ...TURNS["54969530:10"], enemyLife: 60 }
	FIGHTS.kill = FIGHTS[54969530]
	const w = arena("kill:10")
	delete TURNS["kill:10"]; delete FIGHTS.kill
	assert.deepEqual([w.plan.weapon, w.plan.shots, w.plan.chips, w.plan.protection, w.plan.usefulDamage],
		["shotgun", 1, ["rock"], [], 60])
})

test("a protection that brings one cell under the lethal threshold: not a doomed turn, survival still comes first", () => {
	// 54969530, tour 8, case 126 ramenée de 177,975 à 150 : létale sans protection (150 >= 96 PV), plus avec cure + helmet
	// (150 - 15 = 135 < 96 + 42). Le plan reste celui d'avant le changement : soin, casque, repli, aucun tir.
	const w = arena("54969530:8", { 126: 150 })
	assert.deepEqual(w.logs.filter(line => DOOMED.test(line)), [])
	assert.deepEqual(w.plan, plan(57, 126, null, 0, [], [], ["cure", "helmet"], 7, 0, 150, -51.6))
})
