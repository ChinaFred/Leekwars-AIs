import test from "node:test"
import assert from "node:assert/strict"
import { planAct } from "../dist/Brain/PlanActScenario.js"
import { evaluateTacticalPlans } from "../dist/Classes/Plannification/TacticalPlanner.js"
import { computeReachableCells } from "../dist/Classes/Context/ReachableCells.js"
import { executeReservePlan } from "../dist/Classes/Plannification/ReservePlan.js"
import { ThreatMap } from "../dist/Classes/Context/ThreatMap.js"
import { LeekProfile } from "../dist/Classes/LeekProfile.js"
import { initLeekLogging, getLogConfig, LogConfig, LOG_CONTEXT } from "../dist/Toolbox/Logger.js"

function world({ obstacles = [], los = () => true, danger = c => c.x === -2 ? 0 : 100,
	positions = [[7, 0]], tp = 10, mp = 4, range = 6, chips = [] } = {}) {
	globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4 }
	const grid = new Map()
	for (let x = -4; x <= 9; x++) for (let y = -4; y <= 4; y++) {
		grid.set(`${x},${y}`, { x, y, id: grid.size, obstacle: false, entity: null, empty: true })
	}
	const cell = (x, y = 0) => grid.get(`${x},${y}`) ?? null
	for (const [x, y] of obstacles) cell(x, y).obstacle = true
	const gun = { name: "gun", cost: 4, minRange: 1, maxRange: range, maxUses: -1,
		needsLos: true, features: [{ type: 1, minValue: 30, maxValue: 30 }] }
	const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
	const hit = (from, target, weapon) => distance(from, target.cell) >= weapon.minRange &&
		distance(from, target.cell) <= weapon.maxRange && los(from, target.cell)
	const events = []
	const me = { id: 1, name: "me", cell: cell(0), life: 70, maxLife: 100, tp, mp,
		strength: 0, wisdom: 0, weapon: gun, weapons: [gun], chips,
		distance: target => distance(me.cell, target.cell),
		canUseWeapon: (target, weapon = me.weapon) => target.life > 0 && !me.deny &&
			hit(me.cell, target, weapon),
		canUseChip: (chip, target) => !me.denyChip && target === me,
		chipCells: () => [me.cell],
		setWeapon(weapon) { events.push("equip"); if (!me.failEquip) { me.weapon = weapon; me.tp-- } },
		useWeapon(target) {
			assert.ok(me.tp >= me.weapon.cost && me.canUseWeapon(target))
			events.push("shoot"); me.tp -= me.weapon.cost; target.life -= 30; me.afterShot?.()
			return 1 // USE_SUCCESS : contrat officiel, pas undefined après une dépense réussie.
		},
		useChip(chip) { assert.ok(me.tp >= chip.cost); events.push("heal"); me.tp -= chip.cost; return 1 },
		moveToward(destination, limit) {
			events.push(["move", destination.x, destination.y, limit])
			if (me.failMove) return 0
			const cost = computeReachableCells(me, Math.min(me.mp, limit)).costTo(destination)
			assert.notEqual(cost, null)
			assert.ok(cost <= me.mp && cost <= limit)
			me.cell.entity = null; me.cell = destination; destination.entity = me; me.mp -= cost
			me.afterMove?.()
			return cost
		},
		moveAwayFrom(target, limit) { events.push(["unknown-retreat", target.id, limit]); me.mp -= limit }
	}
	me.cell.entity = me
	const enemies = positions.map(([x, y], i) => {
		const enemy = { id: i + 2, cell: cell(x, y), life: 153, maxLife: 243, mp: 3, weapon: gun }
		enemy.cell.entity = enemy
		return enemy
	})
	globalThis.Fight = { turn: 6, me, getNearestEnemy: () => enemies[0] ?? null,
		getAliveEnemies: () => enemies.filter(e => e.life > 0), getEnemies: () => enemies,
		weaponCells: (target, weapon) => [...grid.values()].filter(c => hit(c, target, weapon)) }
	globalThis.Field = { cellFromXY: cell, distance, lineOfSight: los }
	// La tactique complète abandonne après le fournisseur natif : +61 % (plafond relatif 60 %), avant toute action.
	let ops = 100000
	globalThis.System = { get operations() { return ops }, maxOperations: 1000000 }
	const native = Fight.weaponCells
	Fight.weaponCells = (...args) => { ops = 710000; return native(...args) }
	const reachable = computeReachableCells(me, me.mp)
	const threat = new ThreatMap(me.id, 6, new Map([...reachable.entries()].map(e =>
		[e.cell.x * 4096 + e.cell.y, { cell: e.cell, danger: danger(e.cell), mpCost: e.cost, breakdown: [] }])),
	{ candidateCells: reachable.size, truncated: false, inputsTruncated: false,
		enemyCount: enemies.length, pairsEvaluated: 0, lineOfSightCalls: 0 })
	const context = { reachable, threat }
	const profile = new LeekProfile()
	const config = new LogConfig(); config.setAll(false); config.setEnabled(LOG_CONTEXT.PLANNING, true)
	initLeekLogging(config)
	return { me, enemies, events, context, profile, cell,
		steady() { ops = 510000; Fight.weaponCells = native },
		resetOps() { ops = 100000 }, setOps(n) { ops = n },
		run(ctx = context) { planAct(me, profile, ctx) } }
}

