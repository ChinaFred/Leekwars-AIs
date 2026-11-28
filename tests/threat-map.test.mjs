import assert from "node:assert/strict"
import { makeTurnWorld } from "./helpers/turn-world.mjs"
import test from "node:test"

globalThis.Color = { rgb: () => 0 }
const debugLogs = []
globalThis.Debug = { log: (message) => debugLogs.push(message), pause() {} }
globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4, POISON: 5, BUFF_STRENGTH: 6 }
globalThis.Fight = { turn: 1 }

const { computeReachableCells } = await import("../dist/Classes/Context/ReachableCells.js")
const { LAUNCH_TYPE, isCellInLaunchPattern } = await import("../dist/Classes/Context/LaunchPattern.js")
const {
	isStrengthBoostType, isTpBoostType, meanDamage, planShots, toCandidate, sortByRatio, strengthBoostOf, tpBoostOf, tpBoostTurns
} = await import("../dist/Classes/Context/ShotPlan.js")
const { buildThreatMap, GeometricShotCells, MAX_THREAT_PAIRS, MAX_THREAT_WEAPONS } = await import("../dist/Classes/Context/ThreatMap.js")
const { EnemyMemory } = await import("../dist/Classes/Context/EnemyMemory.js")

// --- mocks -----------------------------------------------------------------

/** Grille [0,width) x [0,height) ; `Field.cellFromXY` et `Field.lineOfSight` (lignes droites seulement, obstacles). */
function makeGrid(width, height, obstacles = []) {
	const cells = new Map()
	const losCalls = []
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
		cellFromXY: (x, y) => cells.get(`${x},${y}`) ?? null,
		lineOfSight(from, to) {
			losCalls.push(`${from.x},${from.y}>${to.x},${to.y}`)
			if (from.y === to.y) {
				for (let x = Math.min(from.x, to.x) + 1; x < Math.max(from.x, to.x); x++) {
					if (cells.get(`${x},${from.y}`)?.obstacle) {
						return false
					}
				}
			}
			return true
		}
	}
	return {
		cells,
		losCalls,
		cell: (x, y) => cells.get(`${x},${y}`),
		place(entity, x, y) {
			const cell = cells.get(`${x},${y}`)
			cell.entity = entity
			cell.empty = false
			entity.cell = cell
			return entity
		}
	}
}

const weapon = ({ id = 1, name = "w", cost = 3, min = 10, max = 20, minRange = 1, maxRange = 8, ...rest } = {}) =>
	({ id, name, cost, minRange, maxRange, needsLos: false, features: [{ type: 1, minValue: min, maxValue: max }], ...rest })

const chip = ({ id = 10, name = "c", cost = 4, min = 25, max = 35, minRange = 1, maxRange = 8, cooldown = 0, ...rest } = {}) =>
	({ id, name, cost, cooldown, currentCooldown: 0, minRange, maxRange, needsLos: false, features: [{ type: 1, minValue: min, maxValue: max }], ...rest })

function makeEntity(id, mp, extra = {}) {
	return {
		id, name: `e${id}`, level: 10, life: 100, maxLife: 100, mp, tp: 10, cell: null, strength: 0,
		weapon: null, weapons: [], chips: [], effects: [], launchedEffects: [], ...extra
	}
}

/** Moi sur la grille avec `mp` PM : retourne aussi mes cases atteignables du tour 1. */
function setupMe(grid, at = [5, 10], mp = 0) {
	const me = grid.place(makeEntity(1, mp), at[0], at[1])
	return { me, myReach: computeReachableCells(me, mp, 1) }
}

/** Entrée de `buildThreatMap` pour un ennemi posé sur la grille (cases de tir calculées en ignorant `me`). */
function addEnemy(grid, me, id, at, { mp = 0, tp = 10, strength = 0, weaponItem = null, otherWeapons = [], chips = [] } = {}) {
	const entity = grid.place(makeEntity(id, mp, { tp, strength, weapon: weaponItem }), at[0], at[1])
	return {
		entity,
		input: {
			id, name: entity.name, strength, tp, weapon: weaponItem, otherWeapons, chips,
			reachable: computeReachableCells(entity, mp, 1, { ignoreEntityId: me.id })
		}
	}
}

/** Danger de ma case actuelle (mp 0) pour un seul ennemi. */
function dangerOf(grid, enemyOptions, at = [10, 10], enemyAt = [7, 10]) {
	const { me, myReach } = setupMe(grid, at)
	const { input } = addEnemy(grid, me, 2, enemyAt, enemyOptions)
	const map = buildThreatMap(me, myReach, [input], 1)
	return { map, me, myReach, breakdown: map.breakdownAt(me.cell) }
}

// --- géométrie ---------------------------------------------------------------

test("launch pattern table: line / diagonal / other as a bit mask, absent or invalid = CIRCLE", () => {
	const line = [[3, 0], [0, -2], [0, 0]]
	const diagonal = [[2, 2], [-3, 3], [1, -1]]
	const other = [[1, 2], [3, 1], [-2, 5]]
	const expected = {
		LINE: [true, false, false],
		DIAGONAL: [false, true, false],
		STAR: [true, true, false],
		STAR_INVERTED: [false, false, true],
		DIAGONAL_INVERTED: [true, false, true],
		LINE_INVERTED: [false, true, true],
		CIRCLE: [true, true, true]
	}
	assert.deepEqual(LAUNCH_TYPE, {
		LINE: 1, DIAGONAL: 2, STAR: 3, STAR_INVERTED: 4, DIAGONAL_INVERTED: 5, LINE_INVERTED: 6, CIRCLE: 7
	})
	for (const [name, [wantLine, wantDiagonal, wantOther]] of Object.entries(expected)) {
		const type = LAUNCH_TYPE[name]
		for (const [dx, dy] of line) assert.equal(isCellInLaunchPattern(type, dx, dy), wantLine, `${name} line ${dx},${dy}`)
		for (const [dx, dy] of diagonal) assert.equal(isCellInLaunchPattern(type, dx, dy), wantDiagonal, `${name} diag ${dx},${dy}`)
		for (const [dx, dy] of other) assert.equal(isCellInLaunchPattern(type, dx, dy), wantOther, `${name} other ${dx},${dy}`)
	}
	for (const invalid of [undefined, null, 0, 8, 2.5, Number.NaN, -1]) {
		for (const [dx, dy] of [...line, ...diagonal, ...other]) {
			assert.equal(isCellInLaunchPattern(invalid, dx, dy), true, `invalid ${invalid}`)
		}
	}
})

test("geometric provider: Manhattan range bounds are inclusive, launch type filters the pattern", () => {
	makeGrid(21, 21)
	const provider = new GeometricShotCells()
	const from = { id: 0, x: 10, y: 10 }
	const at = (x, y) => ({ id: 0, x, y })
	const ring = weapon({ minRange: 2, maxRange: 4 })
	assert.equal(provider.canHit(from, at(10, 11), ring), false) // distance 1 < min
	assert.equal(provider.canHit(from, at(10, 12), ring), true) // distance 2 = min
	assert.equal(provider.canHit(from, at(12, 12), ring), true) // distance 4 = max
	assert.equal(provider.canHit(from, at(13, 12), ring), false) // distance 5 > max
	assert.equal(provider.canHit(from, at(8, 10), ring), true)

	const line = weapon({ minRange: 1, maxRange: 5, launchType: LAUNCH_TYPE.LINE })
	assert.equal(provider.canHit(from, at(13, 10), line), true)
	assert.equal(provider.canHit(from, at(11, 11), line), false) // diagonale
	assert.equal(provider.canHit(from, at(12, 11), line), false) // autre
	const diagonal = weapon({ minRange: 1, maxRange: 5, launchType: LAUNCH_TYPE.DIAGONAL })
	assert.equal(provider.canHit(from, at(12, 12), diagonal), true)
	assert.equal(provider.canHit(from, at(12, 10), diagonal), false)
	const star = weapon({ minRange: 1, maxRange: 5, launchType: LAUNCH_TYPE.STAR })
	assert.equal(provider.canHit(from, at(12, 12), star), true)
	assert.equal(provider.canHit(from, at(12, 10), star), true)
	assert.equal(provider.canHit(from, at(12, 11), star), false)
	const inverted = weapon({ minRange: 1, maxRange: 5, launchType: LAUNCH_TYPE.STAR_INVERTED })
	assert.equal(provider.canHit(from, at(12, 11), inverted), true)
	assert.equal(provider.canHit(from, at(12, 10), inverted), false)
	// launchType absent : CIRCLE
	assert.equal(provider.canHit(from, at(12, 11), weapon({ minRange: 1, maxRange: 5 })), true)
})

test("line of sight is asked only for needsLos items, after the geometric filter, once per (S, X) pair", () => {
	const grid = makeGrid(21, 21, [[7, 10]])
	const provider = new GeometricShotCells()
	const from = grid.cell(5, 10)
	const target = grid.cell(9, 10)
	const open = weapon({ minRange: 1, maxRange: 6 })
	const sighted = weapon({ minRange: 1, maxRange: 6, needsLos: true })

	assert.equal(provider.canHit(from, target, open), true) // obstacle ignoré sans needsLos
	assert.equal(grid.losCalls.length, 0)
	assert.equal(provider.canHit(from, target, sighted), false) // obstacle entre les deux
	assert.equal(grid.losCalls.length, 1)
	assert.equal(provider.canHit(from, target, sighted), false) // mémorisé
	assert.equal(provider.canHit(from, target, weapon({ minRange: 1, maxRange: 6, needsLos: true, id: 2 })), false)
	assert.equal(grid.losCalls.length, 1)
	assert.equal(provider.lineOfSightCalls, 1)
	// hors portée : aucun appel de ligne de vue
	assert.equal(provider.canHit(from, grid.cell(15, 10), sighted), false)
	// hors motif de lancer : aucun appel non plus
	assert.equal(provider.canHit(from, grid.cell(8, 11), weapon({ needsLos: true, launchType: LAUNCH_TYPE.LINE })), false)
	assert.equal(grid.losCalls.length, 1)
	// dégagée : vrai
	assert.equal(provider.canHit(grid.cell(5, 12), grid.cell(9, 12), sighted), true)
	assert.equal(provider.lineOfSightCalls, 2)
})

// --- dégâts de l'arme ------------------------------------------------------

test("weapon damage = mean × (1 + strength/100) × shots, shots = floor(TP / cost)", () => {
	const gun = weapon({ min: 10, max: 20, cost: 3 })
	assert.equal(meanDamage(gun, 0), 15)
	assert.equal(meanDamage(gun, 50), 22.5)
	assert.equal(meanDamage(gun, Number.NaN), 15)

	const { breakdown } = dangerOf(makeGrid(21, 21), { weaponItem: gun, tp: 10 })
	assert.equal(breakdown.length, 1)
	assert.equal(breakdown[0].damage, 45) // 3 tirs × 15
	assert.equal(breakdown[0].weaponShots, 3)
	assert.equal(breakdown[0].weapon, gun)
	assert.deepEqual(breakdown[0].chips, [])

	const strong = dangerOf(makeGrid(21, 21), { weaponItem: gun, tp: 10, strength: 50 })
	assert.equal(strong.breakdown[0].damage, 67.5) // 3 × 22.5
})

test("maxUses caps the shots (-1 or absent = unlimited); insufficient TP gives no shot", () => {
	const damageWith = (extra, tp = 10) =>
		dangerOf(makeGrid(21, 21), { weaponItem: weapon({ cost: 3, ...extra }), tp }).map.dangerAt({ x: 10, y: 10 })

	assert.equal(damageWith({ maxUses: 2 }), 30)
	assert.equal(damageWith({ maxUses: 1 }), 15)
	assert.equal(damageWith({ maxUses: -1 }), 45)
	assert.equal(damageWith({}), 45)
	assert.equal(damageWith({ maxUses: 5 }), 45) // le PT limite avant maxUses
	assert.equal(damageWith({ maxUses: 0 }), 0)
	assert.equal(damageWith({}, 2), 0) // 2 PT < coût 3
	assert.equal(damageWith({}, 3), 15)
})

