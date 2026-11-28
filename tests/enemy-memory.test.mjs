import assert from "node:assert/strict"
import test from "node:test"
import { makeTurnWorld } from "./helpers/turn-world.mjs"

globalThis.Color = { rgb: () => 0 }
const debugLogs = []
globalThis.Debug = { log: (message) => debugLogs.push(message), pause() {} }
globalThis.Effect = {
	DAMAGE: 1,
	HEAL: 2,
	ABSOLUTE_SHIELD: 3,
	RELATIVE_SHIELD: 4,
	POISON: 5,
	BUFF_STRENGTH: 6
}

const { EnemyMemory } = await import("../dist/Classes/Context/EnemyMemory.js")
const { MAX_HIT_LOG, INFINITE_COOLDOWN } = await import("../dist/Classes/Context/EnemyProfile.js")

const pistol = { id: 37, name: "pistol", cost: 3, minRange: 1, maxRange: 7, features: [{ type: 1, minValue: 15, maxValue: 20 }] }
const laser = { id: 40, name: "laser", cost: 5, minRange: 2, maxRange: 9, features: [{ type: 1, minValue: 40, maxValue: 50 }] }
const shield = { id: 20, name: "shield", cost: 3, cooldown: 4, currentCooldown: 0, features: [{ type: 3, minValue: 10, maxValue: 10 }] }
const dart = { id: 21, name: "dart", cost: 2, cooldown: 3, currentCooldown: 0, features: [{ type: 1, minValue: 10, maxValue: 20 }] }
const spark = { id: 22, name: "spark", cost: 1, cooldown: 0, currentCooldown: 0, features: [{ type: 1, minValue: 10, maxValue: 20 }] }
const regen = { id: 23, name: "regeneration", cost: 4, cooldown: -1, currentCooldown: 0, features: [{ type: 2, minValue: 5, maxValue: 5 }] }

function makeEnemy(overrides = {}) {
	return {
		id: 2,
		name: "enemy",
		level: 50,
		life: 100,
		maxLife: 100,
		tp: 10,
		mp: 3,
		strength: 0,
		agility: 20,
		wisdom: 30,
		resistance: 40,
		science: 50,
		magic: 60,
		weapon: null,
		weapons: [pistol],
		chips: [shield, dart],
		effects: [],
		launchedEffects: [],
		...overrides
	}
}

function makeMe(life = 100, effects = []) {
	return { id: 1, name: "me", life, maxLife: 100, effects }
}

function effectOf(item, caster, target, turns = 2, type = 3) {
	return { type, value: 10, caster, turns, critical: false, item, target, modifiers: 0 }
}

test("identify stores the enemy snapshot once", () => {
	const memory = new EnemyMemory()
	const enemy = makeEnemy({ weapon: pistol })
	const profile = memory.identify(enemy, 1)

	assert.equal(profile.id, 2)
	assert.equal(profile.name, "enemy")
	assert.equal(profile.level, 50)
	assert.equal(profile.maxLife, 100)
	assert.deepEqual(profile.stats, { strength: 0, agility: 20, wisdom: 30, resistance: 40, science: 50, magic: 60 })
	assert.equal(profile.identifiedTurn, 1)
	assert.deepEqual(profile.knownWeapons, [pistol])
	assert.deepEqual(profile.knownChips, [shield, dart])
	assert.equal(profile.equippedWeapon, pistol)
	assert.equal(memory.identify(makeEnemy(), 5), profile)
	assert.equal(profile.identifiedTurn, 1)
	assert.equal(memory.has(2), true)
	assert.equal(memory.getProfile(99), null)
	assert.equal(memory.update(makeEnemy({ id: 99 }), makeMe(), 1), null)
})

test("read API returns neutral values for unknown enemies and aggregates known weapons", () => {
	const memory = new EnemyMemory()
	assert.deepEqual(memory.knownWeapons(7), [])
	assert.deepEqual(memory.observedWeapons(7), [])
	assert.deepEqual(memory.observedChips(7), [])
	assert.equal(memory.maxKnownWeaponRange(7), 0)
	assert.equal(memory.isChipReady(7, shield), true)
	assert.equal(memory.getCooldown(7, shield), 0)

	memory.identify(makeEnemy({ weapons: [pistol, laser] }), 1)
	assert.equal(memory.maxKnownWeaponRange(2), 9)
})

