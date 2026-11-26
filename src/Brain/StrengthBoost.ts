// @version:5.8
// file version: 3
import {
	baseMeanDamage,
	isStrengthBoostType,
	isTpBoostType,
	maxUsesOf,
	strengthBoostOf,
	strengthBoostTurns,
	tpBoostOf,
	tpBoostTurns
} from "../Classes/Context/ShotPlan.js"
import { log, LOG_CONTEXT } from "../Toolbox/Logger.js"

/** Part créditée des tours futurs couverts par le boost (le contact avec l'ennemi n'est pas garanti). */
export const FUTURE_TURN_WEIGHT = 0.75

/** En dessous de ce ratio de PV, les PT d'un combat en cours vont à la protection, pas au boost. */
export const MIN_LIFE_RATIO_FOR_BOOST = 0.5

export interface BoostOption {
	readonly chip: Chip
	/** Force ajoutée (science comprise). */
	readonly gain: number
	/** Durée de l'effet en tours (le tour du lancer compte pour 1). */
	readonly turns: number
}

/** Un boost de force est-il déjà actif sur moi (effet de force non expiré) ? Évite de gaspiller PT et délai. */
export function hasActiveStrengthBoost(me: Me): boolean {
	return (me.effects ?? []).some((effect) => isStrengthBoostType(effect.type) && effect.turns > 0)
}

/** Boosts de force prêts, abordables avec `tp` PT, hors boost déjà actif (liste vide s'il y en a un). */
export function readyBoosts(me: Me, tp: number): BoostOption[] {
	const found: BoostOption[] = []
	if (hasActiveStrengthBoost(me)) {
		return found
	}
	for (const chip of me.chips ?? []) {
		const gain = strengthBoostOf(chip, me.science ?? 0)
		if (!(gain > 0) || !Number.isInteger(chip.cost) || chip.cost <= 0 || chip.cost > tp ||
			chip.currentCooldown !== 0) {
			continue
		}
		found.push({ chip, gain, turns: strengthBoostTurns(chip) })
	}
	return found
}

/** Le boost au plus grand gain de force parmi les prêts ; null sinon. */
export function pickBoost(me: Me, tp: number): BoostOption | null {
	let best: BoostOption | null = null
	for (const option of readyBoosts(me, tp)) {
		if (best === null || option.gain > best.gain) {
			best = option
		}
	}
	return best
}

/** Un boost de PT est-il déjà actif sur moi (effet de PT non expiré) ? */
export function hasActiveTpBoost(me: Me): boolean {
	return (me.effects ?? []).some((effect) => isTpBoostType(effect.type) && effect.turns > 0)
}

/** Boosts de PT prêts : `gain` = PT ajoutés par tour d'effet ; abordables avec `tp` PT ; vide si un est actif. */
export function readyTpBoosts(me: Me, tp: number): BoostOption[] {
	const found: BoostOption[] = []
	if (hasActiveTpBoost(me)) {
		return found
	}
	for (const chip of me.chips ?? []) {
		const gain = tpBoostOf(chip, me.science ?? 0)
		if (!(gain > 0) || !Number.isInteger(chip.cost) || chip.cost <= 0 || chip.cost > tp ||
			chip.currentCooldown !== 0) {
			continue
		}
		found.push({ chip, gain, turns: tpBoostTurns(chip) })
	}
	return found
}

/** Le boost de PT au plus grand gain parmi les prêts ; null sinon. */
export function pickTpBoost(me: Me, tp: number): BoostOption | null {
	let best: BoostOption | null = null
	for (const option of readyTpBoosts(me, tp)) {
		if (best === null || option.gain > best.gain) {
			best = option
		}
	}
	return best
}

/**
 * Part des tours SUIVANTS d'un boost de PT pour `weapon` : `FUTURE_TURN_WEIGHT` × (durée − 1) tours à
 * `fullTp` + gain contre `fullTp`, en tirs entiers, chaque tour plafonné par les PV de l'ennemi.
 */
export function tpBoostFutureDamage(
	me: Me, weapon: Weapon, option: BoostOption, fullTp: number, enemyLife = Number.POSITIVE_INFINITY
): number {
	const base = baseMeanDamage(weapon)
	if (!(base > 0) || !(weapon.cost > 0)) {
		return 0
	}
	const limit = maxUsesOf(weapon)
	const strength = Number.isFinite(me.strength) ? me.strength : 0
	const life = Number.isFinite(enemyLife) && enemyLife > 0 ? enemyLife : Number.POSITIVE_INFINITY
	const damage = (budget: number): number =>
		Math.min(life, Math.max(0, Math.min(Math.floor(budget / weapon.cost), limit)) * base * (1 + strength / 100))
	return Math.max(0, option.turns - 1) * (damage(fullTp + option.gain) - damage(fullTp)) * FUTURE_TURN_WEIGHT
}

/**
 * Part des tours SUIVANTS d'un boost de force pour `weapon`, non plafonnée : `FUTURE_TURN_WEIGHT` × (durée − 1)
 * tours pleins à `fullTp` PT, chaque tir gagnant `gain` % des dégâts de base. L'appelant plafonne par les PV
 * qui restent à la cible après ce tour.
 */