test("an enemy without weapon and chips, or with a damage-free weapon, adds nothing", () => {
	const none = dangerOf(makeGrid(21, 21), { weaponItem: null })
	assert.equal(none.map.dangerAt(none.me.cell), 0)
	assert.deepEqual(none.breakdown, [])
	assert.equal(none.map.pairsEvaluated, 0) // pas parcouru

	const heal = { id: 5, name: "heal", cost: 2, minRange: 1, maxRange: 8, needsLos: false, features: [{ type: 2, minValue: 5, maxValue: 5 }] }
	const harmless = dangerOf(makeGrid(21, 21), { weaponItem: heal })
	assert.equal(harmless.map.dangerAt(harmless.me.cell), 0)
	assert.equal(harmless.map.pairsEvaluated, 0)
})

test("an enemy that cannot reach me from anywhere gives 0", () => {
	const far = dangerOf(makeGrid(21, 21), { weaponItem: weapon({ maxRange: 3 }), mp: 2 }, [15, 10], [2, 10])
	assert.equal(far.map.dangerAt(far.me.cell), 0)
	assert.deepEqual(far.breakdown, [])
	// avec assez de PM, il y arrive
	const near = dangerOf(makeGrid(21, 21), { weaponItem: weapon({ maxRange: 3 }), mp: 10 }, [15, 10], [2, 10])
	assert.equal(near.map.dangerAt(near.me.cell), 45)
	assert.ok(near.map.breakdownAt(near.me.cell)[0].shotCell.x >= 12)
})

// --- puces ---------------------------------------------------------------------

test("an advantageous chip with a cooldown is used once, then the weapon shoots with the remaining TP", () => {
	const gun = weapon({ min: 10, max: 20, cost: 3 }) // 5 dégâts/PT
	const strike = chip({ id: 11, name: "strike", cost: 4, min: 25, max: 35, cooldown: 1 }) // 30, 7,5/PT
	const { breakdown } = dangerOf(makeGrid(21, 21), { weaponItem: gun, chips: [strike], tp: 10 })
	assert.equal(breakdown[0].damage, 60) // 30 + floor(6/3) = 2 tirs × 15
	assert.equal(breakdown[0].weaponShots, 2)
	assert.deepEqual(breakdown[0].chips, [strike])
	assert.equal(breakdown[0].weapon, gun)
})

test("a chip with a cooldown is not repeated even with TP for it twice, and maxUses of the weapon caps the remaining shots", () => {
	const gun = weapon({ min: 10, max: 20, cost: 3, maxUses: 1 })
	const strike = chip({ id: 11, name: "strike", cost: 2, min: 28, max: 32, cooldown: 1 }) // 30, 15/PT
	const { breakdown } = dangerOf(makeGrid(21, 21), { weaponItem: gun, chips: [strike], tp: 10 })
	assert.equal(breakdown[0].damage, 45) // 30 + 1 tir (maxUses) × 15
	assert.equal(breakdown[0].weaponShots, 1)
})

// Combat 54965081, tour 4 : l'ennemi lance deux fois la même puce sans cooldown (143 dégâts pour un danger annoncé de 71,1).
test("fight 54965081: an enemy chip without base cooldown counts as many times as TP and maxUses allow, others once", () => {
	const cases = [
		["no cooldown: floor(10 / 3) casts", { cooldown: 0 }, 3],
		["no cooldown, maxUses 2", { cooldown: 0, maxUses: 2 }, 2],
		["cooldown 2", { cooldown: 2 }, 1],
		["infinite cooldown (-1)", { cooldown: -1 }, 1],
		["unknown base cooldown (field absent)", {}, 1]
	]
	for (const [name, options, casts] of cases) {
		const spark = chip({ id: 40, name: "spark", cost: 3, min: 20, max: 20, ...options })
		if (!("cooldown" in options)) delete spark.cooldown
		const { breakdown } = dangerOf(makeGrid(21, 21), { chips: [spark], tp: 10 })
		assert.equal(breakdown[0].damage, 20 * casts, name)
		assert.deepEqual(breakdown[0].chips, Array(casts).fill(spark), name)
	}
	// Avec une arme moins rentable par PT : 3 lancers (60) puis plus assez de PT pour tirer, mieux que l'arme seule (45).
	const spark = chip({ id: 41, name: "spark", cost: 3, min: 20, max: 20, cooldown: 0 })
	const armed = dangerOf(makeGrid(21, 21), { weaponItem: weapon({ min: 10, max: 20, cost: 3 }), chips: [spark], tp: 10 })
	assert.equal(armed.breakdown[0].damage, 60)
	assert.equal(armed.breakdown[0].weaponShots, 0)
})

test("a chips-only plan does not pay the swap of a weapon it does not fire", () => {
	const spark = chip({ id: 42, name: "spark", cost: 2, min: 30, max: 30, cooldown: 0 }) // 15/PT
	const spare = weapon({ id: 2, name: "spare", cost: 5, min: 20, max: 20 }) // 4/PT, non équipée : 1 PT de changement
	const { breakdown } = dangerOf(makeGrid(21, 21), { otherWeapons: [spare], chips: [spark], tp: 10 })
	assert.equal(breakdown[0].damage, 150) // 5 lancers ; 4 seulement (120) si le changement d'arme était payé
	assert.deepEqual([breakdown[0].weapon, breakdown[0].swapTp], [null, 0])
})

// Le glouton « tous les lancers de la puce au meilleur ratio d'abord » annonçait 90 et 82 : moins que le plan
// « chaque puce une fois » (99 et 91). Le maximum exact sur les PT donne 99 et 100.
test("exact maximum over TP: repeated casts never hide a better mix with the weapon or another chip", () => {
	const cannon = weapon({ min: 69, max: 69, cost: 7 })
	const zap = chip({ id: 44, name: "zap", cost: 3, min: 30, max: 30, cooldown: 0 })
	const mixed = dangerOf(makeGrid(21, 21), { weaponItem: cannon, chips: [zap], tp: 10 }).breakdown[0]
	assert.deepEqual([mixed.damage, mixed.weaponShots, mixed.chips.length], [99, 1, 1]) // 69 + 30, pas 3 × 30
	const a = chip({ id: 45, name: "a", cost: 4, min: 41, max: 41, cooldown: 0 }) // 10,25/PT
	const b = chip({ id: 46, name: "b", cost: 5, min: 50, max: 50, cooldown: 0 }) // 10/PT
	const chipsOnly = dangerOf(makeGrid(21, 21), { chips: [a, b], tp: 10 }).breakdown[0]
	assert.equal(chipsOnly.damage, 100) // 2 × b, pas 2 × a (82)
	assert.deepEqual(chipsOnly.chips, [b, b])
})

test("a chip weaker per TP than the weapon only takes the TP the weapon cannot use", () => {
	const gun = weapon({ min: 10, max: 20, cost: 3 }) // 5/PT
	const weak = chip({ id: 12, name: "weak", cost: 2, min: 6, max: 10, cooldown: 1 }) // 8 → 4/PT
	const nine = dangerOf(makeGrid(21, 21), { weaponItem: gun, chips: [weak], tp: 10 }).breakdown[0]
	assert.deepEqual([nine.damage, nine.weaponShots, nine.chips.length], [45, 3, 0]) // 2 tirs + puce = 38
	const eleven = dangerOf(makeGrid(21, 21), { weaponItem: gun, chips: [weak], tp: 11 }).breakdown[0]
	assert.deepEqual([eleven.damage, eleven.weaponShots, eleven.chips.length], [53, 3, 1])
})

test("no damage-per-TP filter: a chip is kept exactly when it raises the total, whatever its ratio against the weapon", () => {
	const gun = weapon({ min: 10, max: 20, cost: 3 }) // 15 par tir, 5/PT
	// 9/PT et 2/PT : la puce faible (4 PT) retirerait un tir d'arme -> 18 + 8 + 15 = 41 au lieu de 48
	const good = chip({ id: 21, name: "good", cost: 2, min: 18, max: 18, cooldown: 1 })
	const weak = chip({ id: 22, name: "weak", cost: 4, min: 8, max: 8, cooldown: 1 })
	const mixed = dangerOf(makeGrid(21, 21), { weaponItem: gun, chips: [good, weak], tp: 10 })
	assert.deepEqual(mixed.breakdown[0].chips.map((c) => c.name), ["good"])
	assert.equal(mixed.breakdown[0].damage, 48) // 18 + floor(8 / 3) = 2 tirs × 15
	assert.equal(mixed.breakdown[0].weaponShots, 2)

	// ratio exactement égal (5/PT) : retenue, son PT est celui que l'arme perd (5 + 3 tirs × 15 = 50 ; sans : 45).
	// L'ancien filtre strict « ratio > arme » l'écartait et annonçait 45.
	const equal = chip({ id: 23, name: "equal", cost: 1, min: 5, max: 5, cooldown: 1 })
	const tie = dangerOf(makeGrid(21, 21), { weaponItem: gun, chips: [equal], tp: 10 })
	assert.equal(tie.breakdown[0].damage, 50)
	assert.deepEqual(tie.breakdown[0].chips, [equal])
	const better = chip({ id: 24, name: "better", cost: 1, min: 6, max: 6, cooldown: 1 })
	const win = dangerOf(makeGrid(21, 21), { weaponItem: gun, chips: [better], tp: 10 })
	assert.equal(win.breakdown[0].damage, 51) // 6 + 3 tirs × 15
	assert.deepEqual(win.breakdown[0].chips.map((c) => c.name), ["better"])
})

test("several chips and the weapon share the TP: best total, chips listed in damage-per-TP order", () => {
	const gun = weapon({ min: 10, max: 20, cost: 3 })
	const heavy = chip({ id: 14, name: "heavy", cost: 4, min: 25, max: 35, cooldown: 1 }) // 30, 7,5/PT
	const light = chip({ id: 15, name: "light", cost: 2, min: 18, max: 18, cooldown: 1 }) // 18, 9/PT
	const tooCostly = chip({ id: 16, name: "costly", cost: 12, min: 200, max: 200 }) // > PT
	const { breakdown } = dangerOf(makeGrid(21, 21), { weaponItem: gun, chips: [heavy, light, tooCostly], tp: 10 })
	assert.deepEqual(breakdown[0].chips.map((c) => c.name), ["light", "heavy"])
	assert.equal(breakdown[0].damage, 63) // 18 + 30 + 1 tir (4 PT restants) × 15
	assert.equal(breakdown[0].weaponShots, 1)
})

test("the weapon-only plan is kept when it beats the chip plan (TP rounding)", () => {
	const gun = weapon({ min: 10, max: 10, cost: 2 }) // 5/PT
	const strike = chip({ id: 17, name: "strike", cost: 5, min: 26, max: 26 }) // 5,2/PT
	const { breakdown } = dangerOf(makeGrid(21, 21), { weaponItem: gun, chips: [strike], tp: 6 })
	assert.equal(breakdown[0].damage, 30) // 3 tirs ; la puce donnerait 26 + 0 tir
	assert.equal(breakdown[0].weaponShots, 3)
	assert.deepEqual(breakdown[0].chips, [])

	const direct = planShots(6, toCandidate(gun, false, 0), [toCandidate(strike, true, 0)])
	assert.equal(direct.damage, 30)
	assert.equal(direct.tpUsed, 6)
})

test("a chip usable from the shot cell while the weapon is not: chip only, even if its ratio is lower", () => {
	const shortGun = weapon({ min: 10, max: 20, cost: 3, minRange: 1, maxRange: 2 })
	const sniper = chip({ id: 18, name: "sniper", cost: 4, min: 20, max: 20, minRange: 1, maxRange: 8, cooldown: 1 }) // 5/PT
	const meh = chip({ id: 19, name: "meh", cost: 4, min: 4, max: 4, minRange: 1, maxRange: 8, cooldown: 1 }) // 1/PT
	// ennemi à 3 cases de moi : hors de portée de l'arme
	const { breakdown } = dangerOf(makeGrid(21, 21), { weaponItem: shortGun, chips: [sniper], tp: 10 }, [10, 10], [7, 10])
	assert.equal(breakdown[0].damage, 20) // une seule utilisation de la puce (cooldown)
	assert.equal(breakdown[0].weapon, null)
	assert.equal(breakdown[0].weaponShots, 0)
	assert.deepEqual(breakdown[0].chips, [sniper])
	const lower = dangerOf(makeGrid(21, 21), { weaponItem: shortGun, chips: [meh], tp: 10 }, [10, 10], [7, 10])
	assert.equal(lower.breakdown[0].damage, 4)
})

