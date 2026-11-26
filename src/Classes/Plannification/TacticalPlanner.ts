// @version:5.8
// file version: 31
import { ReachableCells, computeReachableCells, MOVE_NEIGHBOR_OFFSETS } from "../Context/ReachableCells.js"
import { isCellInLaunchPattern } from "../Context/LaunchPattern.js"
import { aliveEnemies } from "../Context/Targets.js"
import { ThreatMap } from "../Context/ThreatMap.js"
import {
	ShotCandidate, baseMeanDamage, chipUsesOf, isStrengthBoostType, isTpBoostType, maxUsesOf, toCandidate
} from "../Context/ShotPlan.js"
import { LeekProfile, createStrategy } from "../LeekProfile.js"
import { LeekStrategy } from "../Strategy/LeekStrategy.js"
import {
	BoostOption, FUTURE_TURN_WEIGHT, MIN_LIFE_RATIO_FOR_BOOST, boostReach, pickAgilityBoost, pickBoost, pickTpBoost,
	strengthBoostFutureDamage, tpBoostFutureDamage
} from "../../Brain/StrengthBoost.js"
import { log, LOG_CONTEXT } from "../../Toolbox/Logger.js"
import { ExecutionBudget, EXECUTION_BUDGET_POLICY, SEARCH_GLOBAL_FRACTION, hasExecutionRoom } from "./ExecutionBudget.js"
import { StagnationTracker, STAGNATION_TURNS } from "../Context/StagnationTracker.js"
import { track } from "../Context/StagnationTracker.js"

