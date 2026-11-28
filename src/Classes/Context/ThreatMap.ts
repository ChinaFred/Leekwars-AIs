// @version:5.8
// file version: 14
import { OPS_BUDGET } from "../../Toolbox/Budgets.js"
import { cutOperations, logSearchCut } from "../../Toolbox/Logger.js"
import { SEARCH_GLOBAL_FRACTION } from "../Plannification/ExecutionBudget.js"
import { isCellInLaunchPattern, LAUNCH_TYPE } from "./LaunchPattern.js"
import { MOVE_NEIGHBOR_OFFSETS, ReachableCells } from "./ReachableCells.js"
import {
	EMPTY_PLAN,
	planShots,
	ShotCandidate,
	ShotItem,
	ShotPlan,
	sortByRatio,
	strengthBoostOf,
	toCandidate,
	tpBoostOf
} from "./ShotPlan.js"

/**
 * Garde-fou : nombre maximal de paires (case de tir S de l'ennemi, ma case X) examinées par carte, tous
 * ennemis confondus. Cas courant : 41 cases (4 PM) × 25 cases (3 PM) ≈ 1 000 paires par ennemi. Une paire
 * coûte quelques appels de `canHit` (un par item offensif) et un calcul de plan ; non mesuré en ops réelles.
 * Au-delà, la carte est marquée `truncated` : seules les cases de X entièrement évaluées (pour tous les
 * ennemis) sont conservées, les autres sont absentes (donc jamais présentées comme « sûres »).
 * 8 000 → 16 000 avec `TACTICAL_LIMITS.cells` = 113 : 113 cases × 113 cases de tir (ennemi à 7 PM) = 12 769 paires.
 */
export const MAX_THREAT_PAIRS = 16000

/**
 * Plafond d'opérations de la construction (au-delà, la carte est `truncated`) : le plafond global de recherche,
 * `SEARCH_GLOBAL_FRACTION` de `System.maxOperations`, comme la recherche tactique et le plan B qui ne démarrent
 * plus passé ce seuil. Sans lui, `MAX_THREAT_PAIRS` paires pouvaient dépasser à elles seules le total du tour (erreur
 * d'exécution, aucune action) ; avec lui, la carte s'arrête et le planificateur se replie sur `operations reserve`.
 * Contrôlé une fois par case X (au plus les cases de tir de chaque ennemi entre deux contrôles). Sans `System` : aucun plafond d'ops.
 */
function operationsCeiling(fraction: number = SEARCH_GLOBAL_FRACTION): number {
	return typeof System === "undefined" || !Number.isFinite(System.maxOperations) || System.maxOperations <= 0
		? Number.POSITIVE_INFINITY
		: System.maxOperations * fraction
}

function overCeiling(ceiling: number): boolean {
	return ceiling !== Number.POSITIVE_INFINITY && System.operations >= ceiling
}

/**
 * Plafond de paires (case de tir, case visée) EXAMINÉES par `buildTargetZone`, distinct de celui de la carte de
 * danger. Garde-fou seulement : la recherche bornée de `zoneThreat` examine quelques paires par case (compté hors jeu,
 * sous Node : moins de 2 par case pour un ennemi à 7 PM et portée 12 sur terrain dégagé, 761 cases ; l'ancien parcours
 * exhaustif en demandait ~86 000 et s'arrêtait ici). Valeur inchangée ; coût en opérations non mesuré en combat.
 */
export const MAX_TARGET_ZONE_PAIRS = 16000

/**
 * Plafond d'opérations de `buildTargetZone`, en part de `System.maxOperations` (seuil ABSOLU du tour, comme
 * `SEARCH_GLOBAL_FRACTION`, pas un budget relatif) : la zone est calculée AVANT le plan et s'arrête là pour lui laisser
 * sa fenêtre de recherche (60 % depuis son départ, mais coupée par le plafond global de 80 % : 50 % + 60 % > 80 %, il ne reste que 30 %).
 * 0,20 → 0,50 : à 20 %, une carte de danger déjà coûteuse ne laissait à la zone que les cases reprises de cette carte.
 * Valeur déduite de la fenêtre du plan, non mesurée en combat (le log `Target zone:` donne le coût réel en opérations).
 * Contrôlé une fois par anneau du parcours en largeur et une fois par case évaluée ; les marques ne sont pas comptées.
 */
export const TARGET_ZONE_OPERATIONS_FRACTION = OPS_BUDGET.TARGET_ZONE

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
	/**
	 * Optionnelle : équivalent groupé de `canHit` pour tous les `items` d'une paire (voir `GeometricShotCells`).
	 * Absente, `buildThreatMap` appelle `canHit` item par item. Doit donner exactement les mêmes réponses.
	 */
	hitSignature?(from: Cell, target: Cell, items: readonly ShotItem[], weights: readonly number[], hits: boolean[]): number
	/**
	 * Optionnelle : true si `canHit` refuse tout décalage hors du motif `isCellInLaunchPattern(item.launchType, dx, dy)`.
	 * `buildTargetZone` resserre alors ses bornes par classe de décalage ; absente, seules les portées les bornent.
	 */
	readonly launchPatterns?: boolean
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
 *
 * `hitSignature` est la forme groupée utilisée par `buildThreatMap` : tous les items d'une paire (S, X) en un
 * appel, une seule lecture de dx/dy/distance et une seule ligne de vue par paire. Mêmes réponses et mêmes appels
 * à `Field.lineOfSight` que `canHit` item par item.
 */
