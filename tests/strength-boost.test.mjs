import assert from "node:assert/strict"
import test from "node:test"

globalThis.Color = { rgb: () => 0 }
globalThis.Debug = { log() {}, pause() {} }
globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4, POISON: 5, BUFF_STRENGTH: 6 }
globalThis.Fight = { turn: 2 }

const {
	boostNetDamage, castBoostInContact, castBoostWithSpareTp, hasActiveStrengthBoost, hasActiveTpBoost, logChipInventory,
	pickBoost, readyTpBoosts, tpBoostNetDamage, FUTURE_TURN_WEIGHT, MIN_LIFE_RATIO_FOR_BOOST
} = await import("../dist/Brain/StrengthBoost.js")
const { strengthBoostTurns } = await import("../dist/Classes/Context/ShotPlan.js")
const { initLeekLogging, LogConfig } = await import("../dist/Toolbox/Logger.js")

const machineGun = { id: 38, name: "machine_gun", cost: 4, minRange: 1, maxRange: 6, needsLos: false, features: [{ type: 1, minValue: 20, maxValue: 25 }] }
const protein = (extra = {}) => ({
	id: 8, name: "protein", cost: 3, cooldown: 3, currentCooldown: 0, minRange: 0, maxRange: 0, needsLos: false,
	features: [{ type: 38, minValue: 80, maxValue: 100, turns: 2 }], ...extra
})

function makeMe({ chips = [protein()], tp = 10, mp = 4, life = 300, strength = 10, effects = [], distance = 8, weapon = machineGun } = {}) {
	const casts = []
	const me = {
		id: 1, name: "me", life, maxLife: 300, tp, mp, strength, science: 0, weapon, weapons: [machineGun], chips, effects,
		distance: () => distance,
		canUseChip: (chip) => chip.currentCooldown === 0 && me.tp >= chip.cost,
		useChip(chip) { casts.push(chip.name); me.tp -= chip.cost; chip.currentCooldown = chip.cooldown; return 1 }
	}
	return { me, casts, enemy: { id: 2, mp: 3 } }
}

test("pickBoost: ready, affordable, not already active; the strongest wins", () => {
	assert.equal(pickBoost(makeMe().me, 10).gain, 90)
	assert.equal(pickBoost(makeMe({ chips: [protein({ currentCooldown: 1 })] }).me, 10), null)
	assert.equal(pickBoost(makeMe().me, 2), null) // coût 3 > 2 PT
	assert.equal(pickBoost(makeMe({ effects: [{ type: 38, turns: 1 }] }).me, 10), null)
	const stronger = protein({ id: 9, name: "big", features: [{ type: 38, minValue: 150, maxValue: 150, turns: 2 }] })
	assert.equal(pickBoost(makeMe({ chips: [protein(), stronger] }).me, 10).chip.name, "big")
	assert.equal(pickBoost(makeMe({ chips: [{ ...machineGun, currentCooldown: 0 }] }).me, 10), null) // pas de boost
})

test("an expired or foreign effect does not count as an active strength boost", () => {
	assert.equal(hasActiveStrengthBoost({ effects: [{ type: 38, turns: 0 }] }), false)
	assert.equal(hasActiveStrengthBoost({ effects: [{ type: 2, turns: 3 }] }), false)
	assert.equal(hasActiveStrengthBoost({ effects: [{ type: 6, turns: 2 }] }), true)
	assert.equal(hasActiveStrengthBoost({}), false)
})

test("boostNetDamage: a lasting boost pays over the turns it covers, a one-turn boost does not", () => {
	const { me } = makeMe()
	const base = 22.5
	const lasting = pickBoost(me, 10)
	const expected = 1 * base * 2.0 - 2 * base * 1.1 + 1 * 2 * base * 0.9 * FUTURE_TURN_WEIGHT
	assert.ok(Math.abs(boostNetDamage(me, machineGun, lasting, 10) - expected) < 1e-9)
	assert.ok(boostNetDamage(me, machineGun, lasting, 10) > 0)
	const brief = { ...lasting, turns: 1 }
	assert.ok(boostNetDamage(me, machineGun, brief, 10) < 0) // 1 tir à ×2,0 < 2 tirs à ×1,1
	assert.equal(strengthBoostTurns(protein()), 2)
	assert.equal(strengthBoostTurns(machineGun), 0)
})