export function strengthBoostFutureDamage(weapon: Weapon, option: BoostOption, fullTp: number): number {
	const base = baseMeanDamage(weapon)
	if (!(base > 0) || !(weapon.cost > 0)) {
		return 0
	}
	const shots = Math.max(0, Math.min(Math.floor(fullTp / weapon.cost), maxUsesOf(weapon)))
	return Math.max(0, option.turns - 1) * shots * base * (option.gain / 100) * FUTURE_TURN_WEIGHT
}

/**
 * Portée (en cases) sous laquelle un boost lancé sans tirer ce tour peut encore servir au tour suivant :
 * portée max de mes armes + deux tours de mes PM + les PM de l'ennemi.
 */
export function boostReach(me: Me, enemy: Entity): number {
	let range = me.weapon?.maxRange ?? 0
	for (const weapon of me.weapons ?? []) {
		range = Math.max(range, weapon.maxRange)
	}
	return range + 2 * me.mp + (enemy.mp ?? 0)
}

/**
 * Dégâts nets d'un boost de PT (`option.gain` PT immédiatement, puis à chaque tour couvert) pour `weapon` :
 * ce tour (si je tire : `inContactNow`), PT − coût + gain contre PT ; puis `FUTURE_TURN_WEIGHT` × (durée − 1)
 * tours à `fullTp` + gain contre `fullTp`. Les dégâts sont plafonnés par les PV de l'ennemi. Les PT sont
 * convertis en tirs entiers (`floor(PT / coût)`), donc un gain de PT inférieur au coût de l'arme peut ne rien
 * valoir. Estimation à une arme, pas une simulation du plan.
 */
export function tpBoostNetDamage(
	me: Me, weapon: Weapon, option: BoostOption, tp: number, fullTp: number, inContactNow: boolean,
	enemyLife = Number.POSITIVE_INFINITY
): number {
	const base = baseMeanDamage(weapon)
	if (!(base > 0) || !(weapon.cost > 0)) {
		return 0
	}
	const limit = maxUsesOf(weapon)
	const strength = Number.isFinite(me.strength) ? me.strength : 0
	const life = Number.isFinite(enemyLife) && enemyLife > 0 ? enemyLife : Number.POSITIVE_INFINITY
	const damage = (budget: number): number =>
		Math.min(life, Math.max(0, Math.min(Math.floor(budget / weapon.cost), limit)) * base * (1 + strength / 100))
	const now = inContactNow ? damage(tp - option.chip.cost + option.gain) - damage(tp) : 0
	return now + tpBoostFutureDamage(me, weapon, option, fullTp, enemyLife)
}

/**
 * Dégâts supplémentaires (nets du PT dépensé) d'un boost lancé maintenant avec `tp` PT, pour `weapon` : tirs de
 * ce tour avec et sans boost, plus `FUTURE_TURN_WEIGHT` × les tirs d'un tour plein pour chaque tour futur
 * couvert (durée − 1). Les dégâts sont plafonnés par les PV de l'ennemi (`enemyLife`) : un boost qui ferait
 * perdre un meurtre ce tour a un gain négatif. Estimation à une arme et sans puce offensive, pas une
 * simulation du plan.
 */
export function boostNetDamage(
	me: Me, weapon: Weapon, option: BoostOption, tp: number, enemyLife = Number.POSITIVE_INFINITY
): number {
	const base = baseMeanDamage(weapon)
	if (!(base > 0) || !(weapon.cost > 0)) {
		return 0
	}
	const limit = maxUsesOf(weapon)
	const shots = (budget: number): number => Math.max(0, Math.min(Math.floor(budget / weapon.cost), limit))
	const strength = Number.isFinite(me.strength) ? me.strength : 0
	const life = Number.isFinite(enemyLife) && enemyLife > 0 ? enemyLife : Number.POSITIVE_INFINITY
	const without = Math.min(life, shots(tp) * base * (1 + strength / 100))
	const boosted = Math.min(life, shots(tp - option.chip.cost) * base * (1 + (strength + option.gain) / 100))
	const future = Math.min(Math.max(0, life - boosted), strengthBoostFutureDamage(weapon, option, tp))
	return boosted - without + future
}

/**
 * Inventaire des puces (une ligne, tour 1) : identifiant, coût, délai et features, pour vérifier les boosts.
 * Ce module n'importe pas `Debug.ts` (les planificateurs l'importent) : l'appelant protège l'appel.
 */
export function logChipInventory(me: Me): void {
	const chips = me.chips ?? []
	if (chips.length === 0) {
		return
	}
	log(() => `[Chips] ${chips.map((chip) =>
		`${chip.name}#${chip.id}(${chip.cost}TP,cd${chip.cooldown},${(chip.features ?? []).map((feature) =>
			`${feature.type}:${feature.minValue}-${feature.maxValue}x${feature.turns}`).join("/")})`).join("; ")} | STR ${me.strength}, SCI ${me.science}`,
		LOG_CONTEXT.CHIP)
}
