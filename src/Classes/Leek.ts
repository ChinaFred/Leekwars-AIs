// @version:5.8
// file version: 2
import { Coordinates } from "./Context/Coordinates.js"
import { nearestEnemy } from "./Context/Targets.js"
import { World } from "./Context/World.js"
import { ItemModel } from "./Items/Item.js"
import { LeekProfile } from "./LeekProfile.js"

export class Leek {
	target: Entity | null = null
	readonly world: World

	constructor(
		readonly entity: Me = Fight.me,
		readonly profile = new LeekProfile(),
		world = new World()
	) {
		this.world = world
	}

	get id(): number { return this.entity.id }
	get name(): string { return this.entity.name }
	get life(): number { return this.entity.life }
	get totalLife(): number { return this.entity.maxLife }
	get strength(): number { return this.entity.strength }
	get wisdom(): number { return this.entity.wisdom }
	get agility(): number { return this.entity.agility }
	get resistance(): number { return this.entity.resistance }
	get science(): number { return this.entity.science }
	get magic(): number { return this.entity.magic }
	get frequency(): number { return this.entity.frequency }
	get cores(): number { return this.entity.cores }
	get ram(): number { return this.entity.ram }
	get mp(): number { return this.entity.mp }
	get tp(): number { return this.entity.tp }
	get cell(): Cell { return this.entity.cell }
	get coordinates(): Coordinates { return new Coordinates(this.cell) }
	get equippedWeapon(): Weapon | null { return this.entity.weapon }
	get equipedWeapon(): Weapon | null { return this.equippedWeapon }
	get weapons(): Weapon[] { return this.entity.weapons }
	get wearedWeapons(): Weapon[] { return this.weapons }
	get chips(): Chip[] { return this.entity.chips }
	get wearedChips(): Chip[] { return this.chips }
	get cooledChips(): Chip[] { return this.chips.filter((chip) => chip.currentCooldown === 0) }

	setTarget(target: Entity | null = nearestEnemy()): void {
		this.target = target
	}

	updateTargetFromFight(): void {
		if (this.target === null) {
			return
		}
		this.target = Fight.getEnemies().find((enemy) => enemy.id === this.target?.id) ?? null
	}

	getChipById(id: number): Chip | null {
		return this.chips.find((chip) => chip.id === id) ?? null
	}

	getDamagingItems(): ItemModel[] {
		return [
			...this.weapons.map((weapon) => new ItemModel(weapon)),
			...this.chips
				.filter((chip) => chip.features.some((feature) => feature.type === Effect.DAMAGE))
				.map((chip) => new ItemModel(chip))
		]
	}

	getUsableDamagingItems(
		distance: number,
		hasLos: boolean,
		leftTp: number,
		leftMp: number
	): ItemModel[] {
		return this.getDamagingItems().filter((item) =>
			item.cost <= leftTp &&
			item.effects.damage !== null &&
			item.minRange <= distance &&
			item.maxRange + leftMp >= distance &&
			(hasLos || !item.needsLos)
		)
	}

	getReachableCells(): Set<Cell> {
		const obstacles = new Set(this.world.obstacles.map((cell) => cell.id))
		return new Set(this.world.cells.filter((cell) =>
			!obstacles.has(cell.id) &&
			isReachable(this.cell, cell, this.mp)
		))
	}

	getReachableCoordinatesFromCell(from: Coordinates, mp: number): Set<Coordinates> {
		const start = from.cell
		if (start === null) {
			return new Set()
		}
		const obstacles = new Set(this.world.obstacles.map((cell) => cell.id))
		return new Set(this.world.cells
			.filter((cell) =>
				!obstacles.has(cell.id) &&
				isReachable(start, cell, mp)
			)
			.map((cell) => new Coordinates(cell)))
	}

	equipWeapon(weapon: Weapon): boolean {
		return this.entity.setWeapon(weapon)
	}

	equipWeaponById(id: number): boolean {
		const weapon = this.weapons.find((candidate) => candidate.id === id)
		return weapon === undefined ? false : this.equipWeapon(weapon)
	}

	shootOnTarget(target: Entity | null = this.target): number | null {
		if (!this.canUseWeaponOnTarget(target, this.tp)) {
			return null
		}
		if (target === null) return null
		return this.entity.useWeapon(target)
	}

	useChipOnTarget(chip: Chip, target: Entity | null = this.entity): number | null {
		if (!this.canUseChipOnTarget(chip, target, this.tp)) {
			return null
		}
		if (target === null) return null
		return this.entity.useChip(chip, target)
	}

	canUseWeaponOnTarget(target: Entity | null, availableTp = this.tp): boolean {
		const weapon = this.equippedWeapon
		return weapon !== null &&
			target !== null &&
			weapon.cost <= availableTp &&
			this.entity.canUseWeapon(target)
	}

	canUseChipOnTarget(chip: Chip | null, target: Entity | null, availableTp = this.tp): boolean {
		return chip !== null &&
			target !== null &&
			chip.cost <= availableTp &&
			this.entity.canUseChip(chip, target)
	}

	canShootOnTarget(): boolean {
		return this.canUseWeaponOnTarget(this.target, this.tp)
	}

	shoot(target: Entity | null = this.target): number | null {
		return this.shootOnTarget(target)
	}

	useChip(chip: Chip | null, target: Entity | null = this.entity): number | null {
		return chip === null ? null : this.useChipOnTarget(chip, target)
	}

	moveTowardTarget(target: Entity | null = this.target, mp = 1): number {
		return target === null || mp <= 0 ? 0 : this.entity.moveToward(target, mp)
	}

	moveTowardOneCell(cell: Cell): number {
		return this.entity.moveToward(cell)
	}

	fleeTarget(target: Entity | null = this.target): number {
		return target === null ? 0 : this.entity.moveAwayFrom(target)
	}

	play(ai: (me: Me) => void): void {
		ai(this.entity)
	}
}

function isReachable(from: Cell, to: Cell, movementPoints: number): boolean {
	if (from.id === to.id) {
		return true
	}
	const pathLength = Field.pathLength(from, to)
	return pathLength > 0 && pathLength <= movementPoints
}
