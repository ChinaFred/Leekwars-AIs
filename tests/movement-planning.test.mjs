import assert from "node:assert/strict"
import test from "node:test"

import { planAct } from "../dist/Brain/PlanActScenario.js"
import { LeekProfile } from "../dist/Classes/LeekProfile.js"

// Mini-monde 1D/2D : grille de cellules, distance de Manhattan, PM/PT consommés par les mocks.
// Les actions sont journalisées avec la distance au moment de l'exécution.
const MIN_COORD = -8
const MAX_COORD = 12

function manhattan(a, b) {
	return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
}

function buildWorld({
	myPos,
	enemyPos,
	myMp,
	enemyMp = 0,
	tp,
	life = 100,
	weapon,
	enemyWeapon,
	chips = [],
	obstacles = [],
	blocked = []
}) {
	const grid = new Map()
	let nextId = 0
	for (let x = MIN_COORD; x <= MAX_COORD; x++) {
		for (let y = MIN_COORD; y <= MAX_COORD; y++) {
			grid.set(`${x},${y}`, { id: nextId++, x, y, empty: true, obstacle: false, entity: null })
		}
	}
	for (const [x, y] of obstacles) {
		Object.assign(grid.get(`${x},${y}`), { empty: false, obstacle: true })
	}
	for (const [x, y] of blocked) {
		Object.assign(grid.get(`${x},${y}`), { empty: false })
	}
	const cellAt = (x, y) => grid.get(`${x},${y}`) ?? null

	const log = []
	const state = { tp, mp: myMp, cell: cellAt(myPos[0], myPos[1]) }
	const target = {
		id: 2,
		name: "enemy",
		cell: cellAt(enemyPos[0], enemyPos[1]),
		life: 100,
		maxLife: 100,
		mp: enemyMp,
		weapon: enemyWeapon
	}

	const walk = (towardX, steps) => {
		const direction = Math.sign(towardX - state.cell.x)
		const moved = Math.min(steps, Math.abs(towardX - state.cell.x))
		state.cell = cellAt(state.cell.x + direction * moved, state.cell.y)
		state.mp -= moved
		return moved
	}

	const me = {
		id: 1,
		name: "me",
		get cell() { return state.cell },
		life,
		maxLife: 100,
		get mp() { return state.mp },
		get tp() { return state.tp },
		strength: 0,
		wisdom: 0,
		weapons: [weapon],
		chips,
		weapon,
		distance: (other) => manhattan(state.cell, other.cell),
		setWeapon() { log.push("equip") },
		chipCells: () => [state.cell],
		canUseWeapon: () => {
			const distance = manhattan(state.cell, target.cell)
			return state.tp >= weapon.cost && distance >= weapon.minRange && distance <= weapon.maxRange
		},
		useWeapon() {
			log.push(`shoot@${manhattan(state.cell, target.cell)}`)
			state.tp -= weapon.cost
		},
		useChip(chip) {
			log.push(`chip:${chip.name}`)
			state.tp -= chip.cost
		},
		moveToward(destination) {
			const from = manhattan(state.cell, target.cell)
			const destinationX = (destination.cell ?? destination).x
			walk(destinationX, state.mp)
			log.push(`toward:${JSON.stringify([(destination.cell ?? destination).x, (destination.cell ?? destination).y])}` +
				` (${from}->${manhattan(state.cell, target.cell)})`)
			return 1
		},
		moveAwayFrom(other) {
			const from = manhattan(state.cell, other.cell)
			const direction = state.cell.x >= other.cell.x ? 1 : -1
			walk(Math.max(MIN_COORD, Math.min(MAX_COORD, state.cell.x + direction * state.mp)), state.mp)
			log.push(`away:${from}->${manhattan(state.cell, other.cell)}`)
			return 1
		}
	}

	globalThis.Fight = {
		me,
		getNearestEnemy: () => target,
		getEnemies: () => [target],
		getAliveEnemies: () => [target],
		getAllies: () => [me]
	}
	globalThis.Field = {
		distance: manhattan,
		getObstacles: () => obstacles.map(([x, y]) => cellAt(x, y)),
		cellFromXY: cellAt
	}
	globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4 }
	globalThis.Chip = {
		bandage: { name: "bandage", cost: 1, currentCooldown: 0, features: [{ type: 2, minValue: 5, maxValue: 15 }] }
	}
	globalThis.Weapon = { pistol: weapon }

	return { me, target, log, state }
}

const pistol = (maxRange) => ({
	name: "gun",
	cost: 2,
	minRange: 1,
	maxRange,
	features: [{ type: 1, minValue: 10, maxValue: 10 }]
})

function profile({ aggression = 50, hiding = true } = {}) {
	const result = new LeekProfile()
	result.setRole("BALANCED")
	result.setAggression(aggression)
	result.setSupportOptions(true, true, hiding)
	return result
}

