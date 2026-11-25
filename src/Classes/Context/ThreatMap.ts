// @version:5.8
// file version: 4
import { isCellInLaunchPattern } from "./LaunchPattern.js"
import { ReachableCells } from "./ReachableCells.js"
import {
	EMPTY_PLAN,
	planShots,
	ShotCandidate,
	ShotItem,
	ShotPlan,
	sortByRatio,
	strengthBoostOf,
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
	/**
	 * Un tir de `item` lancé depuis `from` peut-il toucher `target` (tir direct, sans zone d'effet) ? Doit
	 * impliquer que la distance de Manhattan `from`–`target` est dans [minRange, maxRange] : `buildThreatMap`
	 * écarte sans appel les paires hors de toutes les portées.
	 */
	canHit(from: Cell, target: Cell, item: ShotItem): boolean
	/** Appels à `Field.lineOfSight` réellement effectués (statistique, optionnelle). */
	readonly lineOfSightCalls?: number
}

/** Entrées maximales du cache de ligne de vue partagé (mémoire du combat bornée ; vidé au-delà). */
export const MAX_SIGHT_CACHE = 20000

/** Clé numérique d'une paire ordonnée de cases (coordonnées décalées pour rester positives). */
function pairKey(from: Cell, to: Cell): number {
	const a = (from.x + 1024) * 2048 + (from.y + 1024)
	const b = (to.x + 1024) * 2048 + (to.y + 1024)
	return a * 4194304 + b
}

/**
 * Méthode géométrique : distance de Manhattan |dx| + |dy| dans [minRange, maxRange], motif du type de
 * lancer (`isCellInLaunchPattern`, hypothèse de masque), puis — seulement si `item.needsLos` et seulement
 * après ces deux filtres — `Field.lineOfSight(from, target)`, mémorisée par paire ordonnée (S, X). Le cache
 * peut être FOURNI et partagé entre cartes (`EnemyMemory` le garde tout le combat) : les obstacles sont fixes,
 * une paire déjà vue ne coûte plus d'appel. Hypothèse non vérifiée : `Field.lineOfSight` ne tient compte que
 * des obstacles de la grille, pas des entités ; dans le jeu une entité peut bloquer la vue (le cache partagé
 * figerait alors une réponse dépendant de la position d'une entité).
 * `launchType` absent → CIRCLE. Ignore la zone d'effet (`area`).
 */
export class GeometricShotCells implements ShotCellsProvider {
	lineOfSightCalls = 0

	constructor(private readonly sight: Map<number, boolean> = new Map()) {}

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
			if (this.sight.size >= MAX_SIGHT_CACHE) {
				this.sight.clear()
			}
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
	/** Arme ÉQUIPÉE : utilisable sans PT de changement. */
	readonly weapon: Weapon | null
	/**
	 * Autres armes connues : chacune exige un changement d'arme (`WEAPON_SWAP_TP` PT) avant son premier tir.
	 * Absent = aucune. L'arme équipée peut y figurer : elle est ignorée.
	 */
	readonly otherWeapons?: readonly Weapon[]
	/** Puces connues et PRÊTES (cooldown déjà filtré par l'appelant) ; seules celles avec dégâts comptent. */
	readonly chips: readonly Chip[]
	/**
	 * Puces de boost de force PRÊTES (cooldown déjà filtré) : l'ennemi peut en lancer sur lui avant de tirer,
	 * chacune au plus une fois, en payant son coût en PT ; la force gagnée s'ajoute à `strength` (voir
	 * `strengthBoostOf`). Au plus `MAX_THREAT_BOOSTS` sont combinées. Absent = aucune.
	 */
	readonly boosts?: readonly Chip[]
	/** Science de l'ennemi (amplifie `BUFF_STRENGTH`) ; absente = 0. */
	readonly science?: number
	/** Cases atteignables par l'ennemi EN IGNORANT mon entité comme obstacle. */
	readonly reachable: ReachableCells
}

/** Coût en PT d'un changement d'arme (règle du jeu : `setWeapon` coûte 1 PT). */
export const WEAPON_SWAP_TP = 1

/** Armes examinées par ennemi (équipée comprise) : borne le coût de la carte. */
export const MAX_THREAT_WEAPONS = 4

