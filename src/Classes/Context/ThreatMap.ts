// @version:5.8
// file version: 2
import { isCellInLaunchPattern } from "./LaunchPattern.js"
import { ReachableCells } from "./ReachableCells.js"
import {
	EMPTY_PLAN,
	planShots,
	ShotCandidate,
	ShotItem,
	ShotPlan,
	sortByRatio,
	toCandidate
} from "./ShotPlan.js"

/**
 * Garde-fou : nombre maximal de paires (case de tir S de l'ennemi, ma case X) examinées par carte, tous
 * ennemis confondus. Cas courant : 41 cases (4 PM) × 25 cases (3 PM) ≈ 1 000 paires par ennemi. Une paire
 * coûte quelques appels de `canHit` (un par item offensif) et un calcul de plan ; non mesuré en ops réelles.
 * Au-delà, la carte est marquée `truncated` : seules les cases de X entièrement évaluées (pour tous les
 * ennemis) sont conservées, les autres sont absentes (donc jamais présentées comme « sûres »).
 */
export const MAX_THREAT_PAIRS = 8000

/**
 * Fournisseur de « cases de tir » : point d'échange pour une implémentation native future
 * (`Fight.weaponCells(cell, item)`, mise en cache par (case, item)). Seule la version géométrique
 * (`GeometricShotCells`) existe aujourd'hui.
 */
export interface ShotCellsProvider {
	/** Un tir de `item` lancé depuis `from` peut-il toucher `target` (tir direct, sans zone d'effet) ? */
	canHit(from: Cell, target: Cell, item: ShotItem): boolean
	/** Appels à `Field.lineOfSight` réellement effectués (statistique, optionnelle). */
	readonly lineOfSightCalls?: number
}

/** Clé numérique d'une paire ordonnée de cases (coordonnées décalées pour rester positives). */
function pairKey(from: Cell, to: Cell): number {
	const a = (from.x + 1024) * 2048 + (from.y + 1024)
	const b = (to.x + 1024) * 2048 + (to.y + 1024)
	return a * 4194304 + b
}

/**
 * Méthode géométrique : distance de Manhattan |dx| + |dy| dans [minRange, maxRange], motif du type de
 * lancer (`isCellInLaunchPattern`, hypothèse de masque), puis — seulement si `item.needsLos` et seulement
 * après ces deux filtres — `Field.lineOfSight(from, target)`, mémorisée par paire ordonnée (S, X) pour la
 * durée de vie de l'instance (une construction de carte). Hypothèse non vérifiée : `Field.lineOfSight` ne
 * tient compte que des obstacles de la grille, pas des entités ; dans le jeu une entité peut bloquer la vue.
 * `launchType` absent → CIRCLE. Ignore la zone d'effet (`area`).
 */
export class GeometricShotCells implements ShotCellsProvider {
	lineOfSightCalls = 0
	private readonly sight = new Map<number, boolean>()

	canHit(from: Cell, target: Cell, item: ShotItem): boolean {
		const dx = target.x - from.x
		const dy = target.y - from.y
		const distance = Math.abs(dx) + Math.abs(dy)
		if (distance < item.minRange || distance > item.maxRange) {
			return false
		}
		if (!isCellInLaunchPattern(item.launchType, dx, dy)) {
			return false
		}
		if (!item.needsLos) {
			return true
		}
		const key = pairKey(from, target)
		let visible = this.sight.get(key)
		if (visible === undefined) {
			this.lineOfSightCalls++
			visible = Field.lineOfSight(from, target) === true
			this.sight.set(key, visible)
		}
		return visible
	}
}

/** Ce qu'un ennemi sait faire, fourni à `buildThreatMap` (préparé par `EnemyMemory.updateThreatMap`). */
export interface ThreatEnemy {
	readonly id: number
	readonly name: string
	/** Force actuelle (hypothèse : inclut déjà les buffs en cours ; BUFF_STRENGTH n'est pas ajouté). */
	readonly strength: number
	/** PT disponibles pour son prochain tour (hypothèse : maximum de `entity.tp` observé). */
	readonly tp: number
	/** Arme ÉQUIPÉE (seule arme considérée). */
	readonly weapon: Weapon | null
	/** Puces connues et PRÊTES (cooldown déjà filtré par l'appelant) ; seules celles avec dégâts comptent. */
	readonly chips: readonly Chip[]
	/** Cases atteignables par l'ennemi EN IGNORANT mon entité comme obstacle. */
	readonly reachable: ReachableCells
}

/** Meilleur plan d'un ennemi contre une case X (détail conservé pour chaque ennemi). */
export interface EnemyThreat {
	readonly enemyId: number
	readonly name: string
	/** Dégâts potentiels du plan retenu (> 0). */
	readonly damage: number
	/** Case de tir S retenue (la moins coûteuse en PM parmi les ex æquo). */
	readonly shotCell: Cell
	/** Arme du plan (null si le plan n'utilise que des puces). */
	readonly weapon: Weapon | null
	readonly weaponShots: number
	readonly chips: readonly Chip[]
}

