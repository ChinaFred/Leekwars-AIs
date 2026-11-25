// @version:5.8
// file version: 2

/** Arme ou puce : les deux ont coût, portées, `features` ; seule la puce a un cooldown. */
export type ShotItem = Weapon | Chip

/** Somme des dégâts moyens de base (sans force) d'un item : précalculée une fois par instance (singletons du jeu). */
const baseDamageCache = new WeakMap<object, number>()

export function baseMeanDamage(item: ShotItem): number {
	const cached = baseDamageCache.get(item)
	if (cached !== undefined) {
		return cached
	}
	let total = 0
	for (const feature of item.features ?? []) {
		if (feature.type === Effect.DAMAGE) {
			total += (feature.minValue + feature.maxValue) / 2
		}
	}
	baseDamageCache.set(item, total)
	return total
}

/**
 * Dégâts moyens d'UN tir : dégâts de base × (1 + force / 100) (même formule que `Plannification`). Sans
 * critique (pas de × 1,3), sans tenir compte de mes boucliers ni de ma résistance : valeur brute. `strength`
 * absent ou non fini → 0. Ne tient compte ni du poison ni des dégâts sur la durée (seules les features DAMAGE
 * comptent), ni de la zone d'effet. Les dégâts de base sont mis en cache par instance d'item (les features
 * d'un item ne changent pas pendant le combat).
 */
export function meanDamage(item: ShotItem, strength: number): number {
	const force = Number.isFinite(strength) ? strength : 0
	return baseMeanDamage(item) * (1 + force / 100)
}

/** Identifiant officiel de l'effet « force brute » (EFFECT_RAW_BUFF_STRENGTH = 38) si l'API ne le nomme pas. */
const RAW_BUFF_STRENGTH_ID = 38

/**
 * Force supplémentaire qu'apporte une puce de boost de force lancée sur soi : moyenne des features
 * `BUFF_STRENGTH` (amplifiée par la science du lanceur : × (1 + science / 100)) et `RAW_BUFF_STRENGTH`
 * (non amplifiable). 0 si la puce ne boost pas la force. Durée et ciblage non vérifiés : on suppose un
 * lancer sur soi, effectif dès le tir qui suit.
 */
export function strengthBoostOf(chip: Chip, science: number): number {
	const raw = Effect.RAW_BUFF_STRENGTH ?? RAW_BUFF_STRENGTH_ID
	const amplifier = 1 + (Number.isFinite(science) && science > 0 ? science : 0) / 100
	let gain = 0
	for (const feature of chip.features ?? []) {
		const mean = (feature.minValue + feature.maxValue) / 2
		if (feature.type === Effect.BUFF_STRENGTH) {
			gain += mean * amplifier
		} else if (feature.type === raw) {
			gain += mean
		}
	}
	return gain > 0 ? gain : 0
}

/** L'item a-t-il au moins une feature DAMAGE de valeur maximale > 0 ? */
export function hasDamage(item: ShotItem): boolean {
	for (const feature of item.features ?? []) {
		if (feature.type === Effect.DAMAGE && feature.maxValue > 0) {
			return true
		}
	}
	return false
}

/**
 * Plafond d'utilisations par tour : `maxUses` absent ou non numérique → illimité (Infinity) ; < 0 (doc :
 * « -1 s'il n'y a pas de limite ») → illimité ; sinon la valeur (0 = aucune utilisation, lu littéralement).
 */
export function maxUsesOf(item: ShotItem): number {
	const maxUses = item.maxUses
	if (typeof maxUses !== "number" || Number.isNaN(maxUses) || maxUses < 0) {
		return Number.POSITIVE_INFINITY
	}
	return Math.floor(maxUses)
}

/** Un item offensif prêt à être planifié (valeurs déjà calculées une fois par ennemi). */
export interface ShotCandidate {
	readonly item: ShotItem
	readonly isChip: boolean
	/** Dégâts moyens d'un tir (voir `meanDamage`). */
	readonly damage: number
	/** Coût en PT (> 0 et fini). */
	readonly cost: number
	/** Utilisations maximales dans un plan : arme = `maxUsesOf` ; puce = 1 (0 si `maxUses` vaut 0). */
	readonly uses: number
	/** Dégâts par PT. */
	readonly ratio: number
}

