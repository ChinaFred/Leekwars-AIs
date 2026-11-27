// @version:5.8
// file version: 5
import { LeekStrategy } from "./LeekStrategy.js"

export class DefensiveStrategy extends LeekStrategy {
	constructor(aggressionValue = 50) {
		super("DEFENSIVE", aggressionValue)
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
		
		// DEFENSIVE: Zone control trap detection (more eager than aggressive)
		// If distance medium (<=7) AND moderately wounded (<=55%), MUST escape
		const isModeratelyWounded = lifeRatio <= 0.55 - 0.10 * this.getAggressionRatio()
		if (distance <= 7 && isModeratelyWounded) {
			return true
		}
		
		return false
	}
}
