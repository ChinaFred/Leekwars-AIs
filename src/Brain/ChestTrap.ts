// @version:5.8
// file version: 2
import { track } from "../Classes/Context/StagnationTracker.js"
import { aliveChests, aliveEnemies } from "../Classes/Context/Targets.js"
import { reportError } from "../Toolbox/Debug.js"
import { log, LOG_CONTEXT } from "../Toolbox/Logger.js"

/** Borne de sécurité du nombre de tirs sur un coffre en un tour (PT et PV du coffre limitent bien avant). */
const MAX_CHEST_SHOTS = 30

/** Une façon de frapper le coffre depuis ma case : arme (équipée ou non) ou puce à dégâts. */
type ChestShot =
	| { readonly kind: "weapon"; readonly weapon: Weapon; readonly swap: boolean }
	| { readonly kind: "chip"; readonly chip: Chip }

function dealsDamage(item: Weapon | Chip): boolean {
	return item.features.some((feature) => feature.type === Effect.DAMAGE)
}

/** Premier tir possible maintenant sur le coffre : arme équipée, puces à dégâts, puis autres armes (1 PT de changement). */
function nextShot(me: Me, chest: Entity): ChestShot | null {
	if (me.weapon !== null && dealsDamage(me.weapon) && me.canUseWeapon(chest)) {
		return { kind: "weapon", weapon: me.weapon, swap: false }
	}
	for (const chip of me.chips ?? []) {
		if (dealsDamage(chip) && me.tp >= chip.cost && me.canUseChip(chip, chest)) {
			return { kind: "chip", chip }
		}
	}
	for (const weapon of me.weapons ?? []) {
		if (weapon === me.weapon || !dealsDamage(weapon) || me.tp < weapon.cost + 1) {
			continue
		}
		if (me.canUseWeapon(chest, weapon)) {
			return { kind: "weapon", weapon, swap: true }
		}
	}
	return null
}

/** Le coffre que l'ennemi atteindrait avant moi et que je peux frapper d'ici (le plus proche de moi) ; null sinon. */
function contestedChest(me: Me): Entity | null {
	const enemies = aliveEnemies()
	if (enemies.length === 0) {
		return null
	}
	let best: Entity | null = null
	let bestDistance = Number.POSITIVE_INFINITY
	for (const chest of aliveChests()) {
		const mine = me.distance(chest)
		const theirs = Math.min(...enemies.map((enemy) => enemy.distance(chest)))
		if (chest.life > 0 && theirs < mine && mine < bestDistance && nextShot(me, chest) !== null) {
			best = chest
			bestDistance = mine
		}
	}
	return best
}

function fire(me: Me, chest: Entity, shot: ChestShot): boolean {
	if (shot.kind === "chip") {
		return track(me, shot.chip, chest, () => me.useChip(shot.chip, chest)) > 0
	}
	if (shot.swap && !track(me, "equip", null, () => me.setWeapon(shot.weapon))) {
		return false
	}
	return track(me, shot.weapon, chest, () => me.useWeapon(chest)) > 0
}

/**
 * Piège du coffre : si je peux frapper un coffre d'ici (n'importe quelle arme ou puce à dégâts) alors qu'un ennemi
 * en est plus proche que moi, je le frappe tant que PT et tirs le permettent, puis je m'éloigne au maximum de mes PM
 * du coffre. Remplace le plan du tour ; renvoie `false` (rien fait) si le piège ne s'applique pas
 * ou si aucun tir n'a abouti, et le plan normal joue alors.
 */
export function springChestTrap(me: Me): boolean {
	try {
		if (me.life <= 0) {
			return false
		}
		const chest = contestedChest(me)
		if (chest === null) {
			return false
		}
		log(() => `[ChestTrap] ${chest.name} (#${chest.id}) at distance ${me.distance(chest)}, an enemy is nearer: shoot then flee`, LOG_CONTEXT.PLANNING)
		let shots = 0
		for (let i = 0; i < MAX_CHEST_SHOTS && chest.life > 0; i++) {
			const shot = nextShot(me, chest)
			if (shot === null || !fire(me, chest, shot)) {
				break
			}
			shots++
		}
		if (shots === 0) {
			return false
		}
		if (me.mp > 0) {
			track(me, "move", null, () => me.moveAwayFrom(chest))
		}
		log(() => `[ChestTrap] ${shots} shot(s) on ${chest.name}, chest HP ${chest.life}/${chest.maxLife}, fled from the chest`, LOG_CONTEXT.PLANNING)
		return true
	} catch (error) {
		reportError("src/Brain/ChestTrap.ts", "springChestTrap", error)
		return false
	}
}
