// @version:5.8
// file version: 3
import { LeekStrategy } from "./LeekStrategy.js"

export class AggressiveStrategy extends LeekStrategy {
	constructor(aggressionValue = 50) {
		super("AGGRESSIVE", aggressionValue)
	}

	scoreWeapon(damage: number, preferredMid: number, weaponMid: number): number {
		const rangePenalty = Math.abs(preferredMid - weaponMid) * (0.02 - 0.01 * this.getAggressionRatio())
		return damage - rangePenalty
	}

	shouldHeal(lifeRatio: number, _lostLifeRatio: number): boolean {
		return lifeRatio <= 0.40 - 0.15 * this.getAggressionRatio()
	}

	shouldHealWithThreat(lifeRatio: number, _lostLifeRatio: number, distance: number): boolean {
		// Aggressive: heal only if critical HP, even with threat nearby
		if (distance <= 10 && lifeRatio <= 0.50) {
			return true
		}
		return lifeRatio <= 0.40 - 0.15 * this.getAggressionRatio()
	}

	shouldShield(lifeRatio: number, distance: number, threatRange: number): boolean {
		return lifeRatio <= 0.45 - 0.15 * this.getAggressionRatio() && distance <= threatRange
	}

	shouldHide(lifeRatio: number, distance: number, preferredMinRange: number): boolean {
		const minSafeDistance = Math.max(2, preferredMinRange - 1)
		const isTooClose = distance < minSafeDistance
		const isWounded = lifeRatio <= 0.30 - 0.15 * this.getAggressionRatio()
		
		if (isTooClose && isWounded) {
			return true
		}
		
		// Aggressive: hide only in extreme situations (distance=1 AND critical HP)
		if (distance <= 1 && lifeRatio <= 0.50) {
			return true
		}
		
		return false
	}

	shouldUseAttackChip(lifeRatio: number): boolean {
		return lifeRatio >= 0.45 - 0.25 * this.getAggressionRatio()
	}
}
