// @version:5.8
// file version: 2
import { ReachableCells } from "../Context/ReachableCells.js"
import { ThreatMap } from "../Context/ThreatMap.js"
import { SEARCH_GLOBAL_FRACTION } from "./ExecutionBudget.js"
import { StagnationTracker } from "../Context/StagnationTracker.js"
import type { BoostOption } from "../../Brain/StrengthBoost.js"

export interface TacticalContext {
	readonly reachable: ReachableCells | null
	readonly threat: ThreatMap | null
	/** Compteur de stagnation et de passivité (optionnel : sans lui, ni sortie de stagnation ni baisse du poids du risque). */
	readonly stagnation?: StagnationTracker
	/**
	 * Boost de PM candidat, calculé À LA DEMANDE par l'observation (lecture seule, aucune dépense) : `unlock` = un tir
	 * est débloqué par PM + gain (`decideMpBoost`), `flee` = le meilleur plan sans boost est létal (`decideFleeMpBoost`).
	 * Null : pas de candidat. Absent : aucun boost de PM n'est comparé.
	 */
	readonly mpBoost?: (kind: "unlock" | "flee", preparation: TacticalPreparation) => MpBoostCandidate | null
}

/** Zone atteignable et carte de danger à PM + gain d'un boost de PM, pour la seconde recherche du planificateur. */
export interface MpBoostCandidate {
	readonly option: BoostOption
	readonly reachable: ReachableCells
	readonly threat: ThreatMap
	readonly reason: string
}

/** Éphémère, sans dépense : réutilisable par le secours uniquement au même état. */
export interface TacticalPreparation {
	readonly entityId: number
	readonly origin: Cell
	readonly reachable: ReachableCells | null
	readonly turn: number
	readonly mp: number
	readonly tp: number
	readonly enemies: Array<{ enemy: Entity; cell: Cell }>
	dangers: ReadonlyMap<number, number> | null
	readonly weaponCells: Map<Entity, Map<Weapon, Cell[]>>
	/** Listes natives de cases de tir des puces offensives, par cible : indépendantes de mes PM, partagées avec le boost de PM. */
	readonly chipCells: Map<Entity, Map<Chip, Cell[]>>
	readonly currentWeapons: Map<Entity, Map<Weapon, boolean>>
}

export interface TacticalPlan {
	readonly target: Entity
	readonly shotCell: Cell
	readonly destination: Cell
	readonly beforeMp: number
	readonly afterMp: number
	readonly weapon: Weapon | null
	readonly weaponShots: number
	readonly chips: readonly Chip[]
	readonly protection: readonly Chip[]
	/** Boosts lancés avant la protection (PT, force, puis agilité de remplissage) ; `tpGain` : PT que le plan compte recevoir du boost de PT. */
	readonly boost?: { readonly chips: readonly Chip[]; readonly tpGain: number }
	/** Boost de PM : PREMIÈRE action exécutée ; le plan est cherché sur la zone à PM + `gain`, avec `chip.cost` PT de moins. */
	readonly mpBoost?: { readonly chip: Chip; readonly gain: number }
	/** PT dépensés, boosts compris, boost de PM compris (les PT gagnés ne sont pas déduits). */
	readonly tpUsed: number
	readonly usefulDamage: number
	/** Danger brut conservé, même si les dégâts moyens dépassent les PV de la cible. */
	readonly danger: number
	readonly score: number
	/** Terme `N` du score : valeur de la case finale pour le tour suivant (voir `NEXT_TURN_WEIGHT`) ; absent = 0. */
	readonly nextTurn?: number
	readonly progress?: number
	readonly progressModel?: "future firing route" | "stagnation walk route"
	/** Sortie de stagnation : tours sans progrès et distance de MARCHE (BFS) vers une zone de tir, avant/après. */
	readonly stagnation?: { readonly turns: number; readonly walkBefore: number; readonly walkAfter: number }
	/** Distance dans le graphe courant vers une case de tir native, si connue. */
	readonly firingDistance?: number
	/** Distance vers une case de tir géométrique hypothétique, non native. */
	readonly futureRouteDistance?: number
	readonly searchStatus?: string
	readonly state?: { readonly turn: number; readonly enemies: ReadonlyArray<{ enemy: Entity; cell: Cell }> }
}

export class Unavailable extends Error {}

/**
 * Bornes de recherche, pas des mesures d'opérations moteur. Aucun plan partiel n'est exécuté.
 * `cells` 85 → 113 (losange de 7 PM en terrain ouvert : 5 PM + bottes) quand le budget du tour est passé à
 * 2 000 000 d'opérations (pic d'opérations relevé : 44 % à 5 PM). Coût à 113 cases non mesuré en combat.
 */
export const TACTICAL_LIMITS = {
	cells: 113, enemies: 4, weapons: 4, attackChips: 8, protectionChips: 3, tp: 30, work: 100000
} as const

/**
 * Arrêt de la recherche, en fraction de `System.maxOperations`. Relevé de 15 % à 30 % (alors 300 000 sur 1 000 000 ; 600 000 sur 2 000 000 aujourd'hui) :
 * combat 54939649, tours 4 et 5, la recherche interrompue à 150 000 laissait au plan B une attaque à danger 147
 * alors que le planificateur complet choisissait une case sûre. Aucun coût réel mesuré : politique, pas borne moteur.
 */
const SEARCH_FRACTION = 0.30

/**
 * Compteurs de l'évaluation : puces écartées, cause d'un plan nul sans progrès (sinon raison générique), tour condamné
 * et score du meilleur plan classé, même s'il est nul faute d'action (rester sur place) : référence du boost de PM.
 */
export interface Skipped { refused: number; noProgress: string | null; doomed: boolean; leaderScore: number | null }

export class Budget {
	private work = 0
	private readonly start = typeof System === "undefined" ? 0 : System.operations
	private readonly fraction: number
	incumbent: TacticalPlan | null = null

	/** Ticks de recherche consommés (mesure indirecte : un tick n'est pas une opération du moteur). */
	get used(): number { return this.work }

	/** `fraction` : part de `System.maxOperations` permise depuis la construction (recherche : `SEARCH_FRACTION`). */
	constructor(fraction: number = SEARCH_FRACTION) { this.fraction = fraction }

	tick(): void {
		if (++this.work > TACTICAL_LIMITS.work) {
			throw new Unavailable("search bound")
		}
		if (this.work % 64 === 1) this.check()
	}

	check(): void {
		if (typeof System !== "undefined" &&
			Number.isFinite(System.maxOperations) && System.maxOperations > 0 &&
			(System.operations >= System.maxOperations * SEARCH_GLOBAL_FRACTION ||
				System.operations - this.start >= System.maxOperations * this.fraction)) {
			throw new Unavailable("operations reserve")
		}
	}
}

export function key(cell: Cell): number { return cell.x * 4096 + cell.y }
export function same(a: Cell, b: Cell): boolean { return key(a) === key(b) }
export function validCost(cost: number): boolean { return Number.isInteger(cost) && cost > 0 }