test("turn 6 simulation: operations reserve → approach 1 PM, two shots, retreat 3 PM FROM shot", () => {
	const w = world()
	assert.equal(evaluateTacticalPlans(w.me, w.profile, w.context).reason, "operations reserve")
	assert.deepEqual(w.events, [])
	w.resetOps()
	const messages = [], original = console.log
	try {
		console.log = message => messages.push(message)
		w.run()
	} finally { console.log = original }
	assert.ok(messages.some(m => m.includes("[Tactical] fallback: operations reserve")))
	assert.deepEqual(w.events, [["move", 1, 0, 1], "shoot", "shoot", ["move", -2, 0, 3]])
	assert.equal(w.me.mp, 0)
	assert.equal(w.me.tp, 2)
})

test("obstacle and native LOS prevent a fictitious one-PM shot; path costs include detour", () => {
	const w = world({ obstacles: [[1, 0]], los: from => from.y === 0 })
	w.run()
	assert.deepEqual(w.events.slice(0, 3), [["move", 2, 0, 4], "shoot", "shoot"])
	assert.equal(w.me.mp, 0)
})

test("remaining PM cannot reach a low-danger cell using the departure cost", () => {
	const w = world({ danger: c => c.x === -3 ? 0 : c.x === 0 ? 20 : 100 })
	w.run()
	assert.deepEqual(w.events, [["move", 1, 0, 1], "shoot", "shoot", ["move", 0, 0, 1]])
	assert.equal(w.me.mp, 2)
})

test("allowHiding=false forbids the post-shot retreat, not minimal approach", () => {
	const w = world(); w.profile.allowHiding = false; w.run()
	assert.deepEqual(w.events, [["move", 1, 0, 1], "shoot", "shoot"])
	assert.equal(w.me.mp, 3)
})