test("chips without damage features, or with maxUses 0, are not candidates; sortByRatio is stable", () => {
	const heal = chip({ id: 20, name: "heal", cost: 2, min: 1, max: 1, features: [{ type: 2, minValue: 50, maxValue: 50 }] })
	assert.equal(toCandidate(heal, true, 0), null)
	assert.equal(toCandidate(chip({ maxUses: 0 }), true, 0), null)
	assert.equal(toCandidate(weapon({ cost: 0 }), false, 0), null)
	const a = toCandidate(chip({ id: 1, name: "a", cost: 2, min: 10, max: 10 }), true, 0)
	const b = toCandidate(chip({ id: 2, name: "b", cost: 2, min: 10, max: 10 }), true, 0)
	assert.deepEqual(sortByRatio([a, b]).map((c) => c.item.name), ["a", "b"])
})

// --- cases de tir ------------------------------------------------------------

test("MAX over the shot cells, never a sum: the damage of one plan, from the cheapest cell", () => {
	const grid = makeGrid(21, 21)
	const { me, myReach } = setupMe(grid, [10, 10])
	const gun = weapon({ min: 10, max: 20, cost: 3, minRange: 1, maxRange: 1 })
	const { input } = addEnemy(grid, me, 2, [8, 10], { mp: 4, weaponItem: gun, tp: 10 })
	// 4 cases adjacentes à moi sont atteignables (coûts 1, 3, 3, 4 : la dernière en traversant ma case libérée)
	for (const [x, y] of [[9, 10], [11, 10], [10, 9], [10, 11]]) {
		assert.equal(input.reachable.canReach(grid.cell(x, y)), true, `${x},${y}`)
	}
	const map = buildThreatMap(me, myReach, [input], 1)
	const [threat] = map.breakdownAt(me.cell)
	assert.equal(map.dangerAt(me.cell), 45) // un seul plan, pas 4 × 45
	assert.equal(threat.damage, 45)
	assert.equal(Math.abs(threat.shotCell.x - 10) + Math.abs(threat.shotCell.y - 10), 1)
	assert.deepEqual([threat.shotCell.x, threat.shotCell.y], [9, 10]) // 1 PM : la moins coûteuse

	// avec 2 PM depuis (6,10) il n'atteint aucune case adjacente
	const short = addEnemy(grid, me, 3, [6, 10], { mp: 2, weaponItem: gun, tp: 10 })
	assert.equal(buildThreatMap(me, myReach, [short.input], 1).dangerAt(me.cell), 0)
})

test("on a tie, the shot cell with the lowest MP cost (the enemy's own cell first) is kept", () => {
	const grid = makeGrid(21, 21)
	const { me, myReach } = setupMe(grid, [10, 10])
	const gun = weapon({ minRange: 1, maxRange: 3 })
	const { entity, input } = addEnemy(grid, me, 2, [7, 10], { mp: 3, weaponItem: gun })
	const [threat] = buildThreatMap(me, myReach, [input], 1).breakdownAt(me.cell)
	assert.equal(threat.shotCell, entity.cell)
})

test("launch type restricts the shot cells: line weapon cannot hit an off-axis cell, inverted star can", () => {
	const lineGun = weapon({ minRange: 1, maxRange: 8, launchType: LAUNCH_TYPE.LINE })
	const invertedGun = weapon({ minRange: 1, maxRange: 8, launchType: LAUNCH_TYPE.STAR_INVERTED })
	// moi en (7,11), ennemi immobile en (5,10) : décalage (2,1) = « autre »
	assert.equal(dangerOf(makeGrid(21, 21), { weaponItem: lineGun }, [7, 11], [5, 10]).map.dangerAt({ x: 7, y: 11 }), 0)
	assert.equal(dangerOf(makeGrid(21, 21), { weaponItem: invertedGun }, [7, 11], [5, 10]).map.dangerAt({ x: 7, y: 11 }), 45)
})

test("line of sight blocks only needsLos items; the cache shares one call between items of a pair", () => {
	const blocked = (extra, chips = []) => {
		const grid = makeGrid(21, 21, [[7, 10]])
		const result = dangerOf(grid, { weaponItem: weapon({ minRange: 1, maxRange: 8, ...extra }), chips, tp: 10 }, [9, 10], [5, 10])
		return { danger: result.map.dangerAt(result.me.cell), grid, map: result.map }
	}
	assert.equal(blocked({ needsLos: false }).danger, 45)
	assert.equal(blocked({ needsLos: false }).grid.losCalls.length, 0)
	const stopped = blocked({ needsLos: true })
	assert.equal(stopped.danger, 0)
	assert.equal(stopped.grid.losCalls.length, 1)
	assert.equal(stopped.map.lineOfSightCalls, 1)

	// puce sans needsLos : seule elle touche à travers l'obstacle
	const mixed = blocked({ needsLos: true }, [chip({ id: 30, name: "through", needsLos: false, cooldown: 1 })])
	assert.deepEqual(mixed.map.breakdownAt({ x: 9, y: 10 })[0].chips.map((c) => c.name), ["through"])
	// deux items needsLos sur la même paire : une seule ligne de vue
	const shared = blocked({ needsLos: true }, [chip({ id: 31, name: "sight", needsLos: true })])
	assert.equal(shared.grid.losCalls.length, 1)
	assert.equal(shared.danger, 0)
})

test("line of sight is not queried for a pair outside the item's range", () => {
	const grid = makeGrid(21, 21)
	const result = dangerOf(grid, { weaponItem: weapon({ minRange: 1, maxRange: 3, needsLos: true }) }, [15, 10], [2, 10])
	assert.equal(result.map.dangerAt(result.me.cell), 0)
	assert.equal(grid.losCalls.length, 0)
})

// --- plusieurs ennemis et carte --------------------------------------------

test("several enemies add up per cell, and the breakdown keeps one entry per enemy", () => {
	const grid = makeGrid(21, 21)
	const { me, myReach } = setupMe(grid, [10, 10])
	const first = addEnemy(grid, me, 2, [8, 10], { weaponItem: weapon({ id: 1, name: "a", min: 10, max: 20, cost: 3 }), tp: 10 })
	const second = addEnemy(grid, me, 3, [10, 13], {
		weaponItem: weapon({ id: 2, name: "b", min: 20, max: 20, cost: 5 }), tp: 10, strength: 100
	})
	const idle = addEnemy(grid, me, 4, [12, 10], { weaponItem: null })
	const map = buildThreatMap(me, myReach, [first.input, second.input, idle.input], 7)

	assert.equal(map.dangerAt(me.cell), 45 + 80) // 3 × 15 et 2 × (20 × 2)
	const breakdown = map.breakdownAt(me.cell)
	assert.deepEqual(breakdown.map((entry) => entry.enemyId), [2, 3])
	assert.deepEqual(breakdown.map((entry) => entry.damage), [45, 80])
	assert.deepEqual(breakdown.map((entry) => entry.weaponShots), [3, 2])
	assert.equal(breakdown[0].name, "e2")
	assert.equal(map.turn, 7)
	assert.equal(map.entityId, 1)
	assert.equal(map.enemyCount, 3)
})

test("map API: size, entries, dangerAt (null outside), maxDanger, minDanger, safestCells", () => {
	const grid = makeGrid(21, 21)
	const { me, myReach } = setupMe(grid, [5, 10], 1)
	const gun = weapon({ min: 10, max: 20, cost: 3, minRange: 1, maxRange: 1 })
	const { input } = addEnemy(grid, me, 2, [7, 10], { weaponItem: gun, tp: 10 })
	const map = buildThreatMap(me, myReach, [input], 1)

	assert.equal(map.size, 5)
	assert.equal(map.candidateCells, 5)
	assert.equal(map.truncated, false)
	assert.equal(map.inputsTruncated, false)
	const entries = [...map.entries()]
	assert.equal(entries.length, 5)
	assert.equal(entries[0].cell, me.cell)
	assert.equal(entries[0].mpCost, 0)
	assert.equal(map.dangerAt(grid.cell(6, 10)), 45) // adjacente à l'ennemi
	assert.equal(map.dangerAt(grid.cell(5, 10)), 0)
	assert.equal(map.dangerAt(grid.cell(15, 15)), null)
	assert.equal(map.has(grid.cell(15, 15)), false)
	assert.deepEqual(map.breakdownAt(grid.cell(15, 15)), [])
	assert.equal(map.maxDanger, 45)
	assert.equal(map.minDanger, 0)
	const safest = map.safestCells()
	assert.equal(safest[0], me.cell) // ma case actuelle d'abord
	assert.equal(safest.length, 4)
	assert.equal(safest.includes(grid.cell(6, 10)), false)
})

test("an empty reachable set or no enemy gives a map with zero danger and no failure", () => {
	const grid = makeGrid(21, 21)
	const { me, myReach } = setupMe(grid, [5, 10], 2)
	const map = buildThreatMap(me, myReach, [], 3)
	assert.equal(map.size, 13)
	assert.equal(map.maxDanger, 0)
	assert.equal(map.pairsEvaluated, 0)
	assert.equal(map.safestCells().length, 13)
})

test("pair cap default: 113 cells (7 MP, open ground) against a 7 MP enemy are fully evaluated; an 8 MP enemy truncates", () => {
	const gun = weapon({ minRange: 1, maxRange: 40 })
	const build = (enemyMp) => {
		const grid = makeGrid(41, 21)
		const { me, myReach } = setupMe(grid, [10, 10], 7)
		const { input } = addEnemy(grid, me, 2, [28, 10], { mp: enemyMp, weaponItem: gun })
		return { myReach, input, map: buildThreatMap(me, myReach, [input], 1) }
	}
	const seven = build(7)
	assert.deepEqual([seven.myReach.size, seven.input.reachable.size], [113, 113])
	assert.equal(seven.map.pairsEvaluated, 113 * 113) // 12 769 : au-delà de l'ancien plafond de 8 000
	assert.equal(seven.map.truncated, false)
	assert.equal(seven.map.size, 113)
	const eight = build(8) // 113 × 145 = 16 385 paires : le garde-fou coupe toujours, les cases non évaluées sont absentes
	assert.equal(eight.map.truncated, true)
	assert.equal(eight.map.pairsEvaluated, MAX_THREAT_PAIRS)
	assert.ok(eight.map.size < 113)
})

test("pair cap: the map is truncated, unevaluated cells are absent (never shown as safe)", () => {
	const grid = makeGrid(21, 21)
	const { me, myReach } = setupMe(grid, [5, 10], 2) // 13 cases
	const gun = weapon({ minRange: 1, maxRange: 20 })
	const { input } = addEnemy(grid, me, 2, [12, 10], { mp: 2, weaponItem: gun })
	assert.equal(MAX_THREAT_PAIRS > 169, true)

	const full = buildThreatMap(me, myReach, [input], 1)
	assert.equal(full.truncated, false)
	assert.equal(full.pairsEvaluated, 13 * 13)
	assert.equal(full.size, 13)

	const capped = buildThreatMap(me, myReach, [input], 1, { maxPairs: 30 })
	assert.equal(capped.truncated, true)
	assert.equal(capped.size, 2) // 2 cases complètes (26 paires), la 3e est abandonnée
	assert.equal(capped.pairsEvaluated, 30)
	assert.equal(capped.candidateCells, 13)
	assert.equal(capped.dangerAt(grid.cell(5, 10)), 45)
	assert.equal(capped.dangerAt(grid.cell(7, 10)), null)
	assert.ok(capped.safestCells().every((cell) => capped.has(cell)))
})

const boostChip = (cost, gain, extra = {}) =>
	chip({ id: 300 + cost * 10 + gain, name: `boost${gain}`, cost, features: [{ type: 6, minValue: gain, maxValue: gain }], ...extra })

