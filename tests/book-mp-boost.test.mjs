import assert from "node:assert/strict"
import test from "node:test"

globalThis.Effect = { DAMAGE: 1, HEAL: 2, BUFF_STRENGTH: 3, BUFF_AGILITY: 4, RELATIVE_SHIELD: 5, ABSOLUTE_SHIELD: 6, BUFF_MP: 7, BUFF_TP: 8 }
const { planBeam, planWithBook } = await import("../dist/Classes/Plannification/BookPlanner.js")
const { resetBookCache } = await import("../dist/Classes/Plannification/BookCatalog.js")
const { computeReachableCells } = await import("../dist/Classes/Context/ReachableCells.js")
const { ThreatMap } = await import("../dist/Classes/Context/ThreatMap.js")
const { LeekProfile } = await import("../dist/Classes/LeekProfile.js")
const { initLeekLogging, LogConfig } = await import("../dist/Toolbox/Logger.js")

const config = new LogConfig(); config.setAll(false); initLeekLogging(config)

// Le boost de PM est une VARIANTE du faisceau du livre (comme les boosts de force et de PT) : il est retenu si et seulement si
// l'enchaînement qui le contient score plus haut sur les tours simulés (zone et cases de tir à PM + gain tant que l'effet dure).

const feature = (type, min, max, turns = 0) => ({ type, minValue: min, maxValue: max, turns, targets: 31, modifiers: 0 })
const gun = () => ({ id: 1, name: "gun", cost: 4, minRange: 1, maxRange: 6, needsLos: false, launchType: 7, maxUses: 3, area: 1, features: [feature(1, 20, 20)] })
const chip = (id, name, cost, cooldown, features, extra = {}) =>
	({ id, name, cost, cooldown, currentCooldown: 0, minRange: 0, maxRange: 6, needsLos: false, launchType: 7, maxUses: -1, area: 1, features, ...extra })
// Données du générateur : bottes +2 PM sur 2 tours, 3 PT, délai 5 ; motivation +2 PT sur 3 tours, 4 PT, délai 6.
const boots = (extra = {}) => chip(14, "leather_boots", 3, 5, [feature(7, 2, 2, 2)], extra)
const motivation = (extra = {}) => chip(12, "motivation", 4, 6, [feature(8, 2, 2, 3)], extra)

/** Grille ouverte 31 x 11, moi en (2,5), ennemi `enemyX` sur la même ligne, danger nul. `mpZone: false` : zone boostée indisponible. */
function world({ enemyX = 20, chips = [], mpZone = true, tp = 10, mp = 3 } = {}) {
	delete globalThis.System
	resetBookCache()
	const cells = new Map()
	for (let x = 0; x < 31; x++) for (let y = 0; y < 11; y++) cells.set(`${x},${y}`, { id: y * 31 + x, x, y, empty: true, obstacle: false, entity: null })
	globalThis.Field = { cellFromXY: (x, y) => cells.get(`${x},${y}`) ?? null, lineOfSight: () => true }
	const weapon = gun()
	const me = { id: 1, name: "me", level: 25, life: 300, maxLife: 300, mp, tp, strength: 0, magic: 0, agility: 0, wisdom: 0, science: 0, resistance: 0,
		absoluteShield: 0, relativeShield: 0, weapon, weapons: [weapon], chips, effects: [], launchedEffects: [], cell: cells.get("2,5"),
		distance(other) { return Math.abs(this.cell.x - other.cell.x) + Math.abs(this.cell.y - other.cell.y) } }
	me.cell.entity = me
	const enemy = { id: 2, name: "enemy", life: 1000, maxLife: 1000, mp: 3, tp: 10, weapon: { maxRange: 6 }, weapons: [], chips: [],
		absoluteShield: 0, relativeShield: 0, effects: [], launchedEffects: [], cell: cells.get(`${enemyX},5`) }
	enemy.cell.entity = enemy
	globalThis.Fight = { turn: 1, me, getAliveEnemies: () => [enemy], getNearestEnemy: () => enemy, getEnemies: () => [enemy], getAllies: () => [me] }
	const threatOf = (reachable) => new ThreatMap(me.id, 1, new Map([...reachable.entries()].map(({ cell, cost }) =>
		[cell.x * 4096 + cell.y, { cell, mpCost: cost, danger: 0, breakdown: [] }])),
	{ candidateCells: reachable.size, truncated: false, inputsTruncated: false, enemyCount: 1, pairsEvaluated: 0, lineOfSightCalls: 0 })
	const reachable = computeReachableCells(me, me.mp, 1)
	let zoneCalls = 0
	const context = {
		reachable, threat: threatOf(reachable),
		mpZone: mpZone ? (gain) => { zoneCalls++; const zone = computeReachableCells(me, me.mp + gain, 1); return { reachable: zone, threat: threatOf(zone) } } : () => null
	}
	return { me, context, profile: new LeekProfile(50), zoneCalls: () => zoneCalls }
}
const run = (w, options = {}) => planBeam(w.me, w.context, w.profile, options)
const cast = (step) => step.boosts.map((boost) => boost.chip.name)

