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

// shouldHide(lifeRatio, distance)
// Thresholds: Balanced hp <= 0.40 & distance <= 8 | Aggressive hp <= 0.25 & distance <= 10
// | Defensive hp <= 0.50 (aggr. 50) & distance <= 7 | Base: hp <= 0.45 - 0.10 * aggression & distance <= 8
runCases("shouldHide", [
	["balanced 35% hp, distance 6 (critical)", "balanced", 50, [0.35, 6], true],
	["balanced 62% hp, distance 7 (pre-critical)", "balanced", 50, [0.62, 7], false],
	["balanced 50% hp, distance 6 (just above 40%)", "balanced", 50, [0.50, 6], false],
	["balanced exactly 40% hp, distance 6", "balanced", 50, [0.40, 6], true],
	["balanced 40% hp, distance 8 (boundary)", "balanced", 50, [0.40, 8], true],
	["balanced 40% hp, distance 9 (just beyond)", "balanced", 50, [0.40, 9], false],
	["balanced very close (1) + wounded 40%", "balanced", 50, [0.40, 1], true],
	["balanced very close (1) + healthy 60%", "balanced", 50, [0.60, 1], false],
	["balanced 80% hp, distance 10 (normal case)", "balanced", 50, [0.80, 10], false],
	["aggressive 70: 50% hp, distance 6", "aggressive", 70, [0.50, 6], false],
	["aggressive 70: exactly 25% hp (panic), distance 6", "aggressive", 70, [0.25, 6], true],
	["aggressive 50: 40% hp, distance 8", "aggressive", 50, [0.40, 8], false],
	["aggressive 50: 24% hp (panic), distance 8", "aggressive", 50, [0.24, 8], true],
	["defensive 50% hp, distance 6", "defensive", 50, [0.50, 6], true],
	["defensive 50% hp, distance 8 (> 7)", "defensive", 50, [0.50, 8], false],
	["base aggression 70: 42% hp, distance 8 (threshold 0.38)", "base", 70, [0.42, 8], false],
	["base aggression 20: 42% hp, distance 8 (threshold 0.43)", "base", 20, [0.42, 8], true],
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

// shouldShield(lifeRatio, distance, threatRange)
runCases("shouldShield", [
	["aggressive 70: 70% hp (only shields at critical hp)", "aggressive", 70, [0.70, 2, 3], false],
	["defensive 70% hp, distance 2, range 3 (shields readily)", "defensive", 50, [0.70, 2, 3], true],
	["balanced 90% hp, distance 3 > range 2 (distance checked first)", "balanced", 50, [0.90, 3, 2], false],
])
