import assert from "node:assert/strict"
import test from "node:test"

globalThis.Color = { rgb: () => 0 }
globalThis.Debug = { log() {}, pause() {} }
globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4, POISON: 5, BUFF_STRENGTH: 6 }
globalThis.Fight = { turn: 2 }

// Les décisions de boost (lancer ou non) sont prises par les plans : voir tests/strength-boost-turn.test.mjs.
// Ici : le modèle (puces prêtes, gain net à une arme, part des tours suivants, portée utile).
const {
	boostNetDamage, boostReach, hasActiveStrengthBoost, hasActiveTpBoost, pickBoost, pickTpBoost,
	readyTpBoosts, strengthBoostFutureDamage, tpBoostFutureDamage, tpBoostNetDamage, FUTURE_TURN_WEIGHT,
	MIN_LIFE_RATIO_FOR_BOOST
} = await import("../dist/Brain/StrengthBoost.js")
const { strengthBoostTurns } = await import("../dist/Classes/Context/ShotPlan.js")

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

const tpChip = (gain, extra = {}) => ({
	id: 30, name: "motivation", cost: 4, cooldown: 5, currentCooldown: 0, minRange: 0, maxRange: 0, needsLos: false,
	features: [{ type: 32, minValue: gain, maxValue: gain, turns: 3 }], ...extra
})

test("boostNetDamage: the enemy life caps the damage, so a boost that costs the kill never has a positive net", () => {
	const { me } = makeMe()
	const option = pickBoost(me, 10)
	// 2 tirs sans boost = 49,5 ≥ 49 PV ; avec boost : 1 tir de 45, puis au plus les 4 PV restants.
	assert.ok(!(boostNetDamage(me, machineGun, option, 10, 49) > 0))
	assert.ok(boostNetDamage(me, machineGun, option, 10, 400) > 0)
	// Le plus gros gain de force n'est pas le meilleur gain net : une puce à 9 PT ne laisse aucun tir ce tour.
	const big = { ...option, chip: protein({ cost: 9 }), gain: 100 }
	assert.ok(boostNetDamage(me, machineGun, big, 10) < boostNetDamage(me, machineGun, { ...option, gain: 60 }, 10))
})

test("future part of a boost: FUTURE_TURN_WEIGHT x (turns - 1) full turns, nothing for a one-turn boost", () => {
	const { me } = makeMe()
	const strength = pickBoost(me, 10) // +90 force, 2 tours
	assert.ok(Math.abs(strengthBoostFutureDamage(machineGun, strength, 10) - 2 * 22.5 * 0.9 * FUTURE_TURN_WEIGHT) < 1e-9)
	assert.equal(strengthBoostFutureDamage(machineGun, { ...strength, turns: 1 }, 10), 0)
	assert.equal(strengthBoostFutureDamage({ ...machineGun, features: [] }, strength, 10), 0)
	const tp = pickTpBoost(makeMe({ chips: [tpChip(4)] }).me, 10) // +4 PT, 3 tours : 14 PT = 3 tirs au lieu de 2
	assert.equal(tp.chip.name, "motivation")
	assert.ok(Math.abs(tpBoostFutureDamage(me, machineGun, tp, 10) - 2 * 22.5 * 1.1 * FUTURE_TURN_WEIGHT) < 1e-9)
	assert.equal(tpBoostFutureDamage(me, machineGun, { ...tp, gain: 1 }, 10), 0) // 11 PT : toujours 2 tirs
	assert.equal(tpBoostFutureDamage(me, machineGun, tp, 10, 49.5), 0) // 2 tirs tuent déjà
	assert.equal(pickTpBoost(makeMe().me, 10), null) // protein n'est pas un boost de PT
	assert.equal(MIN_LIFE_RATIO_FOR_BOOST, 0.5)
})

