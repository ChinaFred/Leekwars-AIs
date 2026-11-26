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
	readonly tp: number
	readonly wisdom: number
	readonly effects: Effect[]
	readonly launchedEffects: Effect[]
	distance(target: Entity): number
}

/**
 * Effet actif (doc : https://leekwars.com/help/documentation/getEffects et getLaunchedEffects, section TypeScript).
 * La doc nomme les champs mais ne précise pas si caster/item/target sont des objets ou des ids :
 * le type est volontairement l'union des deux et le code doit gérer les deux formes.
 */
interface Effect {
	readonly type: number
	readonly value: number
	readonly caster: Entity | number
	readonly turns: number
	readonly critical: boolean
	readonly item: Weapon | Chip | number
	readonly target: Entity | number
	readonly modifiers: number
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
	/** Type de lancer (LAUNCH_TYPE_*, `Item.LaunchType.*`) : documenté mais optionnel ici (absent des mocks). */
	readonly launchType?: number
	/** Type de zone d'effet (AREA_*, `Item.Area.*`). */
	readonly area?: number
	/** Utilisations maximales par tour, -1 = illimité (doc getWeaponMaxUses). */
	readonly maxUses?: number
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
	readonly cooldown: number
	readonly currentCooldown: number
	readonly minRange: number
	readonly maxRange: number
	readonly features: Feature[]
	readonly needsLos: boolean
	readonly launchType?: number
	readonly area?: number
	readonly maxUses?: number
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

/**
 * Doc officielle (https://leekwars.com/encyclopedia/en/JavaScript_and_TypeScript, singleton `Debug`) :
 * `mark(cells, color)`, `markText(cells, text)`, `show(cell)`, `clearMarks()`, `pause()`.
 * NON confirmé pour TypeScript : `log(value, color)` à 2 arguments (la page `debug` ne montre que `Debug.log(x)` ;
 * `debugC` n'existe qu'en LeekScript) et l'argument `color` de `markText` (documenté en LeekScript seulement).
 * Aucun équivalent TypeScript de `debugE`/`debugW` n'est documenté : non déclaré.
 */
interface DebugApi {
	log(value: unknown, color?: number): void
	mark(cells: Cell | Cell[], color: number): boolean
	markText(cells: Cell | Cell[], text: string, color?: number): boolean
	show(cell: Cell): void
	clearMarks(): void
	pause(): void
}

declare const Fight: FightApi

/** Classe officielle `Chest` (arbre des classes, doc JavaScript_and_TypeScript) : test par `instanceof`. */
declare const Chest: abstract new (...args: never[]) => Entity

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
	readonly POISON: number
	readonly HEAL: number
	readonly ABSOLUTE_SHIELD: number
	readonly RELATIVE_SHIELD: number
	readonly DEBUFF: number
	/** Nom non confirmé dans la doc TypeScript (EFFECT_RAW_BUFF_STRENGTH = 38 en LeekScript) : optionnel. */
	readonly RAW_BUFF_STRENGTH?: number
	readonly BUFF_STRENGTH: number
	readonly BUFF_AGILITY: number
	readonly BUFF_MP: number
	/** Nom non confirmé dans la doc TypeScript (TYPE_RAW_BUFF_MP = 31 dans `Effect.java` du générateur) : optionnel. */
	readonly RAW_BUFF_MP?: number
	readonly BUFF_TP: number
	/** Nom non confirmé dans la doc TypeScript (EFFECT_RAW_BUFF_TP = 32 en LeekScript) : optionnel. */
	readonly RAW_BUFF_TP?: number
}
