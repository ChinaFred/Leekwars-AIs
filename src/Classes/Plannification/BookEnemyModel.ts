// @version:5.8
// file version: 1

/**
 * Hypothèses sur l'adversaire aux tours SIMULÉS (le tour 1 lit la carte de danger du jeu). Isolées ici : remplacer
 * `EnemyMover` ou `futureDangerOf` change l'hypothèse sans toucher au faisceau.
 */

/** Position de l'ennemi après son tour, sachant que je finis le mien sur `me`. */
export type EnemyMover = (enemy: { cell: Cell; mp: number }, me: Cell) => Cell

/** Hypothèse « il reste là ». */
export const stayStill: EnemyMover = (enemy) => enemy.cell

/**
 * Hypothèse par défaut : il avance vers moi de ses PM, un pas à la fois sur l'axe de plus grand écart (puis l'autre),
 * sans entrer dans un obstacle ni une case occupée, et s'arrête au contact. Non vérifiée en combat.
 */
export const advanceTowardMe: EnemyMover = (enemy, me) => {
	let cell = enemy.cell
	for (let step = 0; step < enemy.mp; step++) {
		const dx = me.x - cell.x
		const dy = me.y - cell.y
		if (Math.abs(dx) + Math.abs(dy) <= 1) break
		const axes: Array<[number, number]> = Math.abs(dx) >= Math.abs(dy)
			? [[Math.sign(dx), 0], [0, Math.sign(dy)]] : [[0, Math.sign(dy)], [Math.sign(dx), 0]]
		let moved = false
		for (const [sx, sy] of axes) {
			if (sx === 0 && sy === 0) continue
			const next = Field.cellFromXY(cell.x + sx, cell.y + sy)
			if (next !== null && !next.obstacle && next.entity === null) { cell = next; moved = true; break }
		}
		if (!moved) break
	}
	return cell
}

/**
 * Danger d'une case hors de la carte du tour 1 : celui de la case connue la plus proche (Manhattan). Hypothèse simple :
 * la menace dépend surtout de la distance aux ennemis, pas de la case exacte.
 */
export function futureDangerOf(known: ReadonlyMap<number, { cell: Cell; danger: number }>): (cell: Cell) => number {
	const memo = new Map<number, number>()
	return (cell) => {
		const key = cell.x * 4096 + cell.y
		const direct = known.get(key)
		if (direct !== undefined) return direct.danger
		let value = memo.get(key)
		if (value === undefined) {
			let best = Infinity
			value = 0
			for (const entry of known.values()) {
				const distance = Math.abs(entry.cell.x - cell.x) + Math.abs(entry.cell.y - cell.y)
				if (distance < best) { best = distance; value = entry.danger }
			}
			memo.set(key, value)
		}
		return value
	}
}