// Every way the danger map can be unusable must give an explicit geometric retreat, never a modeled-safety claim.
const invalidMapMutations = {
	"stale": w => { w.context.threat.turn-- },
	"truncated": w => { w.context.threat.inputsTruncated = true },
	"partial": w => { w.context.threat.byKey.delete(4096) },
	"wrong-position": w => { w.context.reachable.startCell = w.cell(0, 1) },
	"reachable-id": w => { w.context.reachable.entityId = 99 },
	"threat-id": w => { w.context.threat.entityId = 99 },
	"reachable-truncated": w => { w.context.reachable.truncated = true },
	"threat-truncated": w => { w.context.threat.truncated = true },
	"enemy-count": w => { w.context.threat.enemyCount = 99 },
	"negative-danger": w => { w.context.threat.byKey.get(4096).danger = -1 },
	"nonfinite-danger": w => { w.context.threat.byKey.get(4096).danger = NaN }
}
for (const invalid of ["absent", ...Object.keys(invalidMapMutations)]) {
	test(`unknown map (${invalid}): explicit geometric retreat, never credited as safe`, () => {
		const w = world()
		w.steady()
		invalidMapMutations[invalid]?.(w)
		const messages = [], original = console.log
		try {
			console.log = message => messages.push(message)
			w.run(invalid === "absent" ? { reachable: null, threat: null } : w.context)
		} finally { console.log = original }
		assert.ok(w.events.includes("shoot"))
		assert.deepEqual(w.events.at(-1), ["unknown-retreat", 2, 3])
		assert.ok(messages.some(m => m.includes("danger unknown; geometric only, no safety claim")))
	})
}

test("entry without context also uses bounded minimal approach and unknown-danger retreat", () => {
	const w = world()
	w.steady()
	planAct(w.me, w.profile)
	assert.deepEqual(w.events, [["move", 1, 0, 1], "shoot", "shoot", ["unknown-retreat", 2, 3]])
})

test("no reachable shot: main plan protects then progresses, using real PT", () => {
	const heal = { name: "bandage", cost: 2, currentCooldown: 0,
		features: [{ type: 2, minValue: 20, maxValue: 20 }] }
	const w = world({ range: 1, danger: c => c.x <= 2 ? 0 : 100, chips: [heal] })
	w.run()
	assert.deepEqual(w.events, ["heal", ["move", 2, 0, 2]])
	assert.equal(w.me.tp, 8)
})

test("no shot: cover competes with progress when the path is too dangerous", () => {
	const w = world({ range: 1, danger: c => c.x < 0 ? 0 : 100 })
	w.run()
	assert.deepEqual(w.events, [["move", -1, 0, 1]])
})

test("zero enemies does nothing; dead target stops shots but permits modeled retreat", () => {
	let w = world({ positions: [] }); w.run(); assert.deepEqual(w.events, [])
	w = world(); w.me.afterShot = () => { w.enemies[0].life = 0 }; w.run()
	assert.deepEqual(w.events, [["move", 1, 0, 1], "shoot", ["move", -2, 0, 3]])
})

test("failed approach stops the sequence, no attacks or second complete plan", () => {
	const w = world(); w.me.failMove = true; w.run()
	assert.deepEqual(w.events, [["move", 1, 0, 1]])
	assert.equal(w.me.mp, 4)
	assert.equal(w.me.tp, 10)
})

test("native refusal after approach prevents all shots, still permits retreat with real PM", () => {
	const w = world(); w.me.afterMove = () => { w.me.deny = true }; w.run()
	assert.deepEqual(w.events, [["move", 1, 0, 1], ["move", -2, 0, 3]])
	assert.equal(w.me.tp, 10)
})

test("target position change invalidates danger and legality is rechecked natively", () => {
	const w = world(); w.me.afterMove = () => { w.enemies[0].cell = w.cell(9, 4) }; w.run()
	assert.deepEqual(w.events, [["move", 1, 0, 1], ["unknown-retreat", 2, 3]])
})

test("multiple enemies: retreat uses aggregate danger, not distance from the chosen target", () => {
	const w = world({ positions: [[7, 0], [-4, 0]],
		danger: c => c.y === 1 ? 10 : c.x < 0 ? 200 : 100 })
	w.run()
	assert.deepEqual(w.events, ["shoot", "shoot", ["move", 0, 1, 1]])
})

