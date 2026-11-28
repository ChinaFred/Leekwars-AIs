import assert from "node:assert/strict"
import test from "node:test"

globalThis.Effect = { DAMAGE: 1, HEAL: 2, BUFF_STRENGTH: 3, BUFF_AGILITY: 4, RELATIVE_SHIELD: 5, ABSOLUTE_SHIELD: 6, BUFF_MP: 7, BUFF_TP: 8 }
const { CombatBook, SHAPE } = await import("../dist/Classes/Plannification/CombatBook.js")
const { planBeam, planWithBook } = await import("../dist/Classes/Plannification/BookPlanner.js")
const { resetBookCache } = await import("../dist/Classes/Plannification/BookCatalog.js")
const { executeTacticalPlan } = await import("../dist/Classes/Plannification/TacticalExecution.js")
const { weaponSegmentsOf } = await import("../dist/Classes/Plannification/TacticalTypes.js")
const { computeReachableCells } = await import("../dist/Classes/Context/ReachableCells.js")
const { ThreatMap } = await import("../dist/Classes/Context/ThreatMap.js")
const { LeekProfile } = await import("../dist/Classes/LeekProfile.js")
const { initLeekLogging, LogConfig } = await import("../dist/Toolbox/Logger.js")

const config = new LogConfig(); config.setAll(false); initLeekLogging(config)

// --- table : deux armes dans le même tour ------------------------------------------------------------------------

const weaponItem = (hits, cost, uses) => ({ isWeapon: true, hits, cost, minRange: 1, maxRange: 8, needsLos: false, uses, stat: "strength" })
const STATS = { strength: 0, magic: 0 }
const read = (book, q) => book.read(STATS, { distance: 4, los: true, shape: SHAPE.LINE, mask: book.maskOf(() => true), ...q })

test("table: magnum then shotgun beats each weapon alone (held weapon first, 1 PT per swap)", () => {
	// magnum : 3 PT, 30, 2 tirs ; shotgun : 4 PT, 45, 2 tirs. 11 PT, magnum en main :
	// magnum x2 (6) + shotgun x1 (1 + 4) = 11 PT, 105 ; magnum seul 60 ; shotgun seul (1 + 8 = 9 PT) 90.
	const book = new CombatBook([weaponItem([30], 3, 2), weaponItem([45], 4, 2)], 12)
	const combo = read(book, { tp: 11, held: 0 })
	assert.deepEqual([...combo.items], [0, 0, 1], "ordre joué : l'arme en main d'abord, puis le changement")
	assert.equal(combo.total, 105)
	assert.equal(combo.tp, 11)
	assert.equal(combo.weaponShots, 3)
	assert.ok(combo.total > read(book, { tp: 11, held: 0, weapon: 0 }).total && combo.total > read(book, { tp: 11, held: 0, weapon: 1 }).total)
	// Même combo si c'est le shotgun qui est en main : il passe en premier (sinon le remettre coûterait 1 PT de plus).
	assert.deepEqual([...read(book, { tp: 12, held: 1 }).items], [1, 1, 0], "shotgun x2 (8) + magnum (1 + 3) = 12 PT")
})

test("table: the swap cost (1 PT) can forbid the combination, and a single weapon stays when it is optimal", () => {
	const book = new CombatBook([weaponItem([30], 3, 1), weaponItem([30], 3, 1)], 8)
	assert.deepEqual([...read(book, { tp: 7, held: 0 }).items], [0, 1], "arme 0 en main : 3 + 1 + 3 = 7 PT")
	const none = read(book, { tp: 7, held: -1 })
	assert.equal(none.items.length, 1, "rien en main : deux changements = 8 PT > 7, une arme seule")
	assert.equal(none.total, 30)
	assert.deepEqual([...read(book, { tp: 8, held: -1 }).items], [0, 1], "8 PT : les deux changements passent")
	// Une seule arme optimale (la seconde est hors portée) : même combo qu'avant.
	const short = new CombatBook([weaponItem([30], 3, 2), { ...weaponItem([99], 3, 2), maxRange: 2 }], 11)
	assert.deepEqual([...read(short, { tp: 11, held: 0 }).items], [0, 0], "arme 1 hors portée à 4 : arme 0 seule")
})

// --- faisceau et exécution -----------------------------------------------------------------------------------------

const feature = (min, max) => ({ type: 1, minValue: min, maxValue: max, turns: 0, targets: 31, modifiers: 0 })
const gun = (id, name, cost, dmg, uses) =>
	({ id, name, cost, minRange: 1, maxRange: 8, needsLos: false, launchType: 7, maxUses: uses, area: 1, features: [feature(dmg, dmg)] })

