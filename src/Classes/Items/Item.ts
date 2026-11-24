// @version:5.8
// file version: 1
import { Action } from "../Plannification/Action.js"
import { EffectsModel } from "./Effects.js"

export class ItemModel {
	readonly effects: EffectsModel

	constructor(readonly item: Weapon | Chip) {
		this.effects = new EffectsModel(item.features)
	}

	get id(): number { return this.item.id }
	get name(): string { return this.item.name }
	get cost(): number { return this.item.cost }
	get minRange(): number { return this.item.minRange }
	get maxRange(): number { return this.item.maxRange }
	get needsLos(): boolean { return this.item.needsLos }
	get weapon(): Weapon | null { return isChip(this.item) ? null : this.item }
	get chip(): Chip | null { return isChip(this.item) ? this.item : null }

	get meanDamage(): number {
		const effect = this.effects.damage
		return effect === null ? 0 : (effect.min + effect.max) / 2 * effect.repeat
	}

	get meanHeal(): number {
		const effect = this.effects.heal
		return effect === null ? 0 : (effect.min + effect.max) / 2
	}

	isWeapon(): boolean {
		return !isChip(this.item)
	}

	isChip(): boolean {
		return isChip(this.item)
	}

	getActionUse(me: Me, target: Entity): Action {
		const weapon = this.weapon
		if (weapon !== null) {
			return new Action("use weapon", () => me.useWeapon(target), `${this.name} on ${target.name}`)
		}
		const chip = this.chip
		if (chip === null) {
			throw new TypeError("ItemModel must wrap a weapon or chip")
		}
		return new Action("use chip", () => me.useChip(chip, target), `${this.name} on ${target.name}`)
	}

	getActionEquip(me: Me): Action {
		const weapon = this.weapon
		if (weapon === null) {
			throw new TypeError(`Cannot equip chip ${this.name}`)
		}
		return new Action("equip weapon", () => me.setWeapon(weapon), this.name)
	}
}

function isChip(item: Weapon | Chip): item is Chip {
	return "currentCooldown" in item
}
