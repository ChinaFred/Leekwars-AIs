import assert from "node:assert/strict"
import test from "node:test"

globalThis.Effect = { DAMAGE: 1, HEAL: 2, BUFF_STRENGTH: 3, BUFF_AGILITY: 4, RELATIVE_SHIELD: 5, ABSOLUTE_SHIELD: 6, BUFF_MP: 7, BUFF_TP: 8 }
const { planBeam, planWithBook } = await import("../dist/Classes/Plannification/BookPlanner.js")
const { OBJECTIVES } = await import("../dist/Classes/Plannification/BookObjective.js")
const { advanceTowardMe, stayStill, futureDangerOf } = await import("../dist/Classes/Plannification/BookEnemyModel.js")
const { TURN_WEIGHTS } = await import("../dist/Classes/Plannification/BookBeam.js")
const { resetBookCache } = await import("../dist/Classes/Plannification/BookCatalog.js")
const { computeReachableCells } = await import("../dist/Classes/Context/ReachableCells.js")
const { ThreatMap } = await import("../dist/Classes/Context/ThreatMap.js")
const { LeekProfile } = await import("../dist/Classes/LeekProfile.js")
const { initLeekLogging, LogConfig } = await import("../dist/Toolbox/Logger.js")

const config = new LogConfig(); config.setAll(false); initLeekLogging(config)

const feature = (type, min, max, turns = 0) => ({ type, minValue: min, maxValue: max, turns, targets: 31, modifiers: 0 })
const gun = () => ({ id: 1, name: "gun", cost: 4, minRange: 1, maxRange: 6, needsLos: false, launchType: 7, maxUses: 3, area: 1, features: [feature(1, 20, 20)] })
const chip = (id, name, cost, cooldown, features, extra = {}) =>
	({ id, name, cost, cooldown, currentCooldown: 0, minRange: 0, maxRange: 6, needsLos: false, launchType: 7, maxUses: -1, area: 1, features, ...extra })
const rock = (cooldown = 3) => chip(10, "rock", 5, cooldown, [feature(1, 40, 40)])
const protein = (turns) => chip(11, "protein", 3, 4, [feature(3, 60, 60, turns)])
const motivation = () => chip(12, "motivation", 2, 6, [feature(8, 4, 4, 3)])
const cure = (heal = 40) => chip(13, "cure", 4, 2, [feature(2, heal, heal)])

/** Grille ouverte 25 x 11 ; `danger(cell)` : carte de danger du jeu ; ennemis : `[x, y, life, extra]`. */
function world({ me: at = [6, 5], tp = 10, mp = 3, life = 300, strength = 0, chips = [], enemies = [[10, 5, 1000]], danger = () => 0, turn = 1, effects = [] } = {}) {
	delete globalThis.System
	resetBookCache()
	const cells = new Map()
	for (let x = 0; x < 25; x++) for (let y = 0; y < 11; y++) cells.set(`${x},${y}`, { id: y * 25 + x, x, y, empty: true, obstacle: false, entity: null })
	globalThis.Field = { cellFromXY: (x, y) => cells.get(`${x},${y}`) ?? null, lineOfSight: () => true }
	const weapon = gun()
	const me = { id: 1, name: "me", level: 25, life, maxLife: 300, mp, tp, strength, magic: 0, agility: 0, wisdom: 0, science: 0, resistance: 0,
		absoluteShield: 0, relativeShield: 0, weapon, weapons: [weapon], chips, effects, launchedEffects: [], cell: cells.get(`${at[0]},${at[1]}`),
		distance(other) { return Math.abs(this.cell.x - other.cell.x) + Math.abs(this.cell.y - other.cell.y) } }
	me.cell.entity = me
	const foes = enemies.map(([x, y, hp, extra = {}], i) => {
		const enemy = { id: 2 + i, name: `enemy${i}`, life: hp, maxLife: hp, mp: 3, tp: 10, weapon: { maxRange: 6 }, weapons: [], chips: [],
			absoluteShield: 0, relativeShield: 0, effects: [], launchedEffects: [], cell: cells.get(`${x},${y}`), ...extra }
		enemy.cell.entity = enemy
		return enemy
	})
	globalThis.Fight = { turn, me, getAliveEnemies: () => foes.filter((e) => e.life > 0), getNearestEnemy: () => foes[0], getEnemies: () => foes, getAllies: () => [me] }
	const reachable = computeReachableCells(me, me.mp, turn)
	const threat = new ThreatMap(me.id, turn, new Map([...reachable.entries()].map(({ cell, cost }) =>
		[cell.x * 4096 + cell.y, { cell, mpCost: cost, danger: danger(cell), breakdown: [] }])),
	{ candidateCells: reachable.size, truncated: false, inputsTruncated: false, enemyCount: foes.length, pairsEvaluated: 0, lineOfSightCalls: 0 })
	const profile = new LeekProfile(); profile.setRole("AGGRESSIVE"); profile.setAggression(50); profile.setSupportOptions(true, true, true)
	return { me, foes, profile, context: { reachable, threat }, cells }
}
const names = (run, step) => step.combo.items.map((i) => run.catalog.book.items[i].ref.name)

