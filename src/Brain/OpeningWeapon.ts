// @version:5.8
// file version: 4
import { track } from "../Classes/Context/StagnationTracker.js"
import { aliveEnemies } from "../Classes/Context/Targets.js"
import type { TacticalPlan } from "../Classes/Plannification/TacticalTypes.js"
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

/** Ce que le jeu sait du prochain contact : distance à l'ennemi le plus proche, PM des deux camps. */
export interface OpeningContact {
	readonly distance: number
	readonly myMp: number
	readonly enemyMp: number
}

/**
 * Distances de tir plausibles au prochain contact, `[min, max]`. Même modèle que le livre (`idleBoostCredit`) : chaque camp
 * avance de ses PM. Le contact est le premier tour `s` où l'arme de plus longue portée `reach` peut tirer
 * (`s` = max(1, ⌈(distance − reach) / (mes PM + ses PM)⌉)) ; ce tour-là l'ennemi a avancé `s` fois et moi `s − 1` fois avant
 * mon déplacement : distances de `distance − s × (PM + PM)` (j'ai tout fermé) à `distance − s × ses PM − (s − 1) × mes PM`
 * (je tire sans bouger). Hypothèse du livre (`advanceTowardMe`) : l'ennemi avance.
 */
export function contactWindow(contact: OpeningContact, reach: number): { readonly min: number; readonly max: number } {
	const speed = contact.myMp + contact.enemyMp
	const turns = speed > 0 ? Math.max(1, Math.ceil((contact.distance - reach) / speed)) : 1
	const min = Math.max(1, contact.distance - turns * speed)
	return { min, max: Math.max(min, contact.distance - turns * contact.enemyMp - (turns - 1) * contact.myMp) }
}

/** Part des distances de la fenêtre où l'arme peut tirer (1 sans fenêtre). */
function usableShare(weapon: Weapon, window: { readonly min: number; readonly max: number } | null): number {
	if (window === null) return 1
	const low = Math.max(window.min, weapon.minRange)
	const high = Math.min(window.max, weapon.maxRange)
	return Math.max(0, high - low + 1) / (window.max - window.min + 1)
}

/**
 * Arme de plus grande valeur = dégâts moyens par PT × part des distances de tir plausibles du prochain contact où elle tire
 * (`contactWindow`) ; à égalité, la plus longue portée. Sans `contact` : rendement seul. Une arme de portée 1 ne gagne donc que
 * si le contact au corps à corps est plausible. Aucune constante : le poids vient de la distance, des PM et des portées.
 */
export function pickOpeningWeapon(me: Me, contact: OpeningContact | null = null): Weapon | null {
	const weapons = me.weapons ?? []
	const window = contact === null ? null : contactWindow(contact, Math.max(0, ...weapons.map((weapon) => weapon.maxRange)))
	let best: Weapon | null = null
	let bestValue = Number.NEGATIVE_INFINITY
	for (const weapon of weapons) {
		const ratio = weapon.cost > 0 ? meanShotDamage(weapon, me.strength) / weapon.cost : 0
		const value = ratio * usableShare(weapon, window)
		if (best === null || value > bestValue || (value === bestValue && weapon.maxRange > best.maxRange)) {
			best = weapon
			bestValue = value
		}
	}
	return best
}

/** Ennemi vivant le plus proche : distance et PM. Null sans ennemi. */
function nearestContact(me: Me, myMp: number): OpeningContact | null {
	let nearest: { distance: number; enemyMp: number } | null = null
	for (const enemy of aliveEnemies()) {
		const distance = me.distance(enemy)
		if (nearest === null || distance < nearest.distance) nearest = { distance, enemyMp: enemy.mp }
	}
	return nearest === null ? null : { distance: nearest.distance, myMp, enemyMp: nearest.enemyMp }
}

/**
 * Tour 1 : équipe toujours une arme avec les PT que le plan n'a pas dépensés. Équiper (1 PT) au tour 1 est presque gratuit et
 * évite ce PT quand l'arme est utile plus tard ; un changement ultérieur reste possible.
 * Choix : 1) l'arme que le meilleur enchaînement du livre utilise en premier aux tours simulés suivants (`plan.later`) ;
 * 2) sinon (pas de plan du livre, tours non simulés, aucune arme dans ces tours) `pickOpeningWeapon` sur le contact plausible.
 * Sans effet hors tour 1, si une arme est déjà équipée, sans arme ou sans PT. `myMp` : mes PM au début du tour.
 */
export function equipOpeningWeapon(me: Me, plan: TacticalPlan | null = null, myMp: number = me.mp): void {
	try {
		if (Fight.turn !== 1 || me.weapon !== null || me.life <= 0 || me.tp < 1) {
			return
		}
		const later = plan?.later
		let weapon: Weapon | null = later?.weapon ?? null
		let source = `plan: first weapon of the best sequence over ${later?.turns ?? 0} later turn(s)`
		if (weapon === null) {
			const contact = nearestContact(me, myMp)
			weapon = pickOpeningWeapon(me, contact)
			const why = later === undefined ? (plan === null ? "no book plan" : "plan without book data") : later.turns === 0 ? "later turns not simulated" : `no weapon in ${later.turns} simulated turn(s)`
			const window = contact === null ? null : contactWindow(contact, Math.max(0, ...(me.weapons ?? []).map((candidate) => candidate.maxRange)))
			source = `fallback (${why}): damage/TP x share of shot distances${contact === null || window === null ? " (no enemy: share 1)" :
				` [${window.min}..${window.max}] (distance ${contact.distance}, MP ${contact.myMp}+${contact.enemyMp})`}`
		}
		if (weapon === null || meanShotDamage(weapon, me.strength) <= 0) {
			return
		}
		const chosen = weapon
		const tpBefore = me.tp
		const equipped = track(me, "equip", null, () => me.setWeapon(chosen))
		log(() => `[Weapon] Opening equip: ${chosen.name} (1 TP, ${tpBefore} → ${me.tp}, result ${String(equipped)}) source ${source}`, LOG_CONTEXT.WEAPON)
	} catch (error) {
		reportError("src/Brain/OpeningWeapon.ts", "equipOpeningWeapon", error)
	}
}
