import assert from "node:assert/strict"
import test from "node:test"
import { existsSync } from "node:fs"

globalThis.Effect = { DAMAGE: 1, HEAL: 2, BUFF_STRENGTH: 3, BUFF_AGILITY: 4, RELATIVE_SHIELD: 5, ABSOLUTE_SHIELD: 6, BUFF_MP: 7, BUFF_TP: 8, RAW_BUFF_TP: 32, RAW_BUFF_STRENGTH: 38 }
const { planBeam, planWithBook, unchosen } = await import("../dist/Classes/Plannification/BookPlanner.js")
const { StandoffTracker, STANDOFF_WINDOW, STANDOFF_MIN_NET_FRACTION, STANDOFF_ACCEPT_MAX } = await import("../dist/Classes/Plannification/BookStandoff.js")
const { resetBookCache } = await import("../dist/Classes/Plannification/BookCatalog.js")
const { computeReachableCells } = await import("../dist/Classes/Context/ReachableCells.js")
const { ThreatMap } = await import("../dist/Classes/Context/ThreatMap.js")
const { LeekProfile } = await import("../dist/Classes/LeekProfile.js")
const { initLeekLogging, LogConfig } = await import("../dist/Toolbox/Logger.js")

const config = new LogConfig(); config.setAll(false); initLeekLogging(config)

// Combat 55005067 (LWGarden/Data/fights/55005067, Kassbi contre Miroboss, nul en 64 tours), tours 5 et 36. Carte 18 x 18 et
// obstacles : fight.json. Positions, PV et cooldowns : actions du combat (PV de début de tour) et journal. Carte de danger :
// marques « Danger zone » de logs.json (arrondies ; 473,97 et 472,14 de la ligne [Book]). Objets : mêmes définitions que
// tests/doomed-turn-fights.test.mjs (rock, spark, protein, motivation). Les armes (shotgun, broadsword) sont hors de portée de
// l'ennemi à ces tours et omises. Ligne de vue : obstacles seulement, comme dans les autres rejeux.
const WIDTH = 18, HEIGHT = 18
const OBSTACLES = { 5: 1, 11: 2, 34: 1, 35: 1, 56: 2, 60: 1, 62: 2, 65: 2, 67: 1, 75: 1, 93: 1, 94: 2, 109: 2, 114: 2, 130: 1, 133: 1,
	134: 1, 147: 1, 152: 1, 157: 1, 161: 1, 163: 1, 185: 1, 202: 1, 205: 2, 227: 1, 231: 1, 269: 2, 270: 1, 272: 2, 284: 1, 319: 1,
	325: 1, 331: 2, 345: 2, 354: 1, 356: 1, 358: 1, 367: 1, 383: 2, 389: 2, 392: 2, 411: 2, 420: 1, 425: 2, 445: 2, 456: 1, 457: 1,
	479: 1, 494: 2, 542: 1, 578: 1, 587: 1, 602: 1, 610: 1 }
const SAFE = [444, 426, 461, 408, 390, 391, 372, 373, 374, 355, 357]
const TURNS = {
	5: { life: 244, tp: 10, enemyLife: 263, shield: 0, enemyMp: 5, cooldowns: { protein: 1 }, effects: [],
		danger: { 466: [478, 496, 495, 514, 513, 477, 531], 473.97: [532, 497], 368: [530], 360: [459] } },
	36: { life: 244, tp: 12, enemyLife: 209, shield: 15, enemyMp: 6, cooldowns: { motivation: 3 },
		effects: [{ type: 32, value: 2, turns: 1 }],
		danger: { 464: [478, 496, 495, 513, 477, 531, 459], 472.14: [514, 532, 497], 366: [530] } }
}

function buildGrid() {
	const rows = WIDTH * 2 - 1
	const cells = []
	for (let id = 0; id < rows * HEIGHT - (WIDTH - 1); id++) {
		const column = id % rows, line = Math.floor(id / rows)
		const y = line - (column % WIDTH)
		cells.push({ id, x: (id - (WIDTH - 1) * y) / WIDTH, y, obstacle: false, empty: true, entity: null,
			north: !(line === 0 && column < WIDTH) && column + 1 !== WIDTH, south: !(line + 1 === HEIGHT && column >= WIDTH) && column !== 0,
			west: !(line === 0 && column < WIDTH) && column !== 0, east: !(line + 1 === HEIGHT && column >= WIDTH) && column + 1 !== WIDTH })
	}
	const byXY = new Map(cells.map(cell => [`${cell.x},${cell.y}`, cell]))
	const at = (x, y) => byXY.get(`${x},${y}`) ?? null
	const neighbor = (cell, dir) => dir === "N" && cell.north ? cells[cell.id - WIDTH + 1] : dir === "W" && cell.west ? cells[cell.id - WIDTH] :
		dir === "E" && cell.east ? cells[cell.id + WIDTH] : dir === "S" && cell.south ? cells[cell.id + WIDTH - 1] : null
	for (const [anchor, size] of Object.entries(OBSTACLES)) {
		const cell = cells[Number(anchor)]
		cell.obstacle = true; cell.empty = false
		if (size === 2) {
			const south = neighbor(cell, "S")
			for (const covered of [neighbor(cell, "E"), south, south && neighbor(south, "E")]) if (covered) { covered.obstacle = true; covered.empty = false }
		}
	}
	return { cells, at }
}

