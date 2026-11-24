// @version:5.8
// file version: 2
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

	shouldShield(lifeRatio: number, distance: number, threatRange: number): boolean {
		return lifeRatio <= 0.45 - 0.15 * this.getAggressionRatio() && distance <= threatRange
	}

	shouldHide(lifeRatio: number, distance: number, preferredMinRange: number): boolean {
		const minSafeDistance = Math.max(2, preferredMinRange - 1)
		const isTooClose = distance < minSafeDistance
		const isWounded = lifeRatio <= 0.30 - 0.15 * this.getAggressionRatio()
		return isTooClose && isWounded
	}

	shouldUseAttackChip(lifeRatio: number): boolean {
		return lifeRatio >= 0.45 - 0.25 * this.getAggressionRatio()
	}
}
