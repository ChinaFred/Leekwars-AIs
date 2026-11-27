// @version:5.8
// file version: 6
/** Sous cette distance (Manhattan) à l'ennemi, le poireau est « trop près » pour `shouldHide`. */
export const MIN_SAFE_DISTANCE = 2

export class LeekStrategy {
	public name = "BALANCED"
	public aggression = 50

	constructor()
	constructor(strategyName: string)
	constructor(strategyName: string, aggressionValue: number)
	constructor(strategyName = "BALANCED", aggressionValue?: number) {
		this.name = strategyName
		if (aggressionValue !== undefined) {
			this.setAggression(aggressionValue)
		}
	}

	setAggression(value: number): void {
		this.aggression = Math.max(0, Math.min(100, value))
	}

	getAggressionRatio(): number {
		return this.aggression / 100.0
	}

	shouldHeal(_lifeRatio: number, lostLifeRatio: number): boolean {
		return lostLifeRatio >= 0.15 + 0.10 * this.getAggressionRatio()
	}

	shouldHealWithThreat(lifeRatio: number, lostLifeRatio: number, distance: number): boolean {
		const baseThreshold = 0.15 + 0.10 * this.getAggressionRatio()
		
		// Heal earlier if wounded enough AND enemy nearby (threat-aware)
		// Distance <= 10 (3 moves away) + moderate damage taken + moderate HP
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
		
		// CRITICAL FIX: Threat-aware preemptive retreat
		// Even if not "too close" by range, if distance is medium (<=8) AND critically wounded (<=45%)
		// we must retreat to corner to escape zone_control trap
		const isCriticallyWounded = lifeRatio <= 0.45 - 0.10 * this.getAggressionRatio()
		if (distance <= 8 && isCriticallyWounded) {
			return true
		}
		
		return false
	}
}
