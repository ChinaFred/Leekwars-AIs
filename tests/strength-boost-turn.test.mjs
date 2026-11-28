import assert from "node:assert/strict"
import test from "node:test"

globalThis.Color = { rgb: () => 0 }
const debugLogs = []
globalThis.Debug = { log: (message) => debugLogs.push(String(message)), pause() {} }
globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4, POISON: 5, BUFF_STRENGTH: 6 }
globalThis.Fight = { turn: 1 }

// Le boost est une composante du plan : décidé par `planAct` (plan conjoint ou plan B) avant la première action,
// jamais lancé par `turn()` en dehors du plan. Ces tests passent par `turn()` avec le planificateur réel.
const { turn, leekProfile } = await import("./helpers/joint-turn.mjs")
const { boostNetDamage, hasActiveStrengthBoost, pickBoost, FUTURE_TURN_WEIGHT } = await import("../dist/Brain/StrengthBoost.js")
const { executeReservePlan } = await import("../dist/Classes/Plannification/ReservePlan.js")
const { LeekProfile } = await import("../dist/Classes/LeekProfile.js")

const machineGun = {
	id: 38, name: "machine_gun", cost: 4, minRange: 1, maxRange: 6, needsLos: false, maxUses: -1,
	features: [{ type: 1, minValue: 20, maxValue: 25 }]
}
const protein = (extra = {}) => ({
	id: 8, name: "protein", cost: 3, cooldown: 3, currentCooldown: 0, minRange: 0, maxRange: 0, needsLos: false,
	features: [{ type: 38, minValue: 90, maxValue: 90, turns: 2 }], ...extra
})
const boostChip = (gain, extra = {}) => protein({ features: [{ type: 38, minValue: gain, maxValue: gain, turns: 2 }], ...extra })
const motivation = () => ({
	id: 15, name: "motivation", cost: 4, cooldown: 6, currentCooldown: 0, minRange: 0, maxRange: 0, needsLos: false,
	features: [{ type: 32, minValue: 4, maxValue: 4, turns: 3 }]
})
const bandage = () => ({
	id: 3, name: "bandage", cost: 2, cooldown: 1, currentCooldown: 0, minRange: 0, maxRange: 0, needsLos: false,
	features: [{ type: 2, minValue: 30, maxValue: 30, turns: 0 }]
})
// Ennemi armé : la carte de danger compte les ennemis armés (`threat.enemyCount`), sans quoi le planificateur se replie.
const enemyGun = { id: 90, name: "enemy gun", cost: 3, minRange: 0, maxRange: 6, needsLos: false, features: [{ type: 1, minValue: 10, maxValue: 20 }] }

// --- monde de combat pour turn() : grille vide 31 x 11, planificateur réel -------------------------------------

