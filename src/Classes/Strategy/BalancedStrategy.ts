// @version:5.8
// file version: 6
import { LeekStrategy, MIN_SAFE_DISTANCE } from "./LeekStrategy.js"

export class BalancedStrategy extends LeekStrategy {
	constructor(aggressionValue = 50) {
		super("BALANCED", aggressionValue)
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

	shouldHide(lifeRatio: number, distance: number): boolean {
		const isTooClose = distance < MIN_SAFE_DISTANCE
		const isWounded = lifeRatio <= 0.55 - 0.20 * this.getAggressionRatio()
		
		// Hide if TOO CLOSE + WOUNDED (classic case)
		if (isTooClose && isWounded) {
			return true
		}
		
		// BALANCED: Threat-aware preemptive retreat (more aggressive than base)
		// If distance medium (<=8) AND critically wounded (<=40%), MUST escape zone_control
		const isCriticallyWounded = lifeRatio <= 0.40
		if (distance <= 8 && isCriticallyWounded) {
			return true
		}
		
		return false
	}
}