test("plan B search ceiling is 80 percent: full search at 750000 and 799999, no search movement from 800000", () => {
	// Même plafond que la recherche tactique (SEARCH_GLOBAL_FRACTION). À 70 % (700 000) le plan B était dégradé :
	// ses 8 premières cases natives seulement, aucune approche, aucun tir.
	const fullPlan = [["move", 1, 0, 1], "shoot", "shoot", ["move", -2, 0, 3]]
	for (const ops of [700000, 750000, 799999]) {
		const w = world(); w.steady(); w.setOps(ops); executeReservePlan(w.me, w.profile, w.context)
		assert.deepEqual(w.events, fullPlan, `plan B starting at ${ops}`)
		assert.equal(w.me.tp, 2)
	}
	for (const ops of [800000, 800001]) {
		const w = world(); w.steady(); w.setOps(ops); executeReservePlan(w.me, w.profile, w.context)
		assert.deepEqual(w.events, [], `plan B starting at ${ops}`)
	}
})

test("no shot: route around a wall progresses even when Manhattan distance initially increases", () => {
	const w = world({ range: 1, mp: 1, danger: () => 0,
		obstacles: Array.from({ length: 7 }, (_, i) => [1, i - 3]) })
	w.run()
	assert.equal(w.events.length, 1)
	assert.equal(w.events[0][0], "move")
	assert.equal(w.events[0][1], 0)
	assert.equal(Math.abs(w.events[0][2]), 1)
	assert.equal(w.me.mp, 0)
	assert.equal(w.me.tp, 10)
})

test("new obstacle after shooting blocks the old cheap retreat path", () => {
	const w = world()
	w.me.afterShot = () => { w.cell(0).obstacle = true }
	w.run()
	assert.deepEqual(w.events, [["move", 1, 0, 1], "shoot", "shoot"])
	assert.equal(w.me.mp, 3)
})

test("displacement during attack: final path starts at the real cell, no second approach", () => {
	const w = world()
	w.me.afterShot = () => {
		w.me.cell.entity = null; w.me.cell = w.cell(0, 1); w.me.cell.entity = w.me
	}
	w.run()
	assert.deepEqual(w.events, [["move", 1, 0, 1], "shoot", ["move", -2, 1, 2]])
	assert.equal(w.me.mp, 1)
})

test("failed equipment never shoots the old weapon and never runs a second sequence", () => {
	const w = world(); w.me.weapon = null; w.me.failEquip = true; w.run()
	assert.deepEqual(w.events, [["move", 1, 0, 1], "equip", ["move", -2, 0, 3]])
	assert.equal(w.me.tp, 10)
})

test("native action exception after approach cannot trigger legacy planning", () => {
	const w = world()
	w.me.useWeapon = () => { w.events.push("failed-shot"); throw new Error("action fixture failure") }
	w.run()
	assert.deepEqual(w.events, [["move", 1, 0, 1], "failed-shot"])
})

test("zero affordable shots: progress without equipment or fictitious attack PT", () => {
	const w = world({ tp: 0, danger: () => 0 }); w.steady(); w.run()
	assert.deepEqual(w.events, [["move", 4, 0, 4]])
	assert.equal(w.me.tp, 0)
})

test("unknown danger permits explicit progress but does not claim modeled cover", () => {
	const w = world({ range: 1 }); w.steady()
	const messages = [], original = console.log
	try {
		console.log = m => messages.push(m)
		w.run({ reachable: null, threat: null })
	} finally { console.log = original }
	assert.deepEqual(w.events, [["move", 4, 0, 4]])
	assert.ok(messages.some(m => m.includes("danger unknown")))
	assert.ok(!messages.some(m => m.includes("danger modeled")))
})

test("allowHiding=false prevents cover-only movement when no shot is available", () => {
	const w = world({ range: 1, danger: c => c.x < 0 ? 0 : c.x === 0 ? 100 : 200 })
	w.profile.allowHiding = false; w.run()
	assert.deepEqual(w.events, [])
})

