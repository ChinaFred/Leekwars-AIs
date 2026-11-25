// @version:5.8
// file version: 2
import { Leek } from "../Leek.js"
import { ItemModel } from "../Items/Item.js"
import { ChipModel } from "../Items/Chip.js"
import { WeaponModel } from "../Items/Weapon.js"
import { isLogEnabled, log, LOG_CONTEXT } from "../../Toolbox/Logger.js"
import { ShootingOption } from "./ShootingOption.js"

export class ShootingOptions {
	options: ShootingOption[] = []

	exploreOptions(leek: Me, target = Fight.getNearestEnemy()): ShootingOption[] {
		this.options = []
		if (target === null) {
			return this.options
		}
		const reachable = new Leek(leek).getReachableCells()
		const items = [
			...leek.weapons.map((weapon) => new WeaponModel(weapon)),
			...ChipModel.getDamagingChips(leek.chips).map((chip) => new ChipModel(chip))
		]
		const orderedItems = ShootingOptions.orderDamagingItems(items)
		this.buildOptions(leek, target, reachable, orderedItems)
		if (this.options.length === 0) {
			this.addEquipForNextTurn(leek, target, orderedItems)
		}
		return this.options
	}

	buildOptions(
		leek: Me,
		target: Entity,
		reachableCells: Iterable<Cell>,
		items: ItemModel[]
	): ShootingOption[] {
		const reachableIds = new Set([...reachableCells].map((cell) => cell.id))
		for (const item of items) {
			const launchCells = item.weapon === null
				? (item.chip === null ? [] : leek.chipCells(item.chip, target))
				: Fight.weaponCells(target, item.weapon)
			if (!launchCells.some((cell) => reachableIds.has(cell.id))) {
				continue
			}

			if (item.weapon !== null) {
				const repeated = new ShootingOption(leek)
				this.getSameWeaponShootMultipleTimes(item, leek, target, repeated)
				this.options.push(repeated)
			}
			const combination = new ShootingOption(leek)
			this.getSameWeaponShootOnce(item, leek, target, combination)
			this.combineItems(items, item, leek, target, combination)
		}
		return this.options
	}

	private equipIfNeeded(item: ItemModel, leek: Me, option: ShootingOption): ShootingOption {
		const weapon = item.weapon
		if (weapon === null || option.equippedWeapon?.id === weapon.id) {
			return option
		}
		if (option.tpLeft < 1) {
			return option
		}
		const wrapper = new WeaponModel(weapon)
		option.actions.push(item.getActionEquip(leek))
		option.tpLeft--
		option.equippedWeapon = wrapper
		return option
	}

	private getSameWeaponShootMultipleTimes(
		item: ItemModel,
		leek: Me,
		target: Entity,
		option: ShootingOption
	): ShootingOption {
		const weapon = item.weapon
		if (weapon === null || item.cost <= 0) {
			return option
		}
		this.equipIfNeeded(item, leek, option)
		if (option.equippedWeapon?.id !== weapon.id) {
			return option
		}
		while (option.tpLeft >= item.cost) {
			option.actions.push(item.getActionUse(leek, target))
			option.tpLeft -= item.cost
			option.willShoot = true
			option.totalMeanDamages += item.meanDamage
		}
		option.usedItems.push(item)
		return option
	}

	private getSameWeaponShootOnce(
		item: ItemModel,
		leek: Me,
		target: Entity,
		option: ShootingOption
	): ShootingOption {
		if (item.cost <= 0) {
			return option
		}
		const weapon = item.weapon
		if (weapon !== null) {
			this.equipIfNeeded(item, leek, option)
			if (option.equippedWeapon?.id !== weapon.id) {
				return option
			}
		} else {
			const chip = item.chip
			if (chip === null || !leek.canUseChip(chip, target)) {
				return option
			}
		}
		if (option.tpLeft < item.cost) {
			return option
		}
		option.actions.push(item.getActionUse(leek, target))
		option.tpLeft -= item.cost
		option.willShoot = true
		option.usedItems.push(item)
		return option
	}

	private combineItems(
		items: ItemModel[],
		currentItem: ItemModel,
		leek: Me,
		target: Entity,
		option: ShootingOption
	): void {
		for (const item of items) {
			if (item === currentItem) {
				continue
			}
			const combination = new ShootingOption(option)
			if (item.weapon !== null) {
				this.getSameWeaponShootMultipleTimes(item, leek, target, combination)
			} else {
				this.getSameWeaponShootOnce(item, leek, target, combination)
			}
			if (combination.actions.length > option.actions.length) {
				this.options.push(combination)
			}
		}
	}

	private addEquipForNextTurn(leek: Me, target: Entity, items: ItemModel[]): void {
		const distance = Field.distance(leek.cell, target.cell)
		const candidate = items.find((item) =>
			item.weapon !== null &&
			item.cost <= leek.tp &&
			item.effects.damage !== null &&
			item.minRange <= distance &&
			item.maxRange + leek.mp * 2 >= distance
		)
		if (candidate === undefined) {
			return
		}
		const option = new ShootingOption(leek)
		this.equipIfNeeded(candidate, leek, option)
		if (option.equippedWeapon?.id === candidate.id) {
			this.options.push(option)
		}
	}

	static orderDamagingItems(items: ItemModel[]): ItemModel[] {
		return [...items].sort((a, b) => b.meanDamage - a.meanDamage)
	}

	static debugDamagingItems(items: ItemModel[], text = "damaging items"): void {
		if (!isLogEnabled(LOG_CONTEXT.SHOOTING)) {
			return
		}
		log(`------------------------------${text}`, LOG_CONTEXT.SHOOTING)
		for (const item of items) {
			log(`damaging item ${item.name} - mean damage: ${item.meanDamage}`, LOG_CONTEXT.SHOOTING)
		}
		log(`--------------------------FIN-${text}`, LOG_CONTEXT.SHOOTING)
	}

	debugShootingOptions(): void {
		if (!isLogEnabled(LOG_CONTEXT.SHOOTING)) {
			return
		}
		for (const option of this.options) {
			log("debut actions ----", LOG_CONTEXT.SHOOTING)
			for (const action of option.actions) {
				log(` action ${action.desc}`, LOG_CONTEXT.SHOOTING)
			}
			log("fin actions ----", LOG_CONTEXT.SHOOTING)
		}
	}
}