/** Puces de boost combinées par ennemi (2^n configurations de force, dont « aucun boost »). */
export const MAX_THREAT_BOOSTS = 3

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
	/** PT de changement d'arme payés par le plan (0 : arme équipée ou aucune arme). */
	readonly swapTp: number
	/** PT dépensés en boosts de force avant de tirer (0 : aucun boost). */
	readonly boostTp: number
	/** Force gagnée par ces boosts (0 : aucun boost). */
	readonly strengthGain: number
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

/** Arme d'un ennemi prête à être évaluée, avec les PT de changement qu'elle exige (0 si équipée). */
interface PreparedWeapon {
	readonly candidate: ShotCandidate
	readonly swapTp: number
	/** Position de l'arme dans `PreparedEnemy.items` (un `canHit` par item et par paire, partagé). */
	readonly index: number
}

interface PreparedChip {
	readonly candidate: ShotCandidate
	readonly index: number
}

/**
 * Une configuration de force de l'ennemi : aucun boost, ou une combinaison de puces de boost lancées avant
 * de tirer (PT payés, force gagnée). Dégâts et PT restants ne dépendent pas de la case : calculés une fois.
 */
interface PreparedVariant {
	readonly boostTp: number
	readonly strengthGain: number
	/** PT restants après les boosts (avant tout changement d'arme). */
	readonly tpLeft: number
	readonly weapons: readonly PreparedWeapon[]
	/** Puces triées par dégâts/PT décroissant. */
	readonly chips: readonly PreparedChip[]
}

/** Préparation d'un ennemi, calculée une fois par carte (aucune valeur dépendante de la case). */
interface PreparedEnemy {
	readonly enemy: ThreatEnemy
	readonly variants: readonly PreparedVariant[]
	/** Items distincts (armes et puces de toutes les configurations). */
	readonly items: readonly ShotItem[]
	readonly minRange: number
	readonly maxRange: number
	readonly shotCells: readonly Cell[]
	/** Plans déjà calculés, par (configuration, arme, masque de puces qui touchent) : un seul `planShots` par combinaison. */
	readonly plans: Map<number, ShotPlan>
	/** Réponses de `canHit` de la paire en cours (réutilisé, entièrement réécrit à chaque paire). */
	readonly hits: boolean[]
}

/** Puces offensives retenues par configuration (les mieux classées en dégâts/PT) : borne le masque de plans. */
const MAX_MASK_CHIPS = 30
const MASK_RADIX = 1073741824 // 2^30

/** Dégâts d'une arme seule dans le budget de PT (changement d'arme déduit). */
function weaponOnlyDamage(entry: PreparedWeapon, tp: number): number {
	const shots = Math.min(Math.floor((tp - entry.swapTp) / entry.candidate.cost), entry.candidate.uses)
	return shots > 0 ? shots * entry.candidate.damage : 0
}

/**
 * `a` rend `b` inutile : portées incluses, même motif, pas plus exigeante en ligne de vue, et au moins autant
 * de dégâts seule. Évite des appels `canHit` pour une arme qui ne peut jamais faire mieux.
 */
function dominates(a: PreparedWeapon, b: PreparedWeapon, tp: number): boolean {
	const x = a.candidate.item as Weapon
	const y = b.candidate.item as Weapon
	return x.minRange <= y.minRange && x.maxRange >= y.maxRange &&
		x.launchType === y.launchType && (!x.needsLos || y.needsLos) &&
		weaponOnlyDamage(a, tp) >= weaponOnlyDamage(b, tp)
}

/** Configurations de force : aucun boost, puis combinaisons de puces de boost (≤ `MAX_THREAT_BOOSTS`), non dominées. */
function boostVariants(enemy: ThreatEnemy, tp: number): Array<{ cost: number; gain: number }> {
	const boosts: Array<{ cost: number; gain: number }> = []
	for (const chip of enemy.boosts ?? []) {
		if (boosts.length >= MAX_THREAT_BOOSTS) {
			break
		}
		const gain = strengthBoostOf(chip, enemy.science ?? 0)
		if (gain > 0 && Number.isInteger(chip.cost) && chip.cost > 0 && chip.cost < tp) {
			boosts.push({ cost: chip.cost, gain })
		}
	}
	const all: Array<{ cost: number; gain: number }> = []
	for (let mask = 0; mask < (1 << boosts.length); mask++) {
		let cost = 0
		let gain = 0
		for (let i = 0; i < boosts.length; i++) {
			if ((mask & (1 << i)) !== 0) {
				cost += boosts[i]!.cost
				gain += boosts[i]!.gain
			}
		}
		if (cost < tp) {
			all.push({ cost, gain })
		}
	}
	// Une configuration qui coûte plus de PT pour moins de force qu'une autre est inutile.
	return all.filter((variant, index) => !all.some((rival, other) =>
		other !== index && rival.gain >= variant.gain && rival.cost <= variant.cost &&
		(rival.gain > variant.gain || rival.cost < variant.cost || other < index)))
}