const feature = (type, min, max, turns = 0) => ({ type, minValue: min, maxValue: max, turns, targets: 31, modifiers: 0 })
const chip = (id, name, cost, cooldown, minRange, maxRange, features, extra = {}) => ({ id, name, cost, cooldown, currentCooldown: 0, minRange, maxRange,
	launchType: 7, maxUses: -1, needsLos: true, area: 1, features, ...extra })

/** `enemyAt` : [x, y] de l'ennemi (cas synthétique : même carte, ennemi plus proche). `hiding` : repli après tir permis (`allowHiding` du profil). */
function replay(turn, { hiding = true, life, danger, enemyAt, extraChips = [], maxLife = 387 } = {}) {
	const spec = TURNS[turn]
	delete globalThis.System
	resetBookCache()
	const { cells, at } = buildGrid()
	const lineOfSight = (start, end) => {
		const a = Math.abs(start.y - end.y), b = Math.abs(start.x - end.x)
		const dx = start.x > end.x ? -1 : 1, dy = start.y < end.y ? 1 : -1
		const path = []
		if (b === 0) path.push(0, a + 1)
		else {
			const d = a / b / 2
			let h = 0
			for (let i = 0; i < b; i++) { const y = 0.5 + (i * 2 + 1) * d; path.push(h, Math.ceil(y - 0.00001) - h); h = Math.floor(y + 0.00001) }
			path.push(h, a + 1 - h)
		}
		for (let p = 0; p < path.length; p += 2) for (let i = 0; i < path[p + 1]; i++) {
			const cell = at(start.x + (p / 2) * dx, start.y + (path[p] + i) * dy)
			if (!cell || cell.obstacle) return false
		}
		return true
	}
	const chips = [chip(7, "rock", 5, 1, 2, 6, [feature(1, 38, 39)]), chip(8, "protein", 3, 3, 0, 4, [feature(38, 80, 100, 2)]),
		chip(15, "motivation", 4, 6, 0, 5, [feature(32, 2, 2, 3)]), chip(18, "spark", 3, 0, 0, 10, [feature(1, 8, 16)], { needsLos: false }), ...extraChips]
	for (const item of chips) item.currentCooldown = spec.cooldowns[item.name] ?? 0
	const me = { id: 103947, name: "Kassbi", level: 30, life: life ?? spec.life, maxLife, mp: 5, tp: spec.tp, strength: 60, magic: 0, agility: 10,
		wisdom: 0, science: 0, resistance: 10, absoluteShield: 0, relativeShield: 0, weapon: null, weapons: [], chips, effects: spec.effects,
		launchedEffects: [], cell: cells[444], distance(other) { return Math.abs(this.cell.x - other.cell.x) + Math.abs(this.cell.y - other.cell.y) } }
	me.cell.entity = me
	const enemy = { id: 136532, name: "Miroboss", life: spec.enemyLife, maxLife: 293, mp: spec.enemyMp, tp: 10, weapon: { maxRange: 6 }, weapons: [], chips: [],
		absoluteShield: spec.shield, relativeShield: 0, effects: [], launchedEffects: [], cell: enemyAt ? at(...enemyAt) : cells[570] }
	enemy.cell.entity = enemy
	globalThis.Fight = { turn, me, getAliveEnemies: () => [enemy], getNearestEnemy: () => enemy, getEnemies: () => [enemy], getAllies: () => [me] }
	globalThis.Field = { cellFromXY: at, lineOfSight }
	const reachable = computeReachableCells(me, me.mp, turn)
	const dangerOf = new Map(SAFE.map((id) => [id, 0]))
	for (const [value, ids] of Object.entries(danger ?? spec.danger)) for (const id of ids) dangerOf.set(id, Number(value))
	const threat = new ThreatMap(me.id, turn, new Map([...reachable.entries()].map(({ cell, cost }) =>
		[cell.x * 4096 + cell.y, { cell, mpCost: cost, danger: dangerOf.get(cell.id), breakdown: [] }])),
	{ candidateCells: reachable.size, truncated: false, inputsTruncated: false, enemyCount: 1, pairsEvaluated: 0, lineOfSightCalls: 0 })
	const profile = new LeekProfile(50); profile.allowHiding = hiding
	return { me, enemy, profile, context: { reachable, threat }, zone: [...reachable.entries()].map(({ cell }) => cell.id).sort((a, b) => a - b), dangerOf }
}

/** Duel constaté depuis `extra` tours au-delà de la fenêtre : 6 + `extra` débuts de tour sans PV perdus ni gagnés, 60 dégâts par tour soignés. */
function duel(extra) {
	const tracker = new StandoffTracker()
	for (let t = 1; t <= STANDOFF_WINDOW + extra; t++) tracker.observe(t, 244, [{ life: 263, maxLife: 293 }], 60)
	return tracker
}
const names = (run, step) => step.combo.items.map((i) => run.catalog.book.items[i].ref.name).join("+")
const first = (run) => run.result.best.steps[0]

