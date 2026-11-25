// @version:5.8
// file version: 2
import { Coordinates } from "../Context/Coordinates.js"
import { ItemModel } from "../Items/Item.js"
import { WeaponModel } from "../Items/Weapon.js"
import { isLogEnabled, log, LOG_CONTEXT } from "../../Toolbox/Logger.js"
import { Action } from "./Action.js"

export class ShootingOption {
	actions: Action[] = []
	usedItems: ItemModel[] = []
	rejected: string[] = []
	tpLeft: number
	mpLeft: number
	cellToShootFrom: Coordinates
	willShoot = false
	totalMeanDamages = 0
	equippedWeapon: WeaponModel | null

	constructor(leek: Me)
	constructor(previousOption: ShootingOption)
	constructor(source: Me | ShootingOption) {
		if (source instanceof ShootingOption) {
			this.actions = [...source.actions]
			this.usedItems = [...source.usedItems]
			this.rejected = [...source.rejected]
			this.tpLeft = source.tpLeft
			this.mpLeft = source.mpLeft
			this.cellToShootFrom = source.cellToShootFrom
			this.willShoot = source.willShoot
			this.totalMeanDamages = source.totalMeanDamages
			this.equippedWeapon = source.equippedWeapon
			return
		}

		this.tpLeft = source.tp
		this.mpLeft = source.mp
		this.cellToShootFrom = new Coordinates(source.cell)
		this.equippedWeapon = source.weapon === null ? null : new WeaponModel(source.weapon)
	}

	static buildDamagingItemsTable(leek: Me): ItemModel[] {
		const items = [
			...leek.weapons.map((weapon) => new ItemModel(weapon)),
			...leek.chips
				.filter((chip) => chip.features.some((feature) => feature.type === Effect.DAMAGE))
				.map((chip) => new ItemModel(chip))
		]
		const potentialAttacks: ItemModel[] = []
		for (const item of items) {
			if (item.cost <= 0) {
				continue
			}
			for (let use = 0; use < Math.floor(leek.tp / item.cost); use++) {
				potentialAttacks.push(item)
			}
		}
		return potentialAttacks
	}

	debugUsedItems(): void {
		if (!isLogEnabled(LOG_CONTEXT.SHOOTING)) {
			return
		}
		log("used items in shooting option", LOG_CONTEXT.SHOOTING)
		for (const item of this.usedItems) {
			log(item.name, LOG_CONTEXT.SHOOTING)
		}
	}
}
