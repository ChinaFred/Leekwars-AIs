// @version:5.8
// file version: 7
import { ShotCandidate, baseMeanDamage, maxUsesOf } from "../Context/ShotPlan.js"
import { LeekProfile } from "../LeekProfile.js"
import { LeekStrategy } from "../Strategy/LeekStrategy.js"
import {
	BoostOption, agilityBoostFutureDamage, pickAgilityBoost, pickBoost, pickTpBoost, strengthBoostFutureDamage,
	tpBoostFutureDamage
} from "../../Brain/StrengthBoost.js"
import { Budget, TACTICAL_LIMITS, TacticalPlan, Unavailable, validCost } from "./TacticalTypes.js"

function featureValue(chip: Chip, type: number): number {
	let value = 0
	for (const feature of chip.features) {
		if (feature.type === type) value += (feature.minValue + feature.maxValue) / 2
	}
	return Math.max(0, value)
}

/** Estimation par feature de dégâts ; arrondis, critiques, érosion et effets secondaires non simulés. */
export function netDamage(candidate: ShotCandidate, target: Entity): number {
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

export interface AttackChoice { attack: Attack; cost: number }

/** Meilleur coût exact ≤ budget ; dégâts utiles plafonnés puis PT minimaux. */
export function attackChoices(
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
export function attacks(
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

export interface Protection {
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
export function protections(me: Me, healing: boolean, shielding: boolean, budget: Budget, tp: number = me.tp): Protection[] {
	const usable = (chip: Chip): boolean => {
		budget.check()
		const result = me.canUseChip(chip, me)
		budget.check()
		return result
	}
	const candidates = [...new Set(me.chips)].filter((chip) =>
		validCost(chip.cost) && chip.cost <= tp && chip.currentCooldown === 0 && maxUsesOf(chip) > 0 &&
		chip.features.length > 0 && chip.features.every((feature) =>
			(feature.type === Effect.HEAL && healing) ||
			((feature.type === Effect.ABSOLUTE_SHIELD || feature.type === Effect.RELATIVE_SHIELD) && shielding)
		) && usable(chip)
	)
	if (candidates.length > TACTICAL_LIMITS.protectionChips) throw new Unavailable("protection bound")
	const result: Protection[] = [{ chips: [], cost: 0, heal: 0, absolute: 0, relative: 0 }]
	for (const chip of candidates) {
		for (const previous of result.slice()) {
			if (previous.cost + chip.cost > tp) continue
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
export function shieldCredit(protection: Protection, danger: number): number {
	return Math.min(danger, protection.absolute + danger * protection.relative / 100)
}

/**
 * Sous le seuil de repli du rôle (`shouldHide`), le danger pèse `RETREAT_RISK_FACTOR` fois plus.
 * Choix heuristique, non calibré en combat.
 */
export const RETREAT_RISK_FACTOR = 2

/**
 * Posture du rôle configuré (`profile.strategyName`) : LE seul endroit où le rôle règle le plan conjoint, en plus des
 * seuils de `Strategy/*.ts`. `BALANCED` est la référence (comportement d'avant la posture). Valeurs heuristiques, NON
 * calibrées en combat.
 * - `risk` : facteur de rôle du poids du risque `w` (voir `riskWeight`, commun au plan B).
 * - `approach` : facteur de rôle du poids d'approche `a` (voir `posture`), appliqué à `G` et à `N` dans le score.
 * - `passivityFloor` : plancher du facteur de passivité `p` (0 : le danger finit par ne plus peser).
 * - `retreat` : recul sans dégâts en tête d'une recherche complète. `free` : jamais filtré ; `damage` : cède à un plan
 *   à dégâts sous la marge ; `advance` : de plus, sans un tel plan, cède à une avance ou à une protection sur place.
 * - `routeWeapon` : arme visée par le trajet futur. `first` : ordre de l'inventaire ; `damage` : meilleurs dégâts
 *   moyens sur un tour ; `range` : plus longue portée max.
 */
export interface RolePosture {
	risk: number
	approach: number
	passivityFloor: number
	retreat: "free" | "damage" | "advance"
	routeWeapon: "first" | "damage" | "range"
}
const BALANCED_POSTURE: RolePosture = { risk: 1, approach: 1, passivityFloor: 0, retreat: "damage", routeWeapon: "first" }
const AGGRESSIVE_POSTURE: RolePosture = { risk: 0.5, approach: 1.25, passivityFloor: 0, retreat: "advance", routeWeapon: "damage" }
const DEFENSIVE_POSTURE: RolePosture = { risk: 1.5, approach: 0.75, passivityFloor: 0.5, retreat: "free", routeWeapon: "range" }
function rolePosture(profile: LeekProfile): RolePosture {
	return profile.strategyName === "AGGRESSIVE" ? AGGRESSIVE_POSTURE :
		profile.strategyName === "DEFENSIVE" ? DEFENSIVE_POSTURE : BALANCED_POSTURE
}

/** Plancher du poids d'approche `a` : même très prudent, un profil garde la moitié du progrès. Non calibré. */
export const APPROACH_WEIGHT_MIN = 0.5

/**
 * Posture du profil pour le plan conjoint. `approach` y devient le poids d'approche `a` = facteur de rôle ×
 * (0,5 + agressivité / 100), borné à [`APPROACH_WEIGHT_MIN`, `approachMax`]. L'appelant passe
 * `approachMax` = 1 / `NEXT_TURN_WEIGHT` : le poids effectif de `N` ne dépasse jamais 1 (des dégâts remis au tour
 * suivant ne valent jamais plus que ceux de ce tour). `BALANCED` à agressivité 50 : `a` = 1.
 */
export function posture(profile: LeekProfile, approachMax: number): RolePosture {
	const role = rolePosture(profile)
	return {
		...role,
		approach: Math.max(APPROACH_WEIGHT_MIN, Math.min(approachMax, role.approach * (0.5 + profile.aggression / 100)))
	}
}

/**
 * Poids du risque, commun au plan conjoint et au plan B : facteur de rôle (`RolePosture.risk`) × (1,5 − agressivité /
 * 100), multiplié par `RETREAT_RISK_FACTOR` si le profil autorise le repli et que `strategy.shouldHide` le demande
 * (`distance` : Manhattan à l'ennemi vivant le plus proche ; « trop près » : `distance < MIN_SAFE_DISTANCE`).
 */
export function riskWeight(profile: LeekProfile, strategy: LeekStrategy, lifeRatio: number, distance: number): number {
	const weight = rolePosture(profile).risk * (1.5 - profile.aggression / 100)
	return profile.allowHiding && strategy.shouldHide(lifeRatio, distance)
		? weight * RETREAT_RISK_FACTOR : weight
}

/** Variante de boost d'un plan : puces dans l'ordre de lancer (PT puis force), coût total et effets attendus. */
export interface BoostVariant {
	chips: readonly Chip[]
	cost: number
	/** PT entiers attendus du boost de PT, dès le lancer (hypothèse de `tpBoostOf`, valeur moyenne arrondie par défaut). */
	tpGain: number
	tp: BoostOption | null
	strength: BoostOption | null
	/** Boost d'agilité (lancé en dernier des boosts) : gain de critique mesuré dans le score. */
	agility: BoostOption | null
}

/**
 * `tp` : PT disponibles pour le plan (ceux du tour, moins le boost de PM d'un plan boosté). Au plus 8 variantes : aucune, meilleur boost de PT prêt, meilleur boost de force prêt, les deux, puis chacune avec le
 * meilleur boost d'agilité prêt (si `canUseChip` sur moi et si PT − coûts ≥ 0, sans compter les PT gagnés : une variante
 * d'agilité ne compte jamais sur le boost de PT, d'où `tpGain` = 0, comme l'ancien remplissage). Sans boost prêt (ou effet
 * déjà actif) : la seule variante « aucune », donc aucun travail de plus dans la recherche.
 */
export function boostVariants(me: Me, tp: number = me.tp): BoostVariant[] {
	const variants: BoostVariant[] = [{ chips: [], cost: 0, tpGain: 0, tp: null, strength: null, agility: null }]
	const tpBoost = pickTpBoost(me, tp)
	const strength = pickBoost(me, tp)
	const tpGain = tpBoost ? Math.floor(tpBoost.gain) : 0
	if (tpBoost) variants.push({ chips: [tpBoost.chip], cost: tpBoost.chip.cost, tpGain, tp: tpBoost, strength: null, agility: null })
	if (strength) variants.push({ chips: [strength.chip], cost: strength.chip.cost, tpGain: 0, tp: null, strength, agility: null })
	if (tpBoost && strength && tpBoost.chip !== strength.chip && strength.chip.cost <= tp - tpBoost.chip.cost + tpGain) {
		variants.push({ chips: [tpBoost.chip, strength.chip], cost: tpBoost.chip.cost + strength.chip.cost, tpGain, tp: tpBoost, strength, agility: null })
	}
	const agility = pickAgilityBoost(me, tp)
	if (agility && usableOnMe(me, agility.chip)) {
		for (const base of variants.slice()) {
			if (base.cost + agility.chip.cost > tp) continue
			variants.push({ ...base, chips: [...base.chips, agility.chip], cost: base.cost + agility.chip.cost, tpGain: 0, agility })
		}
	}
	return variants
}

/** `canUseChip` sur moi ; une erreur native ou une API absente = non utilisable (le boost est facultatif). */
function usableOnMe(me: Me, chip: Chip): boolean {
	try {
		return typeof me.canUseChip === "function" && me.canUseChip(chip, me)
	} catch {
		return false
	}
}

/**
 * Crédit des tours suivants d'une variante pour `weapon` (voir `StrengthBoost.ts`), avant plafonnement par
 * `FUTURE_TURN_WEIGHT` × les PV qui restent à la cible. Force et PT : tirs de l'arme seule ; `idle` (plan
 * sans tir) : PT au meilleur de trois scénarios de portée, crédit optimiste (voir `tpBoostFutureDamage`). Les deux boosts sont crédités
 * indépendamment (agilité comprise : tirs de l'arme seule).
 */
export function boostFuture(
	me: Me, variant: BoostVariant, weapon: Weapon | null, enemyLife: number, idle = false
): number {
	if (weapon === null) return 0
	return (variant.strength ? strengthBoostFutureDamage(weapon, variant.strength, me.tp) : 0) +
		(variant.tp ? tpBoostFutureDamage(me, weapon, variant.tp, me.tp, enemyLife, idle) : 0) +
		(variant.agility ? agilityBoostFutureDamage(me, weapon, variant.agility, me.tp) : 0)
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
 * Ennemi blessé en fuite : sous cette fraction de ses PV max, le poids du risque est ramené à `WOUNDED_RISK_FACTOR`
 * (voir `woundedRiskFactor`). Combat 54995131, tour 5 : ennemi à 98/318 PV (31 %) en fuite à distance 13, Kassbi
 * (346/385) restait sur place faute de case avancée sans danger : 10 PT et 5 PM perdus. 30 % : hypothèse, non mesurée.
 */
export const WOUNDED_ENEMY_LIFE_FRACTION = 0.3

/** Facteur de risque face à un ennemi blessé : 0 comme la passivité au plus bas, le seuil létal reste à `PASSIVE_DANGER_LIFE_FRACTION`. Non calibré. */
export const WOUNDED_RISK_FACTOR = 0

/**
 * Facteur du poids du risque dû à la cible de progression : `WOUNDED_RISK_FACTOR` si elle a moins de
 * `WOUNDED_ENEMY_LIFE_FRACTION` de ses PV max, sinon 1. S'ajoute à la passivité (le plus petit des deux s'applique).
 */
export function woundedRiskFactor(target: Entity | undefined): number {
	return target !== undefined && target.maxLife > 0 && target.life / target.maxLife < WOUNDED_ENEMY_LIFE_FRACTION
		? WOUNDED_RISK_FACTOR : 1
}

/**
 * Coût de risque d'un plan, en points de score : `weight` × danger après protection, plus `LETHAL_PENALTY` et
 * le dépassement si ce danger atteint `lifeFraction` × mes PV (vie + soin prévu ; 1 à poids plein,
 * `PASSIVE_DANGER_LIFE_FRACTION` à poids réduit). Nul si le plan tue le dernier ennemi.
 * Estimation du modèle, pas une garantie de survie (critiques, buffs recastés et armes inconnues non prévus).
 */
export function riskCost(
	me: Me, weight: number, protection: Protection, danger: number, kills: boolean, lifeFraction: number
): number {
	if (kills) return 0
	const exposed = danger - shieldCredit(protection, danger)
	const limit = (me.life + protection.heal) * lifeFraction
	return weight * exposed + (exposed >= limit ? LETHAL_PENALTY + exposed - limit : 0)
}

/** Seuil létal de `riskCost` atteint ? Alors `N` = 0 : aucune valeur future ne rachète une case où je peux mourir. */
export function lethal(me: Me, protection: Protection, danger: number, lifeFraction: number): boolean {
	return danger - shieldCredit(protection, danger) >= (me.life + protection.heal) * lifeFraction
}

export function killsLastEnemy(damage: number, target: Entity, enemyCount: number): boolean {
	return enemyCount === 1 && damage >= target.life * KILL_MARGIN
}

/**
 * Comparaison d'un candidat décrit par ses seuls critères (sans construire l'objet) : permet de ne créer que les
 * plans qui améliorent le meilleur. Ordre : score, danger, PT dépensés, distance de tir courante puis future (même
 * cible), PM totaux. `better` en est la forme sur un plan complet : une seule règle.
 * `doomed` (tour condamné, voir `evaluate`) : une cible tuée (dégâts moyens ≥ ses PV) passe AVANT le score ; le reste
 * du classement est inchangé (soin, protection et case finale gardent leur score : « condamné » reste une estimation).
 */
export function beats(
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

export function better(candidate: TacticalPlan, best: TacticalPlan | null, doomed: boolean): boolean {
	return beats(best, doomed, candidate.usefulDamage, candidate.score, candidate.danger, candidate.tpUsed, candidate.target,
		candidate.firingDistance, candidate.futureRouteDistance, candidate.beforeMp + candidate.afterMp)
}