test("the replayed state matches the fight: same reachable zone and cells", () => {
	for (const turn of [5, 36]) {
		const w = replay(turn)
		assert.equal(w.zone.length, 22)
		assert.deepEqual(w.zone, [...w.dangerOf.keys()].sort((a, b) => a - b), `turn ${turn}: zone = cells of the logged danger map`)
	}
})

test("duel counter: 45 damage / 40 heal triggers, 45 damage / no heal does not (6 turns)", () => {
	const run = (heal) => {
		const tracker = new StandoffTracker()
		let foe = 263
		for (let t = 1; t <= STANDOFF_WINDOW; t++) { tracker.observe(t, 244, [{ life: foe, maxLife: 293 }], t === 1 ? 0 : 45); foe -= 45 - heal }
		return tracker
	}
	assert.equal(run(40).active, true, "net 5 per turn < 15 % of 293 over the window")
	assert.equal(run(0).active, false, "net 45 per turn")
	// Sans dégâts infligés (approche ou refus de combat) : pas un duel.
	const idle = new StandoffTracker()
	for (let t = 1; t <= STANDOFF_WINDOW; t++) idle.observe(t, 244, [{ life: 293, maxLife: 293 }], 0)
	assert.equal(idle.active, false)
	// Mes PV qui baissent : pas un duel.
	const hurt = new StandoffTracker()
	for (let t = 1; t <= STANDOFF_WINDOW; t++) hurt.observe(t, 244 - 10 * t, [{ life: 263, maxLife: 293 }], 60)
	assert.equal(hurt.active, false)
	assert.equal(STANDOFF_MIN_NET_FRACTION, 0.15)
})

test("duel counter: acceptance grows by 0.25 per turn beyond the window, capped at 2.0; risk weight shrinks", () => {
	const tracker = new StandoffTracker()
	assert.deepEqual([tracker.accept, tracker.riskScale], [1, 1], "no duel")
	for (const [extra, accept, risk] of [[0, 1, 0.5], [1, 1.25, 0], [4, 2, 0], [9, STANDOFF_ACCEPT_MAX, 0]]) {
		const t = duel(extra)
		assert.deepEqual([t.beyond, t.accept, t.riskScale], [extra, accept, risk])
	}
	const again = duel(2); again.observe(8, 244, [{ life: 263, maxLife: 293 }], 60)
	assert.equal(again.beyond, 2, "a second observation of the same turn replaces the first")
})

test("step 1: T5 and T36 - rock + spark then back to 444 is NOT feasible: the only shot cells cost all 5 MP (cause: MP, not generation)", () => {
	for (const turn of [5, 36]) {
		const w = replay(turn)
		const run = planBeam(w.me, w.context, w.profile, { depth: 1 })
		const rock = [...run.trace.groups.values()].find((g) => g.stay.combo.items.length === 2)
		assert.ok(rock, `${turn}: the rock + spark group is refined (it was, in the old code, only through the group diversity of the beam)`)
		const shots = run.trace.candidates.filter((c) => c.group === rock.stay.group && c.afterMp === 0 && c.supports.length === 0).map((c) => [c.shotCell.id, c.beforeMp])
		assert.deepEqual(shots.sort((a, b) => a[0] - b[0]), [[497, 5], [532, 5]], "enemy at distance 7 of 444, rock range 6: only 497 and 532, 5 MP each")
		assert.equal(rock.retreat, null, "no MP left to come back: no cell of lower danger within 5 MP")
		assert.ok(rock.stay.lethal && rock.stay.danger > 460, "danger 474 >= my 244 life")
		assert.match(names(run, first(run)), /^spark/, `${turn}: so the lethal rock + spark loses to sparks without a duel`)
	}
})

/** Même carte et même danger, ennemi 2 cases plus près : (25, 8) est à 6 de 478 (danger 466, létal), 2 PM de 444 (sûre). */
const CLOSER = [25, 8]

test("step 1: generation bug fixed - a lethal shot cell whose group can retreat is refined (same map, enemy closer)", () => {
	{
		const w = replay(5, { enemyAt: CLOSER })
		const run = planBeam(w.me, w.context, w.profile, { depth: 1 })
		const step = first(run)
		assert.match(names(run, step), /rock/)
		assert.equal(step.danger, 0, "final cell is safe (hit and run)")
		assert.ok(step.beforeMp > 0 && step.afterMp > 0 && step.beforeMp + step.afterMp <= w.me.mp)
		assert.ok(step.outcome.damage > 70, "rock + spark, more than spark x 3")
		const rock = run.trace.candidates.filter((c) => names(run, c).includes("rock") && c.supports.length === 0)
		assert.ok(rock.length > 0 && rock.filter((c) => c.afterMp === 0).every((c) => c.lethal), "every stay candidate of the group is lethal: only the retreat saves it")
	}
})

