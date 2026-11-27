// @version:5.8
// file version: 6
import { LeekStrategy, MIN_SAFE_DISTANCE } from "./LeekStrategy.js"

export class AggressiveStrategy extends LeekStrategy {
	constructor(aggressionValue = 50) {
		super("AGGRESSIVE", aggressionValue)
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

	shouldHide(lifeRatio: number, distance: number): boolean {
		const isTooClose = distance < MIN_SAFE_DISTANCE
		const isWounded = lifeRatio <= 0.30 - 0.15 * this.getAggressionRatio()
		
		if (isTooClose && isWounded) {
			return true
		}
		
		// Aggressive: hide only in extreme situations (distance=1 AND critical HP)
		if (distance <= 1 && lifeRatio <= 0.50) {
			return true
		}
		
		// AGGRESSIVE: Zone control trap detection
		// If distance medium (<=10) AND at panic levels (<=25%), MUST escape
		const isPanic = lifeRatio <= 0.25
		if (distance <= 10 && isPanic) {
			return true
		}
		
		return false
	}
}