/** Une case que je peux atteindre, avec son danger. */
export interface ThreatCell {
	readonly cell: Cell
	/** PM que je dois dépenser pour y arriver (0 = ma case actuelle). */
	readonly mpCost: number
	/** Somme, sur les ennemis, de leurs meilleurs dégâts potentiels sur cette case. */
	readonly danger: number
	readonly breakdown: readonly EnemyThreat[]
}

export interface ThreatMapOptions {
	readonly provider?: ShotCellsProvider
	readonly maxPairs?: number
}

function cellKey(cell: Cell): number {
	return cell.x * 4096 + cell.y
}

/**
 * Carte de danger de mon poireau pour un tour : une entrée par case que je peux atteindre (case actuelle
 * incluse). Immuable en pratique, remplacée à chaque tour (pas d'accumulation).
 */
export class ThreatMap {
	readonly entityId: number
	readonly turn: number
	/** true si `MAX_THREAT_PAIRS` (ou `maxPairs`) a coupé le calcul : cases non évaluées absentes. */
	readonly truncated: boolean
	/** true si une `ReachableCells` en entrée (la mienne ou celle d'un ennemi) était elle-même tronquée. */
	readonly inputsTruncated: boolean
	/** Ennemis pris en compte (ceux sans item offensif utilisable sont comptés mais n'ajoutent rien). */
	readonly enemyCount: number
	/** Paires (S, X) examinées. */
	readonly pairsEvaluated: number
	/** Appels effectués à `Field.lineOfSight`. */
	readonly lineOfSightCalls: number
	/** Nombre de cases que je pouvais atteindre (évaluées ou non). */
	readonly candidateCells: number
	private readonly byKey: ReadonlyMap<number, ThreatCell>
	private cachedMax: number | null = null
	private cachedMin: number | null = null

	constructor(
		entityId: number,
		turn: number,
		byKey: ReadonlyMap<number, ThreatCell>,
		stats: {
			truncated: boolean
			inputsTruncated: boolean
			enemyCount: number
			pairsEvaluated: number
			lineOfSightCalls: number
			candidateCells: number
		}
	) {
		this.entityId = entityId
		this.turn = turn
		this.byKey = byKey
		this.truncated = stats.truncated
		this.inputsTruncated = stats.inputsTruncated
		this.enemyCount = stats.enemyCount
		this.pairsEvaluated = stats.pairsEvaluated
		this.lineOfSightCalls = stats.lineOfSightCalls
		this.candidateCells = stats.candidateCells
	}

	/** Nombre de cases évaluées. */
	get size(): number {
		return this.byKey.size
	}

	/** Cases évaluées, par coût de déplacement croissant (ordre du parcours en largeur). */
	entries(): IterableIterator<ThreatCell> {
		return this.byKey.values()
	}

	has(cell: Cell): boolean {
		return this.byKey.has(cellKey(cell))
	}

	/** Danger de la case ; null si elle n'est pas dans la carte (non atteignable ou non évaluée). */
	dangerAt(cell: Cell): number | null {
		return this.byKey.get(cellKey(cell))?.danger ?? null
	}

	/** Détail par ennemi (dégâts > 0 seulement) ; vide si la case est inconnue ou sans danger. */
	breakdownAt(cell: Cell): readonly EnemyThreat[] {
		return this.byKey.get(cellKey(cell))?.breakdown ?? []
	}

	/** Plus grand danger de la carte (0 si vide). */
	get maxDanger(): number {
		if (this.cachedMax === null) {
			let max = 0
			for (const entry of this.byKey.values()) {
				max = Math.max(max, entry.danger)
			}
			this.cachedMax = max
		}
		return this.cachedMax
	}

	/** Plus petit danger de la carte (0 si vide). */
	get minDanger(): number {
		if (this.cachedMin === null) {
			let min = Number.POSITIVE_INFINITY
			for (const entry of this.byKey.values()) {
				min = Math.min(min, entry.danger)
			}
			this.cachedMin = Number.isFinite(min) ? min : 0
		}
		return this.cachedMin
	}

	/** Cases de danger minimal, la moins coûteuse en PM d'abord (ma case actuelle en tête à égalité). */
	safestCells(): Cell[] {
		const min = this.minDanger
		const cells: Cell[] = []
		for (const entry of this.byKey.values()) {
			if (entry.danger === min) {
				cells.push(entry.cell)
			}
		}
		return cells
	}
}

/** Préparation d'un ennemi : items offensifs triés, calculée une fois par carte. */
interface PreparedEnemy {
	readonly enemy: ThreatEnemy
	readonly weapon: ShotCandidate | null
	readonly chips: readonly ShotCandidate[]
	readonly shotCells: readonly Cell[]
}

