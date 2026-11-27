import assert from "node:assert/strict"
import test from "node:test"

globalThis.Color = { rgb: () => 0 }
globalThis.Debug = { log() {}, pause() {} }
// RAW_BUFF_AGILITY absent : le code retombe sur l'identifiant officiel 41 (effet de la puce Étirement).
globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4, POISON: 5, BUFF_STRENGTH: 6, BUFF_AGILITY: 7 }
globalThis.Fight = { turn: 1 }

// Boost d'agilité : variante de boost du plan conjoint, gain de critique mesuré dans le score ; refusé si des PT servent mieux.
const { turn } = await import("../dist/Main/Kassbi_Class.js")
const { hasActiveAgilityBoost, pickAgilityBoost } = await import("../dist/Brain/StrengthBoost.js")
const { executeReservePlan } = await import("../dist/Classes/Plannification/ReservePlan.js")
const { LeekProfile } = await import("../dist/Classes/LeekProfile.js")

const machineGun = {
	id: 38, name: "machine_gun", cost: 4, minRange: 1, maxRange: 6, needsLos: false, maxUses: -1,
	features: [{ type: 1, minValue: 20, maxValue: 25 }]
}
// Étirement d'après `data/chips.json` du générateur officiel : effet 41 (agilité brute) 80 à 100, 2 tours, 3 PT, délai 3.
const stretching = (extra = {}) => ({
	id: 9, name: "stretching", cost: 3, cooldown: 3, currentCooldown: 0, minRange: 0, maxRange: 5, needsLos: false,
	features: [{ type: 41, minValue: 80, maxValue: 100, turns: 2 }], ...extra
})
const protein = () => ({
	id: 8, name: "protein", cost: 3, cooldown: 3, currentCooldown: 0, minRange: 0, maxRange: 0, needsLos: false,
	features: [{ type: 38, minValue: 90, maxValue: 90, turns: 2 }]
})
const enemyGun = { id: 90, name: "enemy gun", cost: 3, minRange: 0, maxRange: 6, needsLos: false, features: [{ type: 1, minValue: 10, maxValue: 20 }] }