test("in contact: the boost is cast before the plan when it pays", () => {
	const w = makeMe()
	castBoostInContact(w.me, w.enemy)
	assert.deepEqual(w.casts, ["protein"])
	assert.equal(w.me.tp, 7)
})

test("in contact: no cast when far, hurt, with a one-turn boost, already boosted or no enemy", () => {
	const far = makeMe({ distance: 12 }) // portée 6 + 4 PM = 10
	castBoostInContact(far.me, far.enemy)
	const hurt = makeMe({ life: 300 * MIN_LIFE_RATIO_FOR_BOOST - 1 })
	castBoostInContact(hurt.me, hurt.enemy)
	const brief = makeMe({ chips: [protein({ features: [{ type: 38, minValue: 80, maxValue: 100, turns: 1 }] })] })
	castBoostInContact(brief.me, brief.enemy)
	const active = makeMe({ effects: [{ type: 38, turns: 2 }] })
	castBoostInContact(active.me, active.enemy)
	const lonely = makeMe()
	castBoostInContact(lonely.me, null)
	for (const w of [far, hurt, brief, active, lonely]) assert.deepEqual(w.casts, [])
	const healthy = makeMe({ life: 300 * MIN_LIFE_RATIO_FOR_BOOST })
	castBoostInContact(healthy.me, healthy.enemy)
	assert.deepEqual(healthy.casts, ["protein"]) // exactement au seuil : autorisé
})

test("spare TP: cast when the next turn is covered and the enemy may be in range by then", () => {
	const w = makeMe({ distance: 16 }) // portée 6 + 2 × 4 PM + 3 PM adverses = 17
	castBoostWithSpareTp(w.me, w.enemy, 4)
	assert.deepEqual(w.casts, ["protein"])
	const tooFar = makeMe({ distance: 18 })
	castBoostWithSpareTp(tooFar.me, tooFar.enemy, 4)
	const noTp = makeMe({ distance: 10, tp: 2 })
	castBoostWithSpareTp(noTp.me, noTp.enemy, 4)
	const brief = makeMe({ distance: 10, chips: [protein({ features: [{ type: 38, minValue: 80, maxValue: 100, turns: 1 }] })] })
	castBoostWithSpareTp(brief.me, brief.enemy, 4)
	for (const x of [tooFar, noTp, brief]) assert.deepEqual(x.casts, [])
})

test("no boost when two unboosted shots already kill the enemy: its life caps the damage", () => {
	const killable = makeMe()
	killable.enemy.life = 49 // 2 tirs sans boost = 49,5 ; avec boost : 1 tir de 45 seulement
	castBoostInContact(killable.me, killable.enemy)
	assert.deepEqual(killable.casts, [])
	const sturdy = makeMe()
	sturdy.enemy.life = 400
	castBoostInContact(sturdy.me, sturdy.enemy)
	assert.deepEqual(sturdy.casts, ["protein"])
})

test("in contact the boost with the best NET damage is cast, not the one with the largest strength", () => {
	const small = protein({ id: 11, name: "small", cost: 3, features: [{ type: 38, minValue: 60, maxValue: 60, turns: 2 }] })
	const big = protein({ id: 12, name: "big", cost: 9, features: [{ type: 38, minValue: 100, maxValue: 100, turns: 2 }] })
	const w = makeMe({ chips: [big, small] })
	assert.equal(pickBoost(w.me, 10).chip.name, "big") // plus gros gain de force
	castBoostInContact(w.me, w.enemy)
	assert.deepEqual(w.casts, ["small"]) // mais la grosse laisse 1 PT : aucun tir ce tour
})

test("invalid distances or life never trigger a cast", () => {
	const nan = makeMe({ distance: Number.NaN })
	castBoostInContact(nan.me, nan.enemy)
	castBoostWithSpareTp(nan.me, nan.enemy, 4)
	const noMax = makeMe()
	noMax.me.maxLife = undefined
	castBoostInContact(noMax.me, noMax.enemy)
	const noMp = makeMe({ distance: 10 })
	castBoostWithSpareTp(noMp.me, noMp.enemy, undefined)
	for (const w of [nan, noMax, noMp]) assert.deepEqual(w.casts, [])
})

