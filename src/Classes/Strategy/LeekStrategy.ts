// @version:5.8
// file version: 3
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

	scoreWeapon(damage: number, preferredMid: number, weaponMid: number): number {
		const rangePenalty = Math.abs(preferredMid - weaponMid) * (0.045 - 0.015 * this.getAggressionRatio())
		return damage - rangePenalty
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

	shouldHide(lifeRatio: number, distance: number, preferredMinRange: number): boolean {
		const minSafeDistance = Math.max(2, preferredMinRange - 1)
		const isTooClose = distance < minSafeDistance
		const isWounded = lifeRatio <= 0.55 - 0.20 * this.getAggressionRatio()
		
		// Hide if TOO CLOSE + WOUNDED (classic case)
		if (isTooClose && isWounded) {
			return true
		}
		
		// ALSO hide if VERY CLOSE (<=2) AND MODERATELY WOUNDED (<=70%)
		// This handles incoming threats before they deal critical damage
		if (distance <= 2 && lifeRatio <= 0.70) {
			return true
		}
		
		return false
	}

	shouldUseAttackChip(lifeRatio: number): boolean {
		return lifeRatio >= 0.50 - 0.20 * this.getAggressionRatio()
	}

	shouldSkipHealForDamage(healingCost: number, meanHealing: number, tpLeft: number, meanDamagePerTp: number): boolean {
		if (meanDamagePerTp <= 0 || tpLeft <= 0) return false
		const potentialDamage = meanDamagePerTp * healingCost
		return potentialDamage > meanHealing * 2
	}
}
