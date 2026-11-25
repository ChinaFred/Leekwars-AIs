import assert from "node:assert/strict"
import test from "node:test"
import { evaluateTacticalPlans, executeTacticalPlan } from "../dist/Classes/Plannification/TacticalPlanner.js"
import { computeReachableCells } from "../dist/Classes/Context/ReachableCells.js"
import { ThreatMap } from "../dist/Classes/Context/ThreatMap.js"
import { LeekProfile } from "../dist/Classes/LeekProfile.js"
import { initLeekLogging, LogConfig, LOG_CONTEXT } from "../dist/Toolbox/Logger.js"

globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4 }
const attack = (name, range, damage) => ({
	name, cost: 2, minRange: 1, maxRange: range, currentCooldown: 0, cooldown: 1,
	maxUses: 1, features: [{ type: Effect.DAMAGE, minValue: damage, maxValue: damage }]
})

function scenario({ enemyX = 3, gun = null, chipRange = 2, deny = false, danger = () => 0 } = {}) {
	const cells = new Map()
	for (let x = -2; x <= 4; x++) cells.set(x, { id: x + 2, x, y: 0, empty: true, obstacle: false, entity: null })
	const chip = attack("chip", chipRange, 30)
	const enemy = { id: 2, cell: cells.get(enemyX), life: 100, relativeShield: 0, absoluteShield: 0 }
	const events = []
	const me = {
		id: 1, cell: cells.get(0), life: 100, maxLife: 100, mp: 1, tp: 2, wisdom: 0, strength: 0,
		weapons: gun ? [gun] : [], weapon: gun, chips: [chip],
		canUseChip(item, target) {
			return !deny && this.tp >= item.cost && Math.abs(this.cell.x - target.cell.x) <= item.maxRange &&
				Math.abs(this.cell.x - target.cell.x) >= item.minRange
		},
		chipCells(item, target) {
			return [...cells.values()].filter((cell) => {
				const d = Math.abs(cell.x - target.cell.x)
				return d >= item.minRange && d <= item.maxRange
			})
		},
		moveToward(cell, cost) { events.push(`move:${cell.x}`); this.cell = cell; this.mp -= cost; return cost },
		useChip(item, target) {
			assert.ok(this.canUseChip(item, target))
			events.push("chip")
			this.tp -= item.cost
		},
		canUseWeapon() { return !!this.weapon && this.tp >= this.weapon.cost },
		useWeapon() { events.push("weapon"); this.tp -= this.weapon.cost },
		setWeapon() { throw new Error("unexpected equipment") }
	}
	cells.get(enemyX).entity = enemy
	globalThis.Field = { cellFromXY: (x, y) => y === 0 ? cells.get(x) ?? null : null }
	globalThis.Fight = {
		turn: 1, getAliveEnemies: () => [enemy],
		weaponCells: () => [...cells.values()]
	}
	delete globalThis.System
	initLeekLogging(new LogConfig().setAll(false))
	const reachable = computeReachableCells(me, me.mp, 1)
	const entries = new Map([...reachable.entries()].map(({ cell, cost }) => [
		cell.x * 4096 + cell.y, { cell, mpCost: cost, danger: danger(cell), breakdown: [] }
	]))
	const threat = new ThreatMap(me.id, 1, entries, {
		truncated: false, inputsTruncated: false, enemyCount: 1, pairsEvaluated: 0,
		lineOfSightCalls: 0, candidateCells: reachable.size
	})
	const context = { reachable, threat }
	const profile = new LeekProfile()
	return { me, enemy, chip, events, context, profile,
		evaluate: () => evaluateTacticalPlans(me, profile, context) }
}

test("false with or without a spatial explanation never certifies a hypothetical shot", () => {
	for (const deny of [false, true]) {
		const w = scenario({ deny })
		assert.equal(w.me.canUseChip(w.chip, w.enemy), false, "target currently outside range")
		assert.ok(w.me.chipCells(w.chip, w.enemy).some((cell) => cell.x === 1))
		const result = w.evaluate()
		assert.equal(result.plan, null)
		assert.equal(result.reason, "offensive chip legality unverified")
		assert.deepEqual(w.events, [])
	}
})

