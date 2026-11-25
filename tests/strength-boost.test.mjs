import assert from "node:assert/strict"
import test from "node:test"

globalThis.Color = { rgb: () => 0 }
globalThis.Debug = { log() {}, pause() {} }
globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4, POISON: 5, BUFF_STRENGTH: 6 }
globalThis.Fight = { turn: 2 }

const {
	boostNetDamage, castBoostInContact, castBoostWithSpareTp, hasActiveStrengthBoost, logChipInventory, pickBoost,
	FUTURE_TURN_WEIGHT, MIN_LIFE_RATIO_FOR_BOOST
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