test("boostReach: longest weapon range + two turns of my MP + the enemy MP", () => {
	const { me, enemy } = makeMe({ mp: 4 })
	assert.equal(boostReach(me, enemy), 6 + 2 * 4 + 3)
	assert.equal(boostReach({ ...me, weapon: null, weapons: [{ ...machineGun, maxRange: 9 }] }, enemy), 9 + 8 + 3)
	assert.equal(boostReach({ ...me, weapon: null, weapons: undefined }, { id: 2 }), 8)
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

// Combat 54991104 : motivation (+2 PT) jamais lancée. En tirs entiers d'une arme à 5 PT, 12 PT = 10 PT = 2 tirs.
test("tpBoostFutureDamage: weapon only by default; idle mode takes the best of three range scenarios", () => {
	const gun = { id: 60, name: "gun", cost: 5, minRange: 1, maxRange: 6, needsLos: false, features: [{ type: 1, minValue: 20, maxValue: 20 }] }
	const attack = (name, cost, cooldown, damage, extra = {}) => ({
		id: cost * 100 + damage, name, cost, cooldown, currentCooldown: 0, minRange: 0, maxRange: 10, needsLos: false,
		features: [{ type: 1, minValue: damage, maxValue: damage }], ...extra
	})
	const option = { chip: tpChip(2), gain: 2, turns: 3 }
	const credit = (idle) => (chips, weapon = gun, life = undefined, strength = 10) =>
		tpBoostFutureDamage(makeMe({ chips, weapon, strength }).me, weapon, option, 10, life, idle)
	const future = credit(true) // plan sans tir
	const firing = credit(undefined) // défaut : plans qui tirent, arme seule en tirs entiers
	// Arme seule : 2 tirs à 10 comme à 12 PT (0). Arme + puces : 2 tirs = 40, puis 4 puces = 48 (+ 8). Puces seules :
	// 3 lancers puis 4 (+ 12) : le scénario le plus favorable est retenu. Force 10, 2 tours.
	const expected = 2 * 12 * 1.1 * FUTURE_TURN_WEIGHT
	assert.ok(Math.abs(future([attack("zap", 3, 0, 12)]) - expected) < 1e-9)
	assert.equal(firing([attack("zap", 3, 0, 12)]), 0) // un plan qui tire n'échange pas un lancer certain contre ce crédit
	assert.ok(Math.abs(future([attack("zap", 3, 0, 12), protein(), tpChip(2)]) - expected) < 1e-9) // boosts : pas des tirs
	assert.equal(future([attack("zap", 3, 0, 12)], gun, 39), 0) // 3 lancers (39,6) ou 2 tirs (44) tuent déjà sans le boost
	assert.equal(future([]), 0) // arme seule : 2 tirs à 10 comme à 12 PT
	// Aucun scénario ne profite de 2 PT : puce limitée à 1 lancer par tour (cooldown 1, maxUses 1), en cooldown, ou de
	// cooldown de base long (pas disponible à chaque tour couvert).
	assert.equal(future([attack("once", 3, 1, 12)]), 0)
	assert.equal(future([attack("capped", 3, 0, 12, { maxUses: 1 })]), 0)
	assert.equal(future([attack("cooling", 3, 0, 12, { currentCooldown: 1 })]), 0)
	assert.equal(future([attack("slow", 2, 4, 30)]), 0)
	assert.ok(future([attack("jab", 2, 1, 5)]) > 0) // cooldown 1 : une fois par tour, paie les 2 PT en plus
	// Arme seule en tirs entiers (ancien calcul) : jamais moins, même si les puces remplissent déjà les 10 PT.
	const rifle = { ...gun, cost: 4, features: [{ type: 1, minValue: 20, maxValue: 20 }] }
	assert.ok(Math.abs(future([attack("heavy", 5, 1, 30)], rifle) - 2 * 20 * 1.1 * FUTURE_TURN_WEIGHT) < 1e-9)
	assert.equal(firing([attack("heavy", 5, 1, 30)], rifle), future([attack("heavy", 5, 1, 30)], rifle))
	// Équipement du combat 54991104 (force 20). Tout à portée : 12 PT n'achètent rien de plus (shotgun + rock = 10 PT).
	// Shotgun hors de portée : rock + spark (8 PT) puis rock + 2 sparks (11 PT), + 12 de base par tour.
	const shotgun = { ...gun, name: "shotgun", maxRange: 5, maxUses: 2, features: [{ type: 1, minValue: 33, maxValue: 43 }] }
	const kit = [{ ...attack("rock", 5, 1, 0), features: [{ type: 1, minValue: 38, maxValue: 39 }] },
		{ ...attack("spark", 3, 0, 0), features: [{ type: 1, minValue: 8, maxValue: 16 }] }]
	assert.ok(Math.abs(future(kit, shotgun, undefined, 20) - 21.6) < 1e-9)
	assert.equal(firing(kit, shotgun, undefined, 20), 0)
	assert.equal(future(kit.slice(0, 1), shotgun, undefined, 20), 0) // sans spark : rock une fois, 2 tirs de shotgun
})
