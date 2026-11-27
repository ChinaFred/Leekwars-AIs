// @version:5.8
// file version: 3
import { AggressiveStrategy } from "./Strategy/AggressiveStrategy.js"
import { BalancedStrategy } from "./Strategy/BalancedStrategy.js"
import { DefensiveStrategy } from "./Strategy/DefensiveStrategy.js"
import { LeekStrategy } from "./Strategy/LeekStrategy.js"

export class LeekProfile {
	public role = "BALANCED"
	public aggression = 50
	public preferredMinRange = 1
	public preferredMaxRange = 8
	public allowHealing = true
	public allowShielding = true
	public allowHiding = true
	public strategyName = "BALANCED"

	setRole(value: string): void {
		if (value === "ATTACKER") {
			value = "AGGRESSIVE"
		}
		if (value !== "AGGRESSIVE" && value !== "DEFENSIVE") {
			value = "BALANCED"
		}
		this.role = value
		this.strategyName = value
	}

	setAggression(value: number): void {
		this.aggression = Math.max(0, Math.min(100, value))
	}

	setPreferredRange(minRange: number, maxRange: number): void {
		this.preferredMinRange = Math.max(0, minRange)
		this.preferredMaxRange = Math.max(this.preferredMinRange, maxRange)
	}

	setSupportOptions(healing: boolean, shielding: boolean, hiding: boolean): void {
		this.allowHealing = healing
		this.allowShielding = shielding
		this.allowHiding = hiding
	}
}

/** Stratégie du rôle configuré (seuils de soin, bouclier, repli). */
export function createStrategy(profile: LeekProfile): LeekStrategy {
	if (profile.strategyName === "AGGRESSIVE") {
		return new AggressiveStrategy(profile.aggression)
	}
	if (profile.strategyName === "DEFENSIVE") {
		return new DefensiveStrategy(profile.aggression)
	}
	return new BalancedStrategy(profile.aggression)
}
