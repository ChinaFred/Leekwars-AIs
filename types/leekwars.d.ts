interface Entity {
	readonly id: number
	readonly name: string
	readonly cell: Cell
	readonly life: number
	readonly maxLife: number
	readonly mp: number
	readonly weapon: Weapon | null
	readonly strength: number
	readonly agility: number
	readonly absoluteShield: number
	readonly relativeShield: number
	readonly level: number
	readonly science: number
	readonly magic: number
	readonly resistance: number
	readonly frequency: number
	readonly cores: number
	readonly ram: number
	readonly weapons: Weapon[]
	readonly chips: Chip[]
	distance(target: Entity): number
}

interface Cell {
	readonly id: number
	readonly x: number
	readonly y: number
	readonly empty: boolean
	readonly obstacle: boolean
	readonly entity: Entity | null
}

interface Weapon {
	readonly id: number
	readonly name: string
	readonly cost: number
	readonly minRange: number
	readonly maxRange: number
	readonly features: Feature[]
	readonly needsLos: boolean
}

interface Feature {
	readonly type: number
	readonly minValue: number
	readonly maxValue: number
	readonly turns: number
	readonly targets: number
	readonly modifiers: number
}

interface Chip {
	readonly id: number
	readonly name: string
	readonly cost: number
	readonly currentCooldown: number
	readonly minRange: number
	readonly maxRange: number
	readonly features: Feature[]
	readonly needsLos: boolean
}

interface Me extends Entity {
	readonly tp: number
	readonly weapons: Weapon[]
	readonly chips: Chip[]
	readonly strength: number
	readonly wisdom: number
	setWeapon(weapon: Weapon): boolean
	moveToward(target: Entity | Cell, mp?: number): number
	moveAwayFrom(target: Entity, mp?: number): number
	useWeapon(target: Entity): number
	useChip(chip: Chip, target: Entity): number
	canUseWeapon(target: Entity, weapon?: Weapon): boolean
	canUseChip(chip: Chip, target: Entity): boolean
	chipCells(chip: Chip, target: Entity): Cell[]
	say(message: string): void
}

interface FightApi {
	readonly me: Me
	readonly turn: number
	getNearestEnemy(): Entity | null
	getEnemies(): Entity[]
	getAliveEnemies(): Entity[]
	getAllies(): Entity[]
	weaponCells(target: Cell | Entity, weapon?: Weapon): Cell[]
	weaponTargets(cell: Cell | Entity, weapon?: Weapon): Entity[]
}

interface FieldApi {
	cellFromXY(x: number, y: number): Cell | null
	getObstacles(): Cell[]
	distance(from: Cell, to: Cell): number
	pathLength(from: Cell, to: Cell): number
	lineOfSight(from: Cell, to: Cell): boolean
}

interface DebugApi {
	log(value: unknown, color?: number): void
	mark(cells: Cell | Cell[], color: number): boolean
	pause(): void
}

declare const Fight: FightApi

declare const Field: FieldApi

declare const Debug: DebugApi

interface ColorApi {
	rgb(red: number, green: number, blue: number): number
}

interface SystemApi {
	readonly operations: number
	readonly maxOperations: number
	readonly instructionsCount: number
	readonly usedRAM: number
	readonly maxRAM: number
}

declare const Color: ColorApi

declare const System: SystemApi

declare const Weapon: {
	readonly pistol: Weapon
}

declare const Chip: {
	readonly bandage: Chip
}

declare const Effect: {
	readonly DAMAGE: number
	readonly HEAL: number
	readonly ABSOLUTE_SHIELD: number
	readonly RELATIVE_SHIELD: number
	readonly DEBUFF: number
	readonly BUFF_STRENGTH: number
	readonly BUFF_AGILITY: number
	readonly BUFF_MP: number
	readonly BUFF_TP: number
}
