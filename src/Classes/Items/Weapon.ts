// @version:5.8
// file version: 1
import { ItemModel } from "./Item.js"

export class WeaponModel extends ItemModel {
	constructor(weapon: Weapon) {
		super(weapon)
	}

	getTurnDamage(tp: number, strength = 0): number {
		if (this.cost <= 0) {
			return 0
		}
		return this.meanDamage * (1 + strength / 100) * Math.floor(tp / this.cost)
	}

	fromWhereToUse(target: Entity, reachableCells: Iterable<Cell>): Set<Cell> {
		const weapon = this.weapon
		if (weapon === null) {
			throw new TypeError("WeaponModel must wrap a weapon")
		}
		const reachable = new Set([...reachableCells].map((cell) => cell.id))
		return new Set(Fight.weaponCells(target, weapon)
			.filter((cell) => reachable.has(cell.id)))
	}
}
