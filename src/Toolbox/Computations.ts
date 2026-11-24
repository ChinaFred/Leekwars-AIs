// @version:5.8
// file version: 1
export function getAbsoluteShield(target: Entity): number {
	return Fight.me.level >= 38 ? target.absoluteShield : 0
}

export function getRelativeShield(target: Entity): number {
	return Fight.me.level >= 38 ? target.relativeShield : 0
}

export function getDamagesFromEffect(features: readonly Feature[]): number {
	for (const feature of features) {
		if (feature.type === Effect.DAMAGE) {
			return feature.minValue + (feature.minValue + feature.maxValue) / 2
		}
	}
	return 0
}

export function computePossibleDealtDamages(
	actor: Entity,
	target: Entity,
	gear: Weapon | Chip
): number {
	const targetAbsoluteShield = getAbsoluteShield(target) * (1 + target.agility / 100)
	const targetRelativeShield = Math.min(75, getRelativeShield(target) * target.agility / 50)
	const modifiedDamages = getDamagesFromEffect(gear.features) * (1 + actor.strength / 100)
	return Math.max(0, modifiedDamages * (1 - targetRelativeShield / 100) - targetAbsoluteShield)
}

export function isInsideWorld(x: number, y: number): boolean {
	return Math.abs(x) + Math.abs(y) <= 17
}