test("a ready strength boost is cast before shooting when it pays, with its TP deducted", () => {
	const grid = makeGrid(21, 21)
	const { me, myReach } = setupMe(grid, [10, 10])
	const gun = weapon({ id: 70, cost: 3, min: 10, max: 10 })
	const { input } = addEnemy(grid, me, 2, [7, 10], { weaponItem: gun })
	assert.equal(buildThreatMap(me, myReach, [input], 1).dangerAt(me.cell), 30) // 3 tirs de 10

	const boosted = buildThreatMap(me, myReach, [{ ...input, boosts: [boostChip(3, 100)] }], 1)
	assert.equal(boosted.dangerAt(me.cell), 40) // 7 PT : 2 tirs de 10 × (1 + 100/100)
	const threat = boosted.breakdownAt(me.cell)[0]
	assert.equal(threat.boostTp, 3)
	assert.equal(threat.strengthGain, 100)
	assert.equal(threat.weaponShots, 2)

	const weak = buildThreatMap(me, myReach, [{ ...input, boosts: [boostChip(3, 5)] }], 1)
	assert.equal(weak.dangerAt(me.cell), 30) // 2 tirs × 10,5 < 3 tirs : le boost ne paie pas
	assert.equal(weak.breakdownAt(me.cell)[0].boostTp, 0)
	const unaffordable = buildThreatMap(me, myReach, [{ ...input, boosts: [boostChip(10, 500)] }], 1)
	assert.equal(unaffordable.dangerAt(me.cell), 30) // coût ≥ PT : ignoré
})

test("boost chips combine (each at most once) and only the paying subset is kept", () => {
	const grid = makeGrid(21, 21)
	const { me, myReach } = setupMe(grid, [10, 10])
	const gun = weapon({ id: 71, cost: 2, min: 10, max: 10 })
	const { input } = addEnemy(grid, me, 2, [7, 10], { weaponItem: gun })
	assert.equal(buildThreatMap(me, myReach, [input], 1).dangerAt(me.cell), 50) // 5 tirs
	const one = buildThreatMap(me, myReach, [{ ...input, boosts: [boostChip(2, 100)] }], 1)
	assert.equal(one.dangerAt(me.cell), 80) // 8 PT : 4 tirs × 20
	const both = buildThreatMap(me, myReach, [{ ...input, boosts: [boostChip(2, 100, { id: 9 }), boostChip(2, 100, { id: 10 })] }], 1)
	assert.equal(both.dangerAt(me.cell), 90) // 6 PT : 3 tirs × 30
	assert.equal(both.breakdownAt(me.cell)[0].boostTp, 4)
	assert.equal(both.breakdownAt(me.cell)[0].strengthGain, 200)
})

test("strengthBoostOf: BUFF_STRENGTH is amplified by science, the raw boost (id 38) is not", () => {
	const buff = chip({ id: 80, features: [{ type: 6, minValue: 40, maxValue: 60 }] })
	const raw = chip({ id: 81, features: [{ type: 38, minValue: 40, maxValue: 60 }] })
	const damage = chip({ id: 82 })
	assert.equal(strengthBoostOf(buff, 100), 100)
	assert.equal(strengthBoostOf(buff, 0), 50)
	assert.equal(strengthBoostOf(raw, 100), 50)
	assert.equal(strengthBoostOf(damage, 100), 0)
})

test("EnemyMemory.updateThreatMap: ready boost chips raise the danger, a chip in cooldown does not", () => {
	const gun = weapon({ id: 72, cost: 3, min: 10, max: 10 })
	const protein = boostChip(3, 100, { cooldown: 3 })
	const scenario = memoryScenario({ enemyWeapon: gun, enemyChips: [protein] })
	run(scenario)
	assert.equal(scenario.memory.getThreatMap().dangerAt(scenario.me.cell), 40)
	scenario.memory.getProfile(2).startCooldown(protein)
	scenario.memory.updateReachable(scenario.me, [], [scenario.enemy], 2)
	scenario.memory.updateThreatMap(scenario.me, [scenario.enemy], 2)
	assert.equal(scenario.memory.getThreatMap().dangerAt(scenario.me.cell), 30)
})

test("line of sight is shared between maps through a common cache, one Field call per pair", () => {
	const grid = makeGrid(21, 21)
	const sight = new Map()
	const sighted = weapon({ id: 73, minRange: 1, maxRange: 8, needsLos: true })
	const from = grid.cell(5, 10)
	const target = grid.cell(9, 10)
	assert.equal(new GeometricShotCells(sight).canHit(from, target, sighted), true)
	assert.equal(new GeometricShotCells(sight).canHit(from, target, sighted), true)
	const again = new GeometricShotCells(sight)
	assert.equal(again.canHit(from, target, sighted), true)
	assert.equal(again.lineOfSightCalls, 0)
	assert.equal(grid.losCalls.length, 1)
	assert.equal(new GeometricShotCells().canHit(from, target, sighted), true) // cache propre : nouvel appel
	assert.equal(grid.losCalls.length, 2)
})

test("EnemyMemory reuses line of sight across turns: the second identical map makes no Field.lineOfSight call", () => {
	const sighted = weapon({ id: 74, minRange: 1, maxRange: 8, needsLos: true })
	const scenario = memoryScenario({ enemyWeapon: sighted, mp: 2 })
	const grid = scenario.grid
	run(scenario, 1)
	const first = grid.losCalls.length
	assert.ok(first > 0)
	scenario.memory.updateReachable(scenario.me, [], [scenario.enemy], 2)
	const update = scenario.memory.updateThreatMap(scenario.me, [scenario.enemy], 2)
	assert.equal(update.lineOfSightCalls, 0)
})

test("pairs outside every range never reach the provider, and the danger equals the unfiltered result", () => {
	const grid = makeGrid(21, 21)
	const { me, myReach } = setupMe(grid, [10, 10], 1)
	const gun = weapon({ id: 75, minRange: 1, maxRange: 3 })
	const { input } = addEnemy(grid, me, 2, [6, 10], { mp: 2, weaponItem: gun })
	const reference = buildThreatMap(me, myReach, [input], 1)
	let calls = 0
	const base = new GeometricShotCells()
	const counting = { canHit: (a, b, c) => { calls++; return base.canHit(a, b, c) } }
	const counted = buildThreatMap(me, myReach, [input], 1, { provider: counting })
	for (const entry of reference.entries()) assert.equal(counted.dangerAt(entry.cell), entry.danger)
	assert.ok(calls < counted.pairsEvaluated, `${calls} calls for ${counted.pairsEvaluated} pairs`)
})

test("a cell farther than the enemy's movement plus its longest range is skipped without any pair", () => {
	const grid = makeGrid(21, 21)
	const { me, myReach } = setupMe(grid, [18, 10])
	const gun = weapon({ id: 76, minRange: 1, maxRange: 3 })
	const { input } = addEnemy(grid, me, 2, [2, 10], { mp: 2, weaponItem: gun })
	let calls = 0
	const map = buildThreatMap(me, myReach, [input], 1, { provider: { canHit() { calls++; return true } } })
	assert.equal(map.dangerAt(me.cell), 0)
	assert.equal(map.pairsEvaluated, 0)
	assert.equal(calls, 0)
})

test("base damage is cached per item instance: the same id with other features is not confused", () => {
	const a = weapon({ id: 90, min: 10, max: 10 })
	const b = weapon({ id: 90, min: 30, max: 30 })
	assert.equal(meanDamage(a, 0), 10)
	assert.equal(meanDamage(b, 0), 30)
	assert.equal(meanDamage(a, 50), 15)
	assert.equal(meanDamage(a, Number.NaN), 10)
})

test("an enemy TP boost raises its shot budget: cost paid, TP gained, only when it pays", () => {
	const grid = makeGrid(21, 21)
	const { me, myReach } = setupMe(grid, [10, 10])
	const gun = weapon({ id: 77, cost: 3, min: 10, max: 10 })
	const { input } = addEnemy(grid, me, 2, [7, 10], { weaponItem: gun, tp: 7 })
	const tpChip = (cost, gain) => chip({ id: 400 + cost * 10 + gain, name: `tp${gain}`, cost, features: [{ type: 32, minValue: gain, maxValue: gain }] })
	assert.equal(buildThreatMap(me, myReach, [input], 1).dangerAt(me.cell), 20) // 7 PT : 2 tirs
	const boosted = buildThreatMap(me, myReach, [{ ...input, boosts: [tpChip(2, 4)] }], 1)
	assert.equal(boosted.dangerAt(me.cell), 30) // 7 − 2 + 4 = 9 PT : 3 tirs
	const threat = boosted.breakdownAt(me.cell)[0]
	assert.equal(threat.boostTp, 2)
	assert.equal(threat.tpGain, 4)
	assert.equal(threat.strengthGain, 0)
	const useless = buildThreatMap(me, myReach, [{ ...input, boosts: [tpChip(2, 1)] }], 1)
	assert.equal(useless.dangerAt(me.cell), 20) // 6 PT : 2 tirs, pas mieux : aucun boost retenu
	assert.equal(useless.breakdownAt(me.cell)[0].boostTp, 0)
})

/** `Effect.BUFF_TP` n'existe pas dans les mocks de ce fichier : on le déclare le temps d'un test. */
function withBuffTp(body) {
	globalThis.Effect.BUFF_TP = 8
	try {
		body()
	} finally {
		delete globalThis.Effect.BUFF_TP
	}
}

const tpBoostChip = (cost, gain, extra = {}) =>
	chip({ id: 500 + cost * 10 + gain, name: `tpboost${gain}`, cost, features: [{ type: 32, minValue: gain, maxValue: gain, turns: 3 }], ...extra })

test("tpBoostOf / tpBoostTurns / isTpBoostType: BUFF_TP is amplified by science, RAW_BUFF_TP (32) is not, no confusion with force", () => {
	const raw = chip({ id: 90, features: [{ type: 32, minValue: 3, maxValue: 5, turns: 3 }] })
	assert.equal(tpBoostOf(raw, 100), 4)
	assert.equal(tpBoostOf(raw, 0), 4)
	assert.equal(tpBoostTurns(raw), 3)
	assert.equal(isTpBoostType(32), true)
	assert.equal(isTpBoostType(38), false)
	assert.equal(isTpBoostType(6), false)
	assert.equal(isStrengthBoostType(32), false)
	assert.equal(isTpBoostType(1), false)
	assert.equal(strengthBoostOf(raw, 100), 0) // une puce de PT n'est pas un boost de force
	const damage = chip({ id: 91 })
	assert.equal(tpBoostOf(damage, 100), 0)
	assert.equal(tpBoostTurns(damage), 0)
	assert.equal(tpBoostOf({ ...damage, features: undefined }, 100), 0)
	withBuffTp(() => {
		const buff = chip({ id: 92, features: [{ type: 8, minValue: 3, maxValue: 5, turns: 2 }, { type: 32, minValue: 1, maxValue: 1, turns: 4 }] })
		assert.equal(tpBoostOf(buff, 100), 9) // 4 × 2 amplifié + 1 brut
		assert.equal(tpBoostOf(buff, 0), 5)
		assert.equal(tpBoostOf(buff, Number.NaN), 5)
		assert.equal(tpBoostOf(buff, -50), 5)
		assert.equal(tpBoostTurns(buff), 4) // la plus longue
		assert.equal(isTpBoostType(8), true)
		assert.equal(tpBoostTurns(chip({ id: 93, features: [{ type: 8, minValue: 1, maxValue: 1, turns: Number.NaN }] })), 0)
	})
})

