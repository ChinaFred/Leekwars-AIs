import assert from "node:assert/strict"
import test from "node:test"

globalThis.Color = { rgb: () => 0 }
const debugLogs = []
globalThis.Debug = { log: (message) => debugLogs.push(String(message)), pause() {} }
globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4, POISON: 5, BUFF_STRENGTH: 6 }
globalThis.Fight = { turn: 1 }

const { turn } = await import("../dist/Main/Kassbi_Class.js")
const {
	boostNetDamage, castBoostInContact, castBoostWithSpareTp, pickBoost, FUTURE_TURN_WEIGHT
} = await import("../dist/Brain/StrengthBoost.js")
const { hasActiveStrengthBoost } = await import("../dist/Brain/StrengthBoost.js")

const machineGun = {
	id: 38, name: "machine_gun", cost: 4, minRange: 1, maxRange: 6, needsLos: false, maxUses: -1,
	features: [{ type: 1, minValue: 20, maxValue: 25 }]
}
const protein = (extra = {}) => ({
	id: 8, name: "protein", cost: 3, cooldown: 3, currentCooldown: 0, minRange: 0, maxRange: 0, needsLos: false,
	features: [{ type: 38, minValue: 90, maxValue: 90, turns: 2 }], ...extra
})
const boostChip = (gain, extra = {}) => protein({ features: [{ type: 38, minValue: gain, maxValue: gain, turns: 2 }], ...extra })
// Ennemi armé : la carte de danger compte les ennemis armés (`threat.enemyCount`), sans quoi le planificateur se replie.
const enemyGun = { id: 90, name: "enemy gun", cost: 3, minRange: 0, maxRange: 6, needsLos: false, features: [{ type: 1, minValue: 10, maxValue: 20 }] }

// --- monde de combat pour turn() : grille vide 31 x 11, planificateur réel -------------------------------------

function makeWorld({
	turnNumber, chips = [protein()], effects = [], meAt = [5, 5], enemyAt = [9, 5], equipped = machineGun,
	life = 300, mp = 3, tp = 10, enemyLife = 300, chestAt = null, FakeChest = null, useChipImpl = null
} = {}) {
	const cells = new Map()
	for (let x = 0; x < 31; x++) for (let y = 0; y < 11; y++) {
		cells.set(`${x},${y}`, { id: y * 31 + x, x, y, empty: true, obstacle: false, entity: null })
	}
	globalThis.Field = { cellFromXY: (x, y) => cells.get(`${x},${y}`) ?? null, lineOfSight: () => true }
	const place = (entity, [x, y]) => {
		const cell = cells.get(`${x},${y}`)
		cell.entity = entity
		cell.empty = false
		entity.cell = cell
		return entity
	}
	const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
	const actions = []
	const trace = []
	const me = place({
		id: 1, name: "me", level: 10, life, maxLife: 300, mp, tp, strength: 10, science: 0, wisdom: 0,
		weapon: equipped, weapons: [machineGun], chips, effects, launchedEffects: [],
		say() {},
		distance(other) { return distance(this.cell, other.cell) },
		canUseWeapon(target) {
			return this.weapon !== null && this.tp >= this.weapon.cost && target.life > 0 &&
				distance(this.cell, target.cell) >= this.weapon.minRange && distance(this.cell, target.cell) <= this.weapon.maxRange
		},
		canUseChip(chip, target) { return chip.currentCooldown === 0 && this.tp >= chip.cost && target === this },
		chipCells() { return [this.cell] },
		setWeapon(weapon) { actions.push("equip"); this.tp -= 1; this.weapon = weapon; return true },
		moveToward(destination, max = this.mp) {
			const to = destination.cell ?? destination
			const cost = distance(this.cell, to)
			assert.ok(cost <= Math.min(this.mp, max), "move within MP")
			this.cell.entity = null
			this.cell.empty = true
			place(this, [to.x, to.y])
			this.mp -= cost
			actions.push("move")
			return cost
		},
		moveAwayFrom() { actions.push("retreat"); return 0 },
		useWeapon(target) {
			assert.ok(this.canUseWeapon(target), "shot must be legal")
			trace.push({ shoot: true, tp: this.tp, strength: this.strength })
			this.tp -= this.weapon.cost
			target.life -= 22.5 * (1 + this.strength / 100)
			actions.push("shoot")
			return 1
		},
		useChip(chip, target) {
			assert.ok(this.canUseChip(chip, target), "chip must be legal")
			trace.push({ chip: chip.name, tp: this.tp, strength: this.strength })
			if (useChipImpl) return useChipImpl(this, chip)
			this.tp -= chip.cost
			chip.currentCooldown = chip.cooldown
			this.strength += 90
			this.effects.push({ type: 38, turns: 2 })
			actions.push(chip.name)
			return 1
		}
	}, meAt)
	const enemy = place({
		id: 2, name: "enemy", level: 10, life: enemyLife, maxLife: 300, mp: 3, tp: 10, strength: 0, agility: 0, wisdom: 0,
		resistance: 0, science: 0, magic: 0, weapon: enemyGun, weapons: [], chips: [], effects: [], launchedEffects: []
	}, enemyAt)
	const enemies = [enemy]
	let chest = null
	if (chestAt !== null) {
		chest = place(Object.assign(Object.create(FakeChest.prototype), { ...enemy, id: 3, name: "chest" }), chestAt)
		enemies.unshift(chest)
	}
	globalThis.Fight = {
		me, turn: turnNumber,
		getNearestEnemy: () => enemies.reduce((best, e) => (distance(me.cell, e.cell) < distance(me.cell, best.cell) ? e : best)),
		getEnemies: () => enemies,
		getAliveEnemies: () => enemies.filter((e) => e.life > 0),
		getAllies: () => [me],
		weaponCells: (target, weapon = me.weapon) => [...cells.values()].filter((cell) =>
			distance(cell, target.cell) >= weapon.minRange && distance(cell, target.cell) <= weapon.maxRange)
	}
	globalThis.Weapon = { pistol: machineGun }
	globalThis.Chip = {}
	return { actions, trace, me, enemy, chest }
}

