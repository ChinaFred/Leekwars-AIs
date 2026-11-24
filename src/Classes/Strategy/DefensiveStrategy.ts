// @version:5.8
// file version: 3
import { LeekStrategy } from "./LeekStrategy.js"

export class DefensiveStrategy extends LeekStrategy {
	constructor(aggressionValue = 50) {
		super("DEFENSIVE", aggressionValue)
	}

	scoreWeapon(damage: number, preferredMid: number, weaponMid: number): number {
		const rangePenalty = Math.abs(preferredMid - weaponMid) * (0.07 - 0.015 * this.getAggressionRatio())
		return damage - rangePenalty
	}

	shouldHeal(lifeRatio: number, lostLifeRatio: number): boolean {
		return lifeRatio <= 0.90 - 0.15 * this.getAggressionRatio() || lostLifeRatio >= 0.35
	}

	shouldHealWithThreat(lifeRatio: number, lostLifeRatio: number, distance: number): boolean {
		// Defensive: already eager to heal, but even more so with threat nearby
		if (distance <= 10 && lifeRatio <= 0.80 && lostLifeRatio >= 0.08) {
			return true
		}
		return lifeRatio <= 0.90 - 0.15 * this.getAggressionRatio() || lostLifeRatio >= 0.35
	}

	shouldShield(lifeRatio: number, distance: number, threatRange: number): boolean {
		return distance <= threatRange + 1 && lifeRatio <= 0.98 - 0.10 * this.getAggressionRatio()
	}

	shouldHide(lifeRatio: number, distance: number, preferredMinRange: number): boolean {
		const minSafeDistance = Math.max(2, preferredMinRange - 1)
		const isTooClose = distance < minSafeDistance
		const isWounded = lifeRatio <= 0.80 - 0.10 * this.getAggressionRatio()
		
		if (isTooClose && isWounded) {
			return true
		}
		
		// Defensive: hide eagerly if very close AND somewhat wounded (<=75%)
		if (distance <= 2 && lifeRatio <= 0.75) {
			return true
		}
		
		return false
	}

	shouldUseAttackChip(lifeRatio: number): boolean {
		return lifeRatio >= 0.75 - 0.20 * this.getAggressionRatio()
	}
}