test("beam: five distinct plans, scores sorted, two turns", () => {
	const w = world({ chips: [rock(), cure()] })
	const run = planBeam(w.me, w.context, w.profile, { deepen: true, depth: 2 })
	assert.equal(run.result.depth, 2)
	assert.equal(run.result.beam.length, 5)
	assert.equal(new Set(run.result.beam.map((node) => node.key)).size, 5, "clés distinctes")
	assert.deepEqual(run.result.beam.map((n) => n.score), [...run.result.beam.map((n) => n.score)].sort((a, b) => b - a))
	assert.ok(run.result.beam.every((node) => node.steps.length === 2))
	assert.ok(TURN_WEIGHTS[1] < TURN_WEIGHTS[0], "le tour 2 pèse moins que le tour 1")
	assert.ok(run.work > 0)
})

test("sliding horizon: only turn 1 of the best sequence is executed, the plan matches it", () => {
	const w = world({ chips: [rock()] })
	const run = planBeam(w.me, w.context, w.profile, { deepen: true, depth: 2 })
	const plan = planWithBook(w.me, w.context, w.profile, { deepen: true, depth: 2 })
	const first = run.result.best.steps[0]
	assert.equal(run.result.best.steps.length, 2)
	assert.equal(plan.weaponShots, first.combo.weaponShots)
	assert.deepEqual(plan.chips.map((c) => c.name), names(run, first).filter((n) => n !== "gun"))
	assert.equal(plan.destination.id, first.finalCell.id)
	assert.match(plan.searchStatus, /depth 2/)
	assert.equal(plan.tpUsed, first.tpUsed)
})

test("cooldown is propagated: a chip of cooldown 3 cast on turn 1 is not available on turn 2", () => {
	const w = world({ chips: [rock(3)] })
	const run = planBeam(w.me, w.context, w.profile, { deepen: true, depth: 2 })
	let castFirst = 0
	for (const node of run.result.beam) {
		const [one, two] = node.steps.map((step) => names(run, step))
		if (one.includes("rock")) { castFirst++; assert.ok(!two.includes("rock"), "rock indisponible au tour 2") }
	}
	assert.ok(castFirst > 0, "au moins un enchaînement lance rock au tour 1")
	// Cooldown de base 1 : la puce est de nouveau prête au tour suivant.
	const again = planBeam(...(() => { const x = world({ chips: [rock(1)] }); return [x.me, x.context, x.profile, { deepen: true, depth: 2 }] })())
	assert.ok(again.result.beam.some((node) => node.steps.every((step) => names(again, step).includes("rock"))), "rock (cooldown 1) relancé au tour 2")
})

test("boost on the horizon: worth it with two turns of profit, not with one", () => {
	// 10 PT, arme 4 PT x 20 : sans boost 2 tirs = 40 ; boost 3 PT (force +60) : 1 tir à 32 ce tour, mais 2 tirs à 32 = 64 ensuite.
	const first = (turns, depth) => {
		const w = world({ chips: [protein(turns)] })
		return planBeam(w.me, w.context, w.profile, { depth, deepen: true }).result.best.steps[0].boosts.map((b) => b.chip.name)
	}
	assert.deepEqual(first(2, 1), [], "un seul tour simulé : le boost ne rapporte rien de plus")
	assert.deepEqual(first(1, 2), [], "effet d'un seul tour : jamais rentable")
	assert.deepEqual(first(2, 2), ["protein"], "deux tours de profit : booster d'abord")
	assert.deepEqual(first(3, 3), ["protein"])
})