function captureTurn() {
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

function planLog(lines) {
	const line = lines.find((text) => text.includes("[Tactical] plan before execution"))
	return line === undefined ? null : JSON.parse(line.slice(line.indexOf("{")))
}

// --- (1) ordre des actions dans turn() ----------------------------------------------------------------------

test("turn 1, enemy out of contact: the plan runs first, then the opening weapon, then the spare-TP boost; the inventory is logged once", () => {
	const w = makeWorld({ turnNumber: 1, equipped: null, enemyAt: [19, 5] }) // distance 14 : hors contact (9), dans 6 + 2×3 + 3 = 15
	const lines = captureTurn()
	assert.equal(lines.filter((text) => text.includes("[Chips]")).length, 1)
	assert.ok(lines.some((text) => text.includes("protein#8(3TP,cd3,38:90-90x2)")))
	assert.deepEqual(w.actions, ["move", "equip", "protein"])
	// le plan (approche) passe avant l'arme du tour 1, elle-même avant le boost de PT restants
	assert.equal(w.me.weapon, machineGun)
	assert.equal(w.me.strength, 100)
	assert.equal(w.me.tp, 10 - 1 - 3)

	const second = makeWorld({ turnNumber: 40, enemyAt: [19, 5] })
	assert.equal(captureTurn().some((text) => text.includes("[Chips]")), false) // inventaire : tour 1 seulement
	assert.ok(second.actions.length >= 0)
})

test("in contact: the boost is cast BEFORE the plan, which then sees the reduced TP, the raised strength and a current state", () => {
	const w = makeWorld({ turnNumber: 41 }) // distance 4 : en contact, 300/300 PV, 10 PT
	const lines = captureTurn()
	assert.deepEqual(w.actions, ["protein", "shoot"])
	assert.equal(w.actions.filter((action) => action === "protein").length, 1) // pas relancé après le plan
	// le plan voit 7 PT et la force 100 : un seul tir (4 PT), à ×2,0
	const shots = w.trace.filter((entry) => entry.shoot)
	assert.equal(shots.length, 1)
	assert.deepEqual(shots[0], { shoot: true, tp: 7, strength: 100 })
	const plan = planLog(lines)
	assert.ok(plan, "[Tactical] plan before execution is logged: the planner did not fall back\n" +
		lines.filter((text) => /Plannification|Tactical|ERROR/.test(text)).join("\n") + debugLogs.slice(-3).join("\n"))
	assert.equal(plan.stateCurrent, true)
	assert.equal(plan.tp.available, 7)
	assert.ok(Math.abs(plan.usefulDamage - 22.5 * 2.0) < 1e-6, `usefulDamage ${plan.usefulDamage}`)
	assert.equal(lines.some((text) => text.includes("stale/inconsistent") || text.includes("fallback")), false)
	assert.equal(w.me.tp, 3)
})

test("in contact on turn 1 with no weapon equipped: boost first, then the plan equips and shoots with the reduced TP", () => {
	const w = makeWorld({ turnNumber: 1, equipped: null, meAt: [6, 5], enemyAt: [10, 5] })
	const lines = captureTurn()
	assert.deepEqual(w.actions, ["protein", "equip", "shoot"])
	assert.equal(planLog(lines)?.tp.available, 7)
	assert.deepEqual(w.trace.at(-1), { shoot: true, tp: 6, strength: 100 })
	assert.equal(w.me.tp, 2)
})

test("a turn with no boost chip is unchanged by the feature; a chip in cooldown or an active boost behaves the same", () => {
	const baseline = makeWorld({ turnNumber: 42, chips: [] })
	captureTurn()
	const cooling = makeWorld({ turnNumber: 43, chips: [protein({ currentCooldown: 2 })] })
	captureTurn()
	const active = makeWorld({ turnNumber: 44, effects: [{ type: 38, turns: 1 }] })
	captureTurn()
	assert.deepEqual(baseline.actions, ["shoot", "shoot"]) // 10 PT : 2 tirs de 4 PT
	assert.deepEqual(cooling.actions, baseline.actions)
	assert.deepEqual(active.actions, baseline.actions)
	for (const w of [baseline, cooling, active]) {
		assert.equal(w.me.tp, 2)
		assert.equal(w.me.strength, 10)
	}
})

test("hurt below 50 %: no pre-cast in contact; exactly 50 %: pre-cast", () => {
	const hurt = makeWorld({ turnNumber: 45, life: 149 })
	captureTurn()
	assert.equal(hurt.actions.includes("protein"), false)
	const half = makeWorld({ turnNumber: 46, life: 150 })
	captureTurn()
	assert.equal(half.actions[0], "protein")
})

test("the boost is cast once per turn and never again on the following turn while it is active or cooling down", () => {
	const w = makeWorld({ turnNumber: 47 })
	captureTurn()
	assert.equal(w.actions.filter((action) => action === "protein").length, 1)
	// tour suivant : même puce (délai 3 en cours), effet encore actif
	const next = makeWorld({ turnNumber: 48, chips: w.me.chips, effects: w.me.effects })
	captureTurn()
	assert.equal(next.actions.includes("protein"), false)
})

test("a refused cast (result 0) is reported and the plan still plays with the real TP", () => {
	const w = makeWorld({ turnNumber: 49, useChipImpl: () => 0 })
	captureTurn()
	assert.equal(w.actions.includes("protein"), false)
	assert.equal(w.actions.filter((action) => action === "shoot").length, 2)
})

// --- (4) coffres et absence d'ennemi ---------------------------------------------------------------------

test("a chest next to me never triggers the boost; with no real enemy left nothing is cast", () => {
	class FakeChest {}
	globalThis.Chest = FakeChest
	try {
		const onlyChest = makeWorld({ turnNumber: 50, enemyAt: [9, 5], chestAt: [6, 5], FakeChest })
		onlyChest.enemy.life = 0 // l'ennemi réel est mort : il ne reste que le coffre
		captureTurn()
		assert.deepEqual(onlyChest.actions, [])

		// coffre proche, vrai ennemi hors contact : la décision suit l'ennemi réel, pas le coffre
		const far = makeWorld({ turnNumber: 51, enemyAt: [29, 5], chestAt: [6, 5], FakeChest })
		captureTurn()
		assert.equal(far.actions.includes("protein"), false) // 24 > 15 : hors de portée même après 2 tours
	} finally {
		delete globalThis.Chest
	}
	const none = makeWorld({ turnNumber: 52, enemyAt: [9, 5] })
	none.enemy.life = 0
	globalThis.Fight.getNearestEnemy = () => null
	captureTurn()
	assert.deepEqual(none.actions, [])
})

// --- (3)(5) cas limites ----------------------------------------------------------------------------------

function unit({ chips = [protein()], tp = 10, mp = 4, life = 300, strength = 0, effects = [], distance = 8, extra = {} } = {}) {
	const casts = []
	const me = {
		id: 1, name: "me", life, maxLife: 300, tp, mp, strength, science: 0, weapon: machineGun, weapons: [machineGun],
		chips, effects, distance: () => distance,
		canUseChip: (chip) => me.tp >= chip.cost,
		useChip(chip) { casts.push(chip.name); me.tp -= chip.cost; return 1 },
		...extra
	}
	return { me, casts, enemy: { id: 2, mp: 3 } }
}

test("distance thresholds: contact = max range + MP exactly (cast) and +1 (no cast)", () => {
	const at = unit({ distance: 6 + 4 })
	castBoostInContact(at.me, at.enemy)
	const over = unit({ distance: 6 + 4 + 1 })
	castBoostInContact(over.me, over.enemy)
	assert.deepEqual(at.casts, ["protein"])
	assert.deepEqual(over.casts, [])
	const withoutMp = unit({ distance: 7, mp: 0 }) // 6 + 0
	castBoostInContact(withoutMp.me, withoutMp.enemy)
	assert.deepEqual(withoutMp.casts, [])
	const spareAt = unit({ distance: 6 + 2 * 4 + 3 })
	castBoostWithSpareTp(spareAt.me, spareAt.enemy, 4)
	const spareOver = unit({ distance: 6 + 2 * 4 + 3 + 1 })
	castBoostWithSpareTp(spareOver.me, spareOver.enemy, 4)
	assert.deepEqual(spareAt.casts, ["protein"])
	assert.deepEqual(spareOver.casts, [])
})

test("the spare-TP reach uses the start-of-turn MP, not the MP left after the plan", () => {
	const w = unit({ distance: 17, mp: 0 }) // PM dépensés par le plan
	castBoostWithSpareTp(w.me, w.enemy, 4)
	assert.deepEqual(w.casts, ["protein"])
	const blind = unit({ distance: 17, mp: 0 })
	castBoostWithSpareTp(blind.me, blind.enemy, 0) // portée 6 + 0 + 3 = 9 < 17
	assert.deepEqual(blind.casts, [])
})

test("duration: one turn never pays in contact nor with spare TP; two turns do", () => {
	const one = unit({ chips: [protein({ features: [{ type: 38, minValue: 90, maxValue: 90, turns: 1 }] })], distance: 5 })
	castBoostInContact(one.me, one.enemy)
	castBoostWithSpareTp(one.me, one.enemy, 4)
	assert.deepEqual(one.casts, [])
	const two = unit({ distance: 5 })
	castBoostInContact(two.me, two.enemy)
	assert.deepEqual(two.casts, ["protein"])
})

test("net-damage break-even pins FUTURE_TURN_WEIGHT: gain 41 pays, gain 39 does not (10 TP, cost 3, 4-TP weapon, 2 turns)", () => {
	assert.ok(FUTURE_TURN_WEIGHT > 0.72 && FUTURE_TURN_WEIGHT < 0.78)
	const pays = unit({ chips: [boostChip(41)], strength: 0, distance: 5 })
	castBoostInContact(pays.me, pays.enemy)
	const short = unit({ chips: [boostChip(39)], strength: 0, distance: 5 })
	castBoostInContact(short.me, short.enemy)
	assert.deepEqual(pays.casts, ["protein"])
	assert.deepEqual(short.casts, [])
	const me = unit({ strength: 0 }).me
	assert.ok(boostNetDamage(me, machineGun, pickBoost(unit({ chips: [boostChip(41)] }).me, 10), 10) > 0)
	assert.ok(boostNetDamage(me, machineGun, pickBoost(unit({ chips: [boostChip(39)] }).me, 10), 10) < 0)
})

test("a boost that eats all the TP, or the TP of the only shot, is never cast", () => {
	const broke = unit({ tp: 3, chips: [protein()] }) // 0 tir avec, 0 tir sans (3 < 4) : rien à amplifier, rien à gagner
	castBoostInContact(broke.me, broke.enemy)
	assert.deepEqual(broke.casts, [])
	const tight = unit({ tp: 4, chips: [protein()] }) // 1 tir sans, 0 avec : −22,5 × 1,1 + 0,75 × 1 × 22,5 × 0,9 = −9,6 < 0
	castBoostInContact(tight.me, tight.enemy)
	assert.deepEqual(tight.casts, [])
	const enough = unit({ tp: 7, chips: [protein()] }) // 1 tir sans comme avec (7 − 3 = 4) : gain pur
	castBoostInContact(enough.me, enough.enemy)
	assert.deepEqual(enough.casts, ["protein"])
})

test("pickBoost tolerates missing data: no effects, no science, no features, no chips, odd costs, odd cooldowns", () => {
	const noEffects = unit({ extra: { effects: undefined } }).me
	assert.equal(pickBoost(noEffects, 10).gain, 90)
	assert.equal(hasActiveStrengthBoost(noEffects), false)
	const noScience = unit({ chips: [protein({ features: [{ type: 6, minValue: 50, maxValue: 50, turns: 2 }] })], extra: { science: undefined } }).me
	assert.equal(pickBoost(noScience, 10).gain, 50) // pas de NaN
	const withScience = unit({ chips: [protein({ features: [{ type: 6, minValue: 50, maxValue: 50, turns: 2 }] })], extra: { science: 100 } }).me
	assert.equal(pickBoost(withScience, 10).gain, 100) // BUFF_STRENGTH amplifié, brut (38) non amplifié
	const rawWithScience = unit({ extra: { science: 100 } }).me
	assert.equal(pickBoost(rawWithScience, 10).gain, 90)
	assert.equal(pickBoost(unit({ chips: [{ id: 1, name: "x", cost: 1, cooldown: 0, currentCooldown: 0 }] }).me, 10), null)
	assert.equal(pickBoost(unit({ extra: { chips: undefined } }).me, 10), null)
	assert.equal(pickBoost(unit({ chips: [protein({ cost: 2.5 })] }).me, 10), null)
	assert.equal(pickBoost(unit({ chips: [protein({ cost: 0 })] }).me, 10), null)
	assert.equal(pickBoost(unit({ chips: [protein({ cost: 3 })] }).me, 10.5)?.chip.cost, 3)
	assert.equal(pickBoost(unit({ chips: [protein({ cost: 3 })] }).me, 2.9), null)
	// même convention que le planificateur (`currentCooldown === 0`) : tout autre état bloque, par prudence
	for (const cooldown of [-1, 1, "0", undefined, null, Number.NaN]) {
		assert.equal(pickBoost(unit({ chips: [protein({ currentCooldown: cooldown })] }).me, 10), null, `cooldown ${String(cooldown)}`)
	}
})

test("several boosts: the best NET one is cast in contact, once; the strongest is still picked for spare TP", () => {
	const small = protein({ id: 8, name: "small", features: [{ type: 38, minValue: 60, maxValue: 60, turns: 2 }] })
	const big = protein({ id: 9, name: "big", cost: 8, features: [{ type: 38, minValue: 150, maxValue: 150, turns: 2 }] })
	const rich = unit({ chips: [small, big], distance: 5 })
	castBoostInContact(rich.me, rich.enemy)
	assert.deepEqual(rich.casts, ["small"]) // « big » (8 PT) ne laisse aucun tir : gain net négatif
	const spare = unit({ chips: [small, big], distance: 16 })
	castBoostWithSpareTp(spare.me, spare.enemy, 4)
	assert.deepEqual(spare.casts, ["big"]) // PT inutilisés : la plus forte
	const poor = unit({ chips: [small, big], tp: 7, distance: 5 }) // « big » (8 PT) inabordable
	castBoostInContact(poor.me, poor.enemy)
	assert.deepEqual(poor.casts, ["small"])
})

test("API failures never throw out of the boost functions: distance() throwing, weapons missing, no enemy", () => {
	const broken = unit({ distance: 5, extra: { distance() { throw new Error("boom") } } })
	assert.doesNotThrow(() => castBoostInContact(broken.me, broken.enemy))
	assert.doesNotThrow(() => castBoostWithSpareTp(broken.me, broken.enemy, 4))
	assert.deepEqual(broken.casts, [])
	const noWeapons = unit({ distance: 5, extra: { weapons: undefined, weapon: null } })
	assert.doesNotThrow(() => castBoostInContact(noWeapons.me, noWeapons.enemy))
	assert.doesNotThrow(() => castBoostWithSpareTp(noWeapons.me, noWeapons.enemy, 4))
	assert.deepEqual(noWeapons.casts, [])
	const dead = unit({ life: 0, distance: 5 })
	castBoostInContact(dead.me, dead.enemy)
	castBoostWithSpareTp(dead.me, dead.enemy, 4)
	assert.deepEqual(dead.casts, [])
	const lonely = unit({ distance: 5 })
	castBoostWithSpareTp(lonely.me, null, 4)
	assert.deepEqual(lonely.casts, [])
})