test("support uses real post-shot PT, respects shielding and refusal", () => {
	const shield = { name: "shield", cost: 2, currentCooldown: 0,
		features: [{ type: 3, minValue: 20, maxValue: 20 }] }
	let w = world({ chips: [shield] }); w.run()
	assert.deepEqual(w.events, [["move", 1, 0, 1], "shoot", "shoot", "heal", ["move", -2, 0, 3]])
	assert.equal(w.me.tp, 0)
	w = world({ chips: [shield] }); w.profile.allowShielding = false; w.run()
	assert.ok(!w.events.includes("heal"))
	w = world({ chips: [shield] }); w.me.denyChip = true; w.run()
	assert.ok(!w.events.includes("heal")); assert.equal(w.me.tp, 2)
})

for (const [role, threshold] of [["AGGRESSIVE", 50], ["BALANCED", 80], ["DEFENSIVE", 82.5]]) {
	test(`${role}: minimal approach, attack then support across the healing threshold`, () => {
		for (const [life, heal] of [[threshold - 0.1, true], [threshold + 0.1, false]]) {
			const chip = { name: "bandage", cost: 2, currentCooldown: 0,
				features: [{ type: 2, minValue: 20, maxValue: 20 }] }
			const w = world({ tp: 6, chips: [chip] }); w.steady()
			w.profile.setRole(role); w.me.life = life
			planAct(w.me, w.profile)
			assert.deepEqual(w.events, [
				["move", 1, 0, 1], "shoot", ...(heal ? ["heal"] : []),
				["unknown-retreat", 2, 3]
			], `${role} at ${life}%`)
			assert.equal(w.me.tp, heal ? 0 : 2)
		}
	})
}

test("target disappears during approach: no shot and no second approach", () => {
	const w = world(); w.me.afterMove = () => { w.enemies[0].life = 0 }; w.run()
	assert.deepEqual(w.events, [["move", 1, 0, 1], ["move", -2, 0, 3]])
	assert.equal(w.me.tp, 10)
})

test("reserve provider exception is reported and interrupts the sequence", () => {
	const w = world(); w.steady()
	const reports = [], oldDebug = globalThis.Debug, oldColor = globalThis.Color
	globalThis.Debug = { log: m => reports.push(m) }
	globalThis.Color = { rgb: () => 0 }
	initLeekLogging(new LogConfig().setAll(false).setEnabled(LOG_CONTEXT.ERROR, true))
	Fight.weaponCells = () => { throw new Error("reserve native fixture failure") }
	try { planAct(w.me, w.profile) } finally { globalThis.Debug = oldDebug; globalThis.Color = oldColor }
	assert.deepEqual({
		reported: reports.some(m => m.includes("reserve native fixture failure")),
		events: w.events
	}, { reported: true, events: [] })
})

test("plan B casts an offensive chip without base cooldown as often as TP allow, a cooldown chip once", () => {
	for (const [cooldown, casts] of [[0, 3], [2, 1]]) {
		const spark = { name: "spark", cost: 3, cooldown, currentCooldown: 0, minRange: 1, maxRange: 10, maxUses: -1,
			features: [{ type: 1, minValue: 20, maxValue: 20 }] }
		// Arme hors de portée sans approche (ennemi à 7, portée 6) : la puce, utilisable sur place, coûte 0 PM.
		const w = world({ chips: [spark] })
		w.me.canUseChip = (chip, target) => target !== w.me && target.life > 0
		w.me.useChip = (chip, target) => {
			assert.ok(w.me.tp >= chip.cost)
			w.events.push("spark"); w.me.tp -= chip.cost; target.life -= 20; chip.currentCooldown = chip.cooldown
			return 1
		}
		w.run()
		assert.equal(w.events.filter(event => event === "spark").length, casts, `cooldown ${cooldown}`)
		assert.equal(w.enemies[0].life, 153 - 20 * casts, `cooldown ${cooldown}`)
		assert.ok(!w.events.includes("shoot"))
	}
})