test("an equipped weapon is recorded as observed and added to the known list", () => {
	const memory = new EnemyMemory()
	const enemy = makeEnemy({ weapon: null, weapons: [pistol] })
	memory.identify(enemy, 1)

	let result = memory.update(enemy, makeMe(), 1)
	assert.deepEqual(result.newItems, [])
	assert.deepEqual(memory.observedWeapons(2), [])

	result = memory.update(makeEnemy({ weapon: laser, weapons: [pistol] }), makeMe(), 2)
	assert.deepEqual(result.newItems, ["laser"])
	assert.deepEqual(memory.observedWeapons(2), [laser])
	assert.deepEqual(memory.knownWeapons(2), [pistol, laser])
	assert.equal(memory.maxKnownWeaponRange(2), 9)

	result = memory.update(makeEnemy({ weapon: laser, weapons: [pistol] }), makeMe(), 3)
	assert.deepEqual(result.newItems, [])
	assert.equal(memory.getProfile(2).observedWeapons.get(40).count, 1)
	assert.equal(memory.getProfile(2).observedWeapons.get(40).lastTurn, 3)
})

test("a chip used through an effect is detected via caster and item, with objects or ids", () => {
	const memory = new EnemyMemory()
	const enemy = makeEnemy()
	memory.identify(enemy, 1)

	// launchedEffects, forme objet
	const withObjects = makeEnemy({ launchedEffects: [effectOf(shield, enemy, enemy)] })
	let result = memory.update(withObjects, makeMe(), 2)
	assert.deepEqual(result.newItems, ["shield"])
	assert.deepEqual(memory.observedChips(2), [shield])
	assert.equal(memory.getProfile(2).observedChips.get(20).firstTurn, 2)

	// me.effects dont le lanceur est l'ennemi, forme ids ; un effet d'un autre lanceur est ignoré
	const myEffects = [effectOf(21, 2, 1), effectOf(22, 99, 1)]
	result = memory.update(makeEnemy(), makeMe(100, myEffects), 3)
	assert.deepEqual(result.newItems, ["dart"])
	assert.deepEqual(memory.observedChips(2), [shield, dart])
})

test("an effect on me cast by another entity is ignored even when the item is one of the enemy's chips", () => {
	const memory = new EnemyMemory()
	memory.identify(makeEnemy(), 1)

	memory.update(makeEnemy(), makeMe(100, [effectOf(dart, 99, 1), effectOf(21, 99, 1)]), 2)
	assert.deepEqual(memory.observedChips(2), [])
	assert.equal(memory.getCooldown(2, dart), 0)
})

test("a multi-effect chip whose effects have different durations is counted once", () => {
	const memory = new EnemyMemory()
	const buff = { id: 24, name: "buff", cost: 3, cooldown: 6, currentCooldown: 0, features: [] }
	const enemy = (effects) => makeEnemy({ chips: [buff], launchedEffects: effects })
	memory.identify(enemy([]), 1)

	memory.update(enemy([effectOf(buff, 2, 2, 3), effectOf(buff, 2, 2, 1)]), makeMe(), 2)
	// Tour suivant : l'effet d'1 tour a expiré, l'autre est toujours actif (2 tours restants)
	memory.update(enemy([effectOf(buff, 2, 2, 2)]), makeMe(), 3)

	assert.equal(memory.getProfile(2).observedChips.get(24).count, 1)
	assert.equal(memory.getCooldown(2, buff), 5)
})

test("a multi-effect chip with different durations is counted again only when relaunched", () => {
	const memory = new EnemyMemory()
	const buff = { id: 24, name: "buff", cost: 3, cooldown: 6, currentCooldown: 0, features: [] }
	const enemy = (effects) => makeEnemy({ chips: [buff], launchedEffects: effects })
	memory.identify(enemy([]), 1)
	const count = () => memory.getProfile(2).observedChips.get(24).count

	memory.update(enemy([effectOf(buff, 2, 2, 1), effectOf(buff, 2, 2, 3)]), makeMe(), 2)
	memory.update(enemy([effectOf(buff, 2, 2, 2)]), makeMe(), 3)
	memory.update(enemy([effectOf(buff, 2, 2, 1)]), makeMe(), 4)
	assert.equal(count(), 1)
	memory.update(enemy([effectOf(buff, 2, 2, 3), effectOf(buff, 2, 2, 1)]), makeMe(), 8)
	assert.equal(count(), 2)
})