// Enemy TP boost payoff (whole shots) and affordability. Enemy at [7, 10] (or [6, 10]), me at [10, 10], 7 TP.
// [label, weaponCost, enemyAt, boost cost/gain (null = no boost), expected danger, expected breakdown fields]
const tpBoostThresholdCases = [
	["no boost: 7 TP buy 1 shot of 4 TP", 4, [7, 10], null, 10, { boostTp: 0 }],
	["tie: 7 - 2 + 2 = 7 TP still 1 shot, not cast", 4, [7, 10], [2, 2], 10, { boostTp: 0, tpGain: 0 }],
	["pays: 8 TP buy 2 shots", 4, [7, 10], [2, 3], 20, { boostTp: 2, tpGain: 3, strengthGain: 0, weaponShots: 2 }],
	["cost = TP is castable when it gives TP back (7 - 7 + 8 = 8 TP)", 4, [7, 10], [7, 8], 20, { boostTp: 7 }],
	["cost > TP is never castable (1 TP short)", 4, [7, 10], [8, 12], 10, { boostTp: 0 }],
	["a TP chip that does not reach the weapon cost (5 TP < 9) stays harmless", 9, [6, 10], [3, 1], 0, {}],
	["a TP chip that reaches the weapon cost (10 TP >= 9) makes the enemy dangerous", 9, [6, 10], [3, 6], 10, {}]
]

for (const [label, weaponCost, enemyAt, boost, danger, fields] of tpBoostThresholdCases) {
	test(`enemy TP boost thresholds: ${label}`, () => {
		const grid = makeGrid(21, 21)
		const { me, myReach } = setupMe(grid, [10, 10])
		const gun = weapon({ id: 78, cost: weaponCost, min: 10, max: 10 })
		const { input } = addEnemy(grid, me, 2, enemyAt, { weaponItem: gun, tp: 7 })
		const boosts = boost === null ? undefined : [tpBoostChip(...boost)]
		const map = buildThreatMap(me, myReach, [{ ...input, boosts }], 1)
		assert.equal(map.dangerAt(me.cell), danger)
		if (danger > 0) {
			const threat = map.breakdownAt(me.cell)[0]
			for (const [field, value] of Object.entries(fields)) assert.equal(threat[field], value, field)
		}
	})
}

test("enemy TP boost: science amplifies BUFF_TP (floor of the TP after the cast) but not the raw boost", () => {
	const grid = makeGrid(21, 21)
	const { me, myReach } = setupMe(grid, [10, 10])
	const gun = weapon({ id: 86, cost: 4, min: 10, max: 10 })
	const { input } = addEnemy(grid, me, 2, [7, 10], { weaponItem: gun, tp: 7 })
	const make = (type, science) => buildThreatMap(me, myReach, [{
		...input, science, boosts: [chip({ id: 87, cost: 2, features: [{ type, minValue: 2, maxValue: 3 }] })] // moyenne 2,5
	}], 1).breakdownAt(me.cell)[0]
	withBuffTp(() => {
		assert.equal(make(8, 0).boostTp, 0) // 2,5 PT : floor(7,5) = 7 → 1 tir
		const amplified = make(8, 30) // 2,5 × 1,3 = 3,25 : floor(8,25) = 8 → 2 tirs
		assert.equal(amplified.boostTp, 2)
		assert.equal(amplified.damage, 20)
		assert.ok(Math.abs(amplified.tpGain - 3.25) < 1e-9)
		assert.equal(make(8, 100).boostTp, 2)
		assert.equal(make(32, 100).boostTp, 0) // brut : 2,5 seulement
		assert.equal(make(32, 0).boostTp, 0)
	})
})

test("enemy TP boost and strength boost combine: TP bought by one pays for the other", () => {
	const grid = makeGrid(21, 21)
	const { me, myReach } = setupMe(grid, [10, 10])
	const gun = weapon({ id: 88, cost: 2, min: 10, max: 10 })
	const { input } = addEnemy(grid, me, 2, [7, 10], { weaponItem: gun, tp: 8 })
	const danger = (boosts) => buildThreatMap(me, myReach, [{ ...input, boosts }], 1)
	assert.equal(danger([]).dangerAt(me.cell), 40) // 4 tirs
	assert.equal(danger([boostChip(2, 100)]).dangerAt(me.cell), 60) // 6 PT : 3 tirs × 20
	assert.equal(danger([tpBoostChip(1, 4)]).dangerAt(me.cell), 50) // 11 PT : 5 tirs
	const both = danger([boostChip(2, 100), tpBoostChip(1, 4)]) // 9 PT : 4 tirs × 20
	assert.equal(both.dangerAt(me.cell), 80)
	const threat = both.breakdownAt(me.cell)[0]
	assert.equal(threat.boostTp, 3)
	assert.equal(threat.strengthGain, 100)
	assert.equal(threat.tpGain, 4)
})

test("enemy boosts that cannot be cast do not take one of the MAX_THREAT_BOOSTS slots", () => {
	const grid = makeGrid(21, 21)
	const { me, myReach } = setupMe(grid, [10, 10])
	const gun = weapon({ id: 89, cost: 1, min: 10, max: 10 })
	const { input } = addEnemy(grid, me, 2, [7, 10], { weaponItem: gun, tp: 7 })
	// 3 puces de PT à 8 PT (> 7 PT de l'ennemi : jamais lançables), puis une puce de force abordable.
	const unaffordable = [1, 2, 3].map((i) => tpBoostChip(8, 12, { id: 700 + i }))
	const result = buildThreatMap(me, myReach, [{ ...input, boosts: [...unaffordable, boostChip(2, 100)] }], 1)
	assert.equal(result.dangerAt(me.cell), 100) // la protéine : 5 PT → 5 tirs × 20 > 7 tirs × 10
	assert.equal(result.breakdownAt(me.cell)[0].boostTp, 2)
})

test("enemy TP boosts can finance later boosts in a different order than their inventory", () => {
	const grid = makeGrid(21, 21)
	const { me, myReach } = setupMe(grid, [10, 10])
	const { input } = addEnemy(grid, me, 2, [7, 10], { weaponItem: weapon({ cost: 1, min: 10, max: 10 }), tp: 4 })
	const costly = boostChip(19, 3000)
	const second = tpBoostChip(8, 20)
	const first = tpBoostChip(4, 8)
	const map = buildThreatMap(me, myReach, [{ ...input, boosts: [costly, second, first] }], 1)
	const threat = map.breakdownAt(me.cell)[0]
	assert.equal(threat.damage, 310) // 4 → 8 → 20 → 1 PT, then one shot × 310
	assert.equal(threat.boostTp, 31)
	assert.equal(threat.tpGain, 28)
	assert.equal(threat.strengthGain, 3000)
})

test("enemy boost subsets cannot spend TP from a boost omitted from the subset", () => {
	const grid = makeGrid(21, 21)
	const { me, myReach } = setupMe(grid, [10, 10])
	const { input } = addEnemy(grid, me, 2, [7, 10], { weaponItem: weapon({ cost: 1, min: 10, max: 10 }), tp: 4 })
	const first = tpBoostChip(4, 8)
	const second = tpBoostChip(8, 12)
	const last = chip({ id: 920, cost: 11, features: [
		{ type: 32, minValue: 20, maxValue: 20 },
		{ type: 6, minValue: 1000, maxValue: 1000 }
	] })
	const map = buildThreatMap(me, myReach, [{ ...input, boosts: [last, second, first] }], 1)
	const threat = map.breakdownAt(me.cell)[0]
	assert.equal(threat.damage, 2310) // 4 → 8 → 12 → 21 PT; last alone would falsely give 13 PT
	assert.equal(threat.boostTp, 23)
	assert.equal(threat.tpGain, 40)
	assert.equal(threat.strengthGain, 1000)
})

test("enemy TP boosts cannot finance each other without an affordable first cast", () => {
	const grid = makeGrid(21, 21)
	const { me, myReach } = setupMe(grid, [10, 10])
	const { input } = addEnemy(grid, me, 2, [7, 10], { weaponItem: weapon({ cost: 1, min: 10, max: 10 }), tp: 4 })
	const boosts = [tpBoostChip(5, 12), tpBoostChip(6, 12), boostChip(1, 100)]
	const map = buildThreatMap(me, myReach, [{ ...input, boosts }], 1)
	assert.equal(map.dangerAt(me.cell), 60)
	assert.equal(map.breakdownAt(me.cell)[0].boostTp, 1)
	assert.equal(map.breakdownAt(me.cell)[0].tpGain, 0)
})

test("EnemyMemory.updateThreatMap: a ready TP boost chip raises the danger, one in cooldown does not", () => {
	const gun = weapon({ id: 94, cost: 4, min: 10, max: 10 })
	const motivation = tpBoostChip(2, 4, { cooldown: 5 })
	const scenario = memoryScenario({ enemyWeapon: gun, enemyChips: [motivation] })
	run(scenario)
	assert.equal(scenario.memory.getThreatMap().dangerAt(scenario.me.cell), 30) // 10 − 2 + 4 = 12 PT : 3 tirs (2 sans)
	scenario.memory.getProfile(2).startCooldown(motivation)
	scenario.memory.updateReachable(scenario.me, [], [scenario.enemy], 2)
	scenario.memory.updateThreatMap(scenario.me, [scenario.enemy], 2)
	assert.equal(scenario.memory.getThreatMap().dangerAt(scenario.me.cell), 20)
})

test("truncated reachable inputs are flagged", () => {
	const grid = makeGrid(41, 41)
	const { me, myReach } = setupMe(grid, [20, 20])
	const { input } = addEnemy(grid, me, 2, [20, 30], { mp: 16, weaponItem: weapon({ minRange: 1, maxRange: 20 }) })
	assert.equal(input.reachable.truncated, true)
	const map = buildThreatMap(me, myReach, [input], 1)
	assert.equal(map.inputsTruncated, true)
	assert.equal(map.truncated, false)
	assert.equal(map.dangerAt(me.cell), 45)
})

// --- ignorer mon entité ---------------------------------------------------------

test("computeReachableCells: ignoreEntityId frees the cell of that entity, default behaviour unchanged", () => {
	const grid = makeGrid(21, 1)
	const enemy = grid.place(makeEntity(2, 6), 9, 0)
	const me = grid.place(makeEntity(1, 1), 5, 0)
	const blocked = computeReachableCells(enemy, 6, 1)
	assert.equal(blocked.size, 10) // départ, 3 cases à gauche (8..6), 6 à droite (10..15)
	assert.equal(blocked.canReach(grid.cell(5, 0)), false)
	assert.equal(blocked.canReach(grid.cell(4, 0)), false)
	const defaultOptions = computeReachableCells(enemy, 6, 1, {})
	assert.equal(defaultOptions.size, blocked.size)
	const ignoring = computeReachableCells(enemy, 6, 1, { ignoreEntityId: me.id })
	assert.equal(ignoring.canReach(grid.cell(5, 0)), true)
	assert.equal(ignoring.costTo(grid.cell(5, 0)), 4)
	assert.equal(ignoring.canReach(grid.cell(3, 0)), true)
	assert.equal(ignoring.size, blocked.size + 3)
	// une autre entité reste bloquante
	const other = computeReachableCells(enemy, 6, 1, { ignoreEntityId: 99 })
	assert.equal(other.size, blocked.size)
})

test("the cell I leave is free for the enemy; the enemy never shoots from the cell I stand on", () => {
	const grid = makeGrid(21, 1)
	const memory = new EnemyMemory()
	const me = grid.place(makeEntity(1, 1), 5, 0)
	const gun = weapon({ id: 40, minRange: 1, maxRange: 1, min: 10, max: 20, cost: 3 })
	const enemy = grid.place(makeEntity(2, 6, { weapon: gun, weapons: [gun], tp: 10 }), 9, 0)
	memory.identify(enemy, 1)
	memory.update(enemy, me, 1, 1)
	memory.updateReachable(me, [], [enemy], 1)
	const update = memory.updateThreatMap(me, [enemy], 1)

	assert.notEqual(update, null)
	const map = memory.getThreatMap()
	assert.equal(map.size, 3) // (4,0), (5,0), (6,0)
	// X = (4,0) : l'ennemi doit se placer en (5,0) (ma case libérée, coût 4) ou (3,0) (coût 6)
	assert.equal(map.dangerAt(grid.cell(4, 0)), 45)
	assert.deepEqual([map.breakdownAt(grid.cell(4, 0))[0].shotCell.x], [5])
	// X = (5,0) (je reste) : il tire depuis (6,0) ; (4,0) est aussi adjacente mais plus chère
	assert.deepEqual([map.breakdownAt(grid.cell(5, 0))[0].shotCell.x], [6])
	assert.equal(update.enemies, 1)

	// portée 0 : seule la case X elle-même toucherait X, or l'ennemi ne peut pas s'y tenir
	const corridor = makeGrid(21, 1)
	const stay = corridor.place(makeEntity(1, 1), 5, 0)
	const zero = weapon({ id: 41, minRange: 0, maxRange: 0 })
	const pointBlank = corridor.place(makeEntity(3, 6, { weapon: zero, weapons: [zero], tp: 10 }), 8, 0)
	const memory2 = new EnemyMemory()
	memory2.identify(pointBlank, 1)
	memory2.update(pointBlank, stay, 1, 1)
	memory2.updateReachable(stay, [], [pointBlank], 1)
	memory2.updateThreatMap(stay, [pointBlank], 1)
	assert.equal(memory2.getThreatMap().size, 3)
	assert.equal(memory2.getThreatMap().maxDanger, 0)
})