/** Grille ouverte, moi en (6,5), ennemi en (10,5) (distance 4), `held` en main ; `events` : équiper et tirer, PT décomptés. */
function world({ tp, held, weapons }) {
	delete globalThis.System
	resetBookCache()
	const cells = new Map()
	for (let x = 0; x < 25; x++) for (let y = 0; y < 11; y++) cells.set(`${x},${y}`, { id: y * 25 + x, x, y, empty: true, obstacle: false, entity: null })
	globalThis.Field = { cellFromXY: (x, y) => cells.get(`${x},${y}`) ?? null, lineOfSight: () => true }
	const events = []
	const me = { id: 1, name: "me", level: 25, life: 300, maxLife: 300, mp: 0, tp, strength: 0, magic: 0, agility: 0, wisdom: 0, science: 0, resistance: 0,
		absoluteShield: 0, relativeShield: 0, effects: [], launchedEffects: [], weapon: held, weapons, chips: [], cell: cells.get("6,5"),
		distance(other) { return Math.abs(this.cell.x - other.cell.x) + Math.abs(this.cell.y - other.cell.y) },
		setWeapon(w) { this.tp -= 1; this.weapon = w; events.push(`equip:${w.name}`); return 1 },
		canUseWeapon() { return true },
		useWeapon(target) { this.tp -= this.weapon.cost; target.life -= 30; events.push(`shoot:${this.weapon.name}`); return 2 } }
	me.cell.entity = me
	const enemy = { id: 2, name: "enemy", life: 1000, maxLife: 1000, mp: 3, tp: 10, weapon: { maxRange: 6 }, weapons: [], chips: [], absoluteShield: 0,
		relativeShield: 0, effects: [], launchedEffects: [], cell: cells.get("10,5") }
	enemy.cell.entity = enemy
	globalThis.Fight = { turn: 1, me, getAliveEnemies: () => [enemy], getNearestEnemy: () => enemy, getEnemies: () => [enemy], getAllies: () => [me] }
	const reachable = computeReachableCells(me, me.mp, 1)
	const threat = new ThreatMap(me.id, 1, new Map([...reachable.entries()].map(({ cell, cost }) =>
		[cell.x * 4096 + cell.y, { cell, mpCost: cost, danger: 0, breakdown: [] }])),
	{ candidateCells: reachable.size, truncated: false, inputsTruncated: false, enemyCount: 1, pairsEvaluated: 0, lineOfSight: 0 })
	return { me, enemy, events, context: { reachable, threat }, profile: new LeekProfile(50) }
}

test("beam and plan: two weapons in the same turn, executed in order with the swap", () => {
	const magnum = gun(1, "magnum", 3, 30, 1), shotgun = gun(2, "shotgun", 3, 30, 1)
	const w = world({ tp: 7, held: magnum, weapons: [magnum, shotgun] })
	const plan = planWithBook(w.me, w.context, w.profile, { deepen: false })
	assert.deepEqual(weaponSegmentsOf(plan).map((s) => [s.weapon.name, s.shots]), [["magnum", 1], ["shotgun", 1]])
	assert.equal([plan.weapon.name, plan.weaponShots, plan.tpUsed].join(), "magnum,2,7")
	executeTacticalPlan(w.me, plan)
	assert.deepEqual(w.events, ["shoot:magnum", "equip:shotgun", "shoot:shotgun"], "arme en main d'abord, changement, puis la suivante")
	assert.equal(w.me.tp, 0)
})

test("beam and plan: the swap cost keeps a single weapon when nothing is held and 7 PT are available", () => {
	const magnum = gun(1, "magnum", 3, 30, 1), shotgun = gun(2, "shotgun", 3, 30, 1)
	const w = world({ tp: 7, held: null, weapons: [magnum, shotgun] })
	const run = planBeam(w.me, w.context, w.profile, { deepen: false })
	const first = run.result.best.steps[0]
	assert.equal(first.combo.weaponShots, 1, "2 changements + 2 tirs = 8 PT > 7")
	const rich = world({ tp: 8, held: null, weapons: [magnum, shotgun] })
	assert.equal(planBeam(rich.me, rich.context, rich.profile, { deepen: false }).result.best.steps[0].combo.weaponShots, 2)
})

test("execution: an interrupted first segment stops the second weapon", () => {
	const magnum = gun(1, "magnum", 3, 30, 1), shotgun = gun(2, "shotgun", 3, 30, 1)
	const w = world({ tp: 7, held: magnum, weapons: [magnum, shotgun] })
	const plan = planWithBook(w.me, w.context, w.profile, { deepen: false })
	w.me.useWeapon = () => { w.events.push("shoot:refused"); return 0 }
	executeTacticalPlan(w.me, plan)
	assert.deepEqual(w.events, ["shoot:refused"], "tir refusé : pas de changement d'arme (1 PT) ni de second tir")
})
