// @version:5.8
// file version: 1
import { LeekProfile } from "../LeekProfile.js"
import { AggressiveStrategy } from "./AggressiveStrategy.js"
import { BalancedStrategy } from "./BalancedStrategy.js"
import { DefensiveStrategy } from "./DefensiveStrategy.js"
import { LeekStrategy } from "./LeekStrategy.js"

/** Stratégie du rôle configuré (seuils de soin, bouclier, repli), sans instancier `Plannification`. */
export function createStrategy(profile: LeekProfile): LeekStrategy {
	if (profile.strategyName === "AGGRESSIVE") {
		return new AggressiveStrategy(profile.aggression)
	}
	if (profile.strategyName === "DEFENSIVE") {
		return new DefensiveStrategy(profile.aggression)
	}
	return new BalancedStrategy(profile.aggression)
}
