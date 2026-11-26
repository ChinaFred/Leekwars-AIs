// @version:5.8
// file version: 2
import { track } from "../Classes/Context/ActionHistory.js"
import { reportError } from "../Toolbox/Debug.js"
import { log, LOG_CONTEXT } from "../Toolbox/Logger.js"

/** Dégâts moyens d'un tir (somme des effets `DAMAGE`, force comprise), sans critique. */
function meanShotDamage(weapon: Weapon, strength: number): number {
	let total = 0
	for (const feature of weapon.features) {
		if (feature.type === Effect.DAMAGE) {
			total += (feature.minValue + feature.maxValue) / 2
		}
	}
	return total * (1 + strength / 100)
}

/** Arme au meilleur rendement par PT (à égalité, la plus longue portée) ; null si aucune arme. */
export function pickOpeningWeapon(me: Me): Weapon | null {
	let best: Weapon | null = null
	let bestRatio = Number.NEGATIVE_INFINITY
	for (const weapon of me.weapons ?? []) {
		const ratio = weapon.cost > 0 ? meanShotDamage(weapon, me.strength) / weapon.cost : 0
		if (best === null || ratio > bestRatio || (ratio === bestRatio && weapon.maxRange > best.maxRange)) {
			best = weapon
			bestRatio = ratio
		}
	}
	return best
}

/**
 * Tour 1 : équipe toujours une arme avec les PT que le plan n'a pas dépensés. Équiper (1 PT) au tour 1 est
 * presque gratuit et évite ce PT quand l'arme est utile plus tard ; un changement ultérieur reste possible.
 * Sans effet hors tour 1, si une arme est déjà équipée, sans arme ou sans PT.
 */
export function equipOpeningWeapon(me: Me): void {
	try {
		if (Fight.turn !== 1 || me.weapon !== null || me.life <= 0 || me.tp < 1) {
			return
		}
		const weapon = pickOpeningWeapon(me)
		if (weapon === null || meanShotDamage(weapon, me.strength) <= 0) {
			return
		}
		const tpBefore = me.tp
		const equipped = track(me, "equip", null, () => me.setWeapon(weapon))
		log(() => `[Weapon] Opening equip: ${weapon.name} (1 TP, ${tpBefore} → ${me.tp}, result ${String(equipped)})`, LOG_CONTEXT.WEAPON)
	} catch (error) {
		reportError("src/Brain/OpeningWeapon.ts", "equipOpeningWeapon", error)
	}
}