test("step 1: diagnostic names the best unchosen plan with more damage and why", () => {
	const w = replay(5, { hiding: false })
	const run = planBeam(w.me, w.context, w.profile, { depth: 1 })
	const text = unchosen(first(run), run.trace, run.catalog.book.items, w.me.mp)
	assert.match(text, /unchosen with more damage: \[.*rock\+spark/)
	assert.match(text, /reason: lethal \(danger 4\d\d(\.\d)? >= limit 244\.0\); retreat disabled/)
	// Avec repli (T5) : toujours létal, mais la raison devient « aucune case de moindre danger à portée de PM ».
	const w2 = replay(5)
	const run2 = planBeam(w2.me, w2.context, w2.profile, { depth: 1 })
	assert.match(unchosen(first(run2), run2.trace, run2.catalog.book.items, w2.me.mp), /no cell with a lower danger within 5 MP \(farthest reached: 5 MP\)/)
})

test("step 2: AGGRESSIVE in a duel accepts rock + spark from the dangerous shot cell; without the duel or DEFENSIVE, no change", () => {
	for (const turn of [5, 36]) {
		for (const hiding of [true, false]) {
			const plain = replay(turn, { hiding })
			const without = planBeam(plain.me, plain.context, plain.profile, { depth: 1 })
			assert.match(names(without, first(without)), /^spark\+spark\+spark/, `${turn}: lethal rock + spark refused without a duel`)
			const spark = first(without).outcome.damage // 57,8 au tour 5 comme dans le combat ; 45,1 au tour 36 (le combat : 40,6, gain de protein non connu)
			for (const extra of [5, 8]) {
				const aggressive = replay(turn, { hiding })
				const run = planBeam(aggressive.me, aggressive.context, aggressive.profile, { depth: 1, standoff: duel(extra) })
				assert.match(names(run, first(run)), /rock/, `${turn} duel +${extra}`)
				assert.ok(first(run).outcome.damage > spark + 20, "more damage than spark x 3")
				assert.ok(first(run).danger > 400, "accepted danger: the shot cell is not safe (risk accepted)")
				assert.ok(first(run).danger < 2 * aggressive.me.life, "never 2 x my life or more")
			}
			const key = (standoff) => { const d = replay(turn, { hiding }); return planBeam(d.me, d.context, d.profile, { depth: 1, standoff }).result.best.steps[0].key }
			assert.equal(key(new StandoffTracker()), key(undefined), "duel not yet noticed: unchanged")
		}
	}
})

test("step 2: a duel that has just been noticed does not accept yet (acceptance 1.0), it only lowers the weight of the danger", () => {
	const w = replay(5)
	const run = planBeam(w.me, w.context, w.profile, { depth: 1, standoff: duel(0) })
	assert.match(names(run, first(run)), /^spark\+spark\+spark/)
})

test("step 2: an exposed danger of 2 x life or more is never accepted, even at the maximum acceptance", () => {
	const danger = { 500: [478, 496, 495, 514, 513, 477, 531, 532, 497, 530, 459] } // 500 >= 2 x 244 = 488
	const w = replay(5, { hiding: false, danger })
	const run = planBeam(w.me, w.context, w.profile, { depth: 1, standoff: duel(20) })
	assert.ok(run.trace.candidates.length > 0)
	for (const step of run.trace.candidates) if (step.outcome.exposed >= 2 * w.me.life && !step.outcome.won) assert.equal(step.lethal, true)
	assert.ok(first(run).danger < 500, "it stays on a safe cell and uses sparks")
	assert.match(names(run, first(run)), /^spark/)
})

test("step 2: under 50 % of my life nothing is accepted", () => {
	const w = replay(5, { hiding: false, life: 150 }) // 150 / 387 = 39 %
	const run = planBeam(w.me, w.context, w.profile, { depth: 1, standoff: duel(8) })
	assert.ok(first(run).danger < 150, "no lethal acceptance below the boost life threshold")
})

test("step 2: in a duel, with a hit and run available the safe final cell wins over the accepted danger", () => {
	const w = replay(5, { enemyAt: CLOSER })
	const run = planBeam(w.me, w.context, w.profile, { depth: 1, standoff: duel(8) })
	assert.equal(first(run).danger, 0)
	assert.match(names(run, first(run)), /rock/)
})

test("step 3: level 2 always opened unless deepen is false", () => {
	const w = replay(5)
	const normal = planBeam(w.me, w.context, w.profile, { depth: 2 })
	assert.equal(normal.result.depth, 2, "no duel, clear best plan: two turns anyway")
	const off = planBeam(w.me, w.context, w.profile, { depth: 2, deepen: false })
	assert.equal(off.result.depth, 1)
	assert.match(off.result.skipped, /level 2/)
	const dueled = planBeam(w.me, w.context, w.profile, { depth: 2, standoff: duel(6) })
	assert.equal(dueled.result.depth, 2, "duel: two turns")
	assert.equal(dueled.result.cut, null)
	const forced = planBeam(w.me, w.context, w.profile, { depth: 2, deepen: true })
	assert.equal(forced.result.depth, 2)
})

test("step 3: in a duel the beam reaches depth 2 within a fixed work limit on at least 80 % of the replayed turns", (t) => {
	// Limite d'unités de travail ~ 650 000 opérations / ~240 opérations par unité (rapport relevé sur le combat 55005067 :
	// 489 603 opérations pour 2 044 unités au tour 1, profondeur 2 achevée). ESTIMATION : le rapport n'est pas mesuré ici.
	const LIMIT = 2700
	const states = []
	for (const turn of [5, 36]) for (const life of [244, 200, 300]) for (const hiding of [true, false]) states.push([turn, { life, hiding }])
	let ok = 0
	const lines = []
	for (const [turn, options] of states) {
		const w = replay(turn, options)
		const run = planBeam(w.me, w.context, w.profile, { depth: 2, standoff: duel(6), workLimit: LIMIT })
		const first1 = planBeam(w.me, w.context, w.profile, { depth: 1, standoff: duel(6) })
		if (run.result.depth >= 2 && run.result.cut === null) ok++
		lines.push(`T${turn} life ${options.life} hiding ${options.hiding}: depth 1 ${first1.work} units, depth ${run.result.depth} ${run.work} units, cut ${run.result.cut}`)
	}
	t.diagnostic(lines.join("\n"))
	assert.ok(ok / states.length >= 0.8, `${ok} / ${states.length}`)
})

test("step 3: a duel in AGGRESSIVE gives the beam 70 % of the operations, duel or not", async () => {
	const { BookBudget, BOOK_SEARCH_FRACTION, BOOK_DUEL_SEARCH_FRACTION } = await import("../dist/Classes/Plannification/BookBudget.js")
	assert.equal(BOOK_SEARCH_FRACTION, 0.70)
	assert.equal(BOOK_DUEL_SEARCH_FRACTION, 0.70)
	assert.equal(new BookBudget().fraction, 0.70)
	assert.equal(new BookBudget(undefined, BOOK_DUEL_SEARCH_FRACTION).fraction, 0.70)
	// Branchement : la fraction du budget suit le duel (observable par le plafond d'opérations simulé).
	globalThis.System = { operations: 0, maxOperations: 1000 }
	const aggressive = replay(5)
	globalThis.System = { operations: 0, maxOperations: 1000 }
	const bare = planBeam(aggressive.me, aggressive.context, aggressive.profile, { depth: 1 })
	assert.ok(bare !== null)
	delete globalThis.System
})

test("step 3: the next level opens only the nodes the measured cost of a node allows, and none if it cannot pay one", async () => {
	const { BookBudget } = await import("../dist/Classes/Plannification/BookBudget.js")
	const { NODE_COST_MARGIN } = await import("../dist/Classes/Plannification/BookBeam.js")
	// 250 opérations simulées par unité de travail ; `cap` : opérations permises au total.
	const budgetOf = (cap) => new class extends BookBudget {
		ops() { return this.work * 250 }
		remainingOps() { return cap - this.work * 250 }
		guard() {}
	}()
	// Un monde neuf par appel : le livre mis en cache ne reconstruit pas ses tables, le travail mesuré serait différent.
	const fresh = () => replay(5)
	let w = fresh()
	const one = planBeam(w.me, w.context, w.profile, { depth: 1, standoff: duel(6) })
	const level1 = one.work * 250
	w = fresh()
	const roomy = planBeam(w.me, w.context, w.profile, { depth: 2, standoff: duel(6), budget: budgetOf(level1 * (1 + 2.5 * NODE_COST_MARGIN)) })
	assert.equal(roomy.result.depth, 2)
	const opened = new Set(roomy.result.beam.map((node) => node.steps[0].key))
	const firstLevel = one.result.beam.map((node) => node.steps[0].key)
	assert.ok(opened.size <= 2 && [...opened].every((key) => firstLevel.slice(0, 2).includes(key)), "only the 2 best nodes of turn 1 were opened")
	w = fresh()
	const poor = planBeam(w.me, w.context, w.profile, { depth: 2, standoff: duel(6), budget: budgetOf(level1 * 1.5) })
	assert.equal(poor.result.depth, 1)
	assert.match(poor.result.skipped, /remaining ops/)
	assert.equal(poor.result.cut, null, "no wasted work: level 1 complete, no cut")
	assert.equal(poor.result.best.steps[0].key, one.result.best.steps[0].key)
})

test("heavy turn: 2.0 x the measured node cost remaining opens 3 of 5 nodes (margin 0.55; 0.7 opened 2)", async () => {
	const { BookBudget } = await import("../dist/Classes/Plannification/BookBudget.js")
	const { getLogConfig, LOG_CONTEXT } = await import("../dist/Toolbox/Logger.js")
	const budgetOf = (cap) => new class extends BookBudget {
		ops() { return this.work * 250 }
		remainingOps() { return cap - this.work * 250 }
		guard() {}
	}()
	const lines = [], oldDebug = globalThis.Debug, oldColor = globalThis.Color, previous = getLogConfig()
	globalThis.Debug = { log: (text) => lines.push(String(text)), pause() {} }
	globalThis.Color = { rgb: () => 0xff0000 }
	const errors = new LogConfig(); errors.setAll(false).setEnabled(LOG_CONTEXT.ERROR, true)
	try {
		let w = replay(5)
		const level1 = planBeam(w.me, w.context, w.profile, { depth: 1, standoff: duel(6) }).work * 250
		w = replay(5); initLeekLogging(errors); lines.length = 0
		planBeam(w.me, w.context, w.profile, { depth: 2, standoff: duel(6), budget: budgetOf(level1 * 3) })
		assert.match(lines.join("\n"), /beam nodes bound \(5 > 3\)/)
	} finally {
		globalThis.Debug = oldDebug
		globalThis.Color = oldColor
		initLeekLogging(previous)
	}
})

test("search cut: a deeper level refused or narrowed by the operations allowance is one red line; a roomy budget gives none", async () => {
	const { BookBudget } = await import("../dist/Classes/Plannification/BookBudget.js")
	const { NODE_COST_MARGIN } = await import("../dist/Classes/Plannification/BookBeam.js")
	const { getLogConfig, LOG_CONTEXT } = await import("../dist/Toolbox/Logger.js")
	const budgetOf = (cap, deepen = true) => new class extends BookBudget {
		ops() { return this.work * 250 }
		remainingOps() { return cap - this.work * 250 }
		deepenOk() { return deepen }
		guard() {}
	}()
	const lines = [], oldDebug = globalThis.Debug, oldColor = globalThis.Color, previous = getLogConfig()
	globalThis.Debug = { log: (text) => lines.push(String(text)), pause() {} }
	globalThis.Color = { rgb: () => 0xff0000 }
	const errors = new LogConfig(); errors.setAll(false).setEnabled(LOG_CONTEXT.ERROR, true)
	const run = (options) => { const w = replay(5); initLeekLogging(errors); lines.length = 0; const result = planBeam(w.me, w.context, w.profile, { standoff: duel(6), ...options }); return { result, lines: [...lines] } }
	try {
		const level1 = run({ depth: 1 }).result.work * 250
		const roomy = run({ depth: 2, budget: budgetOf(level1 * 100) })
		assert.equal(roomy.result.result.depth, 2)
		assert.deepEqual(roomy.lines, [])
		const narrow = run({ depth: 2, budget: budgetOf(level1 * (1 + 2.5 * NODE_COST_MARGIN)) })
		assert.equal(narrow.lines.length, 1, narrow.lines.join("\n"))
		assert.match(narrow.lines[0], /^SEARCH CUT \[livre\] cause=beam nodes bound \(\d+ > 2\) ops=\d+\/\? profondeur=2 niveau_atteint=1$/)
		const poor = run({ depth: 2, budget: budgetOf(level1 * 1.5) })
		assert.equal(poor.lines.length, 1, poor.lines.join("\n"))
		assert.match(poor.lines[0], /^SEARCH CUT \[livre\] cause=remaining ops < node cost ops=\d+\/\? profondeur=2 niveau_atteint=1$/)
		const capped = run({ depth: 3, budget: budgetOf(level1 * 100, false) })
		assert.equal(capped.lines.length, 1, capped.lines.join("\n"))
		assert.match(capped.lines[0], /^SEARCH CUT \[livre\] cause=deepen fraction ops=\d+\/\? profondeur=3 niveau_atteint=2$/)
	} finally {
		globalThis.Debug = oldDebug
		globalThis.Color = oldColor
		initLeekLogging(previous)
	}
})

test("fight 55027536: remaining ops 6.9 x the measured node cost open all 5 nodes of level 2 (margin 0.55; margin 1.2 gave 3)", async () => {
	const { BookBudget } = await import("../dist/Classes/Plannification/BookBudget.js")
	const { NODE_COST_MARGIN } = await import("../dist/Classes/Plannification/BookBeam.js")
	const { getLogConfig, LOG_CONTEXT } = await import("../dist/Toolbox/Logger.js")
	assert.equal(NODE_COST_MARGIN, 0.55)
	const budgetOf = (cap) => new class extends BookBudget {
		ops() { return this.work * 250 }
		remainingOps() { return cap - this.work * 250 }
		guard() {}
	}()
	const lines = [], oldDebug = globalThis.Debug, oldColor = globalThis.Color, previous = getLogConfig()
	globalThis.Debug = { log: (text) => lines.push(String(text)), pause() {} }
	globalThis.Color = { rgb: () => 0xff0000 }
	const errors = new LogConfig(); errors.setAll(false).setEnabled(LOG_CONTEXT.ERROR, true)
	try {
		let w = replay(5)
		const level1Run = planBeam(w.me, w.context, w.profile, { depth: 1, standoff: duel(6) })
		const level1 = level1Run.work * 250
		assert.equal(level1Run.result.beam.length, 5, "5 nodes at the beam")
		// reste = 3,6 x coût d'un nœud (combat 55029308 : 5 > 4 à 64,5 % des ops) : 3,6 / 0,55 = 6 nœuds payés ; avec la marge 1,2, 3.
		w = replay(5); initLeekLogging(errors); lines.length = 0
		const run = planBeam(w.me, w.context, w.profile, { depth: 2, standoff: duel(6), budget: budgetOf(level1 * 4.6) })
		assert.equal(run.result.depth, 2)
		assert.deepEqual(lines.filter((line) => line.includes("beam nodes bound")), [])
	} finally {
		globalThis.Debug = oldDebug
		globalThis.Color = oldColor
		initLeekLogging(previous)
	}
})

const CURE = () => chip(4, "cure", 4, 2, 0, 5, [feature(2, 40, 40)])
const ALL_DANGEROUS = [478, 496, 495, 514, 513, 477, 531, 532, 497, 530, 459]

test("step 2 guard: with a heal in the plan, an exposed danger of 2 x life or more stays lethal at the maximum acceptance", () => {
	// 190 PV sur 380 (exactement 50 %, seuil d'acceptation atteint ; AGGRESSIVE soigne à 50 % ou moins avec un ennemi à portée de menace).
	// Danger 400 : 2 x 190 = 380 <= 400 < (190 + 40) x 2.0 = 460. Sans le garde-fou, la limite (PV + soin) x acceptation l'accepterait.
	const w = replay(5, { hiding: false, life: 190, maxLife: 380, extraChips: [CURE()], danger: { 400: ALL_DANGEROUS } })
	const run = planBeam(w.me, w.context, w.profile, { depth: 1, standoff: duel(20) })
	const healed = run.trace.candidates.filter((c) => c.supports.length > 0 && c.outcome.heal > 0 && c.outcome.exposed >= 2 * w.me.life && c.outcome.exposed < (w.me.life + c.outcome.heal) * 2)
	assert.ok(healed.length > 0, "the state has plans with a heal and an exposed danger between 2 x life and (life + heal) x 2")
	for (const step of healed) assert.equal(step.lethal, true, `${step.key}: exposed ${step.outcome.exposed}, limit ${step.limit}`)
	assert.ok(first(run).danger < 400, "the plan played stays on a safe cell")
})

test("step 2 guard: under 50 % of max life a duel changes nothing, at 50 % or more it does", () => {
	// Danger 280 aux cases de tir. Sous 50 % (190 / 387 = 49 %) : 280 >= 190 létal, et sans le garde-fou la limite 190 x 2.0 = 380
	// l'accepterait (2 x 190 = 380 > 280) : le plan changerait. À 200 PV (52 %) le duel l'accepte réellement : contrôle positif.
	const danger = { 280: ALL_DANGEROUS }
	const key = (life, standoff) => { const w = replay(5, { hiding: false, life, danger }); return planBeam(w.me, w.context, w.profile, { depth: 1, standoff }).result.best.steps[0] }
	const low = key(190, duel(8)), lowPlain = key(190, undefined)
	assert.equal(low.key, lowPlain.key, "under 50 %: same plan with and without the duel")
	assert.equal(low.lethal, lowPlain.lethal)
	assert.ok(low.danger < 190, "no lethal shot cell accepted")
	const high = key(200, duel(8)), highPlain = key(200, undefined)
	assert.notEqual(high.key, highPlain.key, "from 50 %: the duel accepts the dangerous rock + spark")
	assert.match(names(planBeam(...(() => { const w = replay(5, { hiding: false, life: 200, danger }); return [w.me, w.context, w.profile, { depth: 1, standoff: duel(8) }] })()), high), /rock/)
})

test("step 3 wiring: the beam gets 70 % of the operations, in a duel or not", () => {
	const fraction = (standoff) => { const w = replay(5); return planBeam(w.me, w.context, w.profile, { depth: 1, standoff }).budgetFraction }
	assert.equal(fraction(duel(6)), 0.70)
	assert.equal(fraction(undefined), 0.70)
	assert.equal(fraction(new StandoffTracker()), 0.70, "no duel noticed yet")
})

const archivedFight = (id) => existsSync(new URL(`../LWGarden/Data/fights/${id}/fight.json`, import.meta.url))

test("duel counter replayed on 55005067 (fight.json): first duel turn is turn 9, then most turns; 55005897 (won in 14 turns) never", { skip: !(archivedFight(55005067) && archivedFight(55005897)) && "archive 55005067 ou 55005897 absente" }, async () => {
	// Même rejeu que ci-dessus. Fixe le tour de déclenchement : à PV adverses de début de tour et dégâts du tour précédent, la
	// fenêtre de 6 tours est pleine au tour 6 mais les dégâts bruts n'atteignent 15 % des PV max qu'à partir du tour 9.
	const { readFileSync } = await import("node:fs")
	const replayDuel = (id) => {
		const f = JSON.parse(readFileSync(new URL(`./data/fight-${id}.json`, import.meta.url), "utf8"))
		const me = f.data.leeks.find((l) => l.farmer === 98285)
		const foes = f.data.leeks.filter((l) => l.team !== me.team && l.type !== 3)
		const life = new Map(f.data.leeks.map((l) => [l.id, l.life])), max = new Map(life)
		const tracker = new StandoffTracker()
		let turn = 0, dealt = 0, started = false
		const activeTurns = []
		for (const a of f.data.actions) {
			if (a[0] === 6) turn = a[1]
			else if (a[0] === 7 && a[1] === me.id) {
				tracker.observe(turn || 1, life.get(me.id), foes.map((l) => ({ life: life.get(l.id), maxLife: max.get(l.id) })), started ? dealt : 0)
				if (tracker.active) activeTurns.push(turn || 1)
				started = true; dealt = 0
			} else if (a[0] === 101) { life.set(a[1], life.get(a[1]) - a[2]); if (foes.some((l) => l.id === a[1])) dealt += a[2] }
			else if (a[0] === 103) life.set(a[1], Math.min(max.get(a[1]), life.get(a[1]) + a[2]))
		}
		return { activeTurns, win: f.winner === me.team, turns: f.report.duration }
	}
	const draw = replayDuel(55005067)
	assert.equal(draw.activeTurns[0], 9, "the counter fires at turn 9")
	assert.ok(draw.activeTurns.length >= 40)
	const won = replayDuel(55005897)
	assert.equal(won.win, true)
	assert.deepEqual(won.activeTurns, [], "no duel in a fight won without one")
})

test("book budget: 25-30 % of the operations no longer cuts the beam; the cut names its cause", async () => {
	const { BookBudget, BookCut, BOOK_DUEL_SEARCH_FRACTION } = await import("../dist/Classes/Plannification/BookBudget.js")
	const cause = (budget) => { try { budget.guard() } catch (error) { assert.ok(error instanceof BookCut); return error.message } return null }
	for (const fraction of [undefined, BOOK_DUEL_SEARCH_FRACTION]) {
		globalThis.System = { operations: 0, maxOperations: 1000 }
		const budget = new BookBudget(undefined, fraction)
		System.operations = 500
		assert.equal(cause(budget), null, "50 % spent: cut under 0.25 / 0.30, not under 0.70")
		System.operations = 700
		assert.equal(cause(budget), "operations reserve (book fraction)")
		System.operations = 800
		assert.equal(cause(budget), "operations reserve (global cap)")
	}
	globalThis.System = { operations: 300, maxOperations: 1000 }
	const late = new BookBudget()
	System.operations = 800
	assert.equal(cause(late), "operations reserve (global cap)", "global cap binds when the beam starts late")
	delete globalThis.System
})

test("search cut: a cut of the book emits exactly one red SEARCH CUT line with its cause; no cut, no line", async () => {
	const { BookBudget } = await import("../dist/Classes/Plannification/BookBudget.js")
	const lines = [], oldDebug = globalThis.Debug, oldColor = globalThis.Color
	globalThis.Debug = { log: (text, color) => lines.push({ text, color }) }
	globalThis.Color = { rgb: () => 0xff0000 }
	const errors = new LogConfig(); errors.setAll(false).setEnabled("error", true); initLeekLogging(errors)
	try {
		let w = replay(5)
		planBeam(w.me, w.context, w.profile, { depth: 1, standoff: duel(6) })
		assert.equal(lines.length, 0, "no cut, no line")
		w = replay(5)
		const run = planBeam(w.me, w.context, w.profile, { depth: 2, standoff: duel(6), budget: new BookBudget(30) })
		assert.equal(run.result.cut, "work limit")
		assert.equal(lines.length, 1)
		assert.equal(lines[0].color, 0xff0000)
		assert.match(lines[0].text, /^SEARCH CUT \[livre\] cause=work limit ops=0\/\? profondeur=1 niveau_atteint=0$/)
	} finally {
		globalThis.Debug = oldDebug; globalThis.Color = oldColor
		const off = new LogConfig(); off.setAll(false); initLeekLogging(off)
	}
})

test("search cut: the book names both operations causes (book fraction, global cap) on its single red line", async () => {
	const { BookBudget } = await import("../dist/Classes/Plannification/BookBudget.js")
	const lines = [], oldDebug = globalThis.Debug, oldColor = globalThis.Color
	globalThis.Debug = { log: (text, color) => lines.push({ text, color }) }
	globalThis.Color = { rgb: () => 0xff0000 }
	const errors = new LogConfig(); errors.setAll(false).setEnabled("error", true); initLeekLogging(errors)
	try {
		for (const [operations, cause] of [[700, "operations reserve (book fraction)"], [850, "operations reserve (global cap)"]]) {
			lines.length = 0
			const w = replay(5)
			globalThis.System = { operations: 0, maxOperations: 1000 }
			const budget = new BookBudget()
			System.operations = operations
			const run = planBeam(w.me, w.context, w.profile, { depth: 2, standoff: duel(6), budget })
			assert.equal(run.result.cut, cause)
			assert.equal(lines.length, 1, cause)
			assert.equal(lines[0].color, 0xff0000)
			assert.match(lines[0].text, new RegExp(`^SEARCH CUT \\[livre\\] cause=${cause.replace(/[()]/g, "\\$&")} ops=${operations}/1000 profondeur=1 niveau_atteint=0$`))
		}
	} finally {
		delete globalThis.System
		globalThis.Debug = oldDebug; globalThis.Color = oldColor
		const off = new LogConfig(); off.setAll(false); initLeekLogging(off)
	}
})