test("a numeric item id that matches both a weapon and a chip is not attributed", () => {
	const memory = new EnemyMemory()
	const clashingChip = { ...shield, id: 37 }
	const enemy = makeEnemy({ weapons: [pistol], chips: [clashingChip] })
	memory.identify(enemy, 1)

	memory.update(makeEnemy({ weapons: [pistol], chips: [clashingChip] }), makeMe(100, [effectOf(37, 2, 1)]), 2)
	assert.deepEqual(memory.observedChips(2), [])
	assert.deepEqual(memory.observedWeapons(2), [])
})

test("an already seen active effect is not counted again, a relaunch is", () => {
	const memory = new EnemyMemory()
	memory.identify(makeEnemy(), 1)
	const seen = (turn, turns) => makeEnemy({ launchedEffects: [effectOf(shield, 2, 2, turns)] })
	const count = () => memory.getProfile(2).observedChips.get(20).count

	memory.update(seen(2, 3), makeMe(), 2)
	assert.equal(count(), 1)
	memory.update(seen(3, 2), makeMe(), 3)
	memory.update(seen(4, 1), makeMe(), 4)
	assert.equal(count(), 1)
	memory.update(seen(5, 3), makeMe(), 5)
	assert.equal(count(), 2)
})

test("cooldown is set on detection, decremented per elapsed turn and becomes ready", () => {
	const memory = new EnemyMemory()
	memory.identify(makeEnemy(), 1)
	assert.equal(memory.isChipReady(2, shield), true)

	memory.update(makeEnemy({ launchedEffects: [effectOf(shield, 2, 2, 1)] }), makeMe(), 2)
	assert.equal(memory.getCooldown(2, shield), 4)
	assert.equal(memory.isChipReady(2, shield), false)

	// Même tour : pas de décrément
	memory.update(makeEnemy(), makeMe(), 2)
	assert.equal(memory.getCooldown(2, shield), 4)

	memory.update(makeEnemy(), makeMe(), 3)
	assert.equal(memory.getCooldown(2, shield), 3)
	memory.update(makeEnemy(), makeMe(), 4)
	memory.update(makeEnemy(), makeMe(), 5)
	assert.equal(memory.getCooldown(2, shield), 1)
	assert.equal(memory.isChipReady(2, shield), false)
	memory.update(makeEnemy(), makeMe(), 6)
	assert.equal(memory.getCooldown(2, shield), 0)
	assert.equal(memory.isChipReady(2, shield), true)
})

test("cooldown handles multi-turn jumps, chips without cooldown and infinite cooldown", () => {
	const memory = new EnemyMemory()
	const enemy = makeEnemy({ chips: [shield, spark, regen] })
	memory.identify(enemy, 1)
	const usage = makeEnemy({
		chips: [shield, spark, regen],
		launchedEffects: [effectOf(shield, 2, 2, 1), effectOf(spark, 2, 1, 1), effectOf(regen, 2, 2, -1)]
	})
	memory.update(usage, makeMe(), 2)
	assert.equal(memory.getCooldown(2, shield), 4)
	assert.equal(memory.isChipReady(2, spark), true)
	assert.equal(memory.getCooldown(2, regen), INFINITE_COOLDOWN)

	// Saut de 2 tours (tours 3-4 sans appel) : 4 - 2 = 2
	memory.update(makeEnemy({ chips: [shield, spark, regen] }), makeMe(), 4)
	assert.equal(memory.getCooldown(2, shield), 2)
	// Saut de 10 tours : prête ; l'infinie diminue seulement de 1 par tour
	memory.update(makeEnemy({ chips: [shield, spark, regen] }), makeMe(), 14)
	assert.equal(memory.isChipReady(2, shield), true)
	assert.equal(memory.getCooldown(2, regen), INFINITE_COOLDOWN - 12)
	assert.equal(memory.isChipReady(2, regen), false)
})

test("a unique compatible candidate is inferred as the source of a life loss", () => {
	const memory = new EnemyMemory()
	const enemy = makeEnemy({ weapon: pistol, tp: 3, chips: [shield] })
	memory.identify(enemy, 1)
	memory.update(enemy, makeMe(100), 1)
	memory.endMyTurn(makeMe(100), 1)

	// pistol 15-20 (1 usage : TP 3 / coût 3), x1.3 critique => plage [15, 26] ; shield n'a pas de dégâts
	const result = memory.update(makeEnemy({ weapon: pistol, tp: 3, chips: [shield] }), makeMe(82), 2)
	assert.deepEqual(result.hit, { turn: 2, amount: 18, item: pistol, source: "inferred" })
	assert.deepEqual(memory.getProfile(2).hits, [result.hit])
	// Une inférence ne marque pas d'usage observé ni de cooldown
	assert.deepEqual(memory.observedWeapons(2).length, 1) // seulement l'arme équipée vue
	assert.deepEqual(memory.observedChips(2), [])
})