// ---------------------------------------------------------------------------
// Point 1 : choix de la cellule de repli
// ---------------------------------------------------------------------------
test("retreat_to_corner heads for a free cell next to the obstacle farthest from the enemy", () => {
	const { me, log } = buildWorld({
		myPos: [0, 0],
		enemyPos: [10, 0],
		myMp: 3,
		enemyMp: 6,
		tp: 4,
		weapon: pistol(1),
		enemyWeapon: { maxRange: 4 },
		// A est collé à l'ennemi (l'ancien score le choisissait), B est proche de moi, C est le plus loin de l'ennemi.
		obstacles: [[11, 0], [-3, 0], [-5, 2]],
		// (-6,2) est voisin de C mais occupé : il doit être ignoré.
		blocked: [[-6, 2]]
	})

	planAct(me, profile())

	const moves = log.filter((entry) => entry.startsWith("toward:"))
	// Voisins de C=(-5,2) : (-6,2) bloqué ; (-5,3) score 18−0,8=17,2 ; (-4,2) et (-5,1) 16−0,6=15,4.
	assert.equal(moves.length, 1, `log: ${log.join(" | ")}`)
	assert.ok(moves[0].startsWith("toward:[-5,3]"), moves[0])
	assert.ok(!log.some((entry) => entry.startsWith("toward:[11,0]")), "ne doit plus viser l'obstacle voisin de l'ennemi")
	assert.ok(!log.some((entry) => entry.startsWith("toward:[-5,2]")), "ne doit pas viser la cellule d'obstacle elle-même")
})

test("retreat_to_corner falls back to moveAwayFrom when no obstacle neighbour is free and farther", () => {
	const { me, log } = buildWorld({
		myPos: [0, 0],
		enemyPos: [10, 0],
		myMp: 3,
		enemyMp: 6,
		tp: 4,
		weapon: pistol(1),
		enemyWeapon: { maxRange: 4 },
		obstacles: [[-5, 2]],
		blocked: [[-4, 2], [-6, 2], [-5, 3], [-5, 1]]
	})

	planAct(me, profile())

	assert.ok(log.some((entry) => entry.startsWith("away:")), `log: ${log.join(" | ")}`)
	assert.ok(!log.some((entry) => entry.startsWith("toward:")))
})

// ---------------------------------------------------------------------------
// Point 2 : tir planifié aussi dans l'ordre « situation critique »
// ---------------------------------------------------------------------------
test("critical order still plans the shots (30% life, distance 6, usable weapon, 9 TP)", () => {
	const { me, log } = buildWorld({
		myPos: [0, 0],
		enemyPos: [6, 0],
		myMp: 4,
		enemyMp: 3,
		tp: 9,
		life: 30,
		weapon: { ...pistol(12), cost: 3 },
		enemyWeapon: { maxRange: 4 }
	})

	planAct(me, profile())

	// Ordre critique inchangé (repli en premier), puis 3 tirs (9 PT / 3), gardés par canUseWeapon à l'exécution.
	assert.deepEqual(log, ["away:6->10", "shoot@10", "shoot@10", "shoot@10"])
})

test("critical order plans the attack chip before the shots", () => {
	const attackChip = {
		name: "spark",
		cost: 1,
		currentCooldown: 0,
		features: [{ type: 1, minValue: 4, maxValue: 8 }]
	}
	const { me, log } = buildWorld({
		myPos: [0, 0],
		enemyPos: [6, 0],
		myMp: 4,
		enemyMp: 3,
		tp: 9,
		life: 35,
		weapon: { ...pistol(12), cost: 3 },
		enemyWeapon: { maxRange: 4 },
		chips: [attackChip]
	})

	// Agressivité 100 : repli critique (vie <= 0,40) ET chip d'attaque autorisée (vie >= 0,30) à 35 %.
	planAct(me, profile({ aggression: 100 }))

	assert.deepEqual(log, ["away:6->10", "chip:spark", "shoot@10", "shoot@10"])
})

// ---------------------------------------------------------------------------
// Point 4 : recul après tir quand les deux peuvent tirer
// ---------------------------------------------------------------------------
function runZoneControl({ distance, myMp, enemyMp = 0, enemyRange = 3, aggressionProfile = profile() }) {
	const { me, log, state, target } = buildWorld({
		myPos: [0, 0],
		enemyPos: [distance, 0],
		myMp,
		enemyMp,
		tp: 6,
		weapon: pistol(5),
		enemyWeapon: { maxRange: enemyRange }
	})
	planAct(me, aggressionProfile)
	return { log, finalDistance: manhattan(state.cell, target.cell) }
}

test("zone_control shoots first, then retreats out of the enemy range", () => {
	const { log, finalDistance } = runZoneControl({ distance: 3, myMp: 3 })

	assert.deepEqual(log, ["shoot@3", "shoot@3", "shoot@3", "away:3->6"])
	assert.ok(finalDistance > 3, "doit finir hors de la portée (3) de l'ennemi")
})

test("zone_control retreat boundary: distance == enemy max range retreats, distance + 1 does not", () => {
	const atRange = runZoneControl({ distance: 3, myMp: 3, enemyRange: 3 })
	assert.ok(atRange.log.some((entry) => entry.startsWith("away:")), `log: ${atRange.log.join(" | ")}`)

	const justOutside = runZoneControl({ distance: 4, myMp: 3, enemyRange: 3 })
	assert.deepEqual(justOutside.log, ["shoot@4", "shoot@4", "shoot@4"])
})