test("plan B never reserves more chip casts than the kill needs: the spare TP stay available for support", () => {
	const spark = { name: "spark", cost: 3, cooldown: 0, currentCooldown: 0, minRange: 1, maxRange: 10, maxUses: -1,
		features: [{ type: 1, minValue: 20, maxValue: 20 }] }
	const preview = (life) => {
		const w = world({ chips: [spark] })
		w.enemies[0].life = life
		w.me.canUseChip = (chip, target) => target !== w.me && target.life > 0
		w.me.useChip = (chip, target) => { w.me.tp -= chip.cost; target.life -= 20; return 1 }
		const lines = []
		const original = console.log
		console.log = (...args) => lines.push(args.join(" "))
		try { w.run() } finally { console.log = original }
		const line = lines.find((text) => text.includes("[Reserve] plan before execution"))
		const plan = JSON.parse(line.slice(line.indexOf("{")))
		return [plan.attack.chip.castsAtMost, plan.resources.attack, plan.resources.tpRemainingIfExecuted]
	}
	assert.deepEqual(preview(40), [2, 6, 4]) // ceil(40 / 20) = 2 lancers, pas floor(10 / 3) = 3
	assert.deepEqual(preview(41), [3, 9, 1])
})

test("rejected native attack must not be reported as two successful attacks", () => {
	const w = world(), messages = [], original = console.log
	w.me.useWeapon = () => { w.events.push("refused"); return -1 }
	try { console.log = m => messages.push(m); w.run() } finally { console.log = original }
	assert.equal(w.me.tp, 10)
	assert.ok(!messages.some(m => m.includes("attack: 2;")), "no PT spent and no shot executed")
})

test("tactical validation checks reserve while scanning danger before fallback", () => {
	const w = world(); let ops = 790000
	globalThis.System = { get operations() { return ops }, maxOperations: 1000000 }
	const dangerAt = w.context.threat.dangerAt.bind(w.context.threat)
	// Compteur synthétique, pas une mesure d'ops du moteur. Plafond global de la recherche tactique : 80 %.
	w.context.threat.dangerAt = cell => { ops += 10000; return dangerAt(cell) }
	const result = evaluateTacticalPlans(w.me, w.profile, w.context)
	assert.equal(result.reason, "operations reserve")
	assert.ok(ops <= 810000, `unguarded validation crossed reserve: ${ops} operations`)
	assert.deepEqual(w.events, [])
})

test("reserve validation stops searching at 3%, then may execute a validated short move", () => {
	const w = world(); let ops = 500000
	globalThis.System = { get operations() { return ops }, maxOperations: 1000000 }
	const dangerAt = w.context.threat.dangerAt.bind(w.context.threat)
	w.context.threat.dangerAt = cell => { ops += 2000; return dangerAt(cell) }
	executeReservePlan(w.me, w.profile, w.context)
	assert.ok(ops <= 532000, `unguarded reserve validation exceeded its search margin: ${ops} operations`)
	assert.deepEqual(w.events, [["move", 1, 0, 1]])
	assert.equal(w.me.mp, 3)
	assert.equal(w.me.tp, 10)
})

for (const role of ["AGGRESSIVE", "BALANCED", "DEFENSIVE"]) {
	for (const [start, after] of [
		[750000, 799999], [750000, 800000], [750000, 800001],
		[500000, 549999], [500000, 550000], [500000, 550001]
	]) test(`${role}: reserve executes with operations ${after} after starting at ${start}`, () => {
		const w = world(); w.steady(); let ops = start
		w.profile.setRole(role)
		globalThis.System = { get operations() { return ops }, maxOperations: 1000000 }
		const native = Fight.weaponCells
		Fight.weaponCells = (...args) => { ops = after; return native(...args) }
		try {
			executeReservePlan(w.me, w.profile, w.context)
			assert.ok(w.events.some(e => Array.isArray(e) && e[0] === "move"),
				`start=${start}, after=${after}`)
		} finally { delete globalThis.System }
	})
}