test("boost on the horizon: the PT boost pays at once and its PT are spent", () => {
	const w = world({ chips: [motivation()] })
	const run = planBeam(w.me, w.context, w.profile, { deepen: true, depth: 2 })
	const step = run.result.best.steps[0]
	assert.deepEqual(step.boosts.map((b) => b.chip.name), ["motivation"])
	assert.equal(step.tpGain, 4)
	assert.equal(step.combo.weaponShots, 3, "10 - 2 + 4 = 12 PT : trois tirs")
	assert.equal(planWithBook(w.me, w.context, w.profile, { deepen: true, depth: 2 }).boost.tpGain, 4)
	assert.equal(step.tpUsed, 14, "boost 2 + 3 tirs de 4")
})

test("objectives: unit scores and different choices on the same state", () => {
	const hurt = { damage: 0, heal: 30, shield: 0, exposed: 0, progress: 0, kills: false, won: false, tpSpent: 0, boostsCast: 0 }
	const hit = { ...hurt, heal: 0, damage: 30 }
	const exposed = { ...hit, exposed: 20 }
	assert.ok(OBJECTIVES.damage.score(hit) > OBJECTIVES.damage.score(hurt))
	assert.ok(OBJECTIVES.heal.score(hurt) > OBJECTIVES.heal.score(hit))
	assert.ok(OBJECTIVES.survival.score(exposed) < OBJECTIVES.damage.score(exposed), "la survie pèse plus le danger")
	assert.deepEqual(Object.keys(OBJECTIVES).sort(), ["damage", "heal", "support", "survival"])
	const pick = (objective) => {
		const w = world({ life: 100, chips: [cure(20)], enemies: [[9, 5, 30]], danger: () => 20 })
		return planBeam(w.me, w.context, w.profile, { depth: 1, objective }).result.best.steps[0]
	}
	assert.equal(pick(OBJECTIVES.damage).supports.length, 0, "dégâts : tuer sans soigner")
	assert.equal(pick(OBJECTIVES.heal).supports.length, 1, "soin : cure d'abord")
})

test("survival is a hard rule: a lethal cell is avoided whatever the profile", () => {
	for (const objective of [OBJECTIVES.damage, OBJECTIVES.heal, OBJECTIVES.support, OBJECTIVES.survival]) {
		const w = world({ me: [6, 5], life: 300, chips: [rock()], enemies: [[9, 5, 1000]], danger: (cell) => cell.x <= 3 ? 0 : 400 })
		const step = planBeam(w.me, w.context, w.profile, { depth: 1, objective }).result.best.steps[0]
		assert.equal(step.lethal, false, objective.name)
		assert.equal(step.danger, 0, `${objective.name} : fin sur une case sûre`)
	}
})

test("several enemies: the target is the one that maximizes the score", () => {
	const w = world({ enemies: [[12, 5, 1000], [9, 5, 30]] })
	const step = planBeam(w.me, w.context, w.profile, { depth: 1 }).result.best.steps[0]
	assert.equal(step.target.enemy.id, 3, "l'ennemi à 30 PV, tuable")
	assert.ok(step.outcome.kills)
})

test("enemy hypotheses are replaceable functions", () => {
	const w = world({ enemies: [[10, 5, 100]] })
	const enemy = { cell: w.foes[0].cell, mp: 3 }
	assert.equal(advanceTowardMe(enemy, w.me.cell).x, 7)
	assert.equal(stayStill(enemy, w.me.cell).x, 10)
	const danger = futureDangerOf(new Map([[1 * 4096 + 1, { cell: { x: 1, y: 1 }, danger: 7 }], [9 * 4096 + 9, { cell: { x: 9, y: 9 }, danger: 3 }]]))
	assert.equal(danger({ x: 8, y: 8 }), 3, "case la plus proche")
	const run = (mover) => planBeam(w.me, w.context, w.profile, { deepen: true, depth: 2, mover }).result.best.steps.length
	assert.equal(run(stayStill), 2)
})