function prepareVariant(
	enemy: ThreatEnemy, cost: number, gain: number, tp: number, indexOf: (item: ShotItem) => number
): PreparedVariant | null {
	const tpLeft = tp - cost
	const strength = enemy.strength + gain
	const found: PreparedWeapon[] = []
	if (enemy.weapon !== null) {
		const candidate = toCandidate(enemy.weapon, false, strength)
		if (candidate !== null && candidate.cost <= tpLeft) {
			found.push({ candidate, swapTp: 0, index: 0 })
		}
	}
	for (const other of enemy.otherWeapons ?? []) {
		if (found.length >= MAX_THREAT_WEAPONS) {
			break
		}
		if (other === enemy.weapon || (enemy.weapon !== null && other.id === enemy.weapon.id)) {
			continue
		}
		const candidate = toCandidate(other, false, strength)
		if (candidate !== null && candidate.cost + WEAPON_SWAP_TP <= tpLeft &&
			!found.some((entry) => entry.candidate.item.id === other.id)) {
			found.push({ candidate, swapTp: WEAPON_SWAP_TP, index: 0 })
		}
	}
	const weapons = found.filter((entry) => !found.some((rival) =>
		rival !== entry && dominates(rival, entry, tpLeft) &&
		// À égalité mutuelle, seule la première (l'équipée si elle y est) est conservée.
		(!dominates(entry, rival, tpLeft) || found.indexOf(rival) < found.indexOf(entry))))
		.map((entry) => ({ ...entry, index: indexOf(entry.candidate.item) }))
	const chips: ShotCandidate[] = []
	for (const chip of enemy.chips) {
		const candidate = toCandidate(chip, true, strength)
		if (candidate !== null && candidate.cost <= tpLeft) {
			chips.push(candidate)
		}
	}
	if (weapons.length === 0 && chips.length === 0) {
		return null
	}
	return {
		boostTp: cost,
		strengthGain: gain,
		tpLeft,
		weapons,
		chips: sortByRatio(chips).slice(0, MAX_MASK_CHIPS).map((candidate) => ({ candidate, index: indexOf(candidate.item) }))
	}
}

function prepare(enemy: ThreatEnemy): PreparedEnemy | null {
	const tp = Number.isFinite(enemy.tp) && enemy.tp > 0 ? Math.floor(enemy.tp) : 0
	const items: ShotItem[] = []
	const indexOf = (item: ShotItem): number => {
		const known = items.indexOf(item)
		if (known >= 0) {
			return known
		}
		items.push(item)
		return items.length - 1
	}
	const variants: PreparedVariant[] = []
	for (const { cost, gain } of boostVariants(enemy, tp)) {
		const variant = prepareVariant(enemy, cost, gain, tp, indexOf)
		if (variant !== null) {
			variants.push(variant)
		}
	}
	if (variants.length === 0) {
		return null
	}
	let minRange = Number.POSITIVE_INFINITY
	let maxRange = Number.NEGATIVE_INFINITY
	for (const item of items) {
		minRange = Math.min(minRange, item.minRange)
		maxRange = Math.max(maxRange, item.maxRange)
	}
	const shotCells: Cell[] = []
	for (const reachable of enemy.reachable.entries()) {
		shotCells.push(reachable.cell)
	}
	return {
		enemy, variants, items, minRange, maxRange, shotCells,
		plans: new Map(), hits: new Array<boolean>(items.length).fill(false)
	}
}