for (const role of ["AGGRESSIVE", "BALANCED", "DEFENSIVE"]) {
	for (const [after, mayAct] of [[969999, true], [970000, false], [970001, false]]) {
		test(`${role}: reserve respects the real 3% execution tail at ${after}`, () => {
			const w = world(); w.steady(); w.profile.setRole(role)
			let ops = 660000
			globalThis.System = { get operations() { return ops }, maxOperations: 1000000 }
			const native = Fight.weaponCells
			Fight.weaponCells = (...args) => { ops = after; return native(...args) }
			try {
				executeReservePlan(w.me, w.profile, w.context)
				assert.equal(w.events.length > 0, mayAct)
				if (!mayAct) {
					assert.deepEqual(w.events, [])
					assert.equal(w.me.tp, 10)
					assert.equal(w.me.mp, 4)
				}
			} finally { delete globalThis.System }
		})
	}
}

for (const result of [0, -1, 1, 2]) {
	test(`native weapon result ${result}: only positive launches count, refusal is not retried`, () => {
		const w = world(), messages = [], original = console.log
		const native = w.me.useWeapon
		let calls = 0
		w.me.useWeapon = target => {
			calls++
			if (result > 0) native(target)
			return result
		}
		try { console.log = m => messages.push(m); w.run() } finally { console.log = original }
		assert.equal(calls, result > 0 ? 2 : 1)
		assert.equal(w.me.tp, result > 0 ? 2 : 10)
		assert.ok(messages.some(m => m.includes(`attack: ${result > 0 ? 2 : 0};`)))
		assert.equal(messages.some(m => m.includes(`weapon refused: result ${result}`)), result <= 0)
	})
}

test("refused support has an explicit result, never a success log or imaginary PT cost", () => {
	const chip = { name: "bandage", cost: 2, currentCooldown: 0,
		features: [{ type: 2, minValue: 20, maxValue: 20 }] }
	const w = world({ chips: [chip] }), messages = [], original = console.log
	w.me.useChip = () => { w.events.push("refused-support"); return 0 }
	try { console.log = m => messages.push(m); w.run() } finally { console.log = original }
	assert.equal(w.me.tp, 2)
	assert.ok(messages.some(m => m.includes("support refused: bandage; result 0")))
	assert.ok(!messages.some(m => m.includes("support: bandage;")))
	assert.equal(w.events.filter(e => e === "refused-support").length, 1)
})

test("reserve scores and retreat reuse only the complete validated danger snapshot", () => {
	const w = world(); w.steady()
	const native = w.context.threat.dangerAt.bind(w.context.threat)
	let reads = 0
	w.context.threat.dangerAt = cell => { reads++; return native(cell) }
	executeReservePlan(w.me, w.profile, w.context)
	assert.equal(reads, w.context.reachable.size)
	assert.deepEqual(w.events, [["move", 1, 0, 1], "shoot", "shoot", ["move", -2, 0, 3]])
})

// --- journal de coupure : une ligne rouge `SEARCH CUT` par recherche coupée par son plafond ---------------------------------

function captureCuts(run) {
	const lines = [], oldDebug = globalThis.Debug, oldColor = globalThis.Color
	globalThis.Debug = { log: (text) => lines.push(String(text)), pause() {} }
	globalThis.Color = { rgb: () => 0xff0000 }
	const errors = new LogConfig(); errors.setAll(false).setEnabled(LOG_CONTEXT.ERROR, true); initLeekLogging(errors)
	try { run() } finally {
		globalThis.Debug = oldDebug; globalThis.Color = oldColor
		const off = new LogConfig(); off.setAll(false); initLeekLogging(off)
	}
	return lines.filter((text) => text.includes("SEARCH CUT"))
}