export class GeometricShotCells implements ShotCellsProvider {
	lineOfSightCalls = 0
	readonly launchPatterns = true

	constructor(private readonly sight: Map<number, boolean> = new Map()) {}

	canHit(from: Cell, target: Cell, item: ShotItem): boolean {
		const dx = target.x - from.x
		const dy = target.y - from.y
		const distance = Math.abs(dx) + Math.abs(dy)
		if (distance < item.minRange || distance > item.maxRange) {
			return false
		}
		if (item.launchType !== LAUNCH_TYPE.CIRCLE && !isCellInLaunchPattern(item.launchType, dx, dy)) {
			return false
		}
		if (!item.needsLos) {
			return true
		}
		return this.visible(from, target)
	}

	/**
	 * Variante groupée utilisée par `bestThreat` : une seule lecture de dx/dy/distance pour tous les items d'une
	 * paire. Même réponse que `distance >= minRange && distance <= maxRange && canHit(...)` item par item, mêmes
	 * appels (et même ordre) à `Field.lineOfSight`. Remplit `hits` et renvoie la somme des `weights` des items qui touchent.
	 */
	hitSignature(from: Cell, target: Cell, items: readonly ShotItem[], weights: readonly number[], hits: boolean[]): number {
		const dx = target.x - from.x
		const dy = target.y - from.y
		const distance = Math.abs(dx) + Math.abs(dy)
		let signature = 0
		let sight = -1 // ligne de vue de la paire : inconnue (-1), obstruée (0), dégagée (1) ; un seul appel par paire
		for (let i = 0; i < items.length; i++) {
			const item = items[i]!
			let hit = distance >= item.minRange && distance <= item.maxRange
			if (hit && item.launchType !== LAUNCH_TYPE.CIRCLE) {
				hit = isCellInLaunchPattern(item.launchType, dx, dy)
			}
			if (hit && item.needsLos) {
				if (sight < 0) {
					sight = this.visible(from, target) ? 1 : 0
				}
				hit = sight === 1
			}
			hits[i] = hit
			if (hit) {
				signature += weights[i]!
			}
		}
		return signature
	}

	private visible(from: Cell, target: Cell): boolean {
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
	/**
	 * Puces connues et PRÊTES (cooldown déjà filtré par l'appelant) ; seules celles avec dégâts comptent. Une puce
	 * sans cooldown de base compte autant de fois que ses PT et `maxUses` le permettent (`chipUsesOf`).
	 */
	readonly chips: readonly Chip[]
	/**
	 * Puces de boost de force ou de PT PRÊTES (cooldown déjà filtré) : l'ennemi peut en lancer sur lui avant de
	 * tirer, chacune au plus une fois, en payant son coût en PT ; la force gagnée s'ajoute à `strength` (voir
	 * `strengthBoostOf`) et les PT gagnés à son budget (`tpBoostOf`, immédiats). Au plus `MAX_THREAT_BOOSTS` sont
	 * combinées. Absent = aucune.
	 */
	readonly boosts?: readonly Chip[]
	/** Science de l'ennemi (amplifie `BUFF_STRENGTH` et `BUFF_TP`) ; absente = 0. */
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
	/** PT gagnés par ces boosts (0 : aucun boost de PT). */
	readonly tpGain: number
}

/** Une case que je peux atteindre, avec son danger. */
export interface ThreatCell {
	readonly cell: Cell
	/** PM que je dois dépenser pour y arriver (0 = ma case actuelle) ; -1 : case hors de mes cases atteignables (`buildTargetZone`). */
	readonly mpCost: number
	/** Somme, sur les ennemis, de leurs meilleurs dégâts potentiels sur cette case. */
	readonly danger: number
	readonly breakdown: readonly EnemyThreat[]
}

export interface ThreatMapOptions {
	readonly provider?: ShotCellsProvider
	readonly maxPairs?: number
	/** Danger ajouté à chaque case de la carte de danger (coffres : `ChestDanger.ts`) ; absent = 0. N'ajoute aucun ennemi. */
	readonly extraDanger?: (cell: Cell) => number
}

export interface TargetZoneOptions extends ThreatMapOptions {
	/**
	 * Carte de danger construite avec les MÊMES `enemies` : ses cases sont reprises telles quelles (même valeur),
	 * sans paire ni ligne de vue de plus.
	 */
	readonly known?: ThreatMap | null
}

function cellKey(cell: Cell): number {
	return cell.x * 4096 + cell.y
}

/**
 * Carte de danger de mon poireau pour un tour : une entrée par case que je peux atteindre (case actuelle
 * incluse). Immuable en pratique, remplacée à chaque tour (pas d'accumulation). Sert aussi de conteneur à la
 * zone visée (`buildTargetZone`) : une entrée par case qu'un ennemi peut toucher, atteignable par moi ou non.
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
	/** Zone visée seulement : candidates entièrement évaluées (retenues ou à danger nul) ; null pour la carte de danger. */
	readonly evaluatedCells: number | null
	/** Zone visée seulement : opérations consommées par sa construction ; null sans `System` et pour la carte de danger. */
	readonly operations: number | null
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
			evaluatedCells?: number
			operations?: number | null
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
		this.evaluatedCells = stats.evaluatedCells ?? null
		this.operations = stats.operations ?? null
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