const tpChip = (gain, extra = {}) => ({
	id: 30, name: "motivation", cost: 4, cooldown: 5, currentCooldown: 0, minRange: 0, maxRange: 0, needsLos: false,
	features: [{ type: 32, minValue: gain, maxValue: gain, turns: 3 }], ...extra
})

test("TP boost in contact: cast when the extra TP buy whole shots over the covered turns", () => {
	const w = makeMe({ chips: [tpChip(4)] }) // 10 PT : 2 tirs ; 14 PT les 2 tours suivants : 3 tirs
	castBoostInContact(w.me, w.enemy)
	assert.deepEqual(w.casts, ["motivation"])
	assert.equal(w.me.tp, 6) // coût 4 ; les PT gagnés dépendent du moteur, le mock n'en ajoute pas
})

test("TP boost: a gain too small to buy another shot is not worth its cost (floor of whole shots)", () => {
	const small = makeMe({ chips: [tpChip(1)] }) // 11 PT : toujours 2 tirs
	castBoostInContact(small.me, small.enemy)
	const alreadyActive = makeMe({ chips: [tpChip(4)], effects: [{ type: 32, turns: 2 }] })
	castBoostInContact(alreadyActive.me, alreadyActive.enemy)
	const killable = makeMe({ chips: [tpChip(4)] })
	killable.enemy.life = 40 // les dégâts sont plafonnés : plus de tirs ne tuent pas davantage
	castBoostInContact(killable.me, killable.enemy)
	for (const w of [small, alreadyActive, killable]) assert.deepEqual(w.casts, [])
})

test("TP boost: the next turns are valued from the turn-start TP, cast with spare TP only if they pay", () => {
	const spare = makeMe({ chips: [tpChip(4)], tp: 6, distance: 12 })
	castBoostWithSpareTp(spare.me, spare.enemy, 4, 10) // PT de départ 10 : 14 PT → 3 tirs
	assert.deepEqual(spare.casts, ["motivation"])
	const noGain = makeMe({ chips: [tpChip(1)], tp: 6, distance: 12 })
	castBoostWithSpareTp(noGain.me, noGain.enemy, 4, 10)
	const brief = makeMe({ chips: [tpChip(4, { features: [{ type: 32, minValue: 4, maxValue: 4, turns: 1 }] })], tp: 6, distance: 12 })
	castBoostWithSpareTp(brief.me, brief.enemy, 4, 10)
	const far = makeMe({ chips: [tpChip(4)], tp: 6, distance: 40 })
	castBoostWithSpareTp(far.me, far.enemy, 4, 10)
	for (const w of [noGain, brief, far]) assert.deepEqual(w.casts, [])
})

test("with a TP and a strength boost, the TP boost is cast first so the strength decision sees the real TP", () => {
	const w = makeMe({ chips: [protein(), tpChip(4)] })
	castBoostInContact(w.me, w.enemy)
	assert.deepEqual(w.casts[0], "motivation")
})

test("TP boost then strength boost, whatever the order of the chip list, and each only once per turn", () => {
	// Comme le moteur : le boost de PT ajoute ses PT au lancer (le mock de base ne le fait pas).
	const gaining = (w) => {
		const useChip = w.me.useChip
		w.me.useChip = (chip, target) => {
			const result = useChip(chip, target)
			if (chip.name === "motivation") w.me.tp += 4
			return result
		}
		return w
	}
	for (const chips of [[protein(), tpChip(4)], [tpChip(4), protein()]]) {
		const w = gaining(makeMe({ chips }))
		castBoostInContact(w.me, w.enemy)
		assert.deepEqual(w.casts, ["motivation", "protein"])
		assert.equal(w.me.tp, 7) // 10 − 4 + 4 − 3
		castBoostInContact(w.me, w.enemy) // cooldowns en cours : rien de plus
		castBoostWithSpareTp(w.me, w.enemy, 4, 10)
		assert.deepEqual(w.casts, ["motivation", "protein"])
	}
	const spare = gaining(makeMe({ chips: [protein(), tpChip(4)], tp: 8, distance: 12 }))
	castBoostWithSpareTp(spare.me, spare.enemy, 4, 10)
	assert.deepEqual(spare.casts, ["motivation", "protein"])
})