// --- EnemyMemory ----------------------------------------------------------------

function memoryScenario({ enemyChips = [], enemyWeapon = null, enemyWeapons, tp = 10, mp = 0, meAt = [10, 10], enemyAt = [7, 10] } = {}) {
	const grid = makeGrid(21, 21)
	const memory = new EnemyMemory()
	const me = grid.place(makeEntity(1, 0), meAt[0], meAt[1])
	const enemy = grid.place(
		makeEntity(2, mp, {
			weapon: enemyWeapon,
			weapons: enemyWeapons ?? (enemyWeapon === null ? [] : [enemyWeapon]),
			chips: enemyChips,
			tp
		}),
		enemyAt[0], enemyAt[1]
	)
	memory.identify(enemy, 1)
	memory.update(enemy, me, 1, 1)
	return { grid, memory, me, enemy }
}

const run = ({ memory, me, enemy }, turn = 1) => {
	memory.updateReachable(me, [], [enemy], turn)
	return memory.updateThreatMap(me, [enemy], turn)
}

test("EnemyMemory.updateThreatMap: summary, storage, and a map replaced at each turn", () => {
	const scenario = memoryScenario({ enemyWeapon: weapon({ id: 50, cost: 3, min: 10, max: 20 }) })
	const update = run(scenario)
	assert.equal(update.size, 1)
	assert.equal(update.maxDanger, 45)
	assert.equal(update.minDanger, 45)
	assert.equal(update.enemies, 1)
	assert.equal(update.truncated, false)
	assert.equal(update.pairsEvaluated, 1)
	assert.equal(update.lineOfSightCalls, 0)
	const first = scenario.memory.getThreatMap()
	assert.equal(first.turn, 1)
	assert.equal(first.dangerAt(scenario.me.cell), 45)

	scenario.enemy.tp = 4
	run(scenario, 2)
	const second = scenario.memory.getThreatMap()
	assert.notEqual(second, first)
	assert.equal(second.turn, 2)
	assert.equal(second.dangerAt(scenario.me.cell), 45) // PT max observés (10), pas les 4 actuels
})

test("EnemyMemory.updateThreatMap: enemy TP = max of entity.tp seen; strength is the current one", () => {
	const scenario = memoryScenario({ enemyWeapon: weapon({ id: 51, cost: 3, min: 10, max: 10 }), tp: 3 })
	scenario.enemy.tp = 9
	scenario.memory.update(scenario.enemy, scenario.me, 2, 1)
	scenario.enemy.tp = 0 // PT restants nuls à la lecture suivante
	scenario.enemy.strength = 100
	run(scenario, 2)
	assert.equal(scenario.memory.getProfile(2).maxTpSeen, 9)
	assert.equal(scenario.memory.getThreatMap().dangerAt(scenario.me.cell), 3 * 20) // 3 tirs × 10 × 2
})

test("EnemyMemory.updateThreatMap: ready offensive chips are used, chips in cooldown are not", () => {
	const gun = weapon({ id: 52, cost: 3, min: 10, max: 20 })
	const strike = chip({ id: 60, name: "strike", cost: 4, min: 25, max: 35, cooldown: 3 })
	const scenario = memoryScenario({ enemyWeapon: gun, enemyChips: [strike] })
	run(scenario)
	assert.equal(scenario.memory.getThreatMap().dangerAt(scenario.me.cell), 60)

	scenario.memory.getProfile(2).startCooldown(strike)
	assert.equal(scenario.memory.isChipReady(2, strike), false)
	run(scenario)
	assert.equal(scenario.memory.getThreatMap().dangerAt(scenario.me.cell), 45)
	assert.deepEqual(scenario.memory.getThreatMap().breakdownAt(scenario.me.cell)[0].chips, [])
})

test("EnemyMemory.updateThreatMap: the other known weapons count, at 1 TP for the swap", () => {
	const equipped = weapon({ id: 53, cost: 3, min: 10, max: 10 })
	const other = weapon({ id: 54, cost: 2, min: 100, max: 100 })
	const scenario = memoryScenario({ enemyWeapon: equipped, enemyWeapons: [equipped, other] })
	assert.deepEqual(scenario.memory.knownWeapons(2), [equipped, other])
	run(scenario)
	// 10 PT − 1 (changement) = 9 PT : 4 tirs de 100 avec l'arme à 2 PT.
	assert.equal(scenario.memory.getThreatMap().dangerAt(scenario.me.cell), 400)
	assert.equal(scenario.memory.getThreatMap().breakdownAt(scenario.me.cell)[0].swapTp, 1)
})

test("EnemyMemory.updateThreatMap: an enemy with no equipped weapon is armed by its other known weapons", () => {
	const other = weapon({ id: 56, cost: 3, min: 10, max: 10 })
	const scenario = memoryScenario({ enemyWeapon: null, enemyWeapons: [other] })
	const update = run(scenario)
	assert.equal(update.enemies, 1)
	assert.equal(scenario.memory.getThreatMap().dangerAt(scenario.me.cell), 30)
})

test("a swapped weapon pays the TP of the swap: fewer shots than the same weapon already equipped", () => {
	const grid = makeGrid(21, 21)
	const equipped = weapon({ id: 60, cost: 3, min: 1, max: 1 })
	const other = weapon({ id: 61, cost: 5, min: 50, max: 50 })
	const { me, myReach } = setupMe(grid, [10, 10])
	const swap = addEnemy(grid, me, 2, [7, 10], { weaponItem: equipped, otherWeapons: [other] })
	const swapMap = buildThreatMap(me, myReach, [swap.input], 1)
	assert.equal(swapMap.dangerAt(me.cell), 50) // 9 PT → 1 tir (5 PT) ; l'arme équipée ferait 3
	const ready = addEnemy(makeGrid(21, 21), me, 2, [7, 10], { weaponItem: other })
	assert.equal(buildThreatMap(me, myReach, [ready.input], 1).dangerAt(me.cell), 100) // 10 PT → 2 tirs
})

test("a weapon the enemy cannot afford after the swap, or that cannot reach me, adds nothing", () => {
	const equipped = weapon({ id: 62, cost: 3, min: 10, max: 10 })
	const tooCostly = weapon({ id: 63, cost: 5, min: 500, max: 500 })
	const tooShort = weapon({ id: 64, cost: 2, min: 500, max: 500, maxRange: 2 })
	const { me, myReach } = setupMe(makeGrid(21, 21), [10, 10])
	const grid = makeGrid(21, 21)
	const place = addEnemy(grid, me, 2, [7, 10], { tp: 5, weaponItem: equipped, otherWeapons: [tooCostly, tooShort] })
	assert.equal(buildThreatMap(me, myReach, [place.input], 1).dangerAt(me.cell), 10) // 5 PT : 1 tir, ni 5+1 PT ni portée 2 (distance 3)
})

test("the equipped weapon listed again in otherWeapons is never counted twice nor charged the swap", () => {
	const equipped = weapon({ id: 70, cost: 3, min: 10, max: 10 })
	const twin = { ...equipped } // même id, autre objet
	const { breakdown } = dangerOf(makeGrid(21, 21), { tp: 9, weaponItem: equipped, otherWeapons: [equipped, twin] })
	assert.equal(breakdown.length, 1)
	assert.equal(breakdown[0].damage, 30) // 9 PT / 3 = 3 tirs, sans PT de changement
	assert.equal(breakdown[0].swapTp, 0)
})

test("a non-integer enemy TP is floored before the swap affordability check", () => {
	const equipped = weapon({ id: 71, cost: 3, min: 10, max: 10 })
	const other = weapon({ id: 72, cost: 5, min: 500, max: 500 })
	// 5,9 PT -> 5 : coût 5 + changement 1 = 6 > 5 : l'arme à changer est écartée.
	assert.equal(dangerOf(makeGrid(21, 21), { tp: 5.9, weaponItem: equipped, otherWeapons: [other] }).breakdown[0].damage, 10)
	// 6,5 PT -> 6 : 5 + 1 = 6 : un tir de 500.
	const ok = dangerOf(makeGrid(21, 21), { tp: 6.5, weaponItem: equipped, otherWeapons: [other] }).breakdown[0]
	assert.equal(ok.damage, 500)
	assert.equal(ok.swapTp, 1)
})

test("at most MAX_THREAT_WEAPONS weapons are examined, the equipped one first", () => {
	const equipped = weapon({ id: 80, cost: 3, min: 1, max: 1 })
	const fillers = [81, 82, 83].map((id) => weapon({ id, cost: 3, min: 2, max: 2 }))
	const fifth = weapon({ id: 84, cost: 3, min: 900, max: 900 })
	assert.equal(MAX_THREAT_WEAPONS, 4)
	const capped = dangerOf(makeGrid(21, 21), { tp: 4, weaponItem: equipped, otherWeapons: [...fillers, fifth] })
	assert.equal(capped.breakdown[0].damage, 2) // la 5e arme (900) n'est pas examinée
	const within = dangerOf(makeGrid(21, 21), { tp: 4, weaponItem: equipped, otherWeapons: [fillers[0], fifth] })
	assert.equal(within.breakdown[0].damage, 900)
})

test("several enemies: the swap only applies to the enemy that changes weapon, dangers add up", () => {
	const grid = makeGrid(21, 21)
	const { me, myReach } = setupMe(grid, [10, 10])
	const gun = weapon({ id: 90, cost: 3, min: 10, max: 10 })
	const big = weapon({ id: 91, cost: 4, min: 100, max: 100 })
	const a = addEnemy(grid, me, 2, [7, 10], { tp: 8, weaponItem: gun, otherWeapons: [big] })
	const b = addEnemy(grid, me, 3, [13, 10], { tp: 8, weaponItem: gun })
	const map = buildThreatMap(me, myReach, [a.input, b.input], 1)
	// A : (8 − 1) / 4 = 1 tir de 100 ; B : 2 tirs de 10.
	assert.equal(map.dangerAt(me.cell), 120)
	assert.deepEqual(map.breakdownAt(me.cell).map((entry) => entry.swapTp), [1, 0])
	assert.equal(map.enemyCount, 2)
})

test("EnemyMemory.updateThreatMap: null (and map cleared) without my reachable cells of this turn", () => {
	const scenario = memoryScenario({ enemyWeapon: weapon({ id: 55 }) })
	assert.equal(scenario.memory.updateThreatMap(scenario.me, [scenario.enemy], 1), null) // jamais calculées
	assert.equal(scenario.memory.getThreatMap(), null)
	run(scenario, 1)
	assert.notEqual(scenario.memory.getThreatMap(), null)
	assert.equal(scenario.memory.updateThreatMap(scenario.me, [scenario.enemy], 2), null) // périmées
	assert.equal(scenario.memory.getThreatMap(), null)
})

test("EnemyMemory.updateThreatMap: an exception never leaves the previous turn's map in place", () => {
	const scenario = memoryScenario({ enemyWeapon: weapon({ id: 57 }) })
	run(scenario, 1)
	assert.equal(scenario.memory.getThreatMap().turn, 1)
	scenario.memory.updateReachable(scenario.me, [], [scenario.enemy], 2)
	scenario.enemy.id = 99
	Object.defineProperty(scenario.enemy, "weapons", { get() { throw new Error("boom") } })
	assert.throws(() => scenario.memory.updateThreatMap(scenario.me, [scenario.enemy], 2))
	assert.equal(scenario.memory.getThreatMap(), null)
})

