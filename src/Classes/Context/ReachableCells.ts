// @version:5.8
// file version: 2

/**
 * Hypothèse (non vérifiée en combat réel) : un déplacement de 1 PM va vers un voisin orthogonal,
 * (x ± 1, y) ou (x, y ± 1) : 4-connexité, pas de diagonale. C'est la seule définition du voisinage
 * utilisée par ce module ; la changer ici suffit à changer la forme de la zone atteignable.
 */
export const MOVE_NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]]

/**
 * Plafond de sécurité sur le nombre de cases atteignables retenues (donc de cases développées) par calcul.
 * La carte de combat compte 613 cases au plus (losange de rayon 17) ; 500 couvre un losange complet
 * jusqu'à 15 PM (481 cases). Au-delà, le résultat est tronqué (`truncated` = true) : il contient alors
 * toutes les cases de coût < c et seulement une partie de celles de coût c (parcours en largeur).
 */
export const MAX_REACHABLE_CELLS = 500

/** Clé numérique d'une case : x * 4096 + y (unique tant que |y| < 2048 ; la carte va de -17 à 17). */
const KEY_STRIDE = 4096

function cellKey(x: number, y: number): number {
	return x * KEY_STRIDE + y
}

/** Case atteignable et son coût (nombre de PM pour y arriver, 0 pour la case de départ). */
export interface ReachableCell {
	readonly cell: Cell
	readonly cost: number
}

/** PM exploitable : entier >= 0 (NaN, valeur absente ou négative → 0). */
function sanitizeMp(mp: number): number {
	return Number.isFinite(mp) && mp > 0 ? Math.floor(mp) : 0
}

/**
 * Cases atteignables par une entité en `mp` pas depuis `startCell`. Résultat immuable en pratique :
 * construit par `computeReachableCells`.
 */
export class ReachableCells {
	/** PM effectivement utilisés pour le calcul (après assainissement). */
	readonly mp: number
	/** Tour de combat du calcul. */
	readonly turn: number
	readonly entityId: number
	readonly startCell: Cell
	/** true si le plafond `MAX_REACHABLE_CELLS` a coupé le parcours (résultat partiel). */
	readonly truncated: boolean
	private readonly byKey: ReadonlyMap<number, ReachableCell>

	constructor(
		entityId: number,
		startCell: Cell,
		mp: number,
		turn: number,
		byKey: ReadonlyMap<number, ReachableCell>,
		truncated: boolean
	) {
		this.entityId = entityId
		this.startCell = startCell
		this.mp = mp
		this.turn = turn
		this.byKey = byKey
		this.truncated = truncated
	}

	/** Nombre de cases atteignables (case de départ incluse). */
	get size(): number {
		return this.byKey.size
	}

	/** Cases atteignables avec leur coût, par coût croissant (ordre du parcours en largeur). */
	entries(): IterableIterator<ReachableCell> {
		return this.byKey.values()
	}

	cells(): Cell[] {
		const cells: Cell[] = []
		for (const reachable of this.byKey.values()) {
			cells.push(reachable.cell)
		}
		return cells
	}

	canReach(cell: Cell): boolean {
		return this.byKey.has(cellKey(cell.x, cell.y))
	}

	/** Coût en PM pour atteindre la case, null si elle n'est pas atteignable. */
	costTo(cell: Cell): number | null {
		return this.byKey.get(cellKey(cell.x, cell.y))?.cost ?? null
	}

	/** Mêmes entrées de calcul (entité, case de départ, PM, tour) : le résultat serait identique. */
	isUpToDate(entityId: number, startCell: Cell, mp: number, turn: number): boolean {
		return this.entityId === entityId &&
			this.startCell.x === startCell.x &&
			this.startCell.y === startCell.y &&
			this.mp === sanitizeMp(mp) &&
			this.turn === turn
	}
}

/** Options de `computeReachableCells`. */
export interface ReachableOptions {
	/** Id d'une entité à ne pas traiter comme obstacle. */
	readonly ignoreEntityId?: number
}

/**
 * Parcours en largeur depuis `entity.cell`, au plus `mp` pas (4-connexité, voir MOVE_NEIGHBOR_OFFSETS).
 * Case traversable : dans la grille (`Field.cellFromXY` ≠ null), ni obstacle (`Cell.obstacle`), ni occupée
 * par une autre entité (`Cell.entity`, alliée ou ennemie : hypothèse qu'une entité bloque le passage).
 * La case de départ est toujours incluse (coût 0). On n'utilise pas `Cell.empty` (sens vis-à-vis des
 * entités non vérifié) ni `Field.pathLength`.
 *
 * Coût : chaque case atteinte est développée une fois ; chaque coordonnée n'est demandée qu'une fois à
 * `Field.cellFromXY` (accepter ou rejeter est mémorisé), soit au plus ~4 appels par case atteinte
 * (au plus 4 × MAX_REACHABLE_CELLS). Aucun appel à `Field.pathLength`.
 *
 * `options.ignoreEntityId` : la case occupée par cette entité est traversable (comme si elle partait).
 * Sert à la carte de danger : je quitte potentiellement ma case, qui se libère pour l'ennemi. Sans option,
 * comportement inchangé.
 */
export function computeReachableCells(
	entity: Entity,
	mp: number,
	turn: number = Fight.turn,
	options: ReachableOptions = {}
): ReachableCells {
	const ignoreId = options.ignoreEntityId
	const steps = sanitizeMp(mp)
	const start = entity.cell
	const reached = new Map<number, ReachableCell>()
	const queue: ReachableCell[] = []
	const seen = new Set<number>()

	const origin: ReachableCell = { cell: start, cost: 0 }
	const startKey = cellKey(start.x, start.y)
	reached.set(startKey, origin)
	seen.add(startKey)
	queue.push(origin)

	let truncated = false
	search:
	for (let head = 0; head < queue.length; head++) {
		const current = queue[head] as ReachableCell
		if (current.cost >= steps) {
			// File par coût croissant : plus rien à développer.
			break
		}
		for (const [dx, dy] of MOVE_NEIGHBOR_OFFSETS) {
			const x = current.cell.x + dx
			const y = current.cell.y + dy
			const key = cellKey(x, y)
			if (seen.has(key)) {
				continue
			}
			seen.add(key)
			const cell = Field.cellFromXY(x, y)
			if (cell === null || cell.obstacle) {
				continue
			}
			const blocker = cell.entity
			if (blocker !== null && blocker.id !== entity.id && blocker.id !== ignoreId) {
				continue
			}
			if (queue.length >= MAX_REACHABLE_CELLS) {
				truncated = true
				break search
			}
			const next: ReachableCell = { cell, cost: current.cost + 1 }
			reached.set(key, next)
			queue.push(next)
		}
	}

	return new ReachableCells(entity.id, start, steps, turn, reached, truncated)
}
