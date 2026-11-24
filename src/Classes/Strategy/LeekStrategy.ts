// @version:5.8
// file version: 1
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