export interface TacticalContext {
	readonly reachable: ReachableCells | null
	readonly threat: ThreatMap | null
	/** Compteur de stagnation et de passivité (optionnel : sans lui, ni sortie de stagnation ni baisse du poids du risque). */
	readonly stagnation?: StagnationTracker
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
	/** PT dépensés, boosts compris (les PT gagnés ne sont pas déduits). */
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

class Unavailable extends Error {}

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
 * Sortie de stagnation : au plus 613 cases explorées (toute la carte) et un arrêt facultatif à 2 % de
 * `System.maxOperations` depuis son entrée, comme le trajet futur existant. Aucune mesure d'opérations réelle.
 */
const STAGNATION_ROUTE_CELLS = 613
const STAGNATION_ROUTE_FRACTION = 0.02

/** Compteurs de l'évaluation : puces écartées, et cause d'un plan nul sans progrès (sinon raison générique). */
interface Skipped { refused: number; noProgress: string | null }

/**
 * Zone d'effet d'une puce offensive : distance de Manhattan à la cible jusqu'à laquelle le lanceur peut se trouver
 * dans la zone (le plan ne simule pas les zones). Clés : types `area` du moteur officiel (leek-wars-generator,
 * `Area.java`) : cercles 1-3 (3, 4, 5), plus 2-3 (6, 7), X 1-3 (8, 9, 10), carrés 1-2 (11, 12). Case seule, laser,
 * premier en ligne, `area` absent ou inconnu : 0. Renvoie 0 si chaque effet exclut le lanceur (`targets` sans le
 * bit 4, `TARGET_CASTER` du moteur ; Éclair : 27). HYPOTHÈSE non vérifiée en combat : `chip.area` et
 * `feature.targets` de l'API ont ces valeurs ; `targets` illisible = lanceur supposé touché.
 */
const AREA_SELF_RADIUS: Readonly<Record<number, number>> = { 3: 1, 4: 2, 5: 3, 6: 2, 7: 3, 8: 2, 9: 4, 10: 6, 11: 2, 12: 4 }
const TARGET_CASTER = 4
export function selfHitRadius(chip: Chip): number {
	const radius = AREA_SELF_RADIUS[chip.area ?? 1] ?? 0
	if (radius === 0 || chip.features.every((feature) =>
		Number.isInteger(feature.targets) && (feature.targets & TARGET_CASTER) === 0)) return 0
	return radius
}
class Budget {
	private work = 0
	private readonly start = typeof System === "undefined" ? 0 : System.operations
	private readonly fraction: number
	incumbent: TacticalPlan | null = null

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

function key(cell: Cell): number { return cell.x * 4096 + cell.y }
function same(a: Cell, b: Cell): boolean { return key(a) === key(b) }
function validCost(cost: number): boolean { return Number.isInteger(cost) && cost > 0 }

function featureValue(chip: Chip, type: number): number {
	let value = 0
	for (const feature of chip.features) {
		if (feature.type === type) value += (feature.minValue + feature.maxValue) / 2
	}
	return Math.max(0, value)
}

/** Estimation par feature de dégâts ; arrondis, critiques, érosion et effets secondaires non simulés. */
function netDamage(candidate: ShotCandidate, target: Entity): number {
	const relative = Math.max(0, Math.min(100, target.relativeShield || 0))
	const absolute = Math.max(0, target.absoluteShield || 0)
	const base = baseMeanDamage(candidate.item)
	const scale = base > 0 ? candidate.damage / base : 0
	let damage = 0
	for (const feature of candidate.item.features) {
		if (feature.type === Effect.DAMAGE) {
			const impact = (feature.minValue + feature.maxValue) / 2 * scale
			damage += Math.max(0, impact * (1 - relative / 100) - absolute)
		}
	}
	return damage
}

interface Attack {
	damage: number
	weaponShots: number
	chips: readonly Chip[]
}

interface AttackChoice { attack: Attack; cost: number }

/** Meilleur coût exact ≤ budget ; dégâts utiles plafonnés puis PT minimaux. */
function attackChoices(
	states: Array<Attack | undefined>, target: Entity, weaponRequired: boolean, budget: Budget
): Array<AttackChoice | undefined> {
	const choices: Array<AttackChoice | undefined> = []
	let best: AttackChoice | undefined
	for (let cost = 0; cost < states.length; cost++) {
		budget.tick()
		const attack = states[cost]
		if (attack && (!weaponRequired || attack.weaponShots > 0) &&
			(!best || Math.min(target.life, attack.damage) > Math.min(target.life, best.attack.damage))) {
			best = { attack, cost }
		}
		choices.push(best)
	}
	return choices
}

/**
 * Sac à dos borné : chaque puce au plus `uses` fois (1 avec un cooldown de base, voir `chipUsesOf`), tous les
 * nombres de tirs permis. Une entrée par coût EXACT ; aucune comparaison gloutonne dégâts/PT. Une puce lancée
 * N fois figure N fois dans `chips` ; elle coûte au plus floor(PT / coût) passes sur la table.
 */
function attacks(
	tp: number, weapon: ShotCandidate | null, chips: readonly ShotCandidate[], target: Entity, budget: Budget
): Array<Attack | undefined> {
	let states: Array<Attack | undefined> = new Array(tp + 1)
	states[0] = { damage: 0, weaponShots: 0, chips: [] }
	if (weapon !== null) {
		const limit = Math.min(weapon.uses, Math.floor(tp / weapon.cost))
		const impact = netDamage(weapon, target)
		for (let shots = 1; shots <= limit; shots++) {
			budget.tick()
			states[shots * weapon.cost] = {
				damage: shots * impact, weaponShots: shots, chips: []
			}
		}
	}
	for (const chip of chips) {
		const impact = netDamage(chip, target)
		const casts = Math.min(chip.uses, Math.floor(tp / chip.cost))
		for (let cast = 0; cast < casts; cast++) {
			const next = states.slice()
			let improved = false
			for (let cost = 0; cost + chip.cost <= tp; cost++) {
				budget.tick()
				const state = states[cost]
				if (state === undefined) continue
				const damage = state.damage + impact
				if (damage > (next[cost + chip.cost]?.damage ?? -1)) {
					next[cost + chip.cost] = {
						damage, weaponShots: state.weaponShots, chips: [...state.chips, chip.item as Chip]
					}
					improved = true
				}
			}
			if (!improved) break
			states = next
		}
	}
	return states
}

interface Protection {
	chips: readonly Chip[]
	cost: number
	heal: number
	absolute: number
	relative: number
}

/**
 * `healing` / `shielding` : le profil l'autorise ET le seuil du rôle (`Strategy/*.ts`) est atteint ; mêmes seuils
 * que le plan B.
 */
function protections(me: Me, healing: boolean, shielding: boolean, budget: Budget): Protection[] {
	const usable = (chip: Chip): boolean => {
		budget.check()
		const result = me.canUseChip(chip, me)
		budget.check()
		return result
	}
	const candidates = [...new Set(me.chips)].filter((chip) =>
		validCost(chip.cost) && chip.cost <= me.tp && chip.currentCooldown === 0 && maxUsesOf(chip) > 0 &&
		chip.features.length > 0 && chip.features.every((feature) =>
			(feature.type === Effect.HEAL && healing) ||
			((feature.type === Effect.ABSOLUTE_SHIELD || feature.type === Effect.RELATIVE_SHIELD) && shielding)
		) && usable(chip)
	)
	if (candidates.length > TACTICAL_LIMITS.protectionChips) throw new Unavailable("protection bound")
	const result: Protection[] = [{ chips: [], cost: 0, heal: 0, absolute: 0, relative: 0 }]
	for (const chip of candidates) {
		for (const previous of result.slice()) {
			if (previous.cost + chip.cost > me.tp) continue
			result.push({
				chips: [...previous.chips, chip], cost: previous.cost + chip.cost,
				heal: Math.min(me.maxLife - me.life,
					previous.heal + featureValue(chip, Effect.HEAL) * (1 + me.wisdom / 100)),
				// Crédit prudent en valeur de base, sans prétendre simuler la résistance du lanceur.
				absolute: previous.absolute + featureValue(chip, Effect.ABSOLUTE_SHIELD),
				relative: Math.min(100, previous.relative + featureValue(chip, Effect.RELATIVE_SHIELD))
			})
		}
	}
	return result
}

/** Ne crédite qu'un impact d'armure absolue, jamais tous les tirs potentiels. Heuristique, pas PV garantis. */
function shieldCredit(protection: Protection, danger: number): number {
	return Math.min(danger, protection.absolute + danger * protection.relative / 100)
}

/**
 * Sous le seuil de repli du rôle (`shouldHide`), le danger pèse `RETREAT_RISK_FACTOR` fois plus.
 * Choix heuristique, non calibré en combat.
 */
export const RETREAT_RISK_FACTOR = 2

/**
 * Poids du risque, commun au plan conjoint et au plan B : facteur de rôle × (1,5 − agressivité / 100), multiplié
 * par `RETREAT_RISK_FACTOR` si le profil autorise le repli et que `strategy.shouldHide` le demande (`distance` :
 * Manhattan à l'ennemi vivant le plus proche ; « trop près » dépend de `profile.preferredMinRange`).
 */
export function riskWeight(profile: LeekProfile, strategy: LeekStrategy, lifeRatio: number, distance: number): number {
	const weight = (profile.strategyName === "DEFENSIVE" ? 1.25 :
		profile.strategyName === "AGGRESSIVE" ? 0.75 : 1) * (1.5 - profile.aggression / 100)
	return profile.allowHiding && strategy.shouldHide(lifeRatio, distance, profile.preferredMinRange)
		? weight * RETREAT_RISK_FACTOR : weight
}

/** Variante de boost d'un plan : puces dans l'ordre de lancer (PT puis force), coût total et effets attendus. */
interface BoostVariant {
	chips: readonly Chip[]
	cost: number
	/** PT entiers attendus du boost de PT, dès le lancer (hypothèse de `tpBoostOf`, valeur moyenne arrondie par défaut). */
	tpGain: number
	tp: BoostOption | null
	strength: BoostOption | null
}

/**
 * Au plus 4 variantes : aucune, meilleur boost de PT prêt, meilleur boost de force prêt, les deux. Sans boost
 * prêt (ou effet déjà actif) : la seule variante « aucune », donc aucun travail de plus dans la recherche.
 */
function boostVariants(me: Me): BoostVariant[] {
	const variants: BoostVariant[] = [{ chips: [], cost: 0, tpGain: 0, tp: null, strength: null }]
	const tp = pickTpBoost(me, me.tp)
	const strength = pickBoost(me, me.tp)
	const tpGain = tp ? Math.floor(tp.gain) : 0
	if (tp) variants.push({ chips: [tp.chip], cost: tp.chip.cost, tpGain, tp, strength: null })
	if (strength) variants.push({ chips: [strength.chip], cost: strength.chip.cost, tpGain: 0, tp: null, strength })
	if (tp && strength && tp.chip !== strength.chip && strength.chip.cost <= me.tp - tp.chip.cost + tpGain) {
		variants.push({ chips: [tp.chip, strength.chip], cost: tp.chip.cost + strength.chip.cost, tpGain, tp, strength })
	}
	return variants
}

/**
 * Crédit des tours suivants d'une variante pour `weapon` (voir `StrengthBoost.ts`), avant plafonnement par
 * `FUTURE_TURN_WEIGHT` × les PV qui restent à la cible. Estimation à une arme ; les deux boosts sont crédités
 * indépendamment.
 */
function boostFuture(me: Me, variant: BoostVariant, weapon: Weapon | null, enemyLife: number): number {
	if (weapon === null) return 0
	return (variant.strength ? strengthBoostFutureDamage(weapon, variant.strength, me.tp) : 0) +
		(variant.tp ? tpBoostFutureDamage(me, weapon, variant.tp, me.tp, enemyLife) : 0)
}

/**
 * Marge sur les dégâts moyens pour compter un meurtre : les dégâts varient (min–max), aucune garantie.
 * Seul le dernier ennemi vivant, tué, annule le danger du plan.
 */
export const KILL_MARGIN = 1.1

/** Pénalité d'un plan dont le danger prévu atteint mes PV (soin compris) : la survie passe avant les dégâts. */
export const LETHAL_PENALTY = 1000

/**
 * Marge sous les PV quand la passivité réduit le poids du risque (`riskFactor < 1`) : le danger modélisé accepté reste
 * strictement sous cette fraction de mes PV (soin prévu compris). 0,75 : le modèle ignore les critiques, et un tour
 * ennemi entièrement critique vaut 1,3 fois le danger modélisé (`CRITICAL_FACTOR`), soit mes PV à 77 % ; arrondi en
 * dessous. À 60 PV : danger accepté < 45. À poids plein, le seuil reste mes PV (fraction 1). Non calibré en combat.
 */
export const PASSIVE_DANGER_LIFE_FRACTION = 0.75

/**
 * Coût de risque d'un plan, en points de score : `weight` × danger après protection, plus `LETHAL_PENALTY` et
 * le dépassement si ce danger atteint `lifeFraction` × mes PV (vie + soin prévu ; 1 à poids plein,
 * `PASSIVE_DANGER_LIFE_FRACTION` à poids réduit). Nul si le plan tue le dernier ennemi.
 * Estimation du modèle, pas une garantie de survie (critiques, buffs recastés et armes inconnues non prévus).
 */
function riskCost(
	me: Me, weight: number, protection: Protection, danger: number, kills: boolean, lifeFraction: number
): number {
	if (kills) return 0
	const exposed = danger - shieldCredit(protection, danger)
	const limit = (me.life + protection.heal) * lifeFraction
	return weight * exposed + (exposed >= limit ? LETHAL_PENALTY + exposed - limit : 0)
}

/** Seuil létal de `riskCost` atteint ? Alors `N` = 0 : aucune valeur future ne rachète une case où je peux mourir. */
function lethal(me: Me, protection: Protection, danger: number, lifeFraction: number): boolean {
	return danger - shieldCredit(protection, danger) >= (me.life + protection.heal) * lifeFraction
}

function killsLastEnemy(damage: number, target: Entity, enemyCount: number): boolean {
	return enemyCount === 1 && damage >= target.life * KILL_MARGIN
}

/**
 * Comparaison d'un candidat décrit par ses seuls critères (sans construire l'objet) : permet de ne créer que les
 * plans qui améliorent le meilleur. Ordre : score, danger, PT dépensés, distance de tir courante puis future (même
 * cible), PM totaux. `better` en est la forme sur un plan complet : une seule règle.
 * `doomed` (tour condamné, voir `evaluate`) : une cible tuée (dégâts moyens ≥ ses PV) passe AVANT le score ; le reste
 * du classement est inchangé (soin, protection et case finale gardent leur score : « condamné » reste une estimation).
 */
function beats(
	best: TacticalPlan | null, doomed: boolean, usefulDamage: number, score: number, danger: number, tpUsed: number,
	target: Entity, firingDistance: number | undefined, futureRouteDistance: number | undefined, totalMp: number
): boolean {
	if (best === null) return true
	if (doomed) {
		const kill = usefulDamage >= target.life
		if (kill !== (best.usefulDamage >= best.target.life)) return kill
	}
	if (score !== best.score) return score > best.score
	if (danger !== best.danger) return danger < best.danger
	if (tpUsed !== best.tpUsed) return tpUsed < best.tpUsed
	if (target === best.target && firingDistance !== undefined &&
		best.firingDistance !== undefined && firingDistance !== best.firingDistance) {
		return firingDistance < best.firingDistance
	}
	if (target === best.target && futureRouteDistance !== undefined &&
		best.futureRouteDistance !== undefined && futureRouteDistance !== best.futureRouteDistance) {
		return futureRouteDistance < best.futureRouteDistance
	}
	return totalMp < best.beforeMp + best.afterMp
}

function better(candidate: TacticalPlan, best: TacticalPlan | null, doomed: boolean): boolean {
	return beats(best, doomed, candidate.usefulDamage, candidate.score, candidate.danger, candidate.tpUsed, candidate.target,
		candidate.firingDistance, candidate.futureRouteDistance, candidate.beforeMp + candidate.afterMp)
}

/**
 * Parcours exploratoire facultatif, sans tir promis : l'unique arme choisie peut
 * être inabordable ce tour. Les distances retournées suivent seulement des
 * cases actuellement traversables, y compris au-delà des PM de ce tour.
 */
function futureWeaponRoute(
	me: Me, target: Entity, weapons: readonly Weapon[], reachable: ReachableCells, budget: Budget
): Map<number, number> | null {
	if (me.mp <= 0 || typeof Field === "undefined" || typeof Field.cellFromXY !== "function") return null
	const weapon = weapons.find((item) => validCost(item.cost) &&
		Number.isFinite(item.minRange) && Number.isFinite(item.maxRange) &&
		item.minRange >= 0 && item.maxRange >= item.minRange && toCandidate(item, false, me.strength) !== null)
	if (!weapon || (weapon.needsLos && typeof Field.lineOfSight !== "function")) return null
	const maximumCells = 160, maximumDistance = 8, maximumSightCalls = 8
	const startOps = typeof System === "undefined" ? 0 : System.operations
	const room = (): boolean => {
		budget.check()
		return typeof System === "undefined" || !Number.isFinite(System.maxOperations) ||
			System.maxOperations <= 0 || System.operations - startOps < System.maxOperations * 0.02
	}
	const queue = [...reachable.entries()].map(({ cell, cost }) => ({ cell, cost }))
	const cells = new Map<number, Cell>(queue.map(({ cell }) => [key(cell), cell]))
	const seen = new Set<number>(cells.keys())
	let goal: Cell | null = null
	let sightCalls = 0
	for (let head = 0; head < queue.length; head++) {
		if (!room()) return null
		budget.tick()
		const { cell, cost } = queue[head]!
		const dx = target.cell.x - cell.x, dy = target.cell.y - cell.y
		const range = Math.abs(dx) + Math.abs(dy)
		if (cost <= maximumDistance && range >= weapon.minRange && range <= weapon.maxRange &&
			isCellInLaunchPattern(weapon.launchType, dx, dy)) {
			if (!weapon.needsLos) { goal = cell; break }
			if (sightCalls >= maximumSightCalls) return null
			sightCalls++
			const visible = Field.lineOfSight(cell, target.cell)
			if (!room()) return null
			if (visible) { goal = cell; break }
		}
		if (cost >= maximumDistance || queue.length >= maximumCells) continue
		// Les contrôles de budget encadrent chaque appel natif (avant : fin du précédent ou en-tête de case ;
		// après : ci-dessous) : aucun contrôle supplémentaire n'est utile entre deux voisins déjà écartés.
		for (const [offsetX, offsetY] of MOVE_NEIGHBOR_OFFSETS) {
			const x = cell.x + offsetX, y = cell.y + offsetY
			const id = x * 4096 + y
			if (seen.has(id)) continue
			seen.add(id)
			const next = Field.cellFromXY(x, y)
			if (!room()) return null
			if (!next || next.obstacle || (next.entity !== null && next.entity.id !== me.id)) continue
			cells.set(id, next)
			queue.push({ cell: next, cost: cost + 1 })
			if (queue.length >= maximumCells) break
		}
	}
	if (!goal) return null
	// Les distances sont calculées dans le sous-graphe exploré, pas à vol d'oiseau.
	const distances = new Map<number, number>([[key(goal), 0]])
	const reverse = [goal]
	for (let head = 0; head < reverse.length; head++) {
		if (!room()) return null
		budget.tick()
		const cell = reverse[head]!
		const nextDistance = distances.get(key(cell))! + 1
		for (const [dx, dy] of MOVE_NEIGHBOR_OFFSETS) {
			const id = (cell.x + dx) * 4096 + cell.y + dy
			const next = cells.get(id)
			if (next && !distances.has(id)) { distances.set(id, nextDistance); reverse.push(next) }
		}
	}
	for (const { cell } of reachable.entries()) if (!distances.has(key(cell))) return null
	return distances
}

/**
 * Terme `N` du score : part créditée des dégâts moyens que la case finale d'un plan permet au tour SUIVANT. Même
 * esprit que `FUTURE_TURN_WEIGHT` (le contact n'est pas garanti : la cible est supposée immobile). Non calibré.
 */
export const NEXT_TURN_WEIGHT = 0.75

/**
 * Allocation du calcul de `N`, en part de `System.maxOperations` depuis son entrée : au-delà, `N` = 0 pour TOUTES
 * les cases (jamais un `N` partiel). Politique, pas un coût mesuré ; aucun appel natif de liste de cases n'y est fait.
 */
const NEXT_TURN_FRACTION = 0.05

/** Valeur des boosts actifs qui ne couvriront plus mon prochain tour (`turns` = 1 : hypothèse non vérifiée en combat). */
function expiringBoost(me: Me, isType: (type: number) => boolean): number {
	let value = 0
	for (const effect of me.effects ?? []) {
		if (isType(effect.type) && effect.turns === 1 && effect.value > 0) value += effect.value
	}
	return value
}

/**
 * Meilleurs dégâts moyens possibles au tour suivant depuis chaque case atteignable (ordre de `entries`), cible
 * supposée IMMOBILE ; null si aucune case n'en permet. `zones` : items dont la liste native de cases de tir a DÉJÀ
 * été obtenue ce tour (aucun appel natif ici). Un item est utilisable depuis `c` si une case de sa liste est à au
 * plus mes PM de MARCHE de `c` (cases libres ; hors de ma zone : `Field.cellFromXY`). Une seule propagation en
 * largeur pour tous les items (masques de bits), bornée au losange de rayon 2 × PM autour de ma case. Dégâts : maximum
 * exact par ensemble d'items (sac à dos des puces, une table par ensemble de puces, puis tirs d'une arme au plus,
 * 1 PT si ce n'est pas l'arme équipée en fin de plan), avec les PT et la force du début de ce tour moins les boosts
 * qui expirent, boucliers actuels de la cible.
 * Du plan, seule compte l'arme équipée à la fin : `equipped[0]` est l'arme actuelle, puis chaque autre arme de
 * `zones` ; `damages[e]` est le tableau pour `equipped[e]`. Ni ses tirs ni ses boosts (gain futur : terme `F`).
 * Approximation : les items d'un ensemble peuvent demander des cases de tir différentes.
 */
interface NextTurn { equipped: Array<Weapon | null>; damages: number[][] }

function nextTurnDamages(
	me: Me, target: Entity, entries: ReadonlyArray<{ cell: Cell; cost: number }>, entryIndex: ReadonlyMap<number, number>,
	zones: ReadonlyArray<{ item: Weapon | Chip; isChip: boolean; cells: readonly Cell[] }>, budget: Budget
): NextTurn | null {
	const tp = me.tp - Math.floor(expiringBoost(me, isTpBoostType))
	const strength = me.strength - expiringBoost(me, isStrengthBoostType)
	const mp = Math.max(0, me.mp)
	const items: Array<{ candidate: ShotCandidate; isChip: boolean; cells: readonly Cell[] }> = []
	for (const { item, isChip, cells } of zones) {
		const candidate = item.cost <= tp ? toCandidate(item, isChip, strength) : null
		if (candidate) items.push({ candidate, isChip, cells })
	}
	if (items.length === 0) return null
	if (typeof Field === "undefined" || typeof Field.cellFromXY !== "function") throw new Unavailable("no cell lookup")
	const ox = me.cell.x, oy = me.cell.y
	const free = (cell: Cell): boolean => !cell.obstacle && (cell.entity === null || cell.entity.id === me.id)
	const reach = new Map<number, number>()
	let frontier = new Map<number, { x: number; y: number; bits: number }>()
	for (let bit = 0; bit < items.length; bit++) {
		for (const cell of items[bit]!.cells) {
			budget.tick()
			const id = key(cell)
			if (Math.abs(cell.x - ox) + Math.abs(cell.y - oy) > 2 * mp || (!entryIndex.has(id) && !free(cell))) continue
			reach.set(id, (reach.get(id) ?? 0) | (1 << bit))
			const seed = frontier.get(id)
			if (seed) seed.bits |= 1 << bit
			else frontier.set(id, { x: cell.x, y: cell.y, bits: 1 << bit })
		}
	}
	// Chaque tour de boucle porte d'un pas les bits acquis au tour précédent (instantané : jamais deux pas par tour).
	// Une case à `step` pas d'une case de tir ne sert que si elle est à ≤ PM − `step` d'une case de ma zone.
	const open = new Map<number, boolean>()
	for (let step = 1; step <= mp && frontier.size > 0; step++) {
		const gained = new Map<number, { x: number; y: number; bits: number }>()
		for (const { x, y, bits } of frontier.values()) {
			budget.tick()
			for (const [dx, dy] of MOVE_NEIGHBOR_OFFSETS) {
				const nx = x + dx, ny = y + dy
				if (Math.abs(nx - ox) + Math.abs(ny - oy) > 2 * mp - step) continue
				const id = nx * 4096 + ny
				const old = reach.get(id) ?? 0
				const fresh = bits & ~old
				if (fresh === 0) continue
				if (old === 0 && !entryIndex.has(id)) {
					let walkable = open.get(id)
					if (walkable === undefined) {
						const cell = Field.cellFromXY(nx, ny)
						walkable = !!cell && free(cell)
						open.set(id, walkable)
					}
					if (!walkable) continue
				}
				reach.set(id, old | fresh)
				const entry = gained.get(id)
				if (entry) entry.bits |= fresh
				else gained.set(id, { x: nx, y: ny, bits: fresh })
			}
		}
		frontier = gained
	}
	const masks = entries.map(({ cell }) => reach.get(key(cell)) ?? 0)
	const equipped: Array<Weapon | null> = [me.weapon]
	for (const { candidate, isChip } of items) {
		if (!isChip && candidate.item !== me.weapon) equipped.push(candidate.item as Weapon)
	}
	// Puces : meilleurs dégâts pour un budget ≤ b, une table par ensemble de puces (partagée par les armes et les mains).
	const chipTables = new Map<number, number[]>()
	const chipTable = (mask: number): number[] => {
		let table = chipTables.get(mask)
		if (table) return table
		table = new Array<number>(tp + 1).fill(0)
		for (let bit = 0; bit < items.length; bit++) {
			const { candidate, isChip } = items[bit]!
			if (!isChip || (mask & (1 << bit)) === 0) continue
			const impact = netDamage(candidate, target)
			const cost = candidate.cost
			if (candidate.uses >= Math.floor(tp / cost)) {
				// Lancers non limités par `maxUses` dans ces PT : une passe croissante (la puce peut se cumuler).
				for (let spent = cost; spent <= tp; spent++) {
					budget.tick()
					table[spent] = Math.max(table[spent]!, table[spent - cost]! + impact)
				}
			} else for (let cast = 0; cast < candidate.uses; cast++) {
				for (let spent = tp; spent >= cost; spent--) {
					budget.tick()
					table[spent] = Math.max(table[spent]!, table[spent - cost]! + impact)
				}
			}
		}
		chipTables.set(mask, table)
		return table
	}
	let chipBits = 0
	for (let bit = 0; bit < items.length; bit++) if (items[bit]!.isChip) chipBits |= 1 << bit
	let any = false
	const damages = equipped.map((held) => {
		const byMask = new Map<number, number>([[0, 0]])
		return masks.map((mask) => {
			let best = byMask.get(mask)
			if (best !== undefined) return best
			const chips = chipTable(mask & chipBits)
			best = chips[tp]!
			for (let bit = 0; bit < items.length; bit++) {
				const { candidate, isChip } = items[bit]!
				if (isChip || (mask & (1 << bit)) === 0) continue
				const impact = netDamage(candidate, target)
				const left = tp - (candidate.item !== held ? 1 : 0)
				for (let shots = 1; shots <= candidate.uses && shots * candidate.cost <= left; shots++) {
					budget.tick()
					best = Math.max(best, shots * impact + chips[left - shots * candidate.cost]!)
				}
			}
			byMask.set(mask, best)
			any = any || best > 0
			return best
		})
	})
	budget.check()
	return any ? { equipped, damages } : null
}

interface StagnationInput {
	me: Me
	target: Entity
	turns: number
	weapons: readonly Weapon[]
	attackChips: readonly Chip[]
	chipZones: ReadonlyMap<Chip, Cell[]>
	entries: ReadonlyArray<{ cell: Cell; cost: number }>
	dangers: ReadonlyMap<number, number>
	preparation: TacticalPreparation
	skipped: Skipped
	budget: Budget
	visited: (cell: Cell) => boolean
	/** Poids du risque annulé par la passivité : seul un danger qui atteint `PASSIVE_DANGER_LIFE_FRACTION` × mes PV écarte une case. */
	riskFree: boolean
}

/**
 * Sortie de stagnation (combat 54940819) : après `STAGNATION_TURNS` tours sans tir ni progrès, aller vers la case
 * atteignable ce tour qui rapproche le plus, en distance de MARCHE (BFS, obstacles et occupants), d'une zone de
 * tir native d'une arme ou puce offensive, même si la distance Manhattan augmente (minimum local derrière un mur).
 * La sécurité reste prioritaire : seules les cases de danger ≤ celui de la case actuelle sont candidates (0 ici si
 * je suis sûr) et la marche doit diminuer strictement. Sinon : maintien, motivé dans le journal et dans la raison.
 * Exception `riskFree` (poids du risque annulé par la passivité, comme dans le plan normal) : toute case dont le danger
 * reste sous `PASSIVE_DANGER_LIFE_FRACTION` × mes PV est candidate.
 * La route peut demander plusieurs tours : un déplacement de sortie qui ne bat pas le record de proximité ne remet
 * pas le compteur à zéro (voir `StagnationTracker`) et la cible est recalculée chaque tour.
 */
function stagnationEscape(input: StagnationInput): TacticalPlan | null {
	const { me, target, turns, weapons, attackChips, chipZones, entries, dangers, preparation, skipped, budget, visited, riskFree } = input
	const hold = (reason: string): null => {
		skipped.noProgress = `stagnation: ${reason}`
		log(() => `[Tactical] stagnation: ${turns} turns without shot or progress (threshold ${STAGNATION_TURNS}); ` +
			`${reason}; holding, safety first`, LOG_CONTEXT.PLANNING)
		return null
	}
	if (typeof Field === "undefined" || typeof Field.cellFromXY !== "function") return hold("walking route unavailable")
	// Zone de tir : cases natives de toutes mes armes/puces offensives (listes déjà obtenues, sinon un appel).
	const goals = new Map<number, Cell>()
	const addZone = (raw: readonly Cell[]): void => {
		if (raw.length > 613) throw new Unavailable("native cells bound")
		for (const cell of raw) {
			budget.tick()
			if (!cell.obstacle && (cell.entity === null || cell.entity.id === me.id)) goals.set(key(cell), cell)
		}
	}
	for (const weapon of weapons) {
		if (!validCost(weapon.cost) || toCandidate(weapon, false, me.strength) === null) continue
		let raw = preparation.weaponCells.get(target)?.get(weapon)
		if (!raw) { budget.check(); raw = Fight.weaponCells(target, weapon); budget.check() }
		addZone(raw)
	}
	for (const chip of attackChips) {
		let raw = chipZones.get(chip)
		if (!raw) { budget.check(); raw = me.chipCells(chip, target); budget.check() }
		addZone(raw)
	}
	if (goals.size === 0) return hold("no firing zone known")
	// BFS inverse depuis la zone de tir jusqu'à avoir étiqueté toutes mes cases atteignables.
	const wanted = new Set(entries.map(({ cell }) => key(cell)))
	const walk = new Map<number, number>()
	const queue: Cell[] = []
	const seen = new Set<number>(goals.keys())
	let missing = wanted.size
	for (const [id, cell] of goals) { walk.set(id, 0); queue.push(cell); if (wanted.has(id)) missing-- }
	const startOps = typeof System === "undefined" ? 0 : System.operations
	for (let head = 0; head < queue.length && missing > 0 && queue.length < STAGNATION_ROUTE_CELLS; head++) {
		budget.tick()
		if (typeof System !== "undefined" && Number.isFinite(System.maxOperations) && System.maxOperations > 0 &&
			System.operations - startOps >= System.maxOperations * STAGNATION_ROUTE_FRACTION) {
			return hold("walking route search stopped by its operations allowance")
		}
		const cell = queue[head]!
		const next = walk.get(key(cell))! + 1
		for (const [dx, dy] of MOVE_NEIGHBOR_OFFSETS) {
			const x = cell.x + dx, y = cell.y + dy, id = x * 4096 + y
			if (seen.has(id)) continue
			seen.add(id)
			const neighbor = Field.cellFromXY(x, y)
			if (!neighbor || neighbor.obstacle || (neighbor.entity !== null && neighbor.entity.id !== me.id)) continue
			walk.set(id, next)
			queue.push(neighbor)
			if (wanted.has(id)) missing--
		}
	}
	const origin = walk.get(key(me.cell))
	if (origin === undefined) return hold("no walking route to a firing zone")
	const ceiling = dangers.get(key(me.cell))!
	const lifeLimit = me.life * PASSIVE_DANGER_LIFE_FRACTION
	let best: { cell: Cell; cost: number; walk: number; danger: number } | null = null
	for (const entry of entries) {
		budget.tick()
		const distance = walk.get(key(entry.cell))
		const danger = dangers.get(key(entry.cell))!
		if (distance === undefined || distance >= origin || visited(entry.cell) ||
			(riskFree ? danger >= lifeLimit : danger > ceiling)) continue
		if (best === null || distance < best.walk ||
			(distance === best.walk && (danger < best.danger || (danger === best.danger && entry.cost < best.cost)))) {
			best = { cell: entry.cell, cost: entry.cost, walk: distance, danger }
		}
	}
	if (best === null) {
		return hold(`no cell with danger ${riskFree ? `< ${lifeLimit} (${PASSIVE_DANGER_LIFE_FRACTION} x my life)` : `<= ${ceiling}`} closer by walking ` +
			`(walking distance ${origin})`)
	}
	const chosen = best
	log(() => `[Tactical] stagnation: ${turns} turns without shot or progress (threshold ${STAGNATION_TURNS}); ` +
		`escaping to (${chosen.cell.x},${chosen.cell.y}), walking distance ${origin} -> ${chosen.walk}, ` +
		`danger ${chosen.danger} (origin ${ceiling}), ${chosen.cost} MP`, LOG_CONTEXT.PLANNING)
	return {
		target, shotCell: me.cell, destination: chosen.cell, beforeMp: 0, afterMp: chosen.cost, weapon: null,
		weaponShots: 0, chips: [], protection: [], tpUsed: 0, usefulDamage: 0, danger: chosen.danger,
		score: origin - chosen.walk, progress: origin - chosen.walk, progressModel: "stagnation walk route",
		stagnation: { turns, walkBefore: origin, walkAfter: chosen.walk }
	}
}

/**
 * Boost d'agilité « de remplissage », ajouté au plan RETENU (après la recherche : ni score, ni comparaison, ni
 * variante de plus). Lancé seulement avec les PT que le plan n'emploie pas (PT − `tpUsed`, SANS les PT attendus d'un
 * boost de PT : s'ils n'arrivent pas, aucun tir prévu n'est perdu), moins 1 PT gardé pour `equipOpeningWeapon` au
 * tour 1 si le plan n'équipe pas d'arme : il ne prend jamais de PT à un tir, une protection ou un autre boost.
 * Facultatif : toute erreur rend le plan inchangé. Il doit pouvoir servir : le plan attaque ce tour (les critiques des tirs en
 * profitent, il est lancé avant), ou l'effet couvre le tour suivant (durée ≥ 2) et l'ennemi le plus proche est à
 * portée `boostReach` (critère du boost « sans tir »). Pas de seuil de PV : ces PT seraient perdus.
 */
function withAgilityFill(me: Me, plan: TacticalPlan, enemies: ReadonlyArray<{ enemy: Entity; cell: Cell }>): TacticalPlan {
	try {
		return agilityFill(me, plan, enemies)
	} catch {
		return plan
	}
}

function agilityFill(me: Me, plan: TacticalPlan, enemies: ReadonlyArray<{ enemy: Entity; cell: Cell }>): TacticalPlan {
	if (typeof me.canUseChip !== "function") return plan
	const reserve = Fight.turn === 1 && me.weapon === null && plan.weapon === null && (me.weapons ?? []).length > 0 ? 1 : 0
	const option = pickAgilityBoost(me, me.tp - plan.tpUsed - reserve)
	if (option === null) return plan
	if (plan.weaponShots === 0 && plan.chips.length === 0) {
		if (option.turns < 2) return plan
		let closest: Entity | null = null
		let closestDistance = Infinity
		for (const { enemy, cell } of enemies) {
			const range = Math.abs(me.cell.x - cell.x) + Math.abs(me.cell.y - cell.y)
			if (range < closestDistance) { closest = enemy; closestDistance = range }
		}
		if (closest === null || closestDistance > boostReach(me, closest)) return plan
	}
	if (!me.canUseChip(option.chip, me)) return plan
	return {
		...plan, tpUsed: plan.tpUsed + option.chip.cost,
		boost: { chips: [...(plan.boost?.chips ?? []), option.chip], tpGain: plan.boost?.tpGain ?? 0 }
	}
}

/**
 * Phase pure côté combat : aucun PT/PM dépensé. Une carte complète reste une estimation incomplète
 * des menaces (voir strategies.md), jamais une preuve de sécurité ou de meurtre.
 */
export function evaluateTacticalPlans(
	me: Me, profile: LeekProfile, context?: TacticalContext
): { plan: TacticalPlan | null; reason: string; preparation: TacticalPreparation } {
	const budget = new Budget()
	const preparation: TacticalPreparation = {
		entityId: me.id, origin: me.cell, reachable: context?.reachable ?? null,
		turn: Fight.turn, mp: me.mp, tp: me.tp, enemies: [],
		dangers: null, weaponCells: new Map(), currentWeapons: new Map()
	}
	const currentState = (): boolean => preparation.turn === Fight.turn &&
		same(me.cell, preparation.origin) && me.mp === preparation.mp && me.tp === preparation.tp &&
		preparation.enemies.every(({ enemy, cell }) => same(enemy.cell, cell))
	const stamp = (plan: TacticalPlan | null): TacticalPlan | null => plan && {
		...withAgilityFill(me, plan, preparation.enemies), state: { turn: preparation.turn, enemies: preparation.enemies }
	}
	try {
		const skipped: Skipped = { refused: 0, noProgress: null }
		const plan = evaluate(me, profile, context, skipped, budget, preparation)
		if (!currentState()) throw new Unavailable("state changed during search")
		const reason = skipped.noProgress ??
			(skipped.refused > 0 ? "offensive chip refused at current cell" : "no actionable plan")
		return { plan: stamp(plan), reason: plan ? "complete search" : reason, preparation }
	} catch (error) {
		if (error instanceof Unavailable) {
			const globalAvailable = hasExecutionRoom()
			// Si le PREMIER fournisseur revient après la limite, ne pas préférer
			// aveuglément une simple progression à son option de tir non encore classée.
			// Le secours continue avec ce résultat et les dangers, sans les recalculer.
			const firingContinuation = budget.incumbent?.usefulDamage === 0 && preparation.weaponCells.size > 0
			return {
				plan: currentState() && globalAvailable && budget.incumbent && !firingContinuation ? stamp({
					...budget.incumbent, searchStatus: `bounded search: ${error.message}; complete incumbent`
				}) : null,
				reason: error.message, preparation
			}
		}
		// Évaluation sans dépense : l'historique reste possible, mais l'exception n'est pas silencieuse.
		log(() => JSON.stringify({
			level: "ERROR",
			file: "src/Classes/Plannification/TacticalPlanner.ts",
			function: "evaluateTacticalPlans",
			error: error instanceof Error
				? { name: error.name, message: error.message, stack: error.stack ?? null }
				: { name: typeof error, message: String(error), stack: null }
		}), LOG_CONTEXT.ERROR, { sink: "debug" })
		return { plan: null, reason: "evaluation API unavailable", preparation }
	}
}

function evaluate(
	me: Me, profile: LeekProfile, context: TacticalContext | undefined,
	skipped: Skipped, budget: Budget, preparation: TacticalPreparation
): TacticalPlan | null {
	const reachable = context?.reachable
	const threat = context?.threat
	if (!reachable || !threat) throw new Unavailable("missing threat/reachable data")
	budget.check()
	if (reachable.truncated || threat.truncated || threat.inputsTruncated) throw new Unavailable("truncated data")
	if (!reachable.isUpToDate(me.id, me.cell, me.mp, Fight.turn) ||
		threat.entityId !== me.id || threat.turn !== Fight.turn ||
		threat.candidateCells !== reachable.size) throw new Unavailable("stale/inconsistent data")
	if (reachable.size > TACTICAL_LIMITS.cells || !Number.isInteger(me.tp) ||
		me.tp < 0 || me.tp > TACTICAL_LIMITS.tp) throw new Unavailable("cells/PT bound")

	const enemies = aliveEnemies().filter((enemy) => enemy.life > 0)
	preparation.enemies.push(...enemies.map((enemy) => ({ enemy, cell: enemy.cell })))
	if (threat.enemyCount !== enemies.length) throw new Unavailable("stale/inconsistent enemy count")
	// La validation fait partie du budget, pas seulement la recherche qui la suit.
	// Un seul appel fournisseur par case ; les scores relisent cet instantané validé.
	const dangers = new Map<number, number>()
	for (const entry of reachable.entries()) {
		budget.check()
		const danger = threat.dangerAt(entry.cell)
		budget.check()
		if (danger === null || !Number.isFinite(danger) || danger < 0) throw new Unavailable("missing/invalid danger cell")
		dangers.set(key(entry.cell), danger)
	}
	preparation.dangers = dangers
	budget.tick()
	const weapons = [...new Set(me.weapon === null ? me.weapons : [me.weapon, ...me.weapons])]
	const attackChips = [...new Set(me.chips)].filter((chip) =>
		chip.currentCooldown === 0 && chip.cost <= me.tp && validCost(chip.cost) &&
		toCandidate(chip, true, me.strength) !== null
	)
	if (enemies.length > TACTICAL_LIMITS.enemies || weapons.length > TACTICAL_LIMITS.weapons ||
		attackChips.length > TACTICAL_LIMITS.attackChips) throw new Unavailable("items/targets bound")
	// Le comportement configuré décide du soin, du bouclier et du poids du risque (seuils du rôle, comme le plan B).
	const strategy = createStrategy(profile)
	const lifeRatio = me.life / me.maxLife
	let closest: Entity | null = null
	let closestDistance = Infinity
	for (const enemy of enemies) {
		const range = Math.abs(me.cell.x - enemy.cell.x) + Math.abs(me.cell.y - enemy.cell.y)
		if (range < closestDistance) { closest = enemy; closestDistance = range }
	}
	const support = protections(me,
		profile.allowHealing && (strategy.shouldHeal(lifeRatio, 1 - lifeRatio) ||
			strategy.shouldHealWithThreat(lifeRatio, 1 - lifeRatio, closestDistance)),
		profile.allowShielding && closest !== null && strategy.shouldShield(lifeRatio, closestDistance,
			closest.mp + (closest.weapon?.maxRange ?? 1)),
		budget)
	const weight = riskWeight(profile, strategy, lifeRatio, closestDistance)
	// Passivité (voir `StagnationTracker.riskFactor`) : le danger pèse de moins en moins tant qu'aucun dégât n'est
	// infligé, jusqu'à 0. `LETHAL_PENALTY` et le crédit de soin (`weight`) ne sont pas réduits ; dès que le poids est
	// réduit, le seuil de `LETHAL_PENALTY` descend à `PASSIVE_DANGER_LIFE_FRACTION` × mes PV (marge sous le modèle).
	const riskFactor = context?.stagnation?.riskFactor ?? 1
	const risk = weight * riskFactor
	const lifeFraction = riskFactor < 1 ? PASSIVE_DANGER_LIFE_FRACTION : 1
	if (riskFactor < 1) {
		log(() => `[Tactical] passivity: ${context!.stagnation!.passiveTurns} turns without damage dealt; ` +
			`risk weight ${weight} x ${riskFactor}, danger accepted under ${PASSIVE_DANGER_LIFE_FRACTION} x life`, LOG_CONTEXT.PLANNING)
	}
	// Danger minimal de la zone (sert aussi à la sortie anticipée de `endingsFor`).
	let minDanger = Infinity
	for (const value of dangers.values()) minDanger = Math.min(minDanger, value)
	// Tour condamné : même test que `LETHAL_PENALTY` (`lethal`), vrai sur la case la moins dangereuse pour CHAQUE
	// protection candidate, donc pour tout plan (le danger exposé croît avec le danger). Alors : cible tuée d'abord
	// (`beats`), et aucun crédit des tours suivants d'un boost (`F` = 0, avec ou sans tir : un boost ne vaut que par les
	// dégâts de CE tour). Combat 54969530, tour 10 : protein sans tir (F = 51,3) + cure, 0 dégât.
	const doomed = support.every((protection) => lethal(me, protection, minDanger, lifeFraction))
	if (doomed) {
		log(() => `[Tactical] doomed turn: least danger ${minDanger} is lethal with every protection ` +
			`(life ${me.life}, fraction ${lifeFraction}); kill first, no future boost credit`, LOG_CONTEXT.PLANNING)
	}
	// Boost : composante du plan. `boosts[0]` est toujours « aucun ». Un plan avec tir n'en lance pas sous
	// `MIN_LIFE_RATIO_FOR_BOOST` de PV ; un plan sans tir seulement si l'ennemi peut être à portée au tour suivant.
	const boosts = boostVariants(me)
	const attackBoosts = lifeRatio >= MIN_LIFE_RATIO_FOR_BOOST ? boosts : [boosts[0]!]
	const strengthGain = attackBoosts.find((variant) => variant.strength !== null)?.strength?.gain ?? 0
	let maxTp = me.tp
	for (const variant of attackBoosts) maxTp = Math.max(maxTp, me.tp - variant.cost + variant.tpGain)
	// Arme de référence du crédit futur quand le plan ne tire pas à l'arme.
	const referenceWeapon = me.weapon ?? weapons[0] ?? null
	// Sans tir, le crédit ne dépend pas de la case : la meilleure variante est choisie une fois par protection.
	const idleTarget = !doomed && boosts.length > 1 && closest !== null && closestDistance <= boostReach(me, closest) ? closest : null
	const idleBoosts = support.map((protection) => {
		let best = { variant: boosts[0]!, credit: 0 }
		if (idleTarget === null) return best
		for (const variant of boosts) {
			if (variant.cost === 0 || me.tp - variant.cost + variant.tpGain < protection.cost) continue
			const credit = Math.min(idleTarget.life * FUTURE_TURN_WEIGHT,
				boostFuture(me, variant, referenceWeapon, idleTarget.life))
			if (credit > best.credit || (credit === best.credit && credit > 0 && variant.cost < best.variant.cost)) {
				best = { variant, credit }
			}
		}
		return best
	})
	const boostOf = (variant: BoostVariant): TacticalPlan["boost"] =>
		variant.cost > 0 ? { chips: variant.chips, tpGain: variant.tpGain } : undefined
	const hasAffordableWeapon = weapons.some((weapon) => validCost(weapon.cost) &&
		weapon.cost + (weapon === me.weapon ? 0 : 1) <= me.tp && toCandidate(weapon, false, me.strength))
	// Zone atteignable en tableaux denses (ordre BFS) : danger et voisins lus par indice dans les boucles chaudes,
	// au lieu d'une clé et d'une table par lecture. Tout préfixe d'un trajet total ≤ PM appartient à cette zone.
	const entries = [...reachable.entries()]
	const entryIndex = new Map<number, number>()
	for (let i = 0; i < entries.length; i++) entryIndex.set(key(entries[i]!.cell), i)
	const entryDanger = entries.map(({ cell }) => dangers.get(key(cell))!)
	if (enemies.length && (hasAffordableWeapon || attackChips.length === 0)) {
		const target = enemies[0]!
		const distance = (cell: Cell): number => Math.abs(cell.x - target.cell.x) + Math.abs(cell.y - target.cell.y)
		const stay = -riskCost(me, risk, support[0]!, dangers.get(key(me.cell))!, false, lifeFraction)
		// Seules les cases à 0 ou 1 PM sont des candidates précoces : filtrées une fois, pas une fois par protection.
		const near = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.cost <= 1)
		const originDistance = distance(me.cell)
		for (const protection of support) for (const { entry, index } of near) {
			budget.tick()
			const progress = originDistance - distance(entry.cell)
			if (!profile.allowHiding && entry.cost > 0 && progress <= 0) continue
			const danger = entryDanger[index]!
			const score = progress - riskCost(me, risk, protection, danger, false, lifeFraction) + weight * protection.heal
			if (score <= stay || (entry.cost === 0 && protection.chips.length === 0)) continue
			if (!beats(budget.incumbent, doomed, 0, score, danger, protection.cost, target, undefined, undefined, entry.cost)) continue
			budget.incumbent = {
				target, shotCell: me.cell, destination: entry.cell, beforeMp: 0, afterMp: entry.cost,
				weapon: null, weaponShots: 0, chips: [], protection: protection.chips,
				tpUsed: protection.cost, usefulDamage: 0, danger, progress, score
			}
		}
	}

