// @version:5.8
// file version: 1
export class LeekProfile {
	public role = "BALANCED"
	public aggression = 50
	public preferredMinRange = 1
	public preferredMaxRange = 8
	public allowHealing = true
	public allowShielding = true
	public allowHiding = true
	public strategyName = "BALANCED"

	setRole(value: string): void {
		if (value === "ATTACKER") {
			value = "AGGRESSIVE"
		}
		if (value !== "AGGRESSIVE" && value !== "DEFENSIVE") {
			value = "BALANCED"
		}
		this.role = value
		this.strategyName = value
	}

	setAggression(value: number): void {
		this.aggression = Math.max(0, Math.min(100, value))
	}

	setPreferredRange(minRange: number, maxRange: number): void {
		this.preferredMinRange = Math.max(0, minRange)
		this.preferredMaxRange = Math.max(this.preferredMinRange, maxRange)
	}

	setSupportOptions(healing: boolean, shielding: boolean, hiding: boolean): void {
		this.allowHealing = healing
		this.allowShielding = shielding
		this.allowHiding = hiding
	}
}