function makeWorld({
	turnNumber, chips = [stretching()], effects = [], meAt = [5, 5], enemyAt = [9, 5], equipped = machineGun,
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
	// Actions ET lignes de journal, dans l'ordre : prouve que le plan est affiché avant la première action.
	const timeline = []
	const act = (name) => { actions.push(name); timeline.push(`action:${name}`) }
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
		setWeapon(weapon) { act("equip"); this.tp -= 1; this.weapon = weapon; return true },
		moveToward(destination, max = this.mp) {
			const to = destination.cell ?? destination
			const cost = distance(this.cell, to)
			assert.ok(cost <= Math.min(this.mp, max), "move within MP")
			this.cell.entity = null
			this.cell.empty = true
			place(this, [to.x, to.y])
			this.mp -= cost
			act("move")
			return cost
		},
		moveAwayFrom() { act("retreat"); return 0 },
		useWeapon(target) {
			assert.ok(this.canUseWeapon(target), "shot must be legal")
			trace.push({ shoot: true, tp: this.tp, strength: this.strength })
			this.tp -= this.weapon.cost
			target.life -= 22.5 * (1 + this.strength / 100)
			act("shoot")
			return 1
		},
		useChip(chip, target) {
			assert.ok(this.canUseChip(chip, target), "chip must be legal")
			trace.push({ chip: chip.name, tp: this.tp, strength: this.strength })
			if (useChipImpl) return useChipImpl(this, chip)
			this.tp -= chip.cost
			chip.currentCooldown = chip.cooldown
			// Comme le moteur (hypothèse du modèle) : force et PT s'ajoutent dès le lancer ; le soin rend des PV.
			for (const feature of chip.features) {
				if (feature.type === 38) { this.strength += feature.minValue; this.effects.push({ type: 38, turns: feature.turns }) }
				if (feature.type === 41) this.effects.push({ type: 41, turns: feature.turns })
				if (feature.type === 32) { this.tp += feature.minValue; this.effects.push({ type: 32, turns: feature.turns }) }
				if (feature.type === 2) this.life = Math.min(this.maxLife, this.life + feature.minValue)
			}
			act(chip.name)
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
	return { actions, trace, timeline, me, enemy, chest }
}

function capture(w, run) {
	const lines = []
	const original = console.log
	console.log = (...args) => { lines.push(args.join(" ")); w?.timeline.push(`log:${args.join(" ")}`) }
	try {
		run()
	} finally {
		console.log = original
	}
	return lines
}
const captureTurn = (w) => capture(w, turn)

function planLog(lines, prefix = "[Tactical] plan before execution") {
	const line = lines.find((text) => text.includes(prefix))
	return line === undefined ? null : JSON.parse(line.slice(line.indexOf("{")))
}

const shots = (w) => w.actions.filter((action) => action === "shoot").length

test("(a) plan with shots and spare TP >= cost: stretching is in the displayed plan, cast before the shots, shots unchanged", () => {
	const baseline = makeWorld({ turnNumber: 20, tp: 11, chips: [] })
	captureTurn(baseline)
	assert.deepEqual(baseline.actions, ["shoot", "shoot"]) // 11 PT : 2 tirs de 4 PT, 3 PT sans emploi
	const w = makeWorld({ turnNumber: 21, tp: 11 })
	const lines = captureTurn(w)
	assert.deepEqual(w.actions, ["stretching", "shoot", "shoot"])
	assert.equal(w.me.tp, 0)
	const plan = planLog(lines)
	assert.deepEqual(plan.boost, [{ name: "stretching", cost: 3 }])
	assert.deepEqual(plan.tp, { available: 11, planned: 11, gainedFromBoost: 0, remainingIfExecuted: 0 })
	assert.equal(plan.weapon.shots, 2)
	const shown = w.timeline.findIndex((entry) => entry.includes("[Tactical] plan before execution"))
	assert.ok(shown >= 0 && shown < w.timeline.findIndex((entry) => entry.startsWith("action:")))
})

test("(a) the agility gain is IN the score: same choice as without the chip, score + crit now + crit of the next turn", () => {
	const baseline = makeWorld({ turnNumber: 22, tp: 11, chips: [] })
	const without = planLog(captureTurn(baseline))
	const w = makeWorld({ turnNumber: 23, tp: 11 })
	const filled = planLog(captureTurn(w))
	for (const field of ["usefulDamage", "danger", "shotCell", "destination", "weapon", "chips", "protection"]) {
		assert.deepEqual(filled[field], without[field], field)
	}
	// 90 d'agilité : + 0,027 de dégâts moyens (0,3 x 90 / 1000). Ce tour : 49,5 x 0,027 ; tour suivant (durée 2, un tour couvert) :
	// 2 tirs x 22,5 x 1,1 x 0,027 x FUTURE_TURN_WEIGHT (0,75).
	const gain = 49.5 * 0.027 + 49.5 * 0.027 * 0.75
	assert.ok(Math.abs(filled.score - without.score - gain) < 1e-9, `${filled.score} - ${without.score} vs ${gain}`)
})

test("a kill needs no critical: agility is not cast (no gain, same PT), and the shot count is unchanged", () => {
	const w = makeWorld({ turnNumber: 43, tp: 11, enemyLife: 20 })
	captureTurn(w)
	assert.deepEqual(w.actions, ["shoot"])
})

test("below 50 % of life the agility is still a candidate (PT and strength boosts are not)", () => {
	const w = makeWorld({ turnNumber: 44, tp: 11, life: 120, chips: [stretching(), protein()] })
	captureTurn(w)
	assert.deepEqual(w.actions, ["stretching", "shoot", "shoot"])
})

test("withAgilityFill no longer exists: the choice is made by the search", async () => {
	const stagnation = await import("../dist/Classes/Plannification/TacticalStagnation.js")
	assert.equal("withAgilityFill" in stagnation, false)
})

test("(b) spare TP < cost: not cast, and the fill never steals a shot or the strength boost", () => {
	const baseline = makeWorld({ turnNumber: 24, chips: [] })
	captureTurn(baseline)
	const tight = makeWorld({ turnNumber: 25 }) // 10 PT : 2 tirs, 2 PT sans emploi < 3
	const lines = captureTurn(tight)
	assert.deepEqual(tight.actions, baseline.actions)
	assert.deepEqual(tight.actions, ["shoot", "shoot"])
	assert.deepEqual(planLog(lines).boost, [])
	// Avec le boost de force : le plan garde force + 1 tir (7 PT) ; l'étirement prend les 3 PT restants, après la force.
	const strong = makeWorld({ turnNumber: 26, chips: [protein()] })
	captureTurn(strong)
	const both = makeWorld({ turnNumber: 27, chips: [stretching(), protein()] })
	captureTurn(both)
	assert.deepEqual(strong.actions, ["protein", "shoot"])
	assert.deepEqual(both.actions, ["protein", "stretching", "shoot"])
	assert.equal(both.me.tp, 0)
})

test("(c) active agility effect, cooldown, or a native refusal on me: not cast", () => {
	const active = makeWorld({ turnNumber: 28, tp: 11, effects: [{ type: 41, turns: 1 }] })
	captureTurn(active)
	assert.deepEqual(active.actions, ["shoot", "shoot"])
	const cooling = makeWorld({ turnNumber: 29, tp: 11, chips: [stretching({ currentCooldown: 2 })] })
	captureTurn(cooling)
	assert.deepEqual(cooling.actions, ["shoot", "shoot"])
	const refusedOnMe = makeWorld({ turnNumber: 30, tp: 11 })
	refusedOnMe.me.canUseChip = () => false
	assert.deepEqual(planLog(captureTurn(refusedOnMe)).boost, [])
	assert.deepEqual(refusedOnMe.actions, ["shoot", "shoot"])
	// Lancé une fois, puis plus tant que l'effet dure ou que le délai court.
	const first = makeWorld({ turnNumber: 31, tp: 11 })
	captureTurn(first)
	const next = makeWorld({ turnNumber: 32, tp: 11, chips: first.me.chips, effects: first.me.effects })
	captureTurn(next)
	assert.equal(next.actions.includes("stretching"), false)
})

test("a stretching refused at execution (result 0) is reported and the planned shots still run", () => {
	const w = makeWorld({ turnNumber: 33, tp: 11, useChipImpl: () => 0 })
	const lines = captureTurn(w)
	assert.ok(lines.some((text) => text.includes("[Tactical] execution: chip refused: stretching, result 0")))
	assert.deepEqual(w.actions, ["shoot", "shoot"])
})

// Le remplissage compte les PT qu'un boost de PT DEVRAIT donner (gain moyen) : s'ils n'arrivent pas, il ne doit pas
// passer avant un tir du plan. Gain prévu 5 (4 à 6) : 10 − 4 + 5 = 11 PT, 2 tirs, 3 PT « sans emploi ».
for (const [name, extra] of [
	["gives less than its mean gain (4 instead of 5)", {}],
	["is refused natively (result 0, no TP)", { useChipImpl: (me, chip) => {
		if (chip.name === "motivation") return 0
		me.tp -= chip.cost
		return 1
	} }]
]) test(`a TP boost that ${name} never costs a planned shot to the fill`, () => {
	const motivation = () => ({
		id: 15, name: "motivation", cost: 4, cooldown: 6, currentCooldown: 0, minRange: 0, maxRange: 0, needsLos: false,
		features: [{ type: 32, minValue: 4, maxValue: 6, turns: 3 }]
	})
	const baseline = makeWorld({ turnNumber: 40, chips: [motivation()], ...extra })
	assert.equal(planLog(captureTurn(baseline)).weapon.shots, 2)
	assert.equal(shots(baseline), 2)
	const w = makeWorld({ turnNumber: 41, chips: [stretching(), motivation()], ...extra })
	assert.equal(planLog(captureTurn(w)).weapon.shots, 2)
	assert.equal(shots(w), 2, `actions: ${w.actions.join(", ")}`)
})

test("an exception while deciding the optional fill keeps the joint plan (no fallback to plan B)", () => {
	const w = makeWorld({ turnNumber: 42, tp: 11 })
	const native = w.me.canUseChip
	w.me.canUseChip = function (chip, target) {
		if (chip.name === "stretching") throw new Error("native canUseChip failure")
		return native.call(this, chip, target)
	}
	const lines = captureTurn(w)
	assert.equal(lines.some((text) => text.includes("[Tactical] fallback")), false, "joint plan lost to plan B")
	const plan = planLog(lines)
	assert.notEqual(plan, null)
	assert.deepEqual(plan.boost, [])
	assert.deepEqual(w.actions, ["shoot", "shoot"])
})

test("(d) plan without a shot: cast only when the enemy is within boostReach and the effect lasts >= 2 turns", () => {
	// Distance 14 : hors de portée ce tour (6 + 3), dans la portée utile (6 + 2 × 3 PM + 3 PM adverses = 15).
	const near = makeWorld({ turnNumber: 34, enemyAt: [19, 5] })
	const lines = captureTurn(near)
	assert.deepEqual(near.actions, ["stretching", "move"])
	assert.deepEqual(planLog(lines).boost, [{ name: "stretching", cost: 3 }])
	const far = makeWorld({ turnNumber: 35, enemyAt: [29, 5] }) // 24 > 15
	captureTurn(far)
	assert.deepEqual(far.actions, ["move"])
	const brief = makeWorld({ turnNumber: 36, enemyAt: [19, 5],
		chips: [stretching({ features: [{ type: 41, minValue: 80, maxValue: 100, turns: 1 }] })] })
	captureTurn(brief)
	assert.deepEqual(brief.actions, ["move"])
	// Avec un tir ce tour, un effet d'un seul tour sert quand même (critiques de ce tour).
	const briefShot = makeWorld({ turnNumber: 37, tp: 11,
		chips: [stretching({ features: [{ type: 41, minValue: 80, maxValue: 100, turns: 1 }] })] })
	captureTurn(briefShot)
	assert.deepEqual(briefShot.actions, ["stretching", "shoot", "shoot"])
})

test("(e) turn 1 without a weapon: 1 TP is kept for the opening equip", () => {
	const tight = makeWorld({ turnNumber: 1, equipped: null, enemyAt: [19, 5], tp: 3 })
	captureTurn(tight)
	assert.deepEqual(tight.actions, ["move", "equip"]) // 3 PT : l'étirement prendrait le PT de l'arme
	assert.equal(tight.me.weapon, machineGun)
	const enough = makeWorld({ turnNumber: 1, equipped: null, enemyAt: [19, 5], tp: 4 })
	captureTurn(enough)
	assert.deepEqual(enough.actions, ["stretching", "move", "equip"])
	assert.equal(enough.me.tp, 0)
	// Hors tour 1, aucune réserve : 3 PT suffisent.
	const later = makeWorld({ turnNumber: 2, equipped: null, enemyAt: [19, 5], tp: 5 })
	captureTurn(later)
	assert.equal(later.actions[0], "stretching")
})

test("(f) plan B never casts the agility fill", () => {
	const profile = new LeekProfile()
	const contact = makeWorld({ turnNumber: 38, tp: 11, mp: 0 }) // sans carte de danger : plan B
	capture(contact, () => assert.equal(executeReservePlan(contact.me, profile), true))
	assert.deepEqual(contact.actions, ["shoot", "shoot"])
	const idle = makeWorld({ turnNumber: 39, enemyAt: [19, 5] })
	capture(idle, () => executeReservePlan(idle.me, profile))
	assert.equal(idle.actions.includes("stretching"), false)
})

test("pickAgilityBoost: largest integer gain; BUFF_AGILITY is amplified by science, the raw effect is not", () => {
	const unit = (chips, science = 0, effects = []) => ({ chips, science, effects })
	const reflexes = { name: "reflexes", cost: 5, cooldown: 2, currentCooldown: 0, features: [{ type: 7, minValue: 35, maxValue: 40, turns: 3 }] }
	const picked = pickAgilityBoost(unit([stretching()]), 3)
	assert.deepEqual([picked.chip.name, picked.gain, picked.turns], ["stretching", 90, 2])
	assert.equal(pickAgilityBoost(unit([stretching()], 200), 3).gain, 90) // brut : non amplifié
	assert.equal(pickAgilityBoost(unit([reflexes]), 5).gain, 37) // 37,5 arrondi par défaut
	assert.equal(pickAgilityBoost(unit([reflexes], 200), 5).gain, 112) // 37,5 × 3
	assert.equal(pickAgilityBoost(unit([stretching(), reflexes], 200), 10).chip.name, "reflexes")
	assert.equal(pickAgilityBoost(unit([stretching(), reflexes], 0), 10).chip.name, "stretching")
	assert.equal(pickAgilityBoost(unit([stretching()]), 2), null)
	assert.equal(pickAgilityBoost(unit([stretching({ cost: 0 })]), 10), null)
	assert.equal(pickAgilityBoost(unit([stretching({ currentCooldown: 1 })]), 10), null)
	assert.equal(pickAgilityBoost(unit([protein()]), 10), null)
	const active = unit([stretching()], 0, [{ type: 41, turns: 1 }])
	assert.equal(hasActiveAgilityBoost(active), true)
	assert.equal(pickAgilityBoost(active, 10), null)
	assert.equal(hasActiveAgilityBoost(unit([], 0, [{ type: 41, turns: 0 }, { type: 38, turns: 2 }])), false)
})