	const adjacency: number[][] = []
	for (const { cell } of entries) {
		budget.tick()
		const adjacent: number[] = []
		for (const [dx, dy] of MOVE_NEIGHBOR_OFFSETS) {
			const neighbor = entryIndex.get((cell.x + dx) * 4096 + cell.y + dy)
			if (neighbor !== undefined) adjacent.push(neighbor)
		}
		adjacency.push(adjacent)
	}
	// Distance de tir courante par case (Infinity : inconnue), remplie par l'anticipation ci-dessous.
	const firing: number[] = entries.map(() => Infinity)
	// Plus petite distance de tir parmi les cases de danger minimal : quand la fin trouvée atteint déjà les deux,
	// aucune case plus lointaine du parcours ne peut la remplacer (égalité stricte exigée).
	let minFiring = Infinity
	// `N` par arme équipée en fin de plan (indice de `nextEquipped`) et par case atteignable, avant le contrôle de
	// létalité : null tant qu'il n'est pas calculé, ou nul partout. `maxNext[e]` : son maximum sur ma zone.
	let nextValues: number[][] | null = null
	let nextEquipped: Array<Weapon | null> = []
	let maxNext: number[] = []
	const nextState = (weapon: Weapon | null): number => nextValues === null ? 0 : Math.max(0, nextEquipped.indexOf(weapon))
	interface Ending { index: number; cell: Cell; cost: number; danger: number }
	const endingCache = new Map<number, Ending[]>()
	const seenStamp: number[] = entries.map(() => 0)
	let stamp = 0
	/**
	 * Fins candidates après un tir depuis `shot`, par danger croissant : pour chaque valeur de `N`, la case de moindre
	 * danger (puis de moindre distance de tir, puis la moins chère en PM), sauf si une case de danger ≤ a un `N`
	 * supérieur. Le coût de risque croît avec le danger pour toute protection : la meilleure fin en fait partie.
	 * Sans `N` (ou `N` égal partout) : une seule fin, la case de moindre danger, et la même sortie anticipée.
	 */
	const endingsFor = (shot: { cell: Cell; cost: number }, state: number): Ending[] => {
		const start = entryIndex.get(key(shot.cell))!
		const cached = endingCache.get(start * 8 + state)
		if (cached) return cached
		const values = nextValues ? nextValues[state]! : null
		const top = values ? maxNext[state]! : 0
		const queue = [start]
		const costs = [0]
		seenStamp[start] = ++stamp
		const groups = new Map<number, { index: number; cost: number; danger: number }>()
		const limit = profile.allowHiding ? me.mp - shot.cost : 0
		for (let head = 0; head < queue.length; head++) {
			budget.tick()
			const index = queue[head]!
			const value = entryDanger[index]!
			const worth = values ? values[index]! : 0
			const group = groups.get(worth)
			if (!group || value < group.danger || (value === group.danger && firing[index]! < firing[group.index]!)) {
				groups.set(worth, { index, cost: costs[head]!, danger: value })
			}
			const best = groups.get(top)
			if (best && best.danger === minDanger && firing[best.index]! <= minFiring) break
			if (costs[head]! >= limit) continue
			for (const neighbor of adjacency[index]!) {
				if (seenStamp[neighbor] === stamp) continue
				seenStamp[neighbor] = stamp
				queue.push(neighbor)
				costs.push(costs[head]! + 1)
			}
		}
		const found = [...groups.entries()]
		const endings = found.filter(([worth, group]) => !found.some(([otherWorth, other]) =>
			otherWorth > worth && other.danger <= group.danger))
			.map(([, group]) => ({ index: group.index, cell: entries[group.index]!.cell, cost: group.cost, danger: group.danger }))
			.sort((a, b) => a.danger - b.danger)
		endingCache.set(start * 8 + state, endings)
		return endings
	}
	/** `N` d'un plan qui finit sur la case `index`, arme `state` en main ; nul si la case est létale avec cette protection. */
	const nextValue = (index: number, protection: Protection, state: number): number =>
		nextValues === null || lethal(me, protection, entryDanger[index]!, lifeFraction) ? 0 : nextValues[state]![index]!
	/** Fin qui maximise `N` − coût de risque pour cette protection ; à égalité, la moins dangereuse. */
	const endingFor = (shot: { cell: Cell; cost: number }, protection: Protection, state: number): Ending => {
		const endings = endingsFor(shot, state)
		let best = endings[0]!
		if (endings.length === 1) return best
		let bestScore = -Infinity
		for (const ending of endings) {
			budget.tick()
			const score = nextValue(ending.index, protection, state) -
				riskCost(me, risk, protection, ending.danger, false, lifeFraction)
			if (score > bestScore) { best = ending; bestScore = score }
		}
		return best
	}
	const retainWeapon = (target: Entity, weapon: Weapon, item: ShotCandidate, shot: { cell: Cell; cost: number }): void => {
		const equip = weapon === me.weapon ? 0 : 1
		// Appelé avant le calcul de `N` : une seule fin, la case de moindre danger ; `N` est ajouté ensuite à l'option gardée.
		const ending = endingsFor(shot, 0)[0]!
		const danger = ending.danger
		const states = attacks(me.tp - equip, item, [], target, budget)
		const choices = attackChoices(states, target, true, budget)
		for (const protection of support) {
			budget.tick()
			const choice = choices[me.tp - equip - protection.cost]
			if (!choice) continue
			const { attack, cost } = choice
			const usefulDamage = Math.min(target.life, attack.damage)
			const tpUsed = cost + equip + protection.cost
			const score = usefulDamage -
				riskCost(me, risk, protection, danger, killsLastEnemy(attack.damage, target, enemies.length), lifeFraction) +
				weight * protection.heal
			if (!beats(budget.incumbent, doomed, usefulDamage, score, danger, tpUsed, target, undefined, undefined, shot.cost + ending.cost)) continue
			budget.incumbent = {
				target, shotCell: shot.cell, destination: ending.cell, beforeMp: shot.cost, afterMp: ending.cost,
				weapon, weaponShots: attack.weaponShots, chips: [], protection: protection.chips,
				tpUsed, usefulDamage, danger, score
			}
		}
	}
	// Option complète avant les fournisseurs ; améliorée dès que chaque arme est
	// préparée, AVANT de lancer les fournisseurs suivants (notamment les puces).
	const readyWeapon = me.weapon ?? weapons[0] ?? null
	const readyCandidate = readyWeapon && validCost(readyWeapon.cost) ? toCandidate(readyWeapon, false, me.strength) : null
	if (readyWeapon && readyCandidate) for (const target of enemies) {
		const equip = readyWeapon === me.weapon ? 0 : 1
		if (readyCandidate.cost + equip > me.tp) continue
		const distance = Math.abs(me.cell.x - target.cell.x) + Math.abs(me.cell.y - target.cell.y)
		if (Number.isFinite(readyWeapon.maxRange) && distance > readyWeapon.maxRange) continue
		budget.check()
		const usable = me.canUseWeapon(target, readyWeapon)
		preparation.currentWeapons.set(target, new Map([[readyWeapon, usable]]))
		budget.check()
		if (usable) retainWeapon(target, readyWeapon, readyCandidate, { cell: me.cell, cost: 0 })
	}