	/** Entrée de la case ; null si elle n'est pas dans la carte. */
	entryAt(cell: Cell): ThreatCell | null {
		return this.byKey.get(cellKey(cell)) ?? null
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
	readonly tpGain: number
	/** PT restants après les boosts (coût payé, PT gagnés ajoutés ; avant tout changement d'arme). */
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
	/** 2^i pour l'item i : la signature d'une paire est la somme des poids des items qui touchent. */
	readonly weights: readonly number[]
	/** Meilleur plan d'une paire par signature (un même ensemble d'items qui touchent donne le même résultat). */
	readonly outcomes: Map<number, PairOutcome | null>
}

/** Meilleur plan d'une paire (S, X) : il ne dépend que de l'ensemble des items qui touchent depuis S. */
interface PairOutcome {
	readonly plan: ShotPlan
	readonly swap: number
	readonly variant: number
}

/** Au-delà, 2^i n'est plus exact en nombre à virgule flottante : pas de mémo par signature. */
const MAX_SIGNATURE_ITEMS = 52

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

/** Configurations de force et de PT : aucun boost, puis combinaisons de puces de boost (≤ `MAX_THREAT_BOOSTS`), non dominées. */
function boostVariants(enemy: ThreatEnemy, tp: number): Array<{ cost: number; gain: number; tpGain: number }> {
	const boosts: Array<{ cost: number; gain: number; tpGain: number }> = []
	const candidates: Array<{ cost: number; gain: number; tpGain: number }> = []
	for (const chip of enemy.boosts ?? []) {
		if (!Number.isInteger(chip.cost) || chip.cost <= 0) {
			continue
		}
		const gain = strengthBoostOf(chip, enemy.science ?? 0)
		const tpGain = tpBoostOf(chip, enemy.science ?? 0)
		if (gain > 0 || tpGain > 0) {
			candidates.push({ cost: chip.cost, gain, tpGain })
		}
	}
	// Les gains nets positifs retenus peuvent financer une puce auparavant inaccessible.
	// Repartir du début conserve la priorité de l'ordre fourni dès qu'une puce devient lançable.
	let maxTp = tp
	while (boosts.length < MAX_THREAT_BOOSTS) {
		const index = candidates.findIndex((boost) => boost.cost <= maxTp && boost.cost - boost.tpGain < maxTp)
		if (index < 0) break
		const boost = candidates.splice(index, 1)[0]!
		boosts.push(boost)
		maxTp += Math.max(0, boost.tpGain - boost.cost)
	}
	const empty = { cost: 0, gain: 0, tpGain: 0 }
	const all: Array<{ cost: number; gain: number; tpGain: number }> = [empty]
	const states: Array<{ cost: number; gain: number; tpGain: number } | null> = [empty]
	for (let mask = 1; mask < (1 << boosts.length); mask++) {
		let state: { cost: number; gain: number; tpGain: number } | null = null
		for (let i = 0; i < boosts.length; i++) {
			if ((mask & (1 << i)) !== 0) {
				const previous = states[mask ^ (1 << i)]
				const boost = boosts[i]!
				if (previous && boost.cost <= tp - previous.cost + previous.tpGain) {
					state = { cost: previous.cost + boost.cost, gain: previous.gain + boost.gain, tpGain: previous.tpGain + boost.tpGain }
					break
				}
			}
		}
		states.push(state)
		if (state !== null && state.cost - state.tpGain < tp) {
			all.push(state)
		}
	}
	// Une configuration qui coûte plus de PT pour moins de force et de PT qu'une autre est inutile.
	return all.filter((variant, index) => !all.some((rival, other) =>
		other !== index && rival.gain >= variant.gain && rival.tpGain >= variant.tpGain && rival.cost <= variant.cost &&
		(rival.gain > variant.gain || rival.tpGain > variant.tpGain || rival.cost < variant.cost || other < index)))
}

function prepareVariant(
	enemy: ThreatEnemy, cost: number, gain: number, tpGain: number, tp: number, indexOf: (item: ShotItem) => number
): PreparedVariant | null {
	const tpLeft = Math.floor(tp - cost + tpGain)
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
		tpGain,
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
	for (const { cost, gain, tpGain } of boostVariants(enemy, tp)) {
		const variant = prepareVariant(enemy, cost, gain, tpGain, tp, indexOf)
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
	const weights: number[] = []
	for (let i = 0, weight = 1; i < items.length; i++, weight *= 2) {
		weights.push(weight)
	}
	return {
		enemy, variants, items, minRange, maxRange, shotCells,
		plans: new Map(), hits: new Array<boolean>(items.length).fill(false), weights, outcomes: new Map()
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
 * Meilleur plan d'une paire (S, X) d'après `prepared.hits` (items qui touchent depuis S) : le premier maximum
 * strictement positif dans l'ordre configurations, armes, puces seules (toujours essayées) ; null si aucun plan
 * ne fait de dégâts.
 */
function pairOutcome(prepared: PreparedEnemy): PairOutcome | null {
	const { variants, hits } = prepared
	let best: ShotPlan = EMPTY_PLAN
	let bestSwap = 0
	let bestVariant = 0
	let found = false
	for (let v = 0; v < variants.length; v++) {
		const variant = variants[v]!
		let mask = 0
		for (let c = 0; c < variant.chips.length; c++) {
			if (hits[variant.chips[c]!.index]) {
				mask |= 1 << c
			}
		}
		for (let w = 0; w < variant.weapons.length; w++) {
			if (!hits[variant.weapons[w]!.index]) {
				continue
			}
			const plan = planFor(prepared, v, w, mask)
			if (plan.damage > best.damage) {
				best = plan
				bestSwap = variant.weapons[w]!.swapTp
				bestVariant = v
				found = true
			}
		}
		// Puces seules, même si une arme touche : un plan qui ne tire pas à l'arme ne paie pas son changement
		// (`WEAPON_SWAP_TP`, déduit du budget de `planShots` dès que l'arme est proposée).
		if (mask !== 0) {
			const plan = planFor(prepared, v, -1, mask)
			if (plan.damage > best.damage) {
				best = plan
				bestSwap = 0
				bestVariant = v
				found = true
			}
		}
	}
	return found ? { plan: best, swap: bestSwap, variant: bestVariant } : null
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
 * combinaison (configuration, arme, masque de puces) n'est planifiée qu'une fois par carte ; le meilleur plan
 * d'une paire ne dépend que de l'ensemble des items qui touchent (signature) : il est calculé une fois par
 * signature et par carte, une paire dont aucun item ne touche est écartée sans parcourir les configurations.
 * Le premier plan strictement meilleur dans l'ordre configurations puis armes puis puces seules reste retenu
 * (le premier maximum d'une paire, puis la première paire qui atteint le maximum, comme avant).
 */
function bestThreat(
	prepared: PreparedEnemy,
	target: Cell,
	provider: ShotCellsProvider,
	budget: { pairs: number, max: number }
): EnemyThreat | null | "aborted" {
	const { enemy, variants, items, hits, weights, outcomes } = prepared
	const origin = enemy.reachable.startCell
	if (Math.abs(origin.x - target.x) + Math.abs(origin.y - target.y) - enemy.reachable.mp > prepared.maxRange) {
		return null
	}
	const memoizable = items.length <= MAX_SIGNATURE_ITEMS
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
		let signature = 0
		if (provider.hitSignature !== undefined) {
			signature = provider.hitSignature(from, target, items, weights, hits)
		} else {
			for (let i = 0; i < items.length; i++) {
				const item = items[i]!
				const hit = distance >= item.minRange && distance <= item.maxRange && provider.canHit(from, target, item)
				hits[i] = hit
				if (hit) {
					signature += weights[i]!
				}
			}
		}
		if (signature === 0) {
			continue
		}
		let outcome: PairOutcome | null | undefined = memoizable ? outcomes.get(signature) : undefined
		if (outcome === undefined) {
			outcome = pairOutcome(prepared)
			if (memoizable) {
				outcomes.set(signature, outcome)
			}
		}
		if (outcome !== null && outcome.plan.damage > best.damage) {
			best = outcome.plan
			bestSwap = outcome.swap
			bestVariant = outcome.variant
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
		chips: best.chips,
		swapTp: best.weapon === null ? 0 : bestSwap,
		boostTp: variants[bestVariant]!.boostTp,
		strengthGain: variants[bestVariant]!.strengthGain,
		tpGain: variants[bestVariant]!.tpGain
	}
}

/**
 * Carte de danger de `me` : pour chaque case que je peux atteindre (`myReachable`, case actuelle incluse),
 * danger = Σ sur les ennemis de leurs meilleurs dégâts potentiels sur cette case (voir `bestThreat` et
 * `planShots`). Fournit le danger potentiel utilisé par le planificateur conjoint (modèle incomplet).
 *
 * Coût borné : au plus `maxPairs` (défaut `MAX_THREAT_PAIRS`) paires (S, X) ; un ennemi sans item offensif
 * utilisable (aucune arme équipée avec dégâts, aucune puce prête avec dégâts, coût > PT) n'est pas parcouru.
 * S'arrête (`truncated`) au plafond d'opérations, contrôlé une fois par case, ou au plafond de paires : la case en
 * cours est abandonnée, les suivantes sont absentes.
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

	const ceiling = operationsCeiling()
	const byKey = new Map<number, ThreatCell>()
	let truncated = false
	let cause = ""
	evaluation:
	for (const candidate of myReachable.entries()) {
		if (overCeiling(ceiling)) {
			truncated = true
			cause = "operations ceiling"
			break
		}
		let danger = 0
		const breakdown: EnemyThreat[] = []
		for (const item of prepared) {
			const threat = bestThreat(item, candidate.cell, provider, budget)
			if (threat === "aborted") {
				truncated = true
				cause = "pairs cap"
				break evaluation
			}
			if (threat !== null) {
				danger += threat.damage
				breakdown.push(threat)
			}
		}
		if (options.extraDanger) danger += options.extraDanger(candidate.cell)
		byKey.set(cellKey(candidate.cell), { cell: candidate.cell, mpCost: candidate.cost, danger, breakdown })
	}

	if (truncated) {
		logSearchCut("carte de danger", cause, `${cutOperations()} paires=${budget.pairs}/${budget.max} cases=${byKey.size}/${myReachable.size}`)
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

/** Classe d'un décalage (dx, dy) entre case de tir et case visée : les trois cas de `isCellInLaunchPattern`. */
const OFFSET_LINE = 0
const OFFSET_DIAGONAL = 1
const OFFSET_OTHER = 2

/** Un ennemi préparé pour la zone visée : index de ses cases de tir et bornes de dégâts par décalage. */
interface ZoneEnemy {
	readonly prepared: PreparedEnemy
	/** Portée maximale entière de ses items : profondeur du parcours en largeur, taille des tables. */
	readonly range: number
	/** Point de la grille (clé `x * 4096 + y`) → une case de tir à distance de Manhattan minimale (≤ `range`). */
	readonly nearest: Map<number, Cell>
	/** Cases de tir par ligne (y), colonne (x) et diagonales (x − y, x + y), dans l'ordre de `shotCells`. */
	readonly rows: Map<number, Cell[]>
	readonly columns: Map<number, Cell[]>
	readonly descending: Map<number, Cell[]>
	readonly ascending: Map<number, Cell[]>
	/**
	 * `bound[classe][d]` : dégâts du meilleur plan si TOUS les items que la distance d (et, si le fournisseur
	 * l'applique, le motif de lancer de la classe) autorise touchent ; 0 si la classe n'existe pas à cette distance.
	 * Une paire réelle de cette classe et de cette distance ne fait jamais plus (voir `zoneThreat`).
	 */
	readonly bound: readonly number[][]
	/** `reach[classe][d]` : maximum de `bound[classe]` sur les distances ≥ d. */
	readonly reach: readonly number[][]
}

/** Meilleur plan pour les items marqués dans `prepared.hits`, de signature `signature` (mémo par signature). */
function signatureOutcome(prepared: PreparedEnemy, signature: number): PairOutcome | null {
	if (signature === 0) {
		return null
	}
	if (prepared.items.length > MAX_SIGNATURE_ITEMS) {
		return pairOutcome(prepared)
	}
	let outcome = prepared.outcomes.get(signature)
	if (outcome === undefined) {
		outcome = pairOutcome(prepared)
		prepared.outcomes.set(signature, outcome)
	}
	return outcome
}

function appendTo(index: Map<number, Cell[]>, key: number, cell: Cell): void {
	const list = index.get(key)
	if (list === undefined) {
		index.set(key, [cell])
	} else {
		list.push(cell)
	}
}

function prepareZone(prepared: PreparedEnemy, patterns: boolean): ZoneEnemy {
	const { items, hits, weights } = prepared
	const range = Math.floor(prepared.maxRange)
	const bound: number[][] = []
	const reach: number[][] = []
	for (let offset = OFFSET_LINE; offset <= OFFSET_OTHER; offset++) {
		const damages: number[] = [0]
		for (let distance = 1; distance <= range; distance++) {
			// Décalage représentatif de la classe à cette distance : (d, 0), (d/2, d/2) ou (d − 1, 1).
			let dx = distance
			let dy = 0
			let exists = true
			if (offset === OFFSET_DIAGONAL) {
				dx = distance / 2
				dy = dx
				exists = distance % 2 === 0
			} else if (offset === OFFSET_OTHER) {
				dx = distance - 1
				dy = 1
				exists = distance >= 3
			}
			let signature = 0
			if (exists) {
				for (let i = 0; i < items.length; i++) {
					const item = items[i]!
					const hit = distance >= item.minRange && distance <= item.maxRange &&
						(!patterns || isCellInLaunchPattern(item.launchType, dx, dy))
					hits[i] = hit
					if (hit) {
						signature += weights[i]!
					}
				}
			}
			damages.push(signatureOutcome(prepared, signature)?.plan.damage ?? 0)
		}
		const best = damages.slice()
		for (let distance = range - 1; distance >= 0; distance--) {
			best[distance] = Math.max(best[distance]!, best[distance + 1]!)
		}
		bound.push(damages)
		reach.push(best)
	}
	const zone: ZoneEnemy = {
		prepared, range, nearest: new Map(), rows: new Map(), columns: new Map(), descending: new Map(), ascending: new Map(),
		bound, reach
	}
	for (const cell of prepared.shotCells) {
		appendTo(zone.rows, cell.y, cell)
		appendTo(zone.columns, cell.x, cell)
		appendTo(zone.descending, cell.x - cell.y, cell)
		appendTo(zone.ascending, cell.x + cell.y, cell)
	}
	return zone
}

/** Meilleure paire trouvée pour une case visée (réutilisé d'une liste de cases de tir à l'autre). */
interface ZoneSearch {
	damage: number
	outcome: PairOutcome | null
	cell: Cell | null
}

/**
 * Examine les cases de tir de `shots` contre `target` et garde dans `search` la première strictement meilleure.
 * `only` ≥ 0 : seules les paires de cette classe de décalage comptent. Une paire dont la borne ne dépasse pas les
 * dégâts déjà trouvés n'est pas testée (ni portée, ni motif, ni ligne de vue). S'arrête dès que `goal` est atteint.
 * Chaque case de tir lue consomme `budget.pairs` ; retourne false si le garde-fou est atteint.
 */
function scanShots(
	zone: ZoneEnemy,
	shots: readonly Cell[] | undefined,
	only: number,
	goal: number,
	target: Cell,
	provider: ShotCellsProvider,
	budget: { pairs: number, max: number },
	search: ZoneSearch
): boolean {
	if (shots === undefined) {
		return true
	}
	const { prepared, range, bound } = zone
	const { items, hits, weights } = prepared
	for (const from of shots) {
		if (search.damage >= goal) {
			return true
		}
		if (budget.pairs >= budget.max) {
			return false
		}
		budget.pairs++
		const dx = Math.abs(from.x - target.x)
		const dy = Math.abs(from.y - target.y)
		const distance = dx + dy
		if (distance === 0 || distance > range) {
			continue
		}
		const offset = dx === 0 || dy === 0 ? OFFSET_LINE : dx === dy ? OFFSET_DIAGONAL : OFFSET_OTHER
		if ((only >= 0 && offset !== only) || bound[offset]![distance]! <= search.damage) {
			continue
		}
		let signature = 0
		if (provider.hitSignature !== undefined) {
			signature = provider.hitSignature(from, target, items, weights, hits)
		} else {
			for (let i = 0; i < items.length; i++) {
				const item = items[i]!
				const hit = distance >= item.minRange && distance <= item.maxRange && provider.canHit(from, target, item)
				hits[i] = hit
				if (hit) {
					signature += weights[i]!
				}
			}
		}
		const outcome = signatureOutcome(prepared, signature)
		if (outcome !== null && outcome.plan.damage > search.damage) {
			search.damage = outcome.plan.damage
			search.outcome = outcome
			search.cell = from
		}
	}
	return true
}

/**
 * Cases de tir à distance de Manhattan ≤ `radius` de `target`, sans parcourir les autres : points communs au losange
 * de rayon `radius` autour de `target` et au losange de rayon PM autour du départ de l'ennemi (toute case de tir y
 * est : son coût en PM est au moins sa distance au départ), gardés s'ils sont une case de tir (`nearest` la rend
 * alors elle-même).
 */
function shotsWithin(zone: ZoneEnemy, target: Cell, radius: number): Cell[] {
	const origin = zone.prepared.enemy.reachable.startCell
	const mp = zone.prepared.enemy.reachable.mp
	const nearest = zone.nearest
	const shots: Cell[] = []
	const lastX = Math.min(origin.x + mp, target.x + radius)
	for (let x = Math.max(origin.x - mp, target.x - radius); x <= lastX; x++) {
		const mine = radius - Math.abs(x - target.x)
		const theirs = mp - Math.abs(x - origin.x)
		const lastY = Math.min(origin.y + theirs, target.y + mine)
		for (let y = Math.max(origin.y - theirs, target.y - mine); y <= lastY; y++) {
			const shot = nearest.get(x * 4096 + y)
			if (shot !== undefined && shot.x === x && shot.y === y) {
				shots.push(shot)
			}
		}
	}
	return shots
}

/**
 * Meilleur plan de l'ennemi contre `target` pour la zone visée : MÊMES dégâts que `bestThreat` (maximum sur toutes ses
 * cases de tir), en n'examinant que quelques paires. Le plan d'une paire est le maximum exact (`planShots`) sur les
 * items qui touchent : ajouter un item qui touche ne le diminue jamais. Les dégâts d'une paire sont donc bornés par
 * `bound[classe][distance]`, et ceux de toute case de tir par `reach[classe][d]`, d étant la distance de `target` à
 * la case de tir la plus proche. Ordre : la case de tir la plus proche, puis — seulement si leur borne dépasse ce qui
 * est déjà trouvé — les cases de tir alignées (ligne et colonne de `target`), celles de ses diagonales, enfin les
 * autres, limitées à la distance où leur borne dépasse encore ce qui est trouvé (`shotsWithin`) ; arrêt dès que la
 * borne restante est atteinte. Terrain dégagé : une paire par case.
 *
 * Seule différence avec `bestThreat` : à dégâts égaux, la case de tir (et le plan) retenue est la première trouvée
 * dans cet ordre, pas la moins coûteuse en PM. null : hors de portée de toute case de tir ou aucun plan à dégâts ;
 * "aborted" : garde-fou de paires atteint.
 */
function zoneThreat(
	zone: ZoneEnemy,
	target: Cell,
	provider: ShotCellsProvider,
	budget: { pairs: number, max: number }
): EnemyThreat | null | "aborted" {
	const near = zone.nearest.get(cellKey(target))
	if (near === undefined) {
		return null
	}
	const { rows, columns, descending, ascending, reach } = zone
	const x = target.x
	const y = target.y
	// L'ennemi ne tire pas depuis `target` : la case de tir la plus proche est au moins à 1.
	const distance = Math.max(1, Math.abs(near.x - x) + Math.abs(near.y - y))
	if (distance > zone.range) {
		return null
	}
	const row = rows.get(y)
	const column = columns.get(x)
	const down = descending.get(x - y)
	const up = ascending.get(x + y)
	const lineGoal = row === undefined && column === undefined ? 0 : reach[OFFSET_LINE]![distance]!
	const diagonalGoal = down === undefined && up === undefined ? 0 : reach[OFFSET_DIAGONAL]![distance]!
	const otherGoal = reach[OFFSET_OTHER]![distance]!
	const search: ZoneSearch = { damage: 0, outcome: null, cell: null }
	let complete = scanShots(zone, [near], -1, Math.max(lineGoal, diagonalGoal, otherGoal), target, provider, budget, search) &&
		scanShots(zone, row, OFFSET_LINE, lineGoal, target, provider, budget, search) &&
		scanShots(zone, column, OFFSET_LINE, lineGoal, target, provider, budget, search) &&
		scanShots(zone, down, OFFSET_DIAGONAL, diagonalGoal, target, provider, budget, search) &&
		scanShots(zone, up, OFFSET_DIAGONAL, diagonalGoal, target, provider, budget, search)
	if (complete && search.damage < otherGoal) {
		// Plus grande distance où une case de tir non alignée peut encore faire mieux (elle existe : otherGoal > trouvé).
		const others = zone.bound[OFFSET_OTHER]!
		let radius = zone.range
		while (others[radius]! <= search.damage) {
			radius--
		}
		complete = scanShots(zone, shotsWithin(zone, target, radius), OFFSET_OTHER, otherGoal, target, provider, budget, search)
	}
	if (!complete) {
		return "aborted"
	}
	const outcome = search.outcome
	if (outcome === null || search.cell === null) {
		return null
	}
	const { enemy, variants } = zone.prepared
	const variant = variants[outcome.variant]!
	return {
		enemyId: enemy.id,
		name: enemy.name,
		damage: outcome.plan.damage,
		shotCell: search.cell,
		weapon: outcome.plan.weapon,
		weaponShots: outcome.plan.weaponShots,
		chips: outcome.plan.chips,
		swapTp: outcome.plan.weapon === null ? 0 : outcome.swap,
		boostTp: variant.boostTp,
		strengthGain: variant.strengthGain,
		tpGain: variant.tpGain
	}
}

/**
 * Zone visée : toutes les cases qu'au moins un ennemi peut toucher à son prochain tour, que je puisse les atteindre
 * ou non, avec le même modèle et les mêmes dégâts que la carte de danger (« si j'étais sur cette case », sans zone
 * d'effet ; voir `zoneThreat`). Les cases à danger nul ne sont pas retenues. Le planificateur ne la lit pas.
 *
 * Candidates : par ennemi, un parcours en largeur sur les coordonnées (obstacles et bords traversés : seule la
 * distance de Manhattan compte) depuis toutes ses cases de tir, jusqu'à sa portée maximale ; il donne à chaque point
 * une case de tir la plus proche. Une candidate est un point atteint qui est une case non-obstacle
 * (`Field.cellFromXY`, un appel par point, partagé entre ennemis) ; la case d'une entité (ennemi compris) le reste.
 * Elles sont évaluées de la plus proche de `me` à la plus lointaine : une troncature garde le voisinage.
 * `mpCost` vaut -1 hors des cases de `options.known`.
 *
 * Bornes propres : `MAX_TARGET_ZONE_PAIRS` (ou `maxPairs`) et `TARGET_ZONE_OPERATIONS_FRACTION` ; au-delà, `truncated`
 * (cases non évaluées absentes). `candidateCells` compte les candidates, `evaluatedCells` celles évaluées.
 */
export function buildTargetZone(
	me: Pick<Entity, "id" | "cell">,
	enemies: readonly ThreatEnemy[],
	turn: number,
	options: TargetZoneOptions = {}
): ThreatMap {
	const metered = typeof System !== "undefined" && Number.isFinite(System.operations)
	const startOperations = metered ? System.operations : 0
	const provider = options.provider ?? new GeometricShotCells()
	const budget = { pairs: 0, max: options.maxPairs ?? MAX_TARGET_ZONE_PAIRS }
	const ceiling = operationsCeiling(TARGET_ZONE_OPERATIONS_FRACTION)
	const known = options.known ?? null
	const zones: ZoneEnemy[] = []
	let inputsTruncated = false
	let truncated = false
	/** Plafond qui coupe (vide : pas de coupure, ou portée infinie, entrée non gérée et non plafond). */
	let cause = ""
	for (const enemy of enemies) {
		inputsTruncated = inputsTruncated || enemy.reachable.truncated
		const item = prepare(enemy)
		if (item === null) {
			continue
		}
		if (!Number.isFinite(item.maxRange)) {
			truncated = true
			continue
		}
		zones.push(prepareZone(item, provider.launchPatterns === true))
	}

	// Candidates rangées par distance à ma case (anneaux) : pas de tri, ordre stable.
	const rings: Cell[][] = []
	const cells = new Map<number, Cell | null>()
	let candidateCells = 0
	const visit = (x: number, y: number, key: number, found: Cell | null): void => {
		if (cells.has(key)) {
			return
		}
		const cell = found ?? Field.cellFromXY(x, y)
		if (cell === null || cell.obstacle) {
			cells.set(key, null)
			return
		}
		cells.set(key, cell)
		const distance = Math.abs(cell.x - me.cell.x) + Math.abs(cell.y - me.cell.y)
		const ring = rings[distance]
		if (ring === undefined) {
			rings[distance] = [cell]
		} else {
			ring.push(cell)
		}
		candidateCells++
	}
	spreading:
	for (const zone of zones) {
		const nearest = zone.nearest
		let xs: number[] = []
		let ys: number[] = []
		let sources: Cell[] = []
		for (const shot of zone.prepared.shotCells) {
			const key = cellKey(shot)
			nearest.set(key, shot)
			visit(shot.x, shot.y, key, shot)
			xs.push(shot.x)
			ys.push(shot.y)
			sources.push(shot)
		}
		for (let depth = 1; depth <= zone.range; depth++) {
			if (overCeiling(ceiling)) {
				truncated = true
				cause = "operations ceiling (spreading)"
				break spreading
			}
			const nextXs: number[] = []
			const nextYs: number[] = []
			const nextSources: Cell[] = []
			for (let i = 0; i < xs.length; i++) {
				const source = sources[i]!
				for (const [dx, dy] of MOVE_NEIGHBOR_OFFSETS) {
					const x = xs[i]! + dx
					const y = ys[i]! + dy
					const key = x * 4096 + y
					if (nearest.has(key)) {
						continue
					}
					nearest.set(key, source)
					visit(x, y, key, null)
					nextXs.push(x)
					nextYs.push(y)
					nextSources.push(source)
				}
			}
			xs = nextXs
			ys = nextYs
			sources = nextSources
		}
	}

	// Un parcours interrompu laisse des `nearest` incomplets : plus aucune case n'est calculée (les connues restent).
	const byKey = new Map<number, ThreatCell>()
	let evaluatedCells = 0
	evaluation:
	for (const ring of rings) {
		if (ring === undefined) {
			continue
		}
		for (const cell of ring) {
			const reused = known === null ? null : known.entryAt(cell)
			if (reused !== null) {
				evaluatedCells++
				if (reused.danger > 0) {
					byKey.set(cellKey(cell), reused)
				}
				continue
			}
			if (truncated || overCeiling(ceiling)) {
				if (!truncated) cause = "operations ceiling"
				truncated = true
				break evaluation
			}
			let danger = 0
			const breakdown: EnemyThreat[] = []
			for (const zone of zones) {
				const threat = zoneThreat(zone, cell, provider, budget)
				if (threat === "aborted") {
					truncated = true
					cause = "pairs cap"
					break evaluation
				}
				if (threat !== null) {
					danger += threat.damage
					breakdown.push(threat)
				}
			}
			evaluatedCells++
			if (danger > 0) {
				byKey.set(cellKey(cell), { cell, mpCost: -1, danger, breakdown })
			}
		}
	}
	if (cause !== "") {
		logSearchCut("zone visée", cause, `${cutOperations()} paires=${budget.pairs}/${budget.max} cases=${evaluatedCells}/${candidateCells}`)
	}
	return new ThreatMap(me.id, turn, byKey, {
		truncated,
		inputsTruncated,
		enemyCount: enemies.length,
		pairsEvaluated: budget.pairs,
		lineOfSightCalls: provider.lineOfSightCalls ?? 0,
		candidateCells,
		evaluatedCells,
		operations: metered ? System.operations - startOperations : null
	})
}