/** Plan de l'ennemi pour une configuration, une arme (`slot` 0 = aucune) et un masque de puces qui touchent. */
function planFor(
	prepared: PreparedEnemy, variantIndex: number, weaponIndex: number, mask: number
): ShotPlan {
	const variant = prepared.variants[variantIndex]!
	const key = (variantIndex * 8 + weaponIndex + 1) * MASK_RADIX + mask
	const cached = prepared.plans.get(key)
	if (cached !== undefined) {
		return cached
	}
	const usable: ShotCandidate[] = []
	for (let i = 0; i < variant.chips.length; i++) {
		if ((mask & (1 << i)) !== 0) {
			usable.push(variant.chips[i]!.candidate)
		}
	}
	const weapon = weaponIndex < 0 ? null : variant.weapons[weaponIndex]!
	const plan = weapon === null
		? planShots(variant.tpLeft, null, usable)
		: planShots(variant.tpLeft - weapon.swapTp, weapon.candidate, usable)
	prepared.plans.set(key, plan)
	return plan
}

/**
 * Meilleur plan de l'ennemi contre la case `target` : MAX sur ses cases de tir S (pas de somme entre cases),
 * sur ses configurations de force (boosts payés en PT) et sur ses armes (une seule par plan ; hors équipée,
 * elle coûte `WEAPON_SWAP_TP` PT). Hypothèse « se déplace puis tire tout » : un plan = une case S, pas de
 * tir-déplacement-tir. L'ennemi ne peut pas se tenir sur la case X (je l'occupe si j'y vais). Consomme
 * `budget.pairs` ; retourne null si le garde-fou est atteint (calcul de la case abandonné).
 *
 * Économies sans changer le résultat : une case X hors de portée de toute case de tir est écartée sans
 * parcours (distance au départ de l'ennemi − PM > portée maximale) ; une paire hors de toutes les portées
 * n'appelle pas `canHit` ; chaque item est testé une fois par paire pour toutes les configurations ; chaque
 * combinaison (configuration, arme, masque de puces) n'est planifiée qu'une fois par carte.
 */
function bestThreat(
	prepared: PreparedEnemy,
	target: Cell,
	provider: ShotCellsProvider,
	budget: { pairs: number, max: number }
): EnemyThreat | null | "aborted" {
	const { enemy, variants, items, hits } = prepared
	const origin = enemy.reachable.startCell
	if (Math.abs(origin.x - target.x) + Math.abs(origin.y - target.y) - enemy.reachable.mp > prepared.maxRange) {
		return null
	}
	let best: ShotPlan = EMPTY_PLAN
	let bestSwap = 0
	let bestVariant = 0
	let bestCell: Cell | null = null
	for (const from of prepared.shotCells) {
		if (budget.pairs >= budget.max) {
			return "aborted"
		}
		budget.pairs++
		if (from.x === target.x && from.y === target.y) {
			continue
		}
		const distance = Math.abs(from.x - target.x) + Math.abs(from.y - target.y)
		if (distance < prepared.minRange || distance > prepared.maxRange) {
			continue
		}
		for (let i = 0; i < items.length; i++) {
			const item = items[i]!
			hits[i] = distance >= item.minRange && distance <= item.maxRange && provider.canHit(from, target, item)
		}
		for (let v = 0; v < variants.length; v++) {
			const variant = variants[v]!
			let mask = 0
			for (let c = 0; c < variant.chips.length; c++) {
				if (hits[variant.chips[c]!.index]) {
					mask |= 1 << c
				}
			}
			let weaponHit = false
			for (let w = 0; w < variant.weapons.length; w++) {
				if (!hits[variant.weapons[w]!.index]) {
					continue
				}
				weaponHit = true
				const plan = planFor(prepared, v, w, mask)
				if (plan.damage > best.damage) {
					best = plan
					bestSwap = variant.weapons[w]!.swapTp
					bestVariant = v
					bestCell = from
				}
			}
			if (!weaponHit && mask !== 0) {
				const plan = planFor(prepared, v, -1, mask)
				if (plan.damage > best.damage) {
					best = plan
					bestSwap = 0
					bestVariant = v
					bestCell = from
				}
			}
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
		chips: best.chips,
		swapTp: best.weapon === null ? 0 : bestSwap,
		boostTp: variants[bestVariant]!.boostTp,
		strengthGain: variants[bestVariant]!.strengthGain
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