test("strength scales the damage range", () => {
	const memory = new EnemyMemory()
	const enemy = makeEnemy({ weapon: pistol, tp: 3, strength: 100, chips: [] })
	memory.identify(enemy, 1)
	memory.update(enemy, makeMe(100), 1)
	memory.endMyTurn(makeMe(100), 1)

	// force 100 : plage [30, 52] ; 18 est trop bas, 35 est compatible
	let result = memory.update(enemy, makeMe(82), 2)
	assert.equal(result.hit.source, "ambiguous")
	memory.endMyTurn(makeMe(82), 2)
	result = memory.update(enemy, makeMe(47), 3)
	assert.equal(result.hit.source, "inferred")
	assert.equal(result.hit.amount, 35)
})

test("the compatible damage range includes its rounding tolerance and critical hit bounds", () => {
	// pistol 15-20, force 0, 1 usage : plage [15, 26] (20 x 1.3), tolérance de 1 PV de chaque côté
	const sourceOf = (loss) => {
		const memory = new EnemyMemory()
		const make = () => makeEnemy({ weapon: pistol, tp: 3, chips: [] })
		memory.identify(make(), 1)
		memory.update(make(), makeMe(100), 1)
		memory.endMyTurn(makeMe(100), 1)
		return memory.update(make(), makeMe(100 - loss), 2).hit.source
	}
	assert.equal(sourceOf(13), "ambiguous")
	assert.equal(sourceOf(14), "inferred")
	assert.equal(sourceOf(26), "inferred")
	assert.equal(sourceOf(27), "inferred")
	assert.equal(sourceOf(28), "ambiguous")
})

test("the maximum compatible damage grows with the number of elapsed turns", () => {
	const lossAfter = (secondTurn) => {
		const memory = new EnemyMemory()
		const make = () => makeEnemy({ weapon: pistol, tp: 3, chips: [] })
		memory.identify(make(), 1)
		memory.update(make(), makeMe(100), 1)
		memory.endMyTurn(makeMe(100), 1)
		return memory.update(make(), makeMe(60), secondTurn).hit.source // perte 40 > 27
	}
	assert.equal(lossAfter(2), "ambiguous")
	assert.equal(lossAfter(3), "inferred") // 2 tours écoulés : max 52
})

test("several compatible candidates or none leave the hit ambiguous", () => {
	const memory = new EnemyMemory()
	const make = () => makeEnemy({ weapon: pistol, tp: 3, chips: [spark] })
	memory.identify(make(), 1)
	memory.update(make(), makeMe(100), 1)
	memory.endMyTurn(makeMe(100), 1)

	// pistol [15, 26] et spark [10, 26] acceptent 18
	let result = memory.update(make(), makeMe(82), 2)
	assert.deepEqual(result.hit, { turn: 2, amount: 18, item: null, source: "ambiguous" })

	// 200 PV perdus : aucun candidat compatible
	memory.endMyTurn(makeMe(300), 2)
	result = memory.update(make(), makeMe(100), 3)
	assert.deepEqual(result.hit, { turn: 3, amount: 200, item: null, source: "ambiguous" })
})

test("a chip with a tracked cooldown is not a candidate", () => {
	const memory = new EnemyMemory()
	const make = (extra = {}) => makeEnemy({ weapon: pistol, tp: 3, chips: [dart], ...extra })
	memory.identify(make(), 1)
	memory.update(make(), makeMe(100), 1)
	memory.endMyTurn(makeMe(100), 1)

	// dart (10-20) et pistol (15-20) sont tous deux compatibles avec 17
	let result = memory.update(make(), makeMe(83), 2)
	assert.equal(result.hit.source, "ambiguous")

	// dart détecté via un effet au tour 3 (cooldown 3) : exclu des candidats au tour 4 (cooldown 2)
	memory.update(make({ launchedEffects: [effectOf(dart, 2, 99, 1, 6)] }), makeMe(83), 3)
	assert.equal(memory.getCooldown(2, dart), 3)
	memory.endMyTurn(makeMe(83), 3)
	result = memory.update(make(), makeMe(66), 4)
	assert.deepEqual(result.hit, { turn: 4, amount: 17, item: pistol, source: "inferred" })
})

