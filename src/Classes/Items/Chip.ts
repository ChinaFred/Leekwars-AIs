// @version:5.8
// file version: 1
import { ItemModel } from "./Item.js"

export class ChipModel extends ItemModel {
	constructor(chip: Chip) {
		super(chip)
	}

	get currentCooldown(): number {
		const chip = this.chip
		if (chip === null) {
			throw new TypeError("ChipModel must wrap a chip")
		}
		return chip.currentCooldown
	}

	canReachCell(from: Cell, to: Cell): boolean {
		const chip = this.chip
		if (chip === null) {
			throw new TypeError("ChipModel must wrap a chip")
		}
		return Field.distance(from, to) >= this.minRange &&
			Field.distance(from, to) <= this.maxRange &&
			(!chip.needsLos || Field.lineOfSight(from, to))
	}

	static getHealingChips(chips: Iterable<Chip>): Chip[] {
		return [...chips].filter((chip) => chip.features.some((feature) => feature.type === Effect.HEAL))
	}

	static getDamagingChips(chips: Iterable<Chip>): Chip[] {
		return [...chips].filter((chip) => chip.features.some((feature) => feature.type === Effect.DAMAGE))
	}

	static getShieldChips(chips: Iterable<Chip>): Chip[] {
		return [...chips].filter((chip) => chip.features.some((feature) =>
			feature.type === Effect.ABSOLUTE_SHIELD || feature.type === Effect.RELATIVE_SHIELD
		))
	}
}