test("far enemy: boots on turn 1 because the 3-turn scenario scores higher (first shot a turn earlier)", () => {
	const withBoots = run(world({ chips: [boots()] }))
	const without = run(world(), { deepen: true })
	const best = withBoots.result.best
	assert.equal(withBoots.result.depth, 3, "3 tours évalués sans option : un boost sans tir ouvre les niveaux 2 et 3")
	assert.deepEqual(cast(best.steps[0]), ["leather_boots"])
	assert.equal(best.steps[0].outcome.damage, 0, "aucun tir au tour 1 : les PT du boost ne coûtent aucun tir")
	assert.ok(best.steps[1].outcome.damage > 0, "premier tir au tour 2, effet des bottes encore actif")
	assert.equal(without.result.best.steps[1].outcome.damage, 0, "sans bottes : pas de tir au tour 2")
	assert.ok(best.score > without.result.best.score, `${best.score} > ${without.result.best.score}`)
	// Le scénario sans boost du même faisceau score moins que celui qui le contient.
	const noBoost = withBoots.result.beam.find((node) => node.steps[0].boosts.length === 0)
	if (noBoost !== undefined) assert.ok(noBoost.score < best.score)
	// Le tour 1 : PM gagnés dès le lancer, case de tir au-delà des 3 PM de base.
	assert.ok(best.steps[0].beforeMp + best.steps[0].afterMp > 3 && best.steps[0].beforeMp + best.steps[0].afterMp <= 5)
	assert.equal(best.steps[0].tpUsed, 3)
	// Durée : le tour du lancer compte pour 1, effet retiré au début du tour suivant la durée (2 tours : PM + 2 aux tours 1 et 2).
	assert.deepEqual(best.steps.map((step) => step.plan.state.mp), [3, 5, 3])
	assert.ok(best.steps[1].plan.state.cooldowns.some((cooldown) => cooldown > 0), "délai des bottes suivi")
})

test("the plan carries the MP boost apart from the other boosts: chip, gain, TP", () => {
	const w = world({ chips: [boots()] })
	const plan = planWithBook(w.me, w.context, w.profile, {})
	assert.equal(plan.mpBoost.chip.name, "leather_boots")
	assert.equal(plan.mpBoost.gain, 2)
	assert.equal(plan.boost, undefined)
	assert.equal(plan.tpUsed, 3)
	assert.ok(plan.beforeMp + plan.afterMp > 3, "le plan marche plus loin que mes 3 PM")
	assert.equal(w.zoneCalls(), 1, "zone et danger à PM + gain demandés une seule fois")
})

test("counter-tests: no MP boost when it brings nothing", () => {
	// Ennemi déjà à portée (distance 5) : les 3 PT de la puce coûtent un tir.
	const near = run(world({ chips: [boots()], enemyX: 7 }))
	assert.deepEqual(cast(near.result.best.steps[0]), [])
	assert.equal(planWithBook(...(() => { const w = world({ chips: [boots()], enemyX: 7 }); return [w.me, w.context, w.profile, {}] })()).mpBoost, undefined)
	// Puce en cooldown : jamais lancée, et pas de zone boostée demandée.
	const cooling = world({ chips: [boots({ currentCooldown: 5 })] })
	const coolingRun = run(cooling)
	assert.ok(coolingRun.result.beam.every((node) => node.steps.every((step) => cast(step).length === 0)))
	assert.equal(cooling.zoneCalls(), 0)
	assert.ok(coolingRun.result.depth >= 2, "niveau 2 toujours ouvert, même sans boost")
	// Zone boostée indisponible : repli sur le livre sans boost de PM.
	const noZone = run(world({ chips: [boots()], mpZone: false }))
	assert.deepEqual(cast(noZone.result.best.steps[0]), [])
	// Pas assez de PT : 2 PT, la puce coûte 3.
	const poor = run(world({ chips: [boots()], tp: 2 }))
	assert.deepEqual(cast(poor.result.best.steps[0]), [])
})

test("PT boost without a shot: chosen when the 3-turn scenario justifies it, not when a shot is possible at once", () => {
	// Ennemi à 12 : premier tir au tour 2 ; Motivation (+2 PT par tour d'effet) donne un tir de plus aux tours 2 et 3.
	const far = run(world({ chips: [motivation()], enemyX: 14 }))
	const none = run(world({ enemyX: 14 }), { deepen: true })
	assert.deepEqual(cast(far.result.best.steps[0]), ["motivation"])
	assert.equal(far.result.best.steps[0].outcome.damage, 0)
	assert.ok(far.result.best.steps[1].outcome.damage > none.result.best.steps[1].outcome.damage)
	assert.ok(far.result.best.score > none.result.best.score)
	// Tir possible au tour 1 : le boost coûterait un tir, le niveau 1 suffit.
	const shoots = run(world({ chips: [motivation()], enemyX: 10 }))
	assert.ok(shoots.result.best.steps[0].outcome.damage > 0)
})

test("boots + motivation together on turn 1 when both pay", () => {
	const both = run(world({ chips: [boots(), motivation()], enemyX: 18 }))
	assert.deepEqual(cast(both.result.best.steps[0]).sort(), ["leather_boots", "motivation"])
})