test("a damage-over-time effect from the enemy is journaled as an effect hit and subtracted", () => {
	const memory = new EnemyMemory()
	const make = () => makeEnemy({ weapon: pistol, tp: 3, chips: [dart] })
	memory.identify(make(), 1)
	memory.update(make(), makeMe(100), 1)
	memory.endMyTurn(makeMe(100), 1)

	const poison = { ...effectOf(dart, 2, 1, 3, 5), value: 7 }
	const result = memory.update(make(), makeMe(93, [poison]), 2)
	assert.deepEqual(result.hit, { turn: 2, amount: 7, item: dart, source: "effect" })
	assert.equal(memory.getProfile(2).hits.length, 1)
})

test("with several living enemies a life loss is never attributed to one item", () => {
	const memory = new EnemyMemory()
	const make = () => makeEnemy({ weapon: pistol, tp: 3, chips: [] })
	memory.identify(make(), 1)
	memory.update(make(), makeMe(100), 1, 2)
	memory.endMyTurn(makeMe(100), 1)
	const result = memory.update(make(), makeMe(82), 2, 2)
	assert.deepEqual(result.hit, { turn: 2, amount: 18, item: null, source: "ambiguous" })
})

test("the hit journal is bounded and keeps the most recent entries", () => {
	const memory = new EnemyMemory()
	const make = () => makeEnemy({ weapon: pistol, tp: 3, chips: [] })
	memory.identify(make(), 1)
	let life = 10_000
	memory.update(make(), makeMe(life), 1)
	memory.endMyTurn(makeMe(life), 1)
	for (let turn = 2; turn <= MAX_HIT_LOG + 11; turn++) {
		life -= 18
		memory.update(make(), makeMe(life), turn)
		memory.endMyTurn(makeMe(life), turn)
	}
	const hits = memory.getProfile(2).hits
	assert.equal(hits.length, MAX_HIT_LOG)
	assert.equal(hits[hits.length - 1].turn, MAX_HIT_LOG + 11)
	assert.equal(hits[0].turn, MAX_HIT_LOG + 11 - MAX_HIT_LOG + 1)
})

/** Monde jouable par le plan conjoint (`helpers/turn-world.mjs`) : ennemi à 4 cases, armé d'un « enemy gun » de portée 0 à 3. */
function makeCombatWorld(enemyId) {
	return makeTurnWorld({
		turnNumber: 1, enemyId, enemyAt: [9, 5], enemyMp: 2, enemyTp: 5,
		enemyWeapon: { id: 90, name: "enemy gun", cost: 3, minRange: 0, maxRange: 3, features: [] }
	})
}

/** Tirs effectués : le plan a joué (deux tirs à 4 PT sur 10 PT), quel que soit le plan retenu pour le reste. */
const shots = (actions) => actions.filter((action) => action === "shoot").length

test("turn() identifies the enemy and the plan still fires", async () => {
	const { turn, leekProfile } = await import("./helpers/joint-turn.mjs")
	const { enemyMemory } = await import("../dist/Brain/TurnObservation.js")
	// Scénario écrit pour les seuils BALANCED (soin, bouclier) ; le rôle par défaut réel est vérifié dans strength-boost-turn.test.mjs.
	leekProfile.setRole("BALANCED")
	const { actions } = makeCombatWorld(2)

	turn()

	assert.equal(shots(actions), 2)
	const profile = enemyMemory.getProfile(2)
	assert.equal(profile.name, "enemy")
	assert.equal(profile.identifiedTurn, 1)
	assert.deepEqual(enemyMemory.observedWeapons(2).map((weapon) => weapon.name), ["enemy gun"])
	assert.equal(enemyMemory.maxKnownWeaponRange(2), 3)
})

test("turn() still plays when the enemy memory fails, and reports the error", async () => {
	const { turn, leekProfile } = await import("./helpers/joint-turn.mjs")
	const { enemyMemory } = await import("../dist/Brain/TurnObservation.js")
	// Scénario écrit pour les seuils BALANCED (soin, bouclier) ; le rôle par défaut réel est vérifié dans strength-boost-turn.test.mjs.
	leekProfile.setRole("BALANCED")
	const { actions, enemy } = makeCombatWorld(3)
	Object.defineProperty(enemy, "launchedEffects", { get() { throw new Error("boom") } })
	debugLogs.length = 0

	turn()

	assert.equal(shots(actions), 2)
	assert.equal(enemyMemory.has(3), true)
	assert.equal(debugLogs.some((entry) => entry.includes("observeEnemies") && entry.includes("boom")), true)
})