/**
 * Candidat offensif, ou null s'il n'a aucun dégât, un coût invalide (≤ 0 ou non fini : évite les divisions
 * par zéro et les tirs infinis) ou aucune utilisation permise. Une puce n'est utilisée qu'une fois par plan
 * (hypothèse : lecture prudente de « une puce n'est utilisée qu'une fois par tour »), quel que soit son
 * cooldown ; `maxUses` = 0 l'exclut.
 */
export function toCandidate(item: ShotItem, isChip: boolean, strength: number): ShotCandidate | null {
	const damage = meanDamage(item, strength)
	const cost = item.cost
	if (!(damage > 0) || !Number.isFinite(cost) || cost <= 0) {
		return null
	}
	const limit = maxUsesOf(item)
	const uses = isChip ? Math.min(1, limit) : limit
	if (uses <= 0) {
		return null
	}
	return { item, isChip, damage, cost, uses, ratio: damage / cost }
}

/** Tri par dégâts/PT décroissant, stable (à égalité l'ordre d'origine est conservé). */
export function sortByRatio(candidates: readonly ShotCandidate[]): ShotCandidate[] {
	return candidates
		.map((candidate, index) => ({ candidate, index }))
		.sort((a, b) => b.candidate.ratio - a.candidate.ratio || a.index - b.index)
		.map((entry) => entry.candidate)
}

/** Une combinaison réalisable avec les PT : jamais la somme de tirs concurrents. */
export interface ShotPlan {
	/** Dégâts totaux (puces + tirs d'arme). */
	readonly damage: number
	readonly weapon: Weapon | null
	readonly weaponShots: number
	readonly chips: readonly Chip[]
	/** PT dépensés par le plan. */
	readonly tpUsed: number
}

export const EMPTY_PLAN: ShotPlan = { damage: 0, weapon: null, weaponShots: 0, chips: [], tpUsed: 0 }

function weaponShotsWith(tp: number, weapon: ShotCandidate): number {
	return Math.min(Math.floor(tp / weapon.cost), weapon.uses)
}

/**
 * Meilleur plan pour `tp` PT avec les seuls items UTILISABLES depuis la case de tir considérée.
 *
 * - `weapon` : l'arme équipée si elle touche la cible depuis cette case, sinon null.
 * - `chips` : puces offensives prêtes qui touchent la cible depuis cette case, DÉJÀ triées par `sortByRatio`.
 *
 * Plan « arme seule » : floor(tp / coût) tirs plafonnés par `uses`. Plan « avec puces » : si l'arme est
 * utilisable, seules les puces dont dégâts/PT > dégâts/PT de l'arme sont retenues ; elles sont prises dans
 * l'ordre (dégâts/PT décroissant) tant qu'elles tiennent dans les PT restants (glouton, pas d'optimum
 * exact), chacune au plus une fois ; les PT restants financent des tirs d'arme (si utilisable). Le
 * meilleur des deux plans est renvoyé (à égalité : arme seule), donc jamais moins que l'arme seule.
 */
export function planShots(tp: number, weapon: ShotCandidate | null, chips: readonly ShotCandidate[]): ShotPlan {
	const budget = Number.isFinite(tp) && tp > 0 ? Math.floor(tp) : 0
	let weaponOnly = EMPTY_PLAN
	if (weapon !== null) {
		const shots = weaponShotsWith(budget, weapon)
		if (shots > 0) {
			weaponOnly = {
				damage: shots * weapon.damage,
				weapon: weapon.item as Weapon,
				weaponShots: shots,
				chips: [],
				tpUsed: shots * weapon.cost
			}
		}
	}

	let remaining = budget
	let chipDamage = 0
	const picked: Chip[] = []
	for (const chip of chips) {
		if (weapon !== null && !(chip.ratio > weapon.ratio)) {
			continue
		}
		if (chip.cost <= remaining) {
			picked.push(chip.item as Chip)
			chipDamage += chip.damage
			remaining -= chip.cost
		}
	}
	if (picked.length === 0) {
		return weaponOnly
	}
	const shots = weapon === null ? 0 : weaponShotsWith(remaining, weapon)
	const combinedDamage = chipDamage + (weapon === null ? 0 : shots * weapon.damage)
	if (combinedDamage > weaponOnly.damage) {
		return {
			damage: combinedDamage,
			weapon: shots > 0 && weapon !== null ? (weapon.item as Weapon) : null,
			weaponShots: shots,
			chips: picked,
			tpUsed: budget - remaining + (weapon === null ? 0 : shots * weapon.cost)
		}
	}
	return weaponOnly
}
