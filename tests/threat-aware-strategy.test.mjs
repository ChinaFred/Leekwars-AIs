import assert from "node:assert/strict"
import test from "node:test"

import { AggressiveStrategy } from "../dist/Classes/Strategy/AggressiveStrategy.js"
import { BalancedStrategy } from "../dist/Classes/Strategy/BalancedStrategy.js"
import { DefensiveStrategy } from "../dist/Classes/Strategy/DefensiveStrategy.js"
import { LeekStrategy } from "../dist/Classes/Strategy/LeekStrategy.js"

const make = {
	balanced: (aggression) => new BalancedStrategy(aggression),
	aggressive: (aggression) => new AggressiveStrategy(aggression),
	defensive: (aggression) => new DefensiveStrategy(aggression),
	base: (aggression) => new LeekStrategy("BALANCED", aggression),
}

// Table-driven cases: [label, kind, aggression, args, expected]
function runCases(method, cases) {
	for (const [label, kind, aggression, args, expected] of cases) {
		test(`${method}: ${label} -> ${expected}`, () => {
			assert.equal(make[kind](aggression)[method](...args), expected)
		})
	}
}

// shouldHide(lifeRatio, distance, preferredMinRange)
// Thresholds: Balanced hp <= 0.40 & distance <= 8 | Aggressive hp <= 0.25 & distance <= 10
// | Defensive hp <= 0.50 (aggr. 50) & distance <= 7 | Base: hp <= 0.45 - 0.10 * aggression & distance <= 8
runCases("shouldHide", [
	["balanced 35% hp, distance 6 (critical)", "balanced", 50, [0.35, 6, 3], true],
	["balanced 62% hp, distance 7 (pre-critical)", "balanced", 50, [0.62, 7, 3], false],
	["balanced 50% hp, distance 6 (just above 40%)", "balanced", 50, [0.50, 6, 3], false],
	["balanced exactly 40% hp, distance 6", "balanced", 50, [0.40, 6, 3], true],
	["balanced 40% hp, distance 8 (boundary)", "balanced", 50, [0.40, 8, 3], true],
	["balanced 40% hp, distance 9 (just beyond)", "balanced", 50, [0.40, 9, 3], false],
	["balanced very close (1) + wounded 40%", "balanced", 50, [0.40, 1, 3], true],
	["balanced very close (1) + healthy 60%", "balanced", 50, [0.60, 1, 3], false],
	["balanced 80% hp, distance 10 (normal case)", "balanced", 50, [0.80, 10, 3], false],
	["aggressive 70: 50% hp, distance 6", "aggressive", 70, [0.50, 6, 3], false],
	["aggressive 70: exactly 25% hp (panic), distance 6", "aggressive", 70, [0.25, 6, 3], true],
	["aggressive 50: 40% hp, distance 8", "aggressive", 50, [0.40, 8, 3], false],
	["aggressive 50: 24% hp (panic), distance 8", "aggressive", 50, [0.24, 8, 3], true],
	["defensive 50% hp, distance 6", "defensive", 50, [0.50, 6, 3], true],
	["defensive 50% hp, distance 8 (> 7)", "defensive", 50, [0.50, 8, 3], false],
	["base aggression 70: 42% hp, distance 8 (threshold 0.38)", "base", 70, [0.42, 8, 3], false],
	["base aggression 20: 42% hp, distance 8 (threshold 0.43)", "base", 20, [0.42, 8, 3], true],
])

// shouldHeal(lifeRatio, lostLifeRatio)
runCases("shouldHeal", [
	["balanced 10% lost (< 20%)", "balanced", 50, [0.70, 0.10], false],
	["balanced exactly 20% lost", "balanced", 50, [1.0, 0.20], true],
	["balanced 19% lost", "balanced", 50, [1.0, 0.19], false],
	["aggressive exactly 32.5% hp threshold", "aggressive", 50, [0.325, 0], true],
	["defensive exactly 82.5% hp threshold", "defensive", 50, [0.825, 0], true],
])

// shouldHealWithThreat(lifeRatio, lostLifeRatio, distance)
runCases("shouldHealWithThreat", [
	["balanced 70% hp, 15.4% lost, distance 7", "balanced", 50, [0.70, 0.154, 7], true],
	["aggressive 50% hp, distance 10", "aggressive", 50, [0.50, 0, 10], true],
	["defensive 80% hp, 8% lost, distance 10", "defensive", 50, [0.80, 0.08, 10], true],
])

// shouldUseAttackChip(lifeRatio)
runCases("shouldUseAttackChip", [
	["balanced 51% hp", "balanced", 50, [0.51], true],
	["balanced 50% hp", "balanced", 50, [0.50], true],
	["balanced 49% hp", "balanced", 50, [0.49], true],
	["defensive 70% hp (threshold 0.65)", "defensive", 50, [0.70], true],
])

// shouldShield(lifeRatio, distance, threatRange)
runCases("shouldShield", [
	["aggressive 70: 70% hp (only shields at critical hp)", "aggressive", 70, [0.70, 2, 3], false],
	["defensive 70% hp, distance 2, range 3 (shields readily)", "defensive", 50, [0.70, 2, 3], true],
	["balanced 90% hp, distance 3 > range 2 (distance checked first)", "balanced", 50, [0.90, 3, 2], false],
])

test("scoreWeapon: aggression lowers the range-mismatch penalty (100 > 0)", () => {
	const aggressiveScore = new LeekStrategy("AGGRESSIVE", 100).scoreWeapon(50, 5, 2)
	const passiveScore = new LeekStrategy("PASSIVE", 0).scoreWeapon(50, 5, 2)

	assert.ok(aggressiveScore > passiveScore,
		`Aggressive score (${aggressiveScore}) should be > Passive score (${passiveScore})`)
})

test("scoreWeapon: BalancedStrategy matches the base calculation", () => {
	assert.equal(new BalancedStrategy(50).scoreWeapon(50, 5, 2), new LeekStrategy("BALANCED", 50).scoreWeapon(50, 5, 2))
})

test("scoreWeapon: a stronger well-ranged weapon outscores a weak mismatched one", () => {
	const strategy = new BalancedStrategy(50)

	assert.ok(strategy.scoreWeapon(15, 5, 5) > strategy.scoreWeapon(7.5, 5, 2))
})