test("hasActiveTpBoost / readyTpBoosts: expired, foreign or force effects do not block; cooldown, cost and an active boost do", () => {
	assert.equal(hasActiveTpBoost({ effects: [{ type: 32, turns: 2 }] }), true)
	assert.equal(hasActiveTpBoost({ effects: [{ type: 32, turns: 0 }] }), false)
	assert.equal(hasActiveTpBoost({ effects: [{ type: 38, turns: 3 }] }), false) // force brute : autre effet
	assert.equal(hasActiveTpBoost({ effects: [{ type: 2, turns: 3 }] }), false)
	assert.equal(hasActiveTpBoost({}), false)
	const names = (me, tp) => readyTpBoosts(me, tp).map((option) => option.chip.name)
	assert.deepEqual(names(makeMe({ chips: [tpChip(4)] }).me, 10), ["motivation"])
	assert.deepEqual(names(makeMe({ chips: [tpChip(4)] }).me, 4), ["motivation"]) // coût = PT : lançable
	assert.deepEqual(names(makeMe({ chips: [tpChip(4)] }).me, 3), []) // coût > PT
	assert.deepEqual(names(makeMe({ chips: [tpChip(4, { currentCooldown: 1 })] }).me, 10), [])
	assert.deepEqual(names(makeMe({ chips: [tpChip(4)], effects: [{ type: 32, turns: 1 }] }).me, 10), [])
	assert.deepEqual(names(makeMe({ chips: [protein(), machineGun, tpChip(0)] }).me, 10), []) // ni force, ni arme, ni coût nul
	const option = readyTpBoosts(makeMe({ chips: [tpChip(4)] }).me, 10)[0]
	assert.equal(option.gain, 4)
	assert.equal(option.turns, 3)
})

test("tpBoostNetDamage: whole shots only, capped by the enemy life, a boost gives the extra turns weight", () => {
	const { me } = makeMe()
	const shot = 22.5 * 1.1 // machine_gun (coût 4) à force 10
	const option = (gain, turns = 3) => ({ chip: tpChip(4), gain, turns })
	const net = (gain, tp, fullTp, now, life, weapon = machineGun, turns = 3) =>
		tpBoostNetDamage(me, weapon, option(gain, turns), tp, fullTp, now, life)
	// ce tour : 10 − 4 + 4 = 10 PT, comme avant (2 tirs) ; ensuite 2 tours à 14 PT (3 tirs) au lieu de 10 (2 tirs)
	assert.ok(Math.abs(net(4, 10, 10, true) - 2 * shot * FUTURE_TURN_WEIGHT) < 1e-9)
	assert.ok(Math.abs(net(4, 10, 10, false) - 2 * shot * FUTURE_TURN_WEIGHT) < 1e-9)
	assert.ok(Math.abs(net(4, 10, 10, false, undefined, machineGun, 2) - shot * FUTURE_TURN_WEIGHT) < 1e-9)
	assert.equal(net(4, 10, 10, false, undefined, machineGun, 1), 0) // un seul tour : rien de futur
	// gain inférieur au coût de l'arme : 11 PT achètent toujours 2 tirs, et le lancer coûte un tir ce tour-ci
	assert.equal(net(1, 10, 10, false), 0)
	assert.ok(Math.abs(net(1, 10, 10, true) + shot) < 1e-9) // 7 PT : 1 tir de moins
	// seuil de gain : 10 PT de départ + 2 = 12 achètent le 3e tir, + 1 non
	assert.ok(net(2, 10, 10, false) > 0)
	// les PT de début de tour (pas les PT restants) servent de base aux tours suivants
	assert.equal(net(2, 6, 8, false), 0) // 8 → 10 PT : 2 tirs dans les deux cas
	assert.ok(net(2, 6, 10, false) > 0) // 10 → 12 PT : un tir de plus
	// plafond par PV ennemis : 3 tirs = 74,25 ; 2 tirs = 49,5
	assert.equal(net(4, 10, 10, false, 49.5), 0)
	assert.ok(Math.abs(net(4, 10, 10, false, 49.6) - 2 * 0.1 * FUTURE_TURN_WEIGHT) < 1e-9)
	assert.ok(Math.abs(net(4, 10, 10, false, 74.25) - 2 * shot * FUTURE_TURN_WEIGHT) < 1e-9)
	assert.ok(Math.abs(net(4, 10, 10, false, 1000) - 2 * shot * FUTURE_TURN_WEIGHT) < 1e-9)
	for (const invalidLife of [0, -5, Number.NaN]) {
		assert.ok(Math.abs(net(4, 10, 10, false, invalidLife) - 2 * shot * FUTURE_TURN_WEIGHT) < 1e-9, `${invalidLife}`) // ignoré
	}
	// usages maximum de l'arme : 2 tirs max, donc aucun gain de PT ne vaut quoi que ce soit
	assert.equal(net(4, 10, 10, true, undefined, { ...machineGun, maxUses: 2 }), 0)
	// arme sans dégâts ou sans coût
	assert.equal(net(4, 10, 10, true, undefined, { ...machineGun, features: [] }), 0)
	assert.equal(net(4, 10, 10, true, undefined, { ...machineGun, cost: 0 }), 0)
})