test("search cut: the joint search emits one red line where its relative cap decides; no cut, no line", () => {
	const w = world()
	const cuts = captureCuts(() => {
		assert.equal(evaluateTacticalPlans(w.me, w.profile, w.context).reason, "operations reserve")
		w.resetOps(); w.steady()
		assert.notEqual(evaluateTacticalPlans(w.me, w.profile, w.context).reason, "operations reserve")
	})
	assert.equal(cuts.length, 1)
	assert.match(cuts[0], /^SEARCH CUT \[tactique\] cause=operations reserve \(search fraction\) ops=710000\/1000000 ticks=\d+\/100000$/)
})

test("search cut: plan B emits one red line at its first refusal (margin or hard reserve); no cut, no line", () => {
	const run = (setup) => {
		const w = world()
		w.steady()
		setup(w)
		return captureCuts(() => executeReservePlan(w.me, w.profile, w.context))
	}
	assert.deepEqual(run(() => {}), [], "no cut, no line")
	const margin = run((w) => { const native = Fight.weaponCells; Fight.weaponCells = (...args) => { w.setOps(550000); return native(...args) } })
	assert.deepEqual(margin, ["SEARCH CUT [plan B] cause=search margin reached ops=550000/1000000"])
	const hard = run((w) => w.setOps(990000))
	assert.equal(hard.length, 1)
	assert.match(hard[0], /^SEARCH CUT \[plan B\] cause=(hard operations reserve|operations reserve \(global cap\)) ops=990000\/1000000$/)
})

test("search cut: plan B over its candidate or native-cell bounds emits one red line each; within the bounds, none", async () => {
	const { getLogConfig } = await import("../dist/Toolbox/Logger.js")
	const lines = [], oldDebug = globalThis.Debug, oldColor = globalThis.Color, previous = getLogConfig()
	globalThis.Debug = { log: (text) => lines.push(String(text)), pause() {} }
	globalThis.Color = { rgb: () => 0xff0000 }
	const errors = new LogConfig(); errors.setAll(false).setEnabled(LOG_CONTEXT.ERROR, true)
	const cuts = (options, adjust = () => {}) => {
		const w = world(options)
		w.steady()
		adjust(w)
		initLeekLogging(errors)
		lines.length = 0
		executeReservePlan(w.me, w.profile, w.context)
		return lines.filter((text) => text.includes("SEARCH CUT"))
	}
	try {
		assert.deepEqual(cuts({ positions: [[7, 0], [7, 1], [7, 2], [7, 3]] }), [], "4 enemies: at the bound")
		const enemies = cuts({ positions: [[7, 0], [7, 1], [7, 2], [7, 3], [7, -1]] })
		assert.equal(enemies.length, 1, enemies.join("\n"))
		assert.match(enemies[0], /^SEARCH CUT \[plan B\] cause=candidate bound \(enemies 5 > 4\) ops=\d+\/1000000 repli=candidats retenus seuls$/)
		const items = (count) => (w) => {
			w.me.weapons = Array.from({ length: count }, (_, i) => ({ ...w.me.weapon, name: `gun${i}` }))
			w.me.weapon = w.me.weapons[0]
		}
		assert.deepEqual(cuts({}, items(4)), [], "4 weapons: at the bound")
		const weapons = cuts({}, items(5))
		assert.equal(weapons.length, 1, weapons.join("\n"))
		assert.match(weapons[0], /cause=candidate bound \(weapons 5 > 4\)/)
		const big = (count) => (w) => {
			const all = [...Array(count)].map((_, i) => ({ x: i, y: 100, id: i, obstacle: false, entity: null }))
			Fight.weaponCells = () => all
		}
		assert.deepEqual(cuts({}, big(613)).filter((text) => text.includes("native cells")), [])
		const native = cuts({}, big(614))
		assert.equal(native.length, 1, native.join("\n"))
		assert.match(native[0], /^SEARCH CUT \[plan B\] cause=native cells bound \(614 > 613\) ops=\d+\/1000000 repli=arme ignorée$/)
	} finally {
		globalThis.Debug = oldDebug
		globalThis.Color = oldColor
		initLeekLogging(previous)
	}
})