test("zone_control retreat accounts for the enemy movement points", () => {
	// Ennemi mobile (PM 2, portée 3 : allonge 5) à distance 4, j'ai 3 PM : 4 + 3 − 2 = 5 > 3 → je peux en sortir.
	const escape = runZoneControl({ distance: 4, myMp: 3, enemyMp: 2, enemyRange: 3 })
	assert.deepEqual(escape.log, ["shoot@4", "shoot@4", "shoot@4", "away:4->7"])

	// Ennemi très mobile (PM 4) : 4 + 2 − 4 = 2 <= 3 → impossible de sortir de sa portée, on reste (pas de recul inutile).
	const cannotEscape = runZoneControl({ distance: 4, myMp: 2, enemyMp: 4, enemyRange: 3 })
	assert.deepEqual(cannotEscape.log, ["shoot@4", "shoot@4", "shoot@4"])
})

test("zone_control does not retreat when no retreat can leave the enemy range or without MP", () => {
	// Distance 2, portée ennemie 5, 1 PM : 2 + 1 = 3 <= 5 → reculer ne sert à rien.
	const useless = runZoneControl({ distance: 2, myMp: 1, enemyRange: 5 })
	assert.deepEqual(useless.log, ["shoot@2", "shoot@2", "shoot@2"])

	const noMp = runZoneControl({ distance: 3, myMp: 0, enemyRange: 3 })
	assert.deepEqual(noMp.log, ["shoot@3", "shoot@3", "shoot@3"])
})

test("zone_control retreat respects a profile that forbids hiding", () => {
	const { log } = runZoneControl({ distance: 3, myMp: 3, aggressionProfile: profile({ hiding: false }) })
	assert.deepEqual(log, ["shoot@3", "shoot@3", "shoot@3"])
})

test("planHide keeps priority over the post-shot retreat and the MP are not spent twice", () => {
	// 35 % de vie à distance 3 : ordre critique, repli (hide) puis tirs ; le recul après tir ne s'ajoute pas.
	const { me, log } = buildWorld({
		myPos: [0, 0],
		enemyPos: [3, 0],
		myMp: 3,
		enemyMp: 0,
		tp: 6,
		life: 35,
		weapon: pistol(12),
		enemyWeapon: { maxRange: 3 }
	})

	planAct(me, profile())

	assert.equal(log.filter((entry) => entry.startsWith("away:")).length, 1, `log: ${log.join(" | ")}`)
	assert.equal(log[0], "away:3->6")
})

// ---------------------------------------------------------------------------
// Compatibilité : API de terrain absente, ennemi sans arme, soin avant recul
// ---------------------------------------------------------------------------
test("retreat_to_corner falls back to moveAwayFrom when Field.getObstacles or Field.cellFromXY is missing", () => {
	for (const missing of ["getObstacles", "cellFromXY"]) {
		const { me, log } = buildWorld({
			myPos: [0, 0],
			enemyPos: [10, 0],
			myMp: 3,
			enemyMp: 6,
			tp: 4,
			weapon: pistol(1),
			enemyWeapon: { maxRange: 4 },
			obstacles: [[-5, 2]]
		})
		delete globalThis.Field[missing]

		planAct(me, profile())

		assert.ok(log.some((entry) => entry.startsWith("away:")), `${missing} absent, log: ${log.join(" | ")}`)
		assert.ok(!log.some((entry) => entry.startsWith("toward:")), `${missing} absent, log: ${log.join(" | ")}`)
	}
})

test("enemy without weapon is assumed to have range 1: retreat at distance 1, none at distance 2", () => {
	const run = (distance) => {
		const { me, log } = buildWorld({
			myPos: [0, 0],
			enemyPos: [distance, 0],
			myMp: 2,
			enemyMp: 0,
			tp: 6,
			weapon: pistol(5),
			enemyWeapon: null
		})
		planAct(me, profile())
		return log
	}

	assert.deepEqual(run(1), ["shoot@1", "shoot@1", "shoot@1", "away:1->3"])
	assert.deepEqual(run(2), ["shoot@2", "shoot@2", "shoot@2"])
})

test("post-shot retreat is the last action: heal is used before moving away", () => {
	const { me, log } = buildWorld({
		myPos: [0, 0],
		enemyPos: [3, 0],
		myMp: 3,
		enemyMp: 0,
		tp: 7,
		life: 65,
		weapon: pistol(5),
		enemyWeapon: { maxRange: 3 }
	})
	me.chips.push(globalThis.Chip.bandage)

	planAct(me, profile())

	assert.equal(log.at(-1), "away:3->6", `log: ${log.join(" | ")}`)
	assert.ok(log.includes("chip:bandage"), `log: ${log.join(" | ")}`)
	assert.ok(log.indexOf("chip:bandage") < log.indexOf("away:3->6"))
	assert.equal(log.filter((entry) => entry.startsWith("away:")).length, 1)
})