test("fallback: no beam on stale or truncated data, so planAct plays", () => {
	const w = world({ chips: [rock()] })
	assert.ok(planWithBook(w.me, w.context, w.profile, { depth: 1 }) !== null)
	const truncated = { ...w.context, threat: Object.assign(Object.create(Object.getPrototypeOf(w.context.threat)), w.context.threat, { truncated: true }) }
	assert.equal(planWithBook(w.me, truncated, w.profile), null)
	assert.equal(planWithBook(w.me, { reachable: null, threat: null }, w.profile), null)
	const dead = world({ enemies: [[10, 5, 0]] })
	assert.equal(planWithBook(dead.me, dead.context, dead.profile), null, "aucun ennemi vivant")
})

test("budget cut: the best COMPLETE plan is kept, never half a plan", () => {
	const w = world({ chips: [rock(), protein(2)] })
	const one = planBeam(w.me, w.context, w.profile, { depth: 1 })
	const two = planBeam(w.me, w.context, w.profile, { deepen: true, depth: 2 })
	assert.ok(two.work > one.work)
	// Coupé pendant le tour 2 : le niveau 2 est abandonné, le tour 1 complet reste.
	const cut = planBeam(w.me, w.context, w.profile, { deepen: true, depth: 2, workLimit: one.work + 1 })
	assert.equal(cut.result.cut, "work limit")
	assert.equal(cut.result.depth, 1)
	assert.equal(cut.result.best.steps.length, 1)
	assert.equal(cut.result.best.steps[0].key, one.result.best.steps[0].key, "même meilleur tour 1")
	const plan = planWithBook(w.me, w.context, w.profile, { deepen: true, depth: 2, workLimit: one.work + 1 })
	assert.match(plan.searchStatus, /cut: work limit/)
	// Coupé pendant le tour 1 : seules des étapes déjà complètes restent ; avant la première, aucun plan (repli planAct).
	const early = planBeam(w.me, w.context, w.profile, { deepen: true, depth: 2, workLimit: 30 })
	if (early.result.best !== null) assert.ok(early.result.best.steps.every((step) => step.combo !== undefined && step.finalCell !== undefined))
	assert.equal(planWithBook(w.me, w.context, w.profile, { workLimit: 1 }), null)
})

test("work units of the beam by width and depth (counted iterations, not game operations)", (t) => {
	const lines = []
	for (const [label, chips] of [["gun + rock + protein + cure", [rock(), protein(2), cure()]], ["gun only", []]]) {
		for (const width of [1, 3, 5]) for (const depth of [1, 2, 3]) {
			const w = world({ chips, enemies: [[12, 5, 1000]], danger: (cell) => Math.abs(cell.x - 12) * 5 })
			const run = planBeam(w.me, w.context, w.profile, { width, depth, deepen: true })
			lines.push(`${label} width ${width} depth ${depth}: ${run.work} beam units + ${run.catalog.book.work} table units, ${run.catalog.book.tablesBuilt} tables, reached depth ${run.result.depth}`)
		}
	}
	t.diagnostic(lines.join("\n"))
	const w = world({ chips: [rock(), protein(2), cure()] })
	assert.ok(planBeam(w.me, w.context, w.profile, { width: 5, deepen: true, depth: 3 }).work < 500000)
})

// --- boost de force posé sans tir (faille B) -------------------------------------------------------------------------------------
const sparkChip = () => chip(20, "spark", 3, 0, [feature(1, 12, 12)], { maxRange: 10 })

test("idle boost: far from the enemy (17), a strength boost is cast when it covers the first expected shot", async () => {
	const { IDLE_BOOST_SHOT_WEIGHT } = await import("../dist/Classes/Plannification/BookBeam.js")
	assert.equal(IDLE_BOOST_SHOT_WEIGHT, 0.75)
	// Distance 17, spark portée 10, mes PM 5, ceux de l'ennemi 3 : premier tir au tour 1 (17 - 5 - 3 - 5 = 4 <= 10) ; protein dure 2 tours
	// (le tour du lancer compte pour 1) : il couvre ce tir.
	const w = world({ me: [2, 5], mp: 5, enemies: [[19, 5, 1000]], chips: [protein(2), sparkChip()] })
	const run = planBeam(w.me, w.context, w.profile, { depth: 1 })
	const step = run.result.best.steps[0]
	assert.deepEqual(step.boosts.map((b) => b.chip.name), ["protein"], "the boost is cast although nothing can be shot this turn")
	assert.equal(step.combo.items.length, 0)
	assert.ok(step.idleCredit > 0)
	assert.equal(run.result.depth, 1)
})