test("EnemyMemory.updateThreatMap: dead enemies are ignored; the enemy BFS runs only for armed enemies", () => {
	const scenario = memoryScenario({ enemyWeapon: weapon({ id: 56 }) })
	scenario.memory.updateReachable(scenario.me, [], [scenario.enemy], 1)
	scenario.enemy.life = 0
	const update = scenario.memory.updateThreatMap(scenario.me, [scenario.enemy], 1)
	assert.equal(update.enemies, 0)
	assert.equal(update.maxDanger, 0)

	const unarmed = memoryScenario({ enemyWeapon: null })
	let cellCalls = 0
	const original = globalThis.Field.cellFromXY
	globalThis.Field.cellFromXY = (x, y) => { cellCalls++; return original(x, y) }
	unarmed.memory.updateReachable(unarmed.me, [], [unarmed.enemy], 1)
	const before = cellCalls
	unarmed.memory.updateThreatMap(unarmed.me, [unarmed.enemy], 1)
	assert.equal(cellCalls, before) // aucun parcours supplémentaire
})

// --- intégration dans turn() ----------------------------------------------

/** Monde jouable par les plans actuels (`helpers/turn-world.mjs`) sur la grille de ce fichier : alliée en (5,7). */
function makeCombatWorld(ids, enemyWeapon, turnNumber) {
	const grid = makeGrid(21, 21)
	const world = makeTurnWorld({
		turnNumber, grid, enemyId: ids.enemy, enemyAt: [9, 5], enemyMp: 2, enemyTp: 5, enemyWeapon,
		ally: makeEntity(ids.ally, 2)
	})
	return { ...world, grid }
}

const armedGun = (extra = {}) => ({
	id: 90, name: "enemy gun", cost: 3, minRange: 0, maxRange: 6, needsLos: false,
	features: [{ type: 1, minValue: 10, maxValue: 20 }], ...extra
})

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

test("turn() builds the threat map, logs one short [Threat] line before TURN END, and fires as with an unarmed enemy", async () => {
	// tours distincts : le module garde `enemyMemory` (et mes cases atteignables) d'un test à l'autre
	const { turn } = await import("../dist/Main/Kassbi_Book.js")
	const { enemyMemory } = await import("../dist/Brain/TurnObservation.js")
	const unarmed = makeCombatWorld({ enemy: 120, ally: 121 }, { ...armedGun(), features: [] }, 10)
	const unarmedLines = await runTurnCapturingLogs(turn)
	const unarmedActions = [...unarmed.actions]

	const armed = makeCombatWorld({ enemy: 122, ally: 123 }, armedGun(), 11)
	debugLogs.length = 0
	const lines = await runTurnCapturingLogs(turn)

	// La carte de danger entre dans le score du plan : seul le nombre de tirs est commun aux deux mondes.
	assert.equal(unarmedActions.filter((action) => action === "shoot").length, 2)
	assert.equal(armed.actions.filter((action) => action === "shoot").length, 2)
	const threatLines = lines.filter((line) => line.startsWith("[Threat]"))
	assert.equal(threatLines.length, 1)
	assert.match(threatLines[0], /^\[Threat\] 23\/23 cells, danger max 15\.0 min \d+\.0, safest \(\d+,\d+\), 1 armed enemies, \d+ pairs, 0 LoS$/)
	assert.ok(lines.indexOf(threatLines[0]) < lines.findIndex((line) => line.includes("=== KASSBI BOOK TURN END ===")))
	assert.equal(lines.filter((line) => line.startsWith("[Reachable]")).length, 1)
	assert.match(unarmedLines.find((line) => line.startsWith("[Threat]")), /danger max 0\.0 min 0\.0, safest \(5,5\), 0 armed enemies/)
	const map = enemyMemory.getThreatMap()
	assert.equal(map.turn, 11)
	assert.equal(map.size, 23)
	assert.equal(map.maxDanger, 15) // 5 PT vus / coût 3 = 1 tir × 15
	assert.equal(debugLogs.some((entry) => entry.includes("observeThreatMap")), false)
	assert.equal(lines.at(-1), "Operations: 0/0 (0.0%)")
})

test("turn() still plays and logs reachable cells when the threat map fails, and reports the error", async () => {
	const { turn } = await import("../dist/Main/Kassbi_Book.js")
	const { actions } = makeCombatWorld({ enemy: 130, ally: 131 }, armedGun({ needsLos: true }), 12)
	globalThis.Field.lineOfSight = () => { throw new Error("los down") }
	debugLogs.length = 0

	const lines = await runTurnCapturingLogs(turn)

	assert.equal(actions.filter((action) => action === "shoot").length, 2)
	assert.equal(lines.filter((line) => line.startsWith("[Reachable]")).length, 1)
	assert.equal(lines.some((line) => line.startsWith("[Threat]")), false)
	assert.equal(debugLogs.some((entry) => entry.includes("observeThreatMap") && entry.includes("los down")), true)
	assert.ok(lines.some((line) => line.includes("=== KASSBI BOOK TURN END ===")))
})

test("turn() logs 'unavailable' when my reachable cells could not be computed", async () => {
	const { turn } = await import("../dist/Main/Kassbi_Book.js")
	makeCombatWorld({ enemy: 140, ally: 141 }, armedGun(), 13)
	globalThis.Field = { cellFromXY() { throw new Error("grid down") } }
	const lines = await runTurnCapturingLogs(turn)
	assert.equal(lines.filter((line) => line === "[Threat] unavailable").length, 1)
	assert.ok(lines.some((line) => line.includes("=== KASSBI BOOK TURN END ===")), "the turn still ends normally")
})

// --- zone visée (buildTargetZone) -------------------------------------------------------------------

const { buildTargetZone, MAX_TARGET_ZONE_PAIRS, TARGET_ZONE_OPERATIONS_FRACTION } = await import("../dist/Classes/Context/ThreatMap.js")

/** Moi en (8,10) avec 2 PM ; ennemi en (12,10), 1 PM, arme de portée 1 à 3 : il touche tout le losange de rayon 4. */
function targetZoneScenario(obstacles = [[15, 10]]) {
	const grid = makeGrid(21, 21, obstacles)
	const { me, myReach } = setupMe(grid, [8, 10], 2)
	const { input } = addEnemy(grid, me, 2, [12, 10], { mp: 1, weaponItem: weapon({ id: 95, cost: 3, min: 10, max: 10, minRange: 1, maxRange: 3 }) })
	return { grid, me, myReach, input, danger: buildThreatMap(me, myReach, [input], 1) }
}

test("target zone: every cell an enemy can hit, reachable by me or not; untouched cells and obstacles are left out", () => {
	const { grid, me, myReach, input, danger } = targetZoneScenario()
	const zone = buildTargetZone(me, [input], 1)
	assert.equal(zone.truncated, false)
	assert.equal(zone.candidateCells, 40) // losange de rayon 1 PM + 3 de portée (41 cases) moins l'obstacle
	assert.equal(zone.size, 40)
	assert.equal(zone.evaluatedCells, 40)
	assert.ok(zone.pairsEvaluated <= 40 * 2, `pairs ${zone.pairsEvaluated}`) // parcours exhaustif : 40 × 5 cases de tir
	// hors de mes cases atteignables, mais visée
	const far = grid.cell(14, 10)
	assert.equal(myReach.canReach(far), false)
	assert.equal(danger.has(far), false)
	assert.equal(zone.dangerAt(far), 30)
	assert.equal(zone.entryAt(far).mpCost, -1)
	assert.equal(zone.dangerAt(grid.cell(12, 14)), 30)
	// atteignable par moi mais hors de toute portée : dans la carte de danger (0), pas dans la zone
	const safe = grid.cell(6, 10)
	assert.equal(danger.dangerAt(safe), 0)
	assert.equal(zone.has(safe), false)
	assert.equal(zone.has(grid.cell(12, 15)), false) // distance 5 de l'ennemi
	assert.equal(zone.has(grid.cell(15, 10)), false) // obstacle
	assert.ok([...zone.entries()].every((entry) => entry.danger > 0))
	// de la plus proche de moi à la plus lointaine
	const distances = [...zone.entries()].map((entry) => Math.abs(entry.cell.x - 8) + Math.abs(entry.cell.y - 10))
	assert.deepEqual(distances, [...distances].sort((a, b) => a - b))
	assert.equal(distances[0], 0)
})

test("target zone: cells shared with the danger map have the same danger, computed or reused from it", () => {
	const { me, input, danger } = targetZoneScenario()
	const computed = buildTargetZone(me, [input], 1)
	const reused = buildTargetZone(me, [input], 1, { known: danger })
	let shared = 0
	for (const entry of danger.entries()) {
		assert.equal(computed.has(entry.cell), entry.danger > 0)
		if (entry.danger > 0) {
			shared++
			assert.equal(computed.dangerAt(entry.cell), entry.danger)
			// même plan ; seule la case de tir retenue parmi les ex æquo peut différer (toujours une case de tir qui touche)
			const [threat] = computed.breakdownAt(entry.cell)
			assert.deepEqual({ ...threat, shotCell: null }, { ...entry.breakdown[0], shotCell: null })
			assert.ok(input.reachable.canReach(threat.shotCell))
			const range = Math.abs(threat.shotCell.x - entry.cell.x) + Math.abs(threat.shotCell.y - entry.cell.y)
			assert.ok(range >= 1 && range <= 3)
			assert.equal(reused.entryAt(entry.cell), entry) // reprise telle quelle (coût en PM compris)
		}
	}
	assert.equal(shared, 5) // (8,10) (9,9) (9,10) (9,11) (10,10)
	const view = (map) => [...map.entries()].map((entry) => [entry.cell.x, entry.cell.y, entry.danger])
	assert.deepEqual(view(reused), view(computed))
	// aucune paire pour une case déjà dans la carte de danger, à danger nul comprise : seules les autres sont calculées
	const known = [...danger.entries()].filter((entry) => Math.abs(entry.cell.x - 12) + Math.abs(entry.cell.y - 10) <= 4).length
	let inside = 0
	const counting = { canHit(from, target, item) { if (danger.has(target)) inside++; return new GeometricShotCells().canHit(from, target, item) } }
	assert.equal(buildTargetZone(me, [input], 1, { known: danger, provider: counting }).size, 40)
	assert.equal(inside, 0)
	assert.ok(known >= 5 && reused.pairsEvaluated < computed.pairsEvaluated)
	assert.deepEqual([reused.evaluatedCells, reused.candidateCells], [40, 40])
})

test("target zone: its own pair cap truncates and keeps the cells nearest to me", () => {
	const { grid, me, input } = targetZoneScenario()
	const capped = buildTargetZone(me, [input], 1, { maxPairs: 2 }) // une paire par case ici : 2 cases complètes
	assert.equal(capped.truncated, true)
	assert.equal(capped.pairsEvaluated, 2)
	assert.equal(capped.candidateCells, 40)
	assert.equal(capped.evaluatedCells, 2)
	assert.deepEqual([...capped.entries()].map((entry) => [entry.cell.x, entry.cell.y]), [[8, 10], [9, 10]])
	assert.equal(capped.dangerAt(grid.cell(14, 10)), null) // non évaluée : absente

	// plafond par défaut : dédié, exporté ; le parcours exhaustif (861 cases × 113 cases de tir) le dépassait et la zone
	// était coupée ; la recherche bornée examine moins de deux paires par case et la zone est complète
	assert.equal(MAX_TARGET_ZONE_PAIRS, 16000)
	const wide = makeGrid(41, 21)
	const { me: me2, myReach } = setupMe(wide, [10, 10], 1)
	const { input: sniper } = addEnemy(wide, me2, 2, [28, 10], { mp: 7, weaponItem: weapon({ minRange: 1, maxRange: 40 }) })
	const before = buildThreatMap(me2, myReach, [sniper], 1)
	const zone = buildTargetZone(me2, [sniper], 1)
	assert.equal(zone.truncated, false)
	assert.ok(zone.pairsEvaluated <= 2 * 41 * 21, `pairs ${zone.pairsEvaluated}`)
	assert.deepEqual([zone.size, zone.evaluatedCells, zone.candidateCells], [41 * 21, 41 * 21, 41 * 21])
	assert.equal(before.truncated, false) // la carte de danger garde son propre plafond
})

