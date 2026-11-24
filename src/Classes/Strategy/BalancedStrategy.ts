// @version:5.8
// file version: 3
import { LeekStrategy } from "./LeekStrategy.js"

export class BalancedStrategy extends LeekStrategy {
	constructor(aggressionValue = 50) {
		super("BALANCED", aggressionValue)
	}

	scoreWeapon(damage: number, preferredMid: number, weaponMid: number): number {
		const rangePenalty = Math.abs(preferredMid - weaponMid) * (0.045 - 0.015 * this.getAggressionRatio())
		return damage - rangePenalty
	}

	shouldHeal(_lifeRatio: number, lostLifeRatio: number): boolean {
		return lostLifeRatio >= 0.15 + 0.10 * this.getAggressionRatio()
	}

	shouldHealWithThreat(lifeRatio: number, lostLifeRatio: number, distance: number): boolean {
		const baseThreshold = 0.15 + 0.10 * this.getAggressionRatio()
		
		// Balanced: heal earlier if wounded enough AND enemy nearby
		if (distance <= 10 && lifeRatio <= 0.70 && lostLifeRatio >= 0.10) {
			return true
		}
		
		return lostLifeRatio >= baseThreshold
	}

	shouldShield(lifeRatio: number, distance: number, threatRange: number): boolean {
		return distance <= threatRange && lifeRatio <= 0.95 - 0.20 * this.getAggressionRatio()
	}

	shouldHide(lifeRatio: number, distance: number, preferredMinRange: number): boolean {
		const minSafeDistance = Math.max(2, preferredMinRange - 1)
		const isTooClose = distance < minSafeDistance
		const isWounded = lifeRatio <= 0.55 - 0.20 * this.getAggressionRatio()
		return isTooClose && isWounded
	}

	shouldUseAttackChip(lifeRatio: number): boolean {
		return lifeRatio >= 0.50 - 0.20 * this.getAggressionRatio()
	}
}
