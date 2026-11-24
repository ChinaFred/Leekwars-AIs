// @version:5.8
// file version: 1
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

	shouldShield(lifeRatio: number, distance: number, threatRange: number): boolean {
		return distance <= threatRange && lifeRatio <= 0.95 - 0.20 * this.getAggressionRatio()
	}

	shouldHide(lifeRatio: number, mpLeft: number): boolean {
		return mpLeft > 0 && lifeRatio <= 0.55 - 0.20 * this.getAggressionRatio()
	}

	shouldUseAttackChip(lifeRatio: number): boolean {
		return lifeRatio >= 0.50 - 0.20 * this.getAggressionRatio()
	}
}