test("BUFF_TP boost: amplified by my science, so the same chip crosses the payoff threshold with more science", () => {
	globalThis.Effect.BUFF_TP = 8
	try {
		const buff = () => tpChip(4, { features: [{ type: 8, minValue: 1, maxValue: 1, turns: 3 }] })
		const plain = makeMe({ chips: [buff()] }) // +1 PT : 11 PT, toujours 2 tirs
		castBoostInContact(plain.me, plain.enemy)
		assert.deepEqual(plain.casts, [])
		const learned = makeMe({ chips: [buff()] })
		learned.me.science = 100 // +2 PT : 12 PT, un 3e tir
		castBoostInContact(learned.me, learned.enemy)
		assert.deepEqual(learned.casts, ["motivation"])
		const active = makeMe({ chips: [buff()], effects: [{ type: 8, turns: 2 }] })
		active.me.science = 100
		castBoostInContact(active.me, active.enemy)
		assert.deepEqual(active.casts, [])
	} finally {
		delete globalThis.Effect.BUFF_TP
	}
})

test("TP boost with spare TP: valued from the turn-start TP, capped by the enemy life", () => {
	const gain2 = () => tpChip(4, { features: [{ type: 32, minValue: 2, maxValue: 2, turns: 3 }] })
	const fromTen = makeMe({ chips: [gain2()], tp: 6, distance: 12 })
	castBoostWithSpareTp(fromTen.me, fromTen.enemy, 4, 10) // 10 → 12 PT : un 3e tir
	assert.deepEqual(fromTen.casts, ["motivation"])
	const fromEight = makeMe({ chips: [gain2()], tp: 6, distance: 12 })
	castBoostWithSpareTp(fromEight.me, fromEight.enemy, 4, 8) // 8 → 10 PT : 2 tirs dans les deux cas
	assert.deepEqual(fromEight.casts, [])
	const sparePtOnly = makeMe({ chips: [gain2()], tp: 6, distance: 12 })
	castBoostWithSpareTp(sparePtOnly.me, sparePtOnly.enemy, 4) // PT de départ omis = PT restants (6 → 8 : un tir de plus)
	assert.deepEqual(sparePtOnly.casts, ["motivation"])
	const killable = makeMe({ chips: [gain2()], tp: 6, distance: 12 })
	killable.enemy.life = 40 // 2 tirs suffisent déjà
	castBoostWithSpareTp(killable.me, killable.enemy, 4, 10)
	assert.deepEqual(killable.casts, [])
	const active = makeMe({ chips: [gain2()], tp: 6, distance: 12, effects: [{ type: 32, turns: 2 }] })
	castBoostWithSpareTp(active.me, active.enemy, 4, 10)
	assert.deepEqual(active.casts, [])
})

test("a refused cast (canUseChip false) spends nothing", () => {
	const w = makeMe()
	w.me.canUseChip = () => false
	castBoostInContact(w.me, w.enemy)
	assert.deepEqual(w.casts, [])
	assert.equal(w.me.tp, 10)
})

test("the chip inventory is logged once, with identifiers, costs, cooldowns and effect types", () => {
	const lines = []
	const config = new LogConfig()
	initLeekLogging(config)
	globalThis.Debug = { log: (message) => lines.push(String(message)), pause() {} }
	globalThis.console = { ...console, log: (message) => lines.push(String(message)) }
	logChipInventory(makeMe().me)
	const line = lines.find((text) => text.includes("[Chips]"))
	assert.ok(line, "inventory line")
	assert.match(line, /protein#8\(3TP,cd3,38:80-100x2\)/)
	assert.match(line, /STR 10/)
})