/** Ancien calcul de la zone : `bestThreat` exhaustif (toutes les cases de tir) sur toutes les cases libres de la grille. */
function exhaustiveZone(grid, me, inputs) {
	const free = [...grid.cells.values()].filter((cell) => !cell.obstacle)
	const everywhere = { truncated: false, size: free.length, entries: () => free.map((cell) => ({ cell, cost: -1 })).values() }
	return buildThreatMap(me, everywhere, inputs, 1, { maxPairs: Number.POSITIVE_INFINITY })
}

function assertSameDamage(zone, reference) {
	assert.equal(zone.truncated, false)
	let touched = 0
	for (const entry of reference.entries()) {
		const where = `cell ${entry.cell.x},${entry.cell.y}`
		assert.equal(zone.has(entry.cell), entry.danger > 0, where)
		if (entry.danger > 0) {
			touched++
			assert.equal(zone.dangerAt(entry.cell), entry.danger, where)
			assert.deepEqual(zone.breakdownAt(entry.cell).map((threat) => [threat.enemyId, threat.damage]),
				entry.breakdown.map((threat) => [threat.enemyId, threat.damage]), where)
		}
	}
	assert.equal(zone.size, touched)
	return touched
}

test("target zone: complete for an enemy with 7 MP and range 12 on open ground, within a few pairs per cell", () => {
	const grid = makeGrid(41, 41)
	const { me } = setupMe(grid, [4, 20], 3)
	const { input } = addEnemy(grid, me, 2, [20, 20], { mp: 7, weaponItem: weapon({ minRange: 1, maxRange: 12, needsLos: true }) })
	assert.equal(input.reachable.size, 113)
	const zone = buildTargetZone(me, [input], 1)
	// losange de rayon 7 PM + 12 de portée : 761 cases, toutes visées ; l'ancien parcours (761 × 113 = 85 993 paires)
	// s'arrêtait à MAX_TARGET_ZONE_PAIRS en ne gardant que le côté proche de moi
	assert.deepEqual([zone.truncated, zone.candidateCells, zone.evaluatedCells, zone.size], [false, 761, 761, 761])
	assert.ok(zone.pairsEvaluated <= 2 * 761, `pairs ${zone.pairsEvaluated}`)
	assert.equal(zone.dangerAt(grid.cell(39, 20)), 45) // côté opposé à moi, à 19 de l'ennemi : 3 tirs de 15
	assert.equal(assertSameDamage(zone, exhaustiveZone(grid, me, [input])), 761)
})

test("target zone: same damage per cell as the exhaustive search with obstacles, launch patterns, ranges and several enemies", () => {
	const obstacles = []
	for (let x = 0; x < 31; x++) {
		for (let y = 0; y < 31; y++) {
			if ((x * 7 + y * 13) % 11 === 0 && (x + y) % 3 !== 0) obstacles.push([x, y])
		}
	}
	const free = (at) => !obstacles.some(([x, y]) => x === at[0] && y === at[1])
	const grid = makeGrid(31, 31, obstacles)
	// la ligne de vue du mock ne voit que les lignes droites : un échantillonnage du segment bloque aussi les autres paires
	globalThis.Field.lineOfSight = (from, to) => {
		const steps = Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y))
		for (let i = 1; i < steps; i++) {
			const x = Math.round(from.x + ((to.x - from.x) * i) / steps)
			const y = Math.round(from.y + ((to.y - from.y) * i) / steps)
			if (grid.cell(x, y).obstacle) return false
		}
		return true
	}
	const spots = [[3, 15], [15, 15], [22, 8], [9, 24], [25, 25]]
	assert.ok(spots.every(free))
	const { me } = setupMe(grid, spots[0], 3)
	const line = weapon({ id: 201, cost: 4, min: 30, max: 40, minRange: 1, maxRange: 6, needsLos: true, launchType: LAUNCH_TYPE.LINE, maxUses: 3 })
	const far = weapon({ id: 202, cost: 8, min: 90, max: 100, minRange: 5, maxRange: 12, needsLos: true, launchType: LAUNCH_TYPE.LINE })
	const diagonal = weapon({ id: 203, cost: 4, min: 25, max: 30, minRange: 2, maxRange: 6, needsLos: true, launchType: LAUNCH_TYPE.DIAGONAL })
	const round = weapon({ id: 204, cost: 3, min: 15, max: 20, minRange: 1, maxRange: 7, needsLos: true })
	const spark = chip({ id: 211, cost: 3, min: 8, max: 16, minRange: 0, maxRange: 10 })
	const rock = chip({ id: 212, cost: 5, min: 38, max: 39, minRange: 2, maxRange: 6, needsLos: true, cooldown: 1 })
	const star = chip({ id: 213, cost: 2, min: 20, max: 20, minRange: 1, maxRange: 9, launchType: LAUNCH_TYPE.STAR_INVERTED, cooldown: 1 })
	const inputs = [
		addEnemy(grid, me, 2, spots[1], { mp: 4, weaponItem: line, chips: [spark, rock] }).input,
		addEnemy(grid, me, 3, spots[2], { mp: 7, tp: 14, weaponItem: far, otherWeapons: [round], chips: [star] }).input,
		addEnemy(grid, me, 4, spots[3], { mp: 3, weaponItem: diagonal, otherWeapons: [line], chips: [rock, spark] }).input,
		addEnemy(grid, me, 5, spots[4], { mp: 5, weaponItem: round, chips: [star, rock] }).input
	]
	let exhaustivePairs = 0
	for (const count of [1, 2, 4]) {
		const enemies = inputs.slice(0, count)
		const reference = exhaustiveZone(grid, me, enemies)
		const zone = buildTargetZone(me, enemies, 1)
		const touched = assertSameDamage(zone, reference)
		assert.ok(touched > 150, `touched ${touched}`)
		exhaustivePairs = reference.pairsEvaluated
		assert.ok(zone.pairsEvaluated * 8 < exhaustivePairs, `pairs ${zone.pairsEvaluated} vs ${exhaustivePairs}`)
		// un fournisseur sans `hitSignature` ni motif déclaré : bornes par portée seule (plus de paires), mêmes dégâts
		const base = new GeometricShotCells()
		const plain = { canHit: (a, b, c) => base.canHit(a, b, c) }
		assertSameDamage(buildTargetZone(me, enemies, 1, { provider: plain, maxPairs: Number.POSITIVE_INFINITY }), reference)
	}
	// plusieurs ennemis : au moins une case visée par deux d'entre eux, danger = somme
	const all = buildTargetZone(me, inputs, 1)
	assert.ok([...all.entries()].some((entry) => entry.breakdown.length >= 2 &&
		entry.danger === entry.breakdown.reduce((sum, threat) => sum + threat.damage, 0)))
	// la case de tir annoncée est une case de tir de l'ennemi d'où l'arme et les puces du plan touchent
	const check = new GeometricShotCells()
	for (const entry of all.entries()) {
		for (const threat of entry.breakdown) {
			const input = inputs.find((candidate) => candidate.id === threat.enemyId)
			assert.ok(input.reachable.canReach(threat.shotCell))
			for (const item of [threat.weapon, ...threat.chips]) {
				assert.ok(item === null || check.canHit(threat.shotCell, entry.cell, item))
			}
		}
	}
})

test("target zone: its own operations ceiling (below the planner's) truncates; the danger map is not affected", () => {
	const previous = globalThis.System
	try {
		assert.ok(TARGET_ZONE_OPERATIONS_FRACTION < 0.8)
		globalThis.System = { operations: 100 * TARGET_ZONE_OPERATIONS_FRACTION, maxOperations: 100 }
		const { me, input, danger } = targetZoneScenario()
		assert.equal(danger.truncated, false)
		assert.equal(danger.size, 13)
		const stopped = buildTargetZone(me, [input], 1)
		assert.equal(stopped.truncated, true)
		assert.equal(stopped.size, 0)
		assert.equal(stopped.pairsEvaluated, 0)
		globalThis.System.operations = 100 * TARGET_ZONE_OPERATIONS_FRACTION - 1
		const complete = buildTargetZone(me, [input], 1)
		assert.equal(complete.truncated, false)
		assert.equal(complete.size, 40)
	} finally {
		globalThis.System = previous
	}
})

test("target zone: reports the operations it consumed; stops at half of the turn's operations, wherever the danger map left them", () => {
	const previous = globalThis.System
	try {
		assert.equal(TARGET_ZONE_OPERATIONS_FRACTION, 0.5)
		let reads = 0
		globalThis.System = { maxOperations: 1000, get operations() { return 300 + 2 * reads++ } } // carte de danger déjà à 30 %
		const { me, input } = targetZoneScenario()
		const zone = buildTargetZone(me, [input], 1)
		assert.deepEqual([zone.truncated, zone.size, zone.evaluatedCells], [false, 40, 40])
		assert.ok(zone.operations > 0)
		assert.equal(buildThreatMap(me, computeReachableCells(me, 2, 1), [input], 1).operations, null)
		globalThis.System = undefined
		assert.equal(buildTargetZone(me, [input], 1).operations, null)
	} finally {
		globalThis.System = previous
	}
})

test("danger map: the planner's operations ceiling (80 %) is unchanged by the shared loop", () => {
	const previous = globalThis.System
	try {
		globalThis.System = { operations: 80, maxOperations: 100 }
		const stopped = targetZoneScenario().danger
		assert.deepEqual([stopped.truncated, stopped.size, stopped.pairsEvaluated, stopped.candidateCells], [true, 0, 0, 13])
		globalThis.System.operations = 79
		const complete = targetZoneScenario().danger
		assert.deepEqual([complete.truncated, complete.size, complete.candidateCells], [false, 13, 13])
	} finally {
		globalThis.System = previous
	}
})

test("target zone: no armed enemy or no enemy gives an empty zone", () => {
	const { me, input } = targetZoneScenario()
	assert.equal(buildTargetZone(me, [], 1).size, 0)
	const unarmed = buildTargetZone(me, [{ ...input, weapon: null }], 1)
	assert.deepEqual([unarmed.size, unarmed.candidateCells, unarmed.truncated, unarmed.enemyCount], [0, 0, false, 1])
})

test("EnemyMemory.computeTargetZone: on demand, from the turn's danger map inputs, sharing the line-of-sight cache", () => {
	const sighted = weapon({ id: 96, cost: 3, min: 10, max: 10, minRange: 1, maxRange: 3, needsLos: true })
	const scenario = memoryScenario({ enemyWeapon: sighted, mp: 1 })
	assert.equal(scenario.memory.computeTargetZone(scenario.me), null) // pas de carte de danger
	run(scenario, 1)
	const danger = scenario.memory.getThreatMap()
	const losBefore = scenario.grid.losCalls.length
	const zone = scenario.memory.computeTargetZone(scenario.me)
	assert.equal(scenario.memory.getThreatMap(), danger) // la carte du planificateur n'est ni remplacée ni modifiée
	assert.equal(danger.size, 1)
	assert.equal(zone.turn, 1)
	assert.equal(zone.size, 41)
	assert.equal(zone.entryAt(scenario.me.cell), danger.entryAt(scenario.me.cell))
	assert.equal(zone.dangerAt(scenario.grid.cell(4, 10)), 30) // derrière l'ennemi, hors de ma portée de déplacement
	assert.ok(scenario.grid.losCalls.length > losBefore)
	// cache partagé : un second calcul ne redemande aucune ligne de vue
	const losAfter = scenario.grid.losCalls.length
	const again = scenario.memory.computeTargetZone(scenario.me)
	assert.equal(again.lineOfSightCalls, 0)
	assert.equal(scenario.grid.losCalls.length, losAfter)
	assert.notEqual(again, zone) // jamais stockée
	// carte de danger effacée (cases atteignables périmées) : plus de zone
	assert.equal(scenario.memory.updateThreatMap(scenario.me, [scenario.enemy], 2), null)
	assert.equal(scenario.memory.computeTargetZone(scenario.me), null)
})