function makeWorld({
	turnNumber, chips = [protein()], effects = [], meAt = [5, 5], enemyAt = [9, 5], equipped = machineGun,
	life = 300, mp = 3, tp = 10, enemyLife = 300, chestAt = null, FakeChest = null, useChipImpl = null,
	weapons = [machineGun]
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
	const offensive = (chip) => chip.features.some((feature) => feature.type === 1)
	const actions = []
	const trace = []
	// Actions ET lignes de journal, dans l'ordre : prouve que le plan est affiché avant la première action.
	const timeline = []
	const act = (name) => { actions.push(name); timeline.push(`action:${name}`) }
	const me = place({
		id: 1, name: "me", level: 10, life, maxLife: 300, mp, tp, strength: 10, science: 0, wisdom: 0,
		weapon: equipped, weapons, chips, effects, launchedEffects: [],
		say() {},
		distance(other) { return distance(this.cell, other.cell) },
		canUseWeapon(target) {
			return this.weapon !== null && this.tp >= this.weapon.cost && target.life > 0 &&
				distance(this.cell, target.cell) >= this.weapon.minRange && distance(this.cell, target.cell) <= this.weapon.maxRange
		},
		// Puce offensive (feature de dégâts) : sur un ennemi à portée ; les autres puces : sur moi, comme avant.
		canUseChip(chip, target) {
			return chip.currentCooldown === 0 && this.tp >= chip.cost && (target === this || (offensive(chip) &&
				target.life > 0 && distance(this.cell, target.cell) >= chip.minRange && distance(this.cell, target.cell) <= chip.maxRange))
		},
		chipCells(chip, target) {
			return !target || target === this || !offensive(chip) ? [this.cell] : [...cells.values()].filter((cell) =>
				distance(cell, target.cell) >= chip.minRange && distance(cell, target.cell) <= chip.maxRange)
		},
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
			if (target !== this) target.life -= (chip.features[0].minValue + chip.features[0].maxValue) / 2 * (1 + this.strength / 100)
			// Comme le moteur (hypothèse du modèle) : force et PT s'ajoutent dès le lancer ; le soin rend des PV.
			for (const feature of chip.features) {
				if (feature.type === 38) { this.strength += feature.minValue; this.effects.push({ type: 38, turns: feature.turns }) }
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

// --- le boost est décidé dans le plan conjoint -------------------------------------------------------------------

test("turn(): nothing is cast before the plan is shown; in contact the plan itself trades a shot for the boost", () => {
	const w = makeWorld({ turnNumber: 41 }) // distance 4, 300/300 PV, 10 PT
	const lines = captureTurn(w)
	// 2 tirs : 49,5. Boost + 1 tir à ×2,0 : 45, plus le tour suivant (0,75 × 2 tirs × 22,5 × 0,9 = 30,4).
	assert.deepEqual(w.actions, ["protein", "shoot"])
	assert.deepEqual(w.trace, [{ chip: "protein", tp: 10, strength: 10 }, { shoot: true, tp: 7, strength: 100 }])
	const plan = planLog(lines)
	assert.ok(plan, "[Tactical] plan before execution is logged\n" +
		lines.filter((text) => /Plannification|Tactical|ERROR/.test(text)).join("\n") + debugLogs.slice(-3).join("\n"))
	// Le plan voit les PT et la force du DÉBUT du tour : rien n'a été lancé avant lui.
	assert.equal(plan.tp.available, 10)
	assert.equal(plan.tp.planned, 7)
	assert.deepEqual(plan.boost, [{ name: "protein", cost: 3 }])
	assert.deepEqual(plan.order.slice(0, 3), ["approach", "boost", "protection"])
	assert.equal(plan.weapon.shots, 1)
	assert.ok(Math.abs(plan.usefulDamage - 22.5 * 2.0) < 1e-6, `usefulDamage ${plan.usefulDamage}`)
	const shown = w.timeline.findIndex((entry) => entry.includes("[Tactical] plan before execution"))
	const firstAction = w.timeline.findIndex((entry) => entry.startsWith("action:"))
	assert.ok(shown >= 0 && shown < firstAction, "the whole plan, boost included, is displayed before the first action")
	assert.equal(lines.some((text) => text.includes("stale/inconsistent") || text.includes("fallback")), false)
	assert.equal(w.me.tp, 3)
})

test("the plan refuses the boost that would cost the fatal blow, and takes it against a sturdy enemy", () => {
	const killable = makeWorld({ turnNumber: 42, enemyLife: 49 }) // 2 tirs sans boost = 49,5 ; boost + 1 tir = 45
	const lines = captureTurn(killable)
	assert.deepEqual(killable.actions, ["shoot", "shoot"])
	assert.deepEqual(planLog(lines).boost, [])
	assert.ok(killable.enemy.life <= 0)
	const sturdy = makeWorld({ turnNumber: 43, enemyLife: 300 })
	captureTurn(sturdy)
	assert.deepEqual(sturdy.actions, ["protein", "shoot"])
})

test("a boost that leaves no shot is not worth it; a one-turn boost never beats the shot it costs", () => {
	const tight = makeWorld({ turnNumber: 44, tp: 4 }) // 1 tir sans boost, 0 avec
	captureTurn(tight)
	assert.deepEqual(tight.actions, ["shoot"])
	const brief = makeWorld({ turnNumber: 45, chips: [protein({ features: [{ type: 38, minValue: 90, maxValue: 90, turns: 1 }] })] })
	captureTurn(brief)
	assert.deepEqual(brief.actions, ["shoot", "shoot"]) // 45 < 49,5 et aucun tour suivant couvert
	const free = makeWorld({ turnNumber: 46, tp: 7 }) // 1 tir avec ou sans boost : le boost ne coûte aucun tir
	captureTurn(free)
	assert.deepEqual(free.actions, ["protein", "shoot"])
})

test("execution order: TP boost, then strength boost, then the shots that use both", () => {
	for (const chips of [[protein(), motivation()], [motivation(), protein()]]) {
		const w = makeWorld({ turnNumber: 47, chips })
		const lines = captureTurn(w)
		// motivation (4 PT, +4 PT pendant 3 tours) puis protein (3 PT) : 7 PT restants, 1 tir à force 100.
		assert.deepEqual(w.actions, ["motivation", "protein", "shoot"])
		assert.deepEqual(w.trace.at(-1), { shoot: true, tp: 7, strength: 100 })
		const plan = planLog(lines)
		assert.deepEqual(plan.boost, [{ name: "motivation", cost: 4 }, { name: "protein", cost: 3 }])
		assert.deepEqual(plan.tp, { available: 10, planned: 11, gainedFromBoost: 4, remainingIfExecuted: 3 })
		assert.equal(w.me.tp, 3)
	}
})

test("turn 1 without a weapon in contact: boost, then the plan equips and shoots", () => {
	const w = makeWorld({ turnNumber: 1, equipped: null, meAt: [6, 5], enemyAt: [10, 5] })
	const lines = captureTurn(w)
	assert.deepEqual(w.actions, ["protein", "equip", "shoot"])
	assert.deepEqual(w.trace.at(-1), { shoot: true, tp: 6, strength: 100 })
	assert.equal(w.me.tp, 2)
	assert.deepEqual(planLog(lines).boost, [{ name: "protein", cost: 3 }])
})

test("plan without a shot: the boost is part of it when the enemy can be in range next turn, not beyond", () => {
	// Distance 14 : hors de portée ce tour (6 + 3), dans la portée utile du boost (6 + 2 × 3 PM + 3 PM adverses = 15).
	const near = makeWorld({ turnNumber: 1, equipped: null, enemyAt: [19, 5] })
	const lines = captureTurn(near)
	assert.deepEqual(near.actions, ["protein", "move", "equip"]) // boost et déplacement du plan, puis l'arme du tour 1
	assert.deepEqual(planLog(lines).boost, [{ name: "protein", cost: 3 }])
	assert.equal(near.me.tp, 10 - 3 - 1)
	const far = makeWorld({ turnNumber: 48, enemyAt: [29, 5] }) // 24 > 15
	captureTurn(far)
	assert.equal(far.actions.includes("protein"), false)
	const brief = makeWorld({ turnNumber: 49, enemyAt: [19, 5],
		chips: [protein({ features: [{ type: 38, minValue: 90, maxValue: 90, turns: 1 }] })] })
	captureTurn(brief)
	assert.equal(brief.actions.includes("protein"), false) // un seul tour : rien à gagner sans tirer
})

// Combat 54991104 : arme à 5 PT, puce offensive à 3 PT sans cooldown, motivation +2 PT jamais lancée (12 PT = 2 tirs
// d'arme comme 10 PT). Le crédit retient le meilleur scénario de portée : puces seules, 4 lancers à 12 PT contre 3 à 10 PT.
test("plan without a shot: a +2 TP boost is cast when the extra TP buy one more offensive chip cast, not otherwise", () => {
	const gun = { ...machineGun, id: 60, name: "gun", cost: 5, features: [{ type: 1, minValue: 20, maxValue: 20 }] }
	const zap = (cooldown) => ({
		id: 18, name: "zap", cost: 3, cooldown, currentCooldown: 0, minRange: 0, maxRange: 10, needsLos: false,
		features: [{ type: 1, minValue: 12, maxValue: 12 }]
	})
	const smallMotivation = () => ({ ...motivation(), features: [{ type: 32, minValue: 2, maxValue: 2, turns: 3 }] })
	// Distance 14 : aucun tir ce tour (arme 6 + 3 PM, puce 10 + 3 PM), dans la portée utile du boost (15).
	const world = (turnNumber, cooldown) => makeWorld({
		turnNumber, equipped: gun, weapons: [gun], enemyAt: [19, 5], chips: [zap(cooldown), smallMotivation()]
	})
	const paying = world(60, 0)
	const lines = captureTurn(paying)
	assert.deepEqual(paying.actions, ["motivation", "move"])
	assert.deepEqual(planLog(lines).boost, [{ name: "motivation", cost: 4 }])
	const useless = world(61, 1) // cooldown 1 : un seul lancer par tour, les 2 PT n'achètent rien dans aucun scénario
	captureTurn(useless)
	assert.deepEqual(useless.actions, ["move"])
	// Tour 3 du combat 54991104 : shotgun, rock, spark, protein ET motivation prêtes, ennemi hors de portée ce tour.
	// Distance 14 = portée utile du boost (shotgun 5 + 2 × 3 PM + 3 PM adverses). Les deux boosts, PT d'abord.
	const shotgun = { ...machineGun, id: 41, name: "shotgun", cost: 5, maxRange: 5, maxUses: 2, features: [{ type: 1, minValue: 33, maxValue: 43 }] }
	const rock = { ...zap(1), id: 7, name: "rock", cost: 5, minRange: 2, maxRange: 6, features: [{ type: 1, minValue: 38, maxValue: 39 }] }
	const spark = { ...zap(0), name: "spark", features: [{ type: 1, minValue: 8, maxValue: 16 }] }
	const both = makeWorld({
		turnNumber: 62, equipped: shotgun, weapons: [shotgun], enemyAt: [19, 5], chips: [rock, protein(), smallMotivation(), spark]
	})
	const bothLines = captureTurn(both)
	assert.deepEqual(both.actions, ["motivation", "protein", "move"])
	assert.deepEqual(planLog(bothLines).boost, [{ name: "motivation", cost: 4 }, { name: "protein", cost: 3 }])
	assert.equal(both.me.tp, 10 - 4 + 2 - 3)
	// Même équipement, plan B sans tir : même crédit (les PT que rien n'emploie seraient perdus).
	const reserve = makeWorld({
		turnNumber: 63, equipped: shotgun, weapons: [shotgun], enemyAt: [19, 5], chips: [{ ...rock }, smallMotivation(), { ...spark }]
	})
	capture(reserve, () => executeReservePlan(reserve.me, new LeekProfile()))
	assert.equal(reserve.actions[0], "motivation")
	// Tours 4 à 8 du combat : spark seul à portée (distance 10 ; rock porte à 6, shotgun à 5, 3 PM), protein en cooldown.
	// Un plan qui TIRE garde ses 3 sparks : pas de spark certain échangé contre le crédit optimiste des puces.
	const sparks = makeWorld({
		turnNumber: 64, equipped: shotgun, weapons: [shotgun], enemyAt: [15, 5],
		chips: [{ ...rock }, protein({ currentCooldown: 2 }), smallMotivation(), { ...spark }]
	})
	captureTurn(sparks)
	assert.deepEqual(sparks.actions.filter((name) => name !== "move"), ["spark", "spark", "spark"])
})

test("a turn with no boost chip is unchanged by the feature; a chip in cooldown or an active boost behaves the same", () => {
	const baseline = makeWorld({ turnNumber: 50, chips: [] })
	captureTurn(baseline)
	const cooling = makeWorld({ turnNumber: 51, chips: [protein({ currentCooldown: 2 })] })
	captureTurn(cooling)
	const active = makeWorld({ turnNumber: 52, effects: [{ type: 38, turns: 1 }] })
	captureTurn(active)
	assert.deepEqual(baseline.actions, ["shoot", "shoot"]) // 10 PT : 2 tirs de 4 PT
	assert.deepEqual(cooling.actions, baseline.actions)
	assert.deepEqual(active.actions, baseline.actions)
	for (const w of [baseline, cooling, active]) {
		assert.equal(w.me.tp, 2)
		assert.equal(w.me.strength, 10)
	}
})

test("hurt below 50 %: a plan that shoots casts no boost; exactly 50 %: it does", () => {
	const hurt = makeWorld({ turnNumber: 53, life: 149 })
	captureTurn(hurt)
	assert.equal(hurt.actions.includes("protein"), false)
	assert.equal(hurt.actions.filter((action) => action === "shoot").length, 2)
	const half = makeWorld({ turnNumber: 54, life: 150 })
	captureTurn(half)
	assert.equal(half.actions[0], "protein")
})

test("the boost is cast once per turn and never again on the following turn while it is active or cooling down", () => {
	const w = makeWorld({ turnNumber: 55 })
	captureTurn(w)
	assert.equal(w.actions.filter((action) => action === "protein").length, 1)
	// tour suivant : même puce (délai 3 en cours), effet encore actif
	const next = makeWorld({ turnNumber: 56, chips: w.me.chips, effects: w.me.effects })
	captureTurn(next)
	assert.equal(next.actions.includes("protein"), false)
})

test("a refused boost (result 0) is reported; the rest of the SAME plan runs with its checks, no second plan", () => {
	const w = makeWorld({ turnNumber: 57, useChipImpl: () => 0 })
	const lines = captureTurn(w)
	assert.equal(w.actions.includes("protein"), false)
	assert.ok(lines.some((text) => text.includes("[Tactical] execution: chip refused: protein, result 0")))
	assert.deepEqual(w.actions, ["shoot"]) // le tir prévu par ce plan ; pas de replanification à 2 tirs
	assert.equal(lines.filter((text) => text.includes("plan before execution")).length, 1)
})

test("a chest next to me never triggers the boost; with no real enemy left nothing is cast", () => {
	class FakeChest {}
	globalThis.Chest = FakeChest
	try {
		const onlyChest = makeWorld({ turnNumber: 58, enemyAt: [9, 5], chestAt: [6, 5], FakeChest })
		onlyChest.enemy.life = 0 // l'ennemi réel est mort : il ne reste que le coffre
		captureTurn(onlyChest)
		assert.deepEqual(onlyChest.actions, [])

		// coffre proche, vrai ennemi hors de portée utile : la décision suit l'ennemi réel, pas le coffre
		const far = makeWorld({ turnNumber: 59, enemyAt: [29, 5], chestAt: [6, 5], FakeChest })
		captureTurn(far)
		assert.equal(far.actions.includes("protein"), false) // 24 > 15
	} finally {
		delete globalThis.Chest
	}
	const none = makeWorld({ turnNumber: 60, enemyAt: [9, 5] })
	none.enemy.life = 0
	globalThis.Fight.getNearestEnemy = () => null
	captureTurn(none)
	assert.deepEqual(none.actions, [])
})

// --- le comportement configuré (leekProfile) décide, de bout en bout ---------------------------------------------

test("turn() reads leekProfile: at 82 % life the fixed behavior does not heal, at 20 % it does with its spare TP", () => {
	const play = (turnNumber, life) => {
		const w = makeWorld({ turnNumber, chips: [bandage()], life })
		captureTurn(w)
		return w
	}
	assert.equal(leekProfile.aggression, 100)
	assert.deepEqual([leekProfile.allowHealing, leekProfile.allowShielding, leekProfile.allowHiding], [true, true, true])
	const healthy = play(61, 246) // seuil de soin à agressivité 100 : vie ≤ 0,25 (0,50 sous menace) ; ici 0,82
	assert.equal(healthy.actions.includes("bandage"), false)
	assert.equal(healthy.me.life, 246)
	const wounded = play(62, 60) // 60/300 = 0,20
	assert.equal(wounded.actions.includes("bandage"), true)
	assert.equal(wounded.me.life, 90)
})

// --- plan B --------------------------------------------------------------------------------------------------

test("plan B: the boost is decided before execution, announced, cast before the attack, and the planned shots follow", () => {
	const profile = new LeekProfile()
	const w = makeWorld({ turnNumber: 63, mp: 0 }) // en contact ; sans carte de danger (danger inconnu)
	const lines = capture(w, () => assert.equal(executeReservePlan(w.me, profile), true))
	assert.deepEqual(w.actions.slice(0, 2), ["protein", "shoot"])
	assert.equal(w.actions.filter((action) => action === "shoot").length, 1)
	const plan = planLog(lines, "[Reserve] plan before execution")
	assert.deepEqual(plan.boost, [{ chip: "protein", tpCost: 3 }])
	assert.equal(plan.attack.weaponShotsAtMost, 1) // 10 − 3 = 7 PT : un tir de 4 PT, plus deux
	assert.equal(plan.resources.boost, 3)
	assert.deepEqual(plan.order.slice(0, 2), ["approach", "boost"])
	const shown = w.timeline.findIndex((entry) => entry.includes("[Reserve] plan before execution"))
	assert.ok(shown >= 0 && shown < w.timeline.findIndex((entry) => entry.startsWith("action:")))

	const killable = makeWorld({ turnNumber: 64, mp: 0, enemyLife: 49 }) // le boost coûterait le coup fatal
	capture(killable, () => executeReservePlan(killable.me, profile))
	assert.deepEqual(killable.actions.slice(0, 2), ["shoot", "shoot"])
	const hurt = makeWorld({ turnNumber: 65, mp: 0, life: 149 }) // sous 50 % de PV : pas de boost avec un tir
	capture(hurt, () => executeReservePlan(hurt.me, profile))
	assert.equal(hurt.actions.includes("protein"), false)
})

test("plan B without a shot: boost with the spare TP only when it covers the next turn and the enemy can be in range", () => {
	const profile = new LeekProfile()
	const near = makeWorld({ turnNumber: 66, enemyAt: [19, 5] }) // distance 14 ≤ 15
	const lines = capture(near, () => executeReservePlan(near.me, profile))
	assert.equal(near.actions[0], "protein")
	assert.deepEqual(planLog(lines, "[Reserve] plan before execution").boost, [{ chip: "protein", tpCost: 3 }])
	const far = makeWorld({ turnNumber: 67, enemyAt: [29, 5] }) // 24 > 15
	capture(far, () => executeReservePlan(far.me, profile))
	assert.equal(far.actions.includes("protein"), false)
	const brief = makeWorld({ turnNumber: 68, enemyAt: [19, 5],
		chips: [protein({ features: [{ type: 38, minValue: 90, maxValue: 90, turns: 1 }] })] })
	capture(brief, () => executeReservePlan(brief.me, profile))
	assert.equal(brief.actions.includes("protein"), false)
})

// --- modèle : cas limites -------------------------------------------------------------------------------------

function unit({ chips = [protein()], tp = 10, strength = 0, extra = {} } = {}) {
	return { id: 1, name: "me", life: 300, maxLife: 300, tp, mp: 4, strength, science: 0, weapon: machineGun,
		weapons: [machineGun], chips, effects: [], ...extra }
}

test("net-damage break-even pins FUTURE_TURN_WEIGHT: gain 41 pays, gain 39 does not (10 TP, cost 3, 4-TP weapon, 2 turns)", () => {
	assert.ok(FUTURE_TURN_WEIGHT > 0.72 && FUTURE_TURN_WEIGHT < 0.78)
	const me = unit()
	assert.ok(boostNetDamage(me, machineGun, pickBoost(unit({ chips: [boostChip(41)] }), 10), 10) > 0)
	assert.ok(boostNetDamage(me, machineGun, pickBoost(unit({ chips: [boostChip(39)] }), 10), 10) < 0)
})

test("pickBoost tolerates missing data: no effects, no science, no features, no chips, odd costs, odd cooldowns", () => {
	const noEffects = unit({ extra: { effects: undefined } })
	assert.equal(pickBoost(noEffects, 10).gain, 90)
	assert.equal(hasActiveStrengthBoost(noEffects), false)
	const noScience = unit({ chips: [protein({ features: [{ type: 6, minValue: 50, maxValue: 50, turns: 2 }] })], extra: { science: undefined } })
	assert.equal(pickBoost(noScience, 10).gain, 50) // pas de NaN
	const withScience = unit({ chips: [protein({ features: [{ type: 6, minValue: 50, maxValue: 50, turns: 2 }] })], extra: { science: 100 } })
	assert.equal(pickBoost(withScience, 10).gain, 100) // BUFF_STRENGTH amplifié, brut (38) non amplifié
	const rawWithScience = unit({ extra: { science: 100 } })
	assert.equal(pickBoost(rawWithScience, 10).gain, 90)
	assert.equal(pickBoost(unit({ chips: [{ id: 1, name: "x", cost: 1, cooldown: 0, currentCooldown: 0 }] }), 10), null)
	assert.equal(pickBoost(unit({ extra: { chips: undefined } }), 10), null)
	assert.equal(pickBoost(unit({ chips: [protein({ cost: 2.5 })] }), 10), null)
	assert.equal(pickBoost(unit({ chips: [protein({ cost: 0 })] }), 10), null)
	assert.equal(pickBoost(unit({ chips: [protein({ cost: 3 })] }), 10.5)?.chip.cost, 3)
	assert.equal(pickBoost(unit({ chips: [protein({ cost: 3 })] }), 2.9), null)
	// même convention que le planificateur (`currentCooldown === 0`) : tout autre état bloque, par prudence
	for (const cooldown of [-1, 1, "0", undefined, null, Number.NaN]) {
		assert.equal(pickBoost(unit({ chips: [protein({ currentCooldown: cooldown })] }), 10), null, `cooldown ${String(cooldown)}`)
	}
})