test("a non-spatial refusal in range excludes only that chip, not a usable weapon", () => {
	const gun = { ...attack("weapon", 5, 10), maxUses: 1 }
	const w = scenario({ enemyX: 2, deny: true, gun })
	assert.equal(w.me.chipCells(w.chip, w.enemy).some((cell) => cell.x === 0), true)
	assert.equal(w.me.canUseChip(w.chip, w.enemy), false)
	const plan = w.evaluate().plan
	assert.equal(plan.weapon, gun)
	assert.deepEqual(plan.chips, [])
	executeTacticalPlan(w.me, plan)
	assert.deepEqual(w.events, ["weapon"])
})

test("refusal despite current geometric eligibility is reported separately from position uncertainty", () => {
	const w = scenario({ enemyX: 2, deny: true })
	const result = w.evaluate()
	assert.equal(result.plan, null)
	assert.equal(result.reason, "offensive chip refused at current cell")
	assert.deepEqual(w.events, [])
})

test("a chip usable now can still be planned after movement, then checked from the real cell", () => {
	const gun = { ...attack("weapon", 5, 10), maxUses: 1 }
	const w = scenario({ enemyX: 2, chipRange: 3, gun, danger: (cell) => cell.x === 1 ? 0 : 20 })
	w.me.tp = 4
	Fight.weaponCells = () => w.me.chipCells(w.chip, w.enemy).filter((cell) => cell.x === 1)
	assert.equal(w.me.canUseChip(w.chip, w.enemy), true)
	const plan = w.evaluate().plan
	assert.equal(plan.shotCell.x, 1)
	assert.deepEqual(plan.chips, [w.chip])
	executeTacticalPlan(w.me, plan)
	assert.deepEqual(w.events, ["move:1", "chip", "weapon"])
})

test("a later chip restriction is rechecked after movement", () => {
	const gun = { ...attack("weapon", 5, 10), maxUses: 1 }
	const w = scenario({ enemyX: 2, chipRange: 3, gun, danger: (cell) => cell.x === 1 ? 0 : 20 })
	w.me.tp = 4
	Fight.weaponCells = () => w.me.chipCells(w.chip, w.enemy).filter((cell) => cell.x === 1)
	const plan = w.evaluate().plan
	const originalMove = w.me.moveToward
	w.me.moveToward = function (...args) {
		const result = originalMove.apply(this, args)
		this.canUseChip = () => false
		return result
	}
	executeTacticalPlan(w.me, plan)
	assert.deepEqual(w.events, ["move:1", "weapon"])
})

test("unexpected errors report the original cause through ERROR, expected rejections do not", () => {
	const w = scenario()
	const reports = []
	const oldDebug = globalThis.Debug
	const oldColor = globalThis.Color
	globalThis.Debug = { log: (message) => reports.push(message) }
	globalThis.Color = { rgb: () => 0 }
	initLeekLogging(new LogConfig().setAll(false).setEnabled(LOG_CONTEXT.ERROR, true))
	try {
		assert.equal(evaluateTacticalPlans(w.me, w.profile, undefined).reason, "missing threat/reachable data")
		assert.equal(reports.length, 0)
		Fight.weaponCells = () => { throw new TypeError("provider failed deliberately") }
		const gun = { ...attack("weapon", 5, 10), maxUses: 1 }
		w.me.weapons = [gun]
		w.me.weapon = gun
		const result = w.evaluate()
		assert.equal(result.plan, null)
		assert.equal(result.reason, "evaluation API unavailable")
		assert.equal(reports.length, 1)
		const report = JSON.parse(reports[0])
		assert.equal(report.function, "evaluateTacticalPlans")
		assert.equal(report.error.name, "TypeError")
		assert.match(report.error.message, /provider failed deliberately/)
		assert.deepEqual(w.events, [])
	} finally {
		globalThis.Debug = oldDebug
		globalThis.Color = oldColor
	}
})
