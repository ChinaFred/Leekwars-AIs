// @version:5.8
// file version: 2
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
import { reportError } from "../Toolbox/Debug.js"
import { log, LOG_CONTEXT } from "../Toolbox/Logger.js"
import { pickOpeningWeapon } from "./OpeningWeapon.js"

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
	const futureTurns = Math.max(0, option.turns - 1)
	const future = futureTurns * (damage(fullTp + option.gain) - damage(fullTp)) * FUTURE_TURN_WEIGHT
	return now + future
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
	const futureTurns = Math.max(0, option.turns - 1)
	const future = Math.min(
		Math.max(0, life - boosted),
		futureTurns * shots(tp) * base * (option.gain / 100) * FUTURE_TURN_WEIGHT
	)
	return boosted - without + future
}

function maxWeaponRange(me: Me): number {
	let range = me.weapon?.maxRange ?? 0
	for (const weapon of me.weapons ?? []) {
		range = Math.max(range, weapon.maxRange)
	}
	return range
}

function cast(me: Me, option: BoostOption, reason: string, unit: "STR" | "TP" = "STR"): boolean {
	const { chip } = option
	if (!me.canUseChip(chip, me)) {
		log(() => `[Boost] ${chip.name}: not usable now (${reason})`, LOG_CONTEXT.CHIP)
		return false
	}
	const strengthBefore = me.strength
	const tpBefore = me.tp
	const result = me.useChip(chip, me)
	log(
		() => `[Boost] cast ${chip.name} (${reason}): +${option.gain.toFixed(0)} ${unit} for ${option.turns} turns, ` +
			`TP ${tpBefore} → ${me.tp}, STR ${strengthBefore} → ${me.strength}, result ${String(result)}`,
		LOG_CONTEXT.CHIP
	)
	return result > 0
}

/**
 * Avant le plan, en contact (je peux tirer ce tour) : lance le boost de force au meilleur gain NET si les
 * dégâts gagnés (ce tour et les tours couverts) dépassent ceux perdus par ses PT. Le plan voit ensuite la force
 * et les PT réels. Sans effet à moins de `MIN_LIFE_RATIO_FOR_BOOST` de PV, sans arme, hors de portée (ou
 * distance inconnue), ou sans boost prêt.
 */
export function castBoostInContact(me: Me, enemy: Entity | null): void {
	try {
		const weapon = me.weapon ?? pickOpeningWeapon(me)
		if (weapon === null || enemy === null || me.life <= 0 || !(me.maxLife > 0)) {
			return
		}
		const distance = me.distance(enemy)
		if (!Number.isFinite(distance) || !(distance <= maxWeaponRange(me) + me.mp) ||
			me.life / me.maxLife < MIN_LIFE_RATIO_FOR_BOOST) {
			return
		}
		const fullTp = me.tp
		// Les PT d'abord : un boost de PT change le budget que le boost de force et le plan verront.
		let bestTp: { option: BoostOption; net: number } | null = null
		for (const option of readyTpBoosts(me, me.tp)) {
			const net = tpBoostNetDamage(me, weapon, option, me.tp, fullTp, true, enemy.life)
			if (bestTp === null || net > bestTp.net) {
				bestTp = { option, net }
			}
		}
		if (bestTp !== null) {
			const chosenTp = bestTp
			if (chosenTp.net > 0) {
				cast(me, chosenTp.option, `in contact, net ${chosenTp.net.toFixed(1)} dmg`, "TP")
			} else {
				log(() => `[Boost] ${chosenTp.option.chip.name}: skipped in contact, net ${chosenTp.net.toFixed(1)} dmg`, LOG_CONTEXT.CHIP)
			}
		}
		let best: { option: BoostOption; net: number } | null = null
		for (const option of readyBoosts(me, me.tp)) {
			const net = boostNetDamage(me, weapon, option, me.tp, enemy.life)
			if (best === null || net > best.net) {
				best = { option, net }
			}
		}
		if (best === null) {
			return
		}
		const chosen = best
		if (chosen.net > 0) {
			cast(me, chosen.option, `in contact, net ${chosen.net.toFixed(1)} dmg`)
		} else {
			log(() => `[Boost] ${chosen.option.chip.name}: skipped in contact, net ${chosen.net.toFixed(1)} dmg`, LOG_CONTEXT.CHIP)
		}
	} catch (error) {
		reportError("src/Brain/StrengthBoost.ts", "castBoostInContact", error)
	}
}

/**
 * Après le plan : lance un boost (PT puis force) avec les PT que le plan n'a pas dépensés (donc sans coût), à
 * condition qu'il couvre le tour suivant (durée ≥ 2) et que l'ennemi puisse être à portée de tir d'ici là
 * (portée + deux tours de mes PM + ses PM). Un boost de PT n'est lancé que si les PT gagnés les tours suivants
 * valent des dégâts (tirs entiers). `mpAtStart` : mes PM au début du tour ; `tpAtStart` : mes PT au début du
 * tour (base du calcul des tours suivants).
 */
export function castBoostWithSpareTp(me: Me, enemy: Entity | null, mpAtStart: number, tpAtStart = me.tp): void {
	try {
		if (enemy === null || me.life <= 0 || (me.weapons ?? []).length === 0) {
			return
		}
		const reach = maxWeaponRange(me) + 2 * mpAtStart + (enemy.mp ?? 0)
		const distance = me.distance(enemy)
		if (!Number.isFinite(distance) || !Number.isFinite(reach) || distance > reach) {
			return
		}
		const weapon = me.weapon ?? pickOpeningWeapon(me)
		if (weapon !== null) {
			let bestTp: { option: BoostOption; net: number } | null = null
			for (const option of readyTpBoosts(me, me.tp)) {
				if (option.turns < 2) {
					continue
				}
				const net = tpBoostNetDamage(me, weapon, option, me.tp, tpAtStart, false, enemy.life)
				if (bestTp === null || net > bestTp.net) {
					bestTp = { option, net }
				}
			}
			if (bestTp !== null && bestTp.net > 0) {
				cast(me, bestTp.option, `spare TP, enemy within ${reach} cells, net ${bestTp.net.toFixed(1)} dmg`, "TP")
			}
		}
		const option = pickBoost(me, me.tp)
		if (option === null || option.turns < 2) {
			return
		}
		cast(me, option, `spare TP, enemy within ${reach} cells`)
	} catch (error) {
		reportError("src/Brain/StrengthBoost.ts", "castBoostWithSpareTp", error)
	}
}

/** Inventaire des puces (une ligne, tour 1) : identifiant, coût, délai et features, pour vérifier les boosts. */
export function logChipInventory(me: Me): void {
	try {
		const chips = me.chips ?? []
		if (chips.length === 0) {
			return
		}
		log(() => `[Chips] ${chips.map((chip) =>
			`${chip.name}#${chip.id}(${chip.cost}TP,cd${chip.cooldown},${(chip.features ?? []).map((feature) =>
				`${feature.type}:${feature.minValue}-${feature.maxValue}x${feature.turns}`).join("/")})`).join("; ")} | STR ${me.strength}, SCI ${me.science}`,
			LOG_CONTEXT.CHIP)
	} catch (error) {
		reportError("src/Brain/StrengthBoost.ts", "logChipInventory", error)
	}
}