function prepare(enemy: ThreatEnemy): PreparedEnemy | null {
	const tp = Number.isFinite(enemy.tp) && enemy.tp > 0 ? Math.floor(enemy.tp) : 0
	let weapon = enemy.weapon === null ? null : toCandidate(enemy.weapon, false, enemy.strength)
	if (weapon !== null && weapon.cost > tp) {
		weapon = null
	}
	const chips: ShotCandidate[] = []
	for (const chip of enemy.chips) {
		const candidate = toCandidate(chip, true, enemy.strength)
		if (candidate !== null && candidate.cost <= tp) {
			chips.push(candidate)
		}
	}
	if (weapon === null && chips.length === 0) {
		return null
	}
	const shotCells: Cell[] = []
	for (const reachable of enemy.reachable.entries()) {
		shotCells.push(reachable.cell)
	}
	return { enemy, weapon, chips: sortByRatio(chips), shotCells }
}

/**
 * Meilleur plan de l'ennemi contre la case `target` : MAX sur ses cases de tir S (pas de somme entre cases).
 * Hypothèse « se déplace puis tire tout » : un plan = une case S, pas de tir-déplacement-tir. L'ennemi ne
 * peut pas se tenir sur la case X (je l'occupe si j'y vais). Consomme `budget.pairs` ; retourne null si le
 * garde-fou est atteint (calcul de la case abandonné).
 */
function bestThreat(
	prepared: PreparedEnemy,
	target: Cell,
	provider: ShotCellsProvider,
	budget: { pairs: number, max: number }
): EnemyThreat | null | "aborted" {
	const { enemy, weapon, chips } = prepared
	let best: ShotPlan = EMPTY_PLAN
	let bestCell: Cell | null = null
	for (const from of prepared.shotCells) {
		if (budget.pairs >= budget.max) {
			return "aborted"
		}
		budget.pairs++
		if (from.x === target.x && from.y === target.y) {
			continue
		}
		const weaponOk = weapon !== null && provider.canHit(from, target, weapon.item)
		const usable: ShotCandidate[] = []
		for (const chip of chips) {
			if (provider.canHit(from, target, chip.item)) {
				usable.push(chip)
			}
		}
		if (!weaponOk && usable.length === 0) {
			continue
		}
		const plan = planShots(enemy.tp, weaponOk ? weapon : null, usable)
		if (plan.damage > best.damage) {
			best = plan
			bestCell = from
		}
	}
	if (bestCell === null) {
		return null
	}
	return {
		enemyId: enemy.id,
		name: enemy.name,
		damage: best.damage,
		shotCell: bestCell,
		weapon: best.weapon,
		weaponShots: best.weaponShots,
		chips: best.chips
	}
}

/**
 * Carte de danger de `me` : pour chaque case que je peux atteindre (`myReachable`, case actuelle incluse),
 * danger = Σ sur les ennemis de leurs meilleurs dégâts potentiels sur cette case (voir `bestThreat` et
 * `planShots`). Fournit le danger potentiel utilisé par le planificateur conjoint (modèle incomplet).
 *
 * Coût borné : au plus `maxPairs` (défaut `MAX_THREAT_PAIRS`) paires (S, X) ; un ennemi sans item offensif
 * utilisable (aucune arme équipée avec dégâts, aucune puce prête avec dégâts, coût > PT) n'est pas parcouru.
 */
export function buildThreatMap(
	me: Entity,
	myReachable: ReachableCells,
	enemies: readonly ThreatEnemy[],
	turn: number,
	options: ThreatMapOptions = {}
): ThreatMap {
	const provider = options.provider ?? new GeometricShotCells()
	const budget = { pairs: 0, max: options.maxPairs ?? MAX_THREAT_PAIRS }
	const prepared: PreparedEnemy[] = []
	let inputsTruncated = myReachable.truncated
	for (const enemy of enemies) {
		inputsTruncated = inputsTruncated || enemy.reachable.truncated
		const item = prepare(enemy)
		if (item !== null) {
			prepared.push(item)
		}
	}

	const byKey = new Map<number, ThreatCell>()
	let truncated = false
	cells:
	for (const mine of myReachable.entries()) {
		let danger = 0
		const breakdown: EnemyThreat[] = []
		for (const item of prepared) {
			const threat = bestThreat(item, mine.cell, provider, budget)
			if (threat === "aborted") {
				truncated = true
				break cells
			}
			if (threat !== null) {
				danger += threat.damage
				breakdown.push(threat)
			}
		}
		byKey.set(cellKey(mine.cell), { cell: mine.cell, mpCost: mine.cost, danger, breakdown })
	}

	return new ThreatMap(me.id, turn, byKey, {
		truncated,
		inputsTruncated,
		enemyCount: enemies.length,
		pairsEvaluated: budget.pairs,
		lineOfSightCalls: provider.lineOfSightCalls ?? 0,
		candidateCells: myReachable.size
	})
}
