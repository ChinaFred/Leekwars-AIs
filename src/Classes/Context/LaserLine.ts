// @version:5.8
// file version: 1

/**
 * Laser (zone « ligne » du moteur, `AreaLaserLine`) : module pur, sans appel au jeu (`cellAt` et `kindOf` sont fournis).
 *
 * Le moteur (leek-wars-generator, `AreaLaserLine.getArea`) part de la case du tireur et avance d'un pas dans la direction
 * de la case visée (axe x ou y commun ; sinon zone vide ; même case : vers le bas), de `minRange` à `maxRange` inclus. Il
 * s'arrête hors carte, et sur une case non praticable seulement si l'arme exige la ligne de vue. Toute entité sur une
 * case de la ligne est touchée, devant ou derrière la cible, alliés, invocations et coffres compris ; pas d'atténuation.
 *
 * HYPOTHÈSES non vérifiées en combat : `AREA_LASER_LINE` = 2 (`Area.java` ; la valeur 13 est `FIRST_IN_LINE`) et
 * `Weapon.area` de l'API TypeScript porte cette valeur ; `Cell.obstacle` = case non praticable du moteur ;
 * `Cell.entity` renvoie l'entité vivante de la case.
 */
export const AREA_LASER_LINE = 2

export type LaserKind = "enemy" | "ally" | "chest" | "self"

export interface LaserItem {
	readonly area?: number
	readonly minRange: number
	readonly maxRange: number
	readonly needsLos: boolean
}

export interface LaserHits {
	readonly enemies: readonly Entity[]
	/** Alliés et invocations (tout ce qui n'est ni ennemi, ni coffre, ni le tireur). */
	readonly allies: readonly Entity[]
	readonly chests: readonly Entity[]
}

export function isLaser(item: { readonly area?: number }): boolean {
	return item.area === AREA_LASER_LINE
}

/** Cases touchées en tirant de `from` vers `aim` ; vide si les deux cases ne sont pas alignées. */
export function laserLine(
	from: Cell, aim: Cell, item: LaserItem, cellAt: (x: number, y: number) => Cell | null
): Cell[] {
	if (!Number.isFinite(item.maxRange)) return []
	let dx = 0
	let dy = 0
	if (from.x === aim.x) dy = from.y > aim.y ? -1 : 1
	else if (from.y === aim.y) dx = from.x > aim.x ? -1 : 1
	else return []
	const line: Cell[] = []
	for (let i = Math.max(0, item.minRange); i <= item.maxRange; i++) {
		const cell = cellAt(from.x + dx * i, from.y + dy * i)
		if (cell === null || (item.needsLos && cell.obstacle)) break
		line.push(cell)
	}
	return line
}

/** Entités vivantes des cases de la ligne, classées ; le tireur (`self`) n'est jamais compté. */
export function laserHits(line: readonly Cell[], kindOf: (entity: Entity) => LaserKind): LaserHits {
	const enemies: Entity[] = []
	const allies: Entity[] = []
	const chests: Entity[] = []
	for (const cell of line) {
		const entity = cell.entity ?? null
		if (entity === null || !(entity.life > 0)) continue
		const kind = kindOf(entity)
		if (kind === "enemy") enemies.push(entity)
		else if (kind === "ally") allies.push(entity)
		else if (kind === "chest") chests.push(entity)
	}
	return { enemies, allies, chests }
}

/**
 * Valeur nette des touches COLLATÉRALES de `shots` tirs : dégâts utiles sur les autres ennemis moins dégâts sur les alliés,
 * chacun borné à ses PV (un allié tué compte pour tous ses PV). `damageOn` : dégâts d'un tir sur l'entité (boucliers
 * compris) ; `primary` : la cible principale, déjà comptée par l'appelant. Les coffres ne sont pas évalués ici : l'appelant
 * écarte tout tir qui en touche un.
 */
export function laserBalance(
	hits: LaserHits, shots: number, damageOn: (entity: Entity) => number, primary: Entity
): number {
	let total = 0
	for (const enemy of hits.enemies) {
		if (enemy.id !== primary.id) total += Math.min(enemy.life, shots * damageOn(enemy))
	}
	for (const ally of hits.allies) total -= Math.min(ally.life, shots * damageOn(ally))
	return total
}