	// Fournisseurs natifs existants : cellules de lancement par (cible,item), pas par couple de cases.
	const nativeCells = (getCells: () => Cell[]): Set<number> => {
		budget.check()
		const raw = getCells()
		budget.check()
		if (raw.length > 613) throw new Unavailable("native cells bound")
		const cells = new Set<number>()
		for (const cell of raw) {
			budget.tick()
			if (reachable.canReach(cell)) cells.add(key(cell))
		}
		return cells
	}
	// Un fournisseur natif (`getCellsToUseWeapon`/`getCellsToUseChip`, 25 834 ops l'appel d'après la documentation
	// officielle LeekScript ; non vérifié pour l'API TypeScript) n'est utile que si une case de MA zone atteignable
	// est à portée de Manhattan [min, max] de la cible : la liste native est un sous-ensemble de ces cases. Test sur la
	// zone elle-même, plus serré que « distance de départ ≤ portée + PM » (obstacles et occupants exclus de la zone).
	const mayReach = (target: Entity, item: Weapon | Chip): boolean => {
		if (!Number.isFinite(item.maxRange)) return true
		const minRange = Number.isFinite(item.minRange) ? item.minRange : 0
		for (const { cell } of entries) {
			const range = Math.abs(cell.x - target.cell.x) + Math.abs(cell.y - target.cell.y)
			if (range >= minRange && range <= item.maxRange) return true
		}
		return false
	}
	const chipZones = new Map<Chip, Cell[]>()
	const prepared = enemies.map((target) => ({
		target,
		weapons: weapons.map((weapon) => {
			const candidate = validCost(weapon.cost) ? toCandidate(weapon, false, me.strength) : null
			if (!candidate || candidate.cost + (weapon === me.weapon ? 0 : 1) > me.tp ||
				!mayReach(target, weapon)) return { weapon, candidate: null, cells: new Set<number>() }
			const cells = nativeCells(() => {
				const cells = Fight.weaponCells(target, weapon)
				let byWeapon = preparation.weaponCells.get(target)
				if (!byWeapon) preparation.weaponCells.set(target, byWeapon = new Map())
				byWeapon.set(weapon, cells) // Même si le contrôle suivant interrompt la recherche.
				return cells
			})
			let nearest: typeof entries[number] | null = null
			let nearestDanger = Infinity
			for (let i = 0; i < entries.length; i++) {
				budget.tick()
				const entry = entries[i]!
				if (cells.has(key(entry.cell)) && (nearest === null || entry.cost < nearest.cost ||
					(entry.cost === nearest.cost && entryDanger[i]! < nearestDanger))) {
					nearest = entry; nearestDanger = entryDanger[i]!
				}
			}
			if (nearest) retainWeapon(target, weapon, candidate, nearest)
			return { weapon, candidate, cells }
		}),
		// Refus depuis ma case alors qu'elle N'EST PAS dans la liste native : la géométrie (portée, alignement, ligne
		// de vue) l'explique, la puce est créditée sur les cases natives atteignables (déplacement puis tir, revérifié
		// par `canUseChip` à l'arrivée). Refus alors que ma case EST dans la liste : restriction inconnue, puce écartée.
		chips: attackChips.map((chip) => {
			if (!mayReach(target, chip)) return null
			const cells = nativeCells(() => {
				const raw = me.chipCells(chip, target)
				chipZones.set(chip, raw) // Réutilisé par la sortie de stagnation, sans second appel natif.
				return raw
			})
			budget.check()
			const usable = me.canUseChip(chip, target)
			budget.check()
			if (!usable && cells.has(key(me.cell))) { skipped.refused++; return null }
			// Zone d'effet non simulée : pas de tir depuis une case où je serais dans la zone centrée sur la cible.
			const radius = selfHitRadius(chip)
			if (radius > 0) {
				const outside = (cell: Cell): boolean =>
					Math.abs(cell.x - target.cell.x) + Math.abs(cell.y - target.cell.y) > radius
				for (const { cell } of entries) {
					budget.tick()
					if (!outside(cell)) cells.delete(key(cell))
				}
				chipZones.set(chip, chipZones.get(chip)!.filter(outside)) // même garde pour la sortie de stagnation
			}
			return { candidate: toCandidate(chip, true, me.strength) as ShotCandidate, cells }
		}).filter((chip) => chip !== null)
	}))
	// Anticipation limitée : distances dans le graphe courant vers les cases de tir
	// natives déjà obtenues pour l'unique cible. Aucun nouveau fournisseur ni LOS.
	// La position ennemie et les obstacles au prochain tour restent inconnus.
	if (prepared.length === 1) {
		const queue: number[] = []
		for (const weapon of prepared[0]!.weapons) for (const id of weapon.cells) {
			budget.tick()
			const index = entryIndex.get(id)
			if (index !== undefined && firing[index] === Infinity) { firing[index] = 0; queue.push(index) }
		}
		for (let head = 0; head < queue.length; head++) {
			budget.tick()
			const index = queue[head]!
			const nextDistance = firing[index]! + 1
			for (const neighbor of adjacency[index]!) {
				if (firing[neighbor] === Infinity) { firing[neighbor] = nextDistance; queue.push(neighbor) }
			}
		}
		for (let i = 0; i < entries.length; i++) {
			if (entryDanger[i] === minDanger) minFiring = Math.min(minFiring, firing[i]!)
		}
	}
	// Terme `N` (un seul ennemi) : dégâts du tour suivant calculés pour TOUTES les cases dans leur propre allocation,
	// sinon `N` nul pour toutes. Puces : exactement celles que la recherche de ce tour crédite (même règle : écartée
	// seulement si `canUseChip` la refuse depuis une case de sa liste native ; cases sous zone d'effet déjà retirées), de
	// cooldown de base 0 ou 1 (prêtes au tour suivant même si le plan les lance). Aucun appel natif de plus.
	let nextDamages: NextTurn | null = null
	if (enemies.length === 1) {
		try {
			const zones: Array<{ item: Weapon | Chip; isChip: boolean; cells: readonly Cell[] }> = []
			for (const [weapon, cells] of preparation.weaponCells.get(enemies[0]!) ?? []) zones.push({ item: weapon, isChip: false, cells })
			for (const { candidate } of prepared[0]!.chips) {
				const chip = candidate.item as Chip
				const cells = chipZones.get(chip)
				if (cells && (chip.cooldown === 0 || chip.cooldown === 1)) zones.push({ item: chip, isChip: true, cells })
			}
			nextDamages = nextTurnDamages(me, enemies[0]!, entries, entryIndex, zones, new Budget(NEXT_TURN_FRACTION))
		} catch (error) {
			const cause = error instanceof Error ? error.message : String(error)
			log(() => `[Tactical] next-turn value unavailable (${cause}): N = 0 for every cell`, LOG_CONTEXT.PLANNING)
		}
		budget.check()
	}
	const firingDistance = (target: Entity, cell: Cell): number | undefined => {
		if (target !== prepared[0]?.target) return undefined
		const distance = firing[entryIndex.get(key(cell))!]
		return distance === Infinity ? undefined : distance
	}
	const weaponOffense = prepared.some((enemy) =>
		enemy.weapons.some((w) => w.candidate && netDamage(w.candidate, enemy.target) > 0 && w.cells.size > 0))
	const hasOffense = weaponOffense || prepared.some((enemy) =>
		enemy.chips.some((c) => netDamage(c.candidate, enemy.target) > 0 && c.cells.size > 0))
	// Le trajet futur est celui d'une ARME : une puce atteignable ce tour ne le coupe pas (son tir peut être décliné
	// comme trop dangereux ; l'avance sûre vers une case de tir d'arme doit alors rester un plan candidat).
	const futureRoute = !weaponOffense && enemies.length === 1
		? futureWeaponRoute(me, enemies[0]!, weapons, reachable, budget) : null
	// Si la case hypothétique est déjà accessible ce tour, conserver le progrès
	// Manhattan existant ; la distance sert seulement à départager les égalités.
	const futureProgress = futureRoute && futureRoute.get(key(me.cell))! > me.mp ? futureRoute : null
	// Une table exacte par cible/arme/masque de puces utilisables, pas par case : `tables[0]` à ma force actuelle,
	// `tables[1]` à la force boostée (seulement si une variante de force existe) ; `future` : crédit par variante.
	interface Offense { tables: Array<Array<AttackChoice | undefined>>; future: number[] }
	interface OffenseOption { target: Entity; weapon: Weapon | null; equipCost: number; tables: Offense }
	const attackCache = new Map<string, Offense>()
	const offenses: Array<OffenseOption[] | undefined> = []
	/** Options d'attaque depuis la case de tir `entries[s]` (mémoïsées : préparées une fois, lues par le classement). */
	const offenseAt = (s: number): OffenseOption[] => {
		const known = offenses[s]
		if (known) return known
		const shot = entries[s]!
		// Depuis la case de tir, pas depuis l'origine : interdit de réutiliser deux fois les mêmes PM.
		// Les supports n'améliorent pas les dégâts : une seule table par cible/case/arme suffit
		// pour TOUS leurs budgets résiduels (les états sont indexés par coût exact).
		const offense: OffenseOption[] = []
		for (let enemyIndex = 0; enemyIndex < prepared.length; enemyIndex++) {
			const enemy = prepared[enemyIndex]!
			const usableChips = enemy.chips.filter((chip) => chip.cells.has(key(shot.cell))).map((chip) => chip.candidate)
			const mask = enemy.chips.reduce((bits, chip, i) => chip.cells.has(key(shot.cell)) ? bits | (1 << i) : bits, 0)
			const options = [null, ...enemy.weapons]
			for (let optionIndex = 0; optionIndex < options.length; optionIndex++) {
				const option = options[optionIndex]!
				budget.tick()
				if (option !== null && (option.candidate === null || !option.cells.has(key(shot.cell)))) continue
				const equipCost = option !== null && option.weapon !== me.weapon ? 1 : 0
				if (equipCost > me.tp) continue
				const cacheKey = `${enemyIndex}:${optionIndex}:${mask}`
				let tables = attackCache.get(cacheKey)
				if (!tables) {
					const table = (weapon: ShotCandidate | null, chips: readonly ShotCandidate[]) => attackChoices(
						attacks(maxTp - equipCost, weapon, chips, enemy.target, budget), enemy.target, option !== null, budget)
					tables = {
						tables: [table(option?.candidate ?? null, usableChips)],
						future: attackBoosts.map((variant) => variant.cost === 0 ? 0 :
							boostFuture(me, variant, option?.weapon ?? referenceWeapon, enemy.target.life))
					}
					if (strengthGain > 0) {
						const boosted = (item: Weapon | Chip, isChip: boolean): ShotCandidate | null =>
							toCandidate(item, isChip, me.strength + strengthGain)
						tables.tables.push(table(option ? boosted(option.weapon, false) : null,
							usableChips.map((chip) => boosted(chip.item, true)).filter((chip) => chip !== null)))
					}
					attackCache.set(cacheKey, tables)
				}
				offense.push({ target: enemy.target, weapon: option?.weapon ?? null, equipCost, tables })
			}
		}
		offenses[s] = offense
		return offense
	}
	// `N` = `NEXT_TURN_WEIGHT` × min(PV de la cible − `U_max`, dégâts du tour suivant depuis la case), où `U_max` est le
	// plus grand dégât utile qu'un plan quelconque peut infliger CE tour (toutes cases de tir, armes et boosts, sans
	// protection ni danger). `N` ne dépend donc que de la case finale : renoncer à un tir coûte ses dégâts pleins, et si
	// un coup fatal est possible ce tour `N` est nul partout (classement identique à celui sans `N`).
	if (nextDamages !== null) {
		const target = enemies[0]!
		let maxUseful = 0
		if (hasOffense) for (let s = 0; s < entries.length && maxUseful < target.life; s++) {
			for (const option of offenseAt(s)) for (const variant of attackBoosts) {
				budget.tick()
				const choice = option.tables.tables[variant.strength ? 1 : 0]![me.tp - variant.cost + variant.tpGain - option.equipCost]
				if (choice) maxUseful = Math.max(maxUseful, Math.min(target.life, choice.attack.damage))
			}
		}
		const remaining = target.life - maxUseful
		if (remaining > 0) {
			nextEquipped = nextDamages.equipped
			nextValues = nextDamages.damages.map((row) => row.map((damage) => NEXT_TURN_WEIGHT * Math.min(remaining, damage)))
			maxNext = nextValues.map((row) => Math.max(...row))
			// Les options complètes gardées avant ce point (sans `N`) reçoivent le leur : la suite compare des scores avec `N`.
			if (budget.incumbent) {
				const kept = budget.incumbent
				const nextTurn = nextValue(entryIndex.get(key(kept.destination))!,
					support.find((protection) => protection.chips === kept.protection) ?? support[0]!,
					nextState(kept.weapon ?? me.weapon))
				if (nextTurn > 0) budget.incumbent = { ...kept, score: kept.score + nextTurn, nextTurn }
			}
		}
	}
	endingCache.clear()
	// Sans attaque connue, progression/couvert/support sont AUSSI un plan complet.
	// Une puce refusée depuis une case de sa liste native n'autorise pas une approche de tir fictive.
	let progressPlan: TacticalPlan | null = null
	if (enemies.length && (hasAffordableWeapon || futureRoute || !skipped.refused)) {
		const target = enemies[0]!
		const distance = (cell: Cell): number => Math.abs(cell.x - target.cell.x) + Math.abs(cell.y - target.cell.y)
		// Valeurs qui ne dépendent pas de la protection : une fois par case, pas une fois par (protection, case).
		const originDistance = distance(me.cell)
		const geometric = entries.map(({ cell }) => originDistance - distance(cell))
		const originFuture = futureProgress ? futureProgress.get(key(me.cell))! : 0
		const progressOf = futureProgress
			? entries.map(({ cell }) => originFuture - futureProgress.get(key(cell))!) : geometric
		const futureDistance = futureRoute ? entries.map(({ cell }) => futureRoute.get(key(cell))) : null
		const firingOf = entries.map(({ cell }) => firingDistance(target, cell))
		for (let p = 0; p < support.length; p++) for (let i = 0; i < entries.length; i++) {
			const protection = support[p]!
			const idle = idleBoosts[p]!
			const ending = entries[i]!
			budget.tick()
			if (!profile.allowHiding && geometric[i]! <= 0 && !same(ending.cell, me.cell)) continue
			const progress = progressOf[i]!
			const danger = entryDanger[i]!
			const nextTurn = nextValue(i, protection, 0)
			const score = progress - riskCost(me, risk, protection, danger, false, lifeFraction) + weight * protection.heal +
				idle.credit + nextTurn
			const futureRouteDistance = futureDistance?.[i]
			const tpUsed = protection.cost + idle.variant.cost
			if (!beats(progressPlan, doomed, 0, score, danger, tpUsed, target, firingOf[i], futureRouteDistance, ending.cost)) continue
			const candidate: TacticalPlan = {
				target, shotCell: me.cell, destination: ending.cell, beforeMp: 0, afterMp: ending.cost,
				weapon: null, weaponShots: 0, chips: [], protection: protection.chips, boost: boostOf(idle.variant),
				tpUsed, usefulDamage: 0, danger, progress,
				progressModel: futureProgress ? "future firing route" : undefined,
				firingDistance: firingOf[i],
				futureRouteDistance,
				score, nextTurn
			}
			progressPlan = candidate
			if ((ending.cost > 0 || protection.heal > 0 || shieldCredit(protection, danger) > 0 || idle.credit > 0) &&
				better(candidate, budget.incumbent, doomed)) budget.incumbent = candidate
		}
	}
	// Règle de stagnation (voir `stagnationEscape` et `StagnationTracker`) appliquée au plan NORMAL, toujours calculé
	// d'abord. Garantie : tant que le plan normal tire ou progresse, il est exécuté tel quel, donc la règle ne peut
	// jamais retarder un tir par rapport à la règle désactivée (tant que la sortie n'a pas été engagée, la trajectoire
	// est celle de la règle désactivée). Elle n'agit que si ce plan est bloqué (aucun tir, aucun déplacement) ou si une
	// sortie est déjà engagée (sinon le progrès Manhattan ramènerait Kassbi dans son minimum local : 187 → 133 → 187).
	const stagnation = context?.stagnation
	const withStagnation = (planned: TacticalPlan | null): TacticalPlan | null => {
		if (planned && (planned.weaponShots > 0 || planned.chips.length > 0)) {
			stagnation?.noteOffense() // un tir RÉEL est prévu : le planificateur normal garde la main
			return planned
		}
		// Anti-oscillation sur TOUT l'épisode : le plan normal ne retourne pas vers une case visitée par une sortie
		// (départ, arrivée, case de stagnation d'origine), sauf record de proximité (jamais le cas d'une case déjà visitée
		// avec des ennemis immobiles). Sont toujours acceptés : un tir prévu, un déplacement vers une case non visitée,
		// un déplacement dont le danger final est STRICTEMENT inférieur à celui de la case courante (retraite de sécurité),
		// et tout plan avec protection (déplacement + protection compris). Seul un déplacement de progression sans gain
		// de sécurité vers une case visitée est refusé.
		let normal = planned
		const currentDanger = dangers.get(key(me.cell))!
		if (stagnation && planned && planned.afterMp > 0 && planned.protection.length === 0 &&
			planned.danger >= currentDanger && stagnation.visited(planned.destination)) {
			const toEnemy = Math.min(...enemies.map((enemy) =>
				Math.abs(planned.destination.x - enemy.cell.x) + Math.abs(planned.destination.y - enemy.cell.y)))
			if (!stagnation.beatsRecord(toEnemy)) {
				log(() => `[Tactical] stagnation: move back to visited cell (${planned.destination.x},` +
					`${planned.destination.y}) refused`, LOG_CONTEXT.PLANNING)
				normal = null
			}
		}
		if (!stagnation?.active || !enemies.length) return normal
		// Une retraite de sécurité (danger final strictement inférieur à celui de la case courante) n'est jamais remplacée
		// par la sortie, dont le plafond de danger est celui de la case courante : elle serait plus exposée que la retraite.
		if (normal && normal.afterMp > 0 && normal.danger < currentDanger) return normal
		const blocked = normal === null || (normal.afterMp === 0 && normal.protection.length === 0)
		if (!blocked && !stagnation.escaping) return normal
		const escape = stagnationEscape({
			me, target: enemies[0]!, turns: stagnation.turns, weapons, attackChips, chipZones,
			entries, dangers, preparation, skipped, budget, visited: (cell) => stagnation.visited(cell),
			riskFree: risk === 0
		})
		if (escape) {
			stagnation.commit(me.cell, escape.destination)
			// La sortie remplace un plan bloqué : elle garde le boost sans tir de ce plan (PT inutilisés).
			const idle = idleBoosts[0]!.variant
			return idle.cost > 0 ? { ...escape, boost: boostOf(idle), tpUsed: idle.cost } : escape
		}
		if (!stagnation.escaping) return normal
		// Sortie engagée sans case sûre plus proche par la marche (ennemi qui a fui, frontière de danger) : on LÈVE
		// l'engagement et le plan normal s'exécute (un maintien éternel retardait le premier tir d'un ennemi qui fuit),
		// sauf retour vers une case visitée (refusé ci-dessus, ce tour et les suivants) ; la sortie ne se ré-engage
		// jamais vers une case visitée.
		stagnation.release()
		log(() => `[Tactical] stagnation: escape released (no safe cell closer by walking); the normal plan resumes`,
			LOG_CONTEXT.PLANNING)
		return normal
	}
	if (!hasOffense) {
		const normal = progressPlan &&
			(progressPlan.afterMp > 0 || progressPlan.protection.length > 0 || progressPlan.boost) ? progressPlan : null
		const result = withStagnation(normal)
		// Plan nul : la case actuelle est le meilleur progrès (souvent un minimum local de distance Manhattan).
		if (result === null && progressPlan && skipped.noProgress === null) skipped.noProgress = "no improving progress"
		return result
	}
	let best: TacticalPlan | null = progressPlan
	let actionable = false
	for (let s = 0; s < entries.length; s++) {
		const shot = entries[s]!
		budget.tick()
		const offense = offenseAt(s)
		if (!same(shot.cell, me.cell) &&
			!offense.some((o) => (o.tables.tables[0]![maxTp - o.equipCost]?.attack.damage ?? 0) > 0)) continue
		for (let p = 0; p < support.length; p++) {
			const protection = support[p]!
			// La fin dépend de la case de tir, de la protection et de l'arme en main à la fin, pas du boost. Sans `N`,
			// D − crédit(D) étant monotone, c'est la même case de moindre danger pour tous les supports.
			const picked: Array<Ending | undefined> = []
			for (const option of offense) for (let v = 0; v < attackBoosts.length; v++) {
				let variant = attackBoosts[v]!
				// Le boost est payé d'abord ; le reste (PT gagnés compris) finance protection, équipement et attaque.
				const available = me.tp - variant.cost + variant.tpGain - protection.cost - option.equipCost
				budget.tick()
				const choice = option.tables.tables[variant.strength ? 1 : 0]![available]
				if (!choice) continue
				const { attack, cost } = choice
				// Sans dégâts ce tour, seul le boost « sans tir » de cette protection est permis (`idleBoosts`).
				let future = 0
				if (!(attack.damage > 0)) {
					if (variant.cost > 0) continue
					if (cost === 0) { variant = idleBoosts[p]!.variant; future = idleBoosts[p]!.credit }
				}
				// Sans repli autorisé, un déplacement avant tir doit permettre des dégâts utiles.
				if (!profile.allowHiding && !(attack.damage > 0) && !same(shot.cell, me.cell)) continue
				const state = attack.weaponShots > 0 ? nextState(option.weapon) : 0
				let ending = picked[state]
				if (!ending) picked[state] = ending = endingFor(shot, protection, state)
				const finalDanger = ending.danger
				const nextTurn = nextValue(ending.index, protection, state)
				if (attack.damage > 0 || protection.heal > 0 || shieldCredit(protection, finalDanger) > 0) actionable = true
				const usefulDamage = Math.min(option.target.life, attack.damage)
				const tpUsed = cost + protection.cost + option.equipCost + variant.cost
				// Tours suivants du boost, plafonnés par les PV qui restent à la cible après ce tour, eux aussi pondérés :
				// des dégâts remis à plus tard ne valent jamais ceux de ce tour (un boost ne bat pas le coup fatal à égalité).
				if (attack.damage > 0 && !doomed) {
					future = Math.min((option.target.life - usefulDamage) * FUTURE_TURN_WEIGHT, option.tables.future[v]!)
				}
				const score = usefulDamage - riskCost(me, risk, protection, finalDanger,
					killsLastEnemy(attack.damage, option.target, enemies.length), lifeFraction) + weight * protection.heal +
					future + nextTurn
				const firingDistanceAtEnd = firingDistance(option.target, ending.cell)
				// Même départage que le plan de progression (trajet futur, seulement sans tir d'arme à portée).
				const futureRouteAtEnd = futureRoute?.get(key(ending.cell))
				if (!beats(best, doomed, usefulDamage, score, finalDanger, tpUsed, option.target, firingDistanceAtEnd,
					futureRouteAtEnd, shot.cost + ending.cost)) continue
				const candidate: TacticalPlan = {
					target: option.target, shotCell: shot.cell, destination: ending.cell,
					beforeMp: shot.cost, afterMp: ending.cost,
					weapon: attack.weaponShots > 0 ? option.weapon : null,
					weaponShots: attack.weaponShots, chips: attack.chips, protection: protection.chips,
					boost: boostOf(variant), tpUsed, usefulDamage, danger: finalDanger,
					firingDistance: firingDistanceAtEnd, futureRouteDistance: futureRouteAtEnd,
					score, nextTurn
				}
				best = candidate
				if (actionable && better(candidate, budget.incumbent, doomed)) budget.incumbent = candidate
			}
		}
	}
	return withStagnation(actionable ? best : null)
}

function interrupted(reason: string): void {
	log(() => `[Tactical] execution: ${reason}`, LOG_CONTEXT.PLANNING)
}

function phase(me: Me, name: string, details: () => unknown): void {
	log(() => `[Tactical] phase before action ${JSON.stringify({
		phase: name, from: { x: me.cell.x, y: me.cell.y }, tp: me.tp, mp: me.mp, details: details()
	})}`, LOG_CONTEXT.PLANNING)
}

/** Contrôles natifs répétés : un échec ne déclenche jamais une seconde séquence historique après dépense. */
export function executeTacticalPlan(me: Me, plan: TacticalPlan): void {
	try { execute(me, plan) }
	catch (error) {
		log(() => JSON.stringify({
			level: "ERROR", file: "TacticalPlanner.ts", function: "executeTacticalPlan",
			error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
		}), LOG_CONTEXT.ERROR, { sink: "debug" })
		interrupted("API failure; no second sequence")
	}
}

function execute(me: Me, plan: TacticalPlan): void {
	const executionBudget = new ExecutionBudget()
	const currentState = (): boolean => !plan.state || (plan.state.turn === Fight.turn &&
		plan.state.enemies.every(({ enemy, cell }) => same(enemy.cell, cell)))
	const available = (): boolean => {
		if (executionBudget.available()) return true
		interrupted("global operations reserve; stop")
		return false
	}
	log(() => `[Tactical] plan before execution ${JSON.stringify({
		mode: "complete intent; native checks may cancel actions",
		order: ["approach", "boost", "protection", "equipment if needed", "offensive chips", "weapon shots", "final move"],
		target: { id: plan.target.id, position: { x: plan.target.cell.x, y: plan.target.cell.y } },
		origin: { x: me.cell.x, y: me.cell.y },
		shotCell: { x: plan.shotCell.x, y: plan.shotCell.y },
		destination: { x: plan.destination.x, y: plan.destination.y },
		tp: { available: me.tp, planned: plan.tpUsed, gainedFromBoost: plan.boost?.tpGain ?? 0,
			remainingIfExecuted: me.tp - plan.tpUsed + (plan.boost?.tpGain ?? 0) },
		mp: { available: me.mp, before: plan.beforeMp, after: plan.afterMp },
		weapon: plan.weapon === null ? null : { name: plan.weapon.name, cost: plan.weapon.cost,
			equipTp: me.weapon === plan.weapon ? 0 : 1, shots: plan.weaponShots },
		chips: plan.chips.map((chip) => ({ name: chip.name, cost: chip.cost })),
		boost: (plan.boost?.chips ?? []).map((chip) => ({ name: chip.name, cost: chip.cost })),
		protection: plan.protection.map((chip) => ({ name: chip.name, cost: chip.cost })),
		attackLegality: plan.weaponShots > 0 || plan.chips.length > 0
			? "native cells; range/LOS checked in selection, native permission rechecked at execution"
			: "no attack selected",
		usefulDamage: plan.usefulDamage, danger: currentState() ? plan.danger : null,
		score: currentState() ? plan.score : null, nextTurn: currentState() ? plan.nextTurn ?? 0 : null,
		stateCurrent: currentState(),
		progress: plan.progress ?? 0, progressModel: plan.progressModel ?? "Manhattan",
		stagnation: plan.stagnation ?? null,
		searchStatus: plan.searchStatus ?? "complete search",
		executionBudget: EXECUTION_BUDGET_POLICY,
		estimates: "damage/score/danger modeled, not guaranteed outcome"
	})}`, LOG_CONTEXT.PLANNING)
	if (me.life <= 0 || !available()) return
	if (!currentState()) { interrupted("enemy positions/turn changed; plan unavailable"); return }
	if (!same(me.cell, plan.shotCell)) {
		// Seules les cases à au plus `beforeMp` pas comptent (au-delà : « shot cell blocked », comme avec `me.mp`).
		const current = computeReachableCells(me, Math.min(me.mp, plan.beforeMp), Fight.turn)
		const cost = current.costTo(plan.shotCell)
		if (!available()) return
		if (cost === null || cost > plan.beforeMp) { interrupted("shot cell blocked"); return }
		phase(me, "approach", () => ({ to: { x: plan.shotCell.x, y: plan.shotCell.y }, mpCost: cost }))
		if (!available()) return
		track(me, "move", null, () => me.moveToward(plan.shotCell, cost))
		if (!same(me.cell, plan.shotCell)) { interrupted("shot cell not reached"); return }
	}
	if (!currentState()) { interrupted("enemy positions/turn changed after approach; stop"); return }
	// Lancers déjà tentés par puce : une puce sans cooldown de base peut être relancée (`chipUsesOf`), les autres non.
	const casts = new Map<Chip, number>()
	const cast = (chip: Chip, target: Entity, name: string): void => {
		if (!available()) return
		if (me.life > 0 && target.life > 0 && (casts.get(chip) ?? 0) < chipUsesOf(chip) && me.chips.includes(chip) &&
			chip.currentCooldown === 0 && me.tp >= chip.cost &&
			me.canUseChip(chip, target)) {
			casts.set(chip, (casts.get(chip) ?? 0) + 1)
			phase(me, name, () => ({ chip: chip.name, target: target.id, tpCost: chip.cost }))
			if (!available()) return
			const result = track(me, chip, target, () => me.useChip(chip, target))
			if (!(result > 0)) {
				casts.set(chip, Infinity) // refus natif : aucun autre lancer de cette puce n'est tenté
				interrupted(`chip refused: ${chip.name}, result ${result}`)
			}
		} else interrupted(`chip unavailable: ${chip.name}`)
	}
	// Boost avant tout le reste : les PT, la force et l'agilité (critiques) qu'il donne servent aux actions suivantes du même plan.
	for (const chip of plan.boost?.chips ?? []) cast(chip, me, "boost")
	for (const chip of plan.protection) cast(chip, me, "protection")
	if (!available()) return
	if (plan.weapon !== null && me.weapon !== plan.weapon && me.tp >= 1 && me.life > 0) {
		phase(me, "equipment", () => ({ weapon: plan.weapon!.name, tpCost: 1 }))
		if (!available()) return
		track(me, "equip", null, () => me.setWeapon(plan.weapon!))
	}
	for (const chip of plan.chips) {
		if (!available()) return
		cast(chip, plan.target, "offensive chip")
	}
	for (let shot = 0; shot < plan.weaponShots; shot++) {
		if (!available()) return
		if (me.life <= 0 || plan.target.life <= 0 || plan.weapon === null || me.weapon !== plan.weapon ||
			shot >= maxUsesOf(plan.weapon) || me.tp < plan.weapon.cost || !me.canUseWeapon(plan.target)) {
			interrupted("weapon/target unavailable")
			break
		}
		phase(me, "weapon shot", () => ({
			weapon: plan.weapon!.name, target: plan.target.id, shot: shot + 1,
			atMost: plan.weaponShots, tpCost: plan.weapon!.cost
		}))
		if (!available()) return
		const result = track(me, plan.weapon, plan.target, () => me.useWeapon(plan.target))
		if (!(result > 0)) { interrupted(`weapon refused: result ${result}`); break }
	}
	if (me.life <= 0 || same(me.cell, plan.destination) || !available()) return
	if (!currentState()) { interrupted("danger stale after actions; final move cancelled"); return }
	const current = computeReachableCells(me, Math.min(me.mp, plan.afterMp), Fight.turn)
	const cost = current.costTo(plan.destination)
	if (!available()) return
	if (cost === null) { interrupted("final cell blocked"); return }
	phase(me, "final move", () => ({ to: { x: plan.destination.x, y: plan.destination.y }, mpCost: cost }))
	if (!available()) return
	track(me, "move", null, () => me.moveToward(plan.destination, cost))
	if (!same(me.cell, plan.destination)) interrupted("final cell not reached")
}