test("idle boost: no credit when the effect ends before the first shot, or when the contact is too far", () => {
	for (const [label, turns, enemy] of [["effect of one turn", 1, [19, 5, 1000]], ["contact too late", 2, [24, 10, 1000]]]) {
		const w = world({ me: [0, 0], mp: 5, enemies: [enemy], chips: [protein(turns), sparkChip()] })
		const step = planBeam(w.me, w.context, w.profile, { depth: 1 }).result.best.steps[0]
		assert.deepEqual(step.boosts, [], label)
		assert.equal(step.idleCredit, 0, label)
	}
})

test("idle boost: with the next turn simulated (depth 2) the credit is not added a second time", () => {
	const w = world({ me: [2, 5], mp: 5, enemies: [[19, 5, 1000]], chips: [protein(2), sparkChip()] })
	const one = planBeam(w.me, w.context, w.profile, { depth: 1 }).result.best
	const w2 = world({ me: [2, 5], mp: 5, enemies: [[19, 5, 1000]], chips: [protein(2), sparkChip()] })
	const two = planBeam(w2.me, w2.context, w2.profile, { depth: 2, deepen: true }).result
	assert.equal(two.depth, 2)
	assert.ok(two.best.score < one.score * 3, "level-2 scores are real simulated damage, not the sum of the estimate")
})

test("idle boost: no credit when a non-lethal shot exists this turn, even a bad one (a boost alone never beats a shot, 55005891 turn 2)", () => {
	// Distance 15, spark portée 10, PM 5 : seul tirer depuis la case 7 est possible, dans une zone de danger 100 (non létal, score -11,6).
	// Sans la garde « aucun tir », le plan « protein seul » reçoit 0,75 x gain (+19,8) et passe devant le repos ; avec elle, aucun score n'est majoré.
	const w = world({ me: [2, 5], mp: 5, enemies: [[17, 5, 1000]], chips: [protein(2), sparkChip()], danger: (c) => (Math.abs(c.x - 17) + Math.abs(c.y - 5) <= 10 ? 100 : 0) })
	const { beam, depth } = planBeam(w.me, w.context, w.profile, { depth: 1 }).result
	assert.equal(depth, 1)
	assert.ok(beam.some((node) => node.steps[0].outcome.damage > 0 && !node.steps[0].lethal), "a non-lethal shot is in the beam")
	assert.ok(beam.some((node) => node.steps[0].idleCredit > 0), "the credit exists but is not applied")
	for (const node of beam) assert.equal(node.score, node.steps[0].score, "no idle credit added")
})

test("boost durations in the archived fight 55005067: protein lasts 2 turns, motivation 3, removed at the start of my turn that follows", async () => {
	const { readFileSync } = await import("node:fs")
	const f = JSON.parse(readFileSync(new URL("../LWGarden/Data/fights/55005067/fight.json", import.meta.url), "utf8"))
	const added = new Map(), removed = []
	let turn = 0, entity = null
	for (const a of f.data.actions) {
		if (a[0] === 6) turn = a[1]
		else if (a[0] === 7) entity = a[1]
		else if (a[0] === 302 && entity === 0 && (a[5] === 38 || a[5] === 32) && a[3] === 0) added.set(a[2], { type: a[5], turns: a[7], turn })
		else if (a[0] === 303 && added.has(a[1])) removed.push({ ...added.get(a[1]), removedTurn: turn, removedBy: entity })
	}
	const protein = removed.filter((r) => r.type === 38)
	assert.ok(protein.length >= 2)
	for (const r of protein) { assert.equal(r.turns, 2); assert.equal(r.removedTurn - r.turn, 2); assert.equal(r.removedBy, 0, "removed in my own turn section") }
})
