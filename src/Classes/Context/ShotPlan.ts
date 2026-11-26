// @version:5.8
// file version: 5

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

/** La feature est-elle un boost de force (`BUFF_STRENGTH` ou `RAW_BUFF_STRENGTH`) ? */
export function isStrengthBoostType(type: number): boolean {
	return type === Effect.BUFF_STRENGTH || type === (Effect.RAW_BUFF_STRENGTH ?? RAW_BUFF_STRENGTH_ID)
}

/** Identifiant officiel de l'effet « PT bruts » (EFFECT_RAW_BUFF_TP = 32) si l'API ne le nomme pas. */
const RAW_BUFF_TP_ID = 32

/** La feature est-elle un boost de PT (`BUFF_TP`, amplifié par la science, ou `RAW_BUFF_TP`, non amplifiable) ? */
export function isTpBoostType(type: number): boolean {
	return type === Effect.BUFF_TP || type === (Effect.RAW_BUFF_TP ?? RAW_BUFF_TP_ID)
}

/**
 * PT supplémentaires qu'apporte une puce de boost de PT lancée sur soi (par tour d'effet) : moyenne des features
 * `BUFF_TP` (× (1 + science / 100)) et `RAW_BUFF_TP`. 0 si la puce ne donne pas de PT. Hypothèse non vérifiée :
 * les PT s'ajoutent immédiatement au lancer, puis à chaque tour où l'effet reste actif.
 */
export function tpBoostOf(chip: Chip, science: number): number {
	const raw = Effect.RAW_BUFF_TP ?? RAW_BUFF_TP_ID
	const amplifier = 1 + (Number.isFinite(science) && science > 0 ? science : 0) / 100
	let gain = 0
	for (const feature of chip.features ?? []) {
		const mean = (feature.minValue + feature.maxValue) / 2
		if (feature.type === Effect.BUFF_TP) {
			gain += mean * amplifier
		} else if (feature.type === raw) {
			gain += mean
		}
	}
	return gain > 0 ? gain : 0
}

/** Identifiant officiel de l'effet « PM bruts » (TYPE_RAW_BUFF_MP = 31, `Effect.java` du générateur) si l'API ne le nomme pas. */
const RAW_BUFF_MP_ID = 31

/** La feature est-elle un boost de PM (`BUFF_MP`, amplifié par la science, ou `RAW_BUFF_MP`, non amplifiable) ? */
export function isMpBoostType(type: number): boolean {
	return type === Effect.BUFF_MP || type === (Effect.RAW_BUFF_MP ?? RAW_BUFF_MP_ID)
}

/**
 * PM supplémentaires qu'apporte une puce de boost de PM lancée sur soi : moyenne des features `BUFF_MP`
 * (× (1 + science / 100)) et `RAW_BUFF_MP`. 0 si la puce ne donne pas de PM. Le moteur arrondit au plus proche ;
 * l'appelant prend la partie entière (sous-estimation prudente).
 */
export function mpBoostOf(chip: Chip, science: number): number {
	const raw = Effect.RAW_BUFF_MP ?? RAW_BUFF_MP_ID
	const amplifier = 1 + (Number.isFinite(science) && science > 0 ? science : 0) / 100
	let gain = 0
	for (const feature of chip.features ?? []) {
		const mean = (feature.minValue + feature.maxValue) / 2
		if (feature.type === Effect.BUFF_MP) {
			gain += mean * amplifier
		} else if (feature.type === raw) {
			gain += mean
		}
	}
	return gain > 0 ? gain : 0
}

/** Durée en tours (la plus longue) des features de boost de PM d'une puce ; 0 si elle n'en a pas. */
export function mpBoostTurns(chip: Chip): number {
	let turns = 0
	for (const feature of chip.features ?? []) {
		if (isMpBoostType(feature.type)) {
			turns = Math.max(turns, Number.isFinite(feature.turns) ? feature.turns : 0)
		}
	}
	return turns
}

/** Durée en tours (la plus longue) des features de boost de PT d'une puce ; 0 si elle n'en a pas. */
export function tpBoostTurns(chip: Chip): number {
	let turns = 0
	for (const feature of chip.features ?? []) {
		if (isTpBoostType(feature.type)) {
			turns = Math.max(turns, Number.isFinite(feature.turns) ? feature.turns : 0)
		}
	}
	return turns
}

/** Durée en tours (la plus longue) des features de boost de force d'une puce ; 0 si elle n'en a pas. */
export function strengthBoostTurns(chip: Chip): number {
	let turns = 0
	for (const feature of chip.features ?? []) {
		if (isStrengthBoostType(feature.type)) {
			turns = Math.max(turns, Number.isFinite(feature.turns) ? feature.turns : 0)
		}
	}
	return turns
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

/**
 * Lancers d'une puce dans un même tour : `maxUsesOf` si son cooldown de BASE (`Chip.cooldown`, distinct de
 * `currentCooldown`) vaut 0 ; sinon 1 (0 si `maxUses` vaut 0). Cooldown de base inconnu (absent, non numérique)
 * ou infini (< 0) : 1, lecture prudente. Combat 54965081 : l'ennemi lance deux fois la même puce dans un tour.
 */
export function chipUsesOf(chip: Chip): number {
	const limit = maxUsesOf(chip)
	return chip.cooldown === 0 ? limit : Math.min(1, limit)
}

/** Un item offensif prêt à être planifié (valeurs déjà calculées une fois par ennemi). */
export interface ShotCandidate {
	readonly item: ShotItem
	readonly isChip: boolean
	/** Dégâts moyens d'un tir (voir `meanDamage`). */
	readonly damage: number
	/** Coût en PT (> 0 et fini). */
	readonly cost: number
	/** Utilisations maximales dans un plan : arme = `maxUsesOf` ; puce = `chipUsesOf`. Peut valoir Infinity. */
	readonly uses: number
	/** Dégâts par PT. */
	readonly ratio: number
}

/**
 * Candidat offensif, ou null s'il n'a aucun dégât, un coût invalide (≤ 0 ou non fini : évite les divisions
 * par zéro et les tirs infinis) ou aucune utilisation permise. Une puce sans cooldown de base est utilisable
 * plusieurs fois par plan, les autres une seule (`chipUsesOf`) ; `maxUses` = 0 l'exclut.
 */
export function toCandidate(item: ShotItem, isChip: boolean, strength: number): ShotCandidate | null {
	const damage = meanDamage(item, strength)
	const cost = item.cost
	if (!(damage > 0) || !Number.isFinite(cost) || cost <= 0) {
		return null
	}
	const uses = isChip ? chipUsesOf(item as Chip) : maxUsesOf(item)
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
	/** Une entrée par lancer : une puce sans cooldown peut y figurer plusieurs fois. */
	readonly chips: readonly Chip[]
	/** PT dépensés par le plan. */
	readonly tpUsed: number
}

export const EMPTY_PLAN: ShotPlan = { damage: 0, weapon: null, weaponShots: 0, chips: [], tpUsed: 0 }

/** État du sac à dos pour un coût EXACT : dégâts, tirs d'arme, et dernier groupe de lancers d'une puce (chaîné). */
interface ShotState {
	readonly damage: number
	readonly shots: number
	readonly chip: Chip | null
	readonly casts: number
	readonly previous: ShotState | null
}

/**
 * Meilleur plan pour `tp` PT avec les seuls items UTILISABLES depuis la case de tir considérée.
 *
 * - `weapon` : l'arme si elle touche la cible depuis cette case, sinon null.
 * - `chips` : puces offensives prêtes qui touchent la cible depuis cette case.
 *
 * Maximum EXACT des dégâts (sac à dos borné sur les PT, une entrée par coût exact) : tirs d'arme ≤ `uses`,
 * lancers de chaque puce ≤ `uses` (1 avec un cooldown de base, voir `chipUsesOf`). Jamais moins que l'arme seule
 * ni qu'une puce de chaque. À dégâts égaux : le moins de PT, puis l'arme et les premières puces de la liste.
 * Un item au coût non entier est ignoré (les coûts du jeu sont entiers). Coût : Σ puces PT × lancers possibles.
 */
export function planShots(tp: number, weapon: ShotCandidate | null, chips: readonly ShotCandidate[]): ShotPlan {
	const budget = Number.isFinite(tp) && tp > 0 ? Math.floor(tp) : 0
	let states: Array<ShotState | undefined> = new Array(budget + 1)
	states[0] = { damage: 0, shots: 0, chip: null, casts: 0, previous: null }
	if (weapon !== null && Number.isInteger(weapon.cost)) {
		const limit = Math.min(Math.floor(budget / weapon.cost), weapon.uses)
		for (let shots = 1; shots <= limit; shots++) {
			states[shots * weapon.cost] = { damage: shots * weapon.damage, shots, chip: null, casts: 0, previous: null }
		}
	}
	for (const chip of chips) {
		const cost = chip.cost
		if (!Number.isInteger(cost) || cost > budget) {
			continue
		}
		const limit = Math.min(Math.floor(budget / cost), chip.uses)
		const next = states.slice()
		for (let spent = cost; spent <= budget; spent++) {
			let best = states[spent]
			for (let casts = 1; casts <= limit && casts * cost <= spent; casts++) {
				const previous = states[spent - casts * cost]
				if (previous === undefined) {
					continue
				}
				const damage = previous.damage + casts * chip.damage
				if (best === undefined || damage > best.damage) {
					best = { damage, shots: previous.shots, chip: chip.item as Chip, casts, previous }
				}
			}
			next[spent] = best
		}
		states = next
	}
	let best = states[0]!
	let tpUsed = 0
	for (let spent = 1; spent <= budget; spent++) {
		const state = states[spent]
		if (state !== undefined && state.damage > best.damage) {
			best = state
			tpUsed = spent
		}
	}
	if (!(best.damage > 0)) {
		return EMPTY_PLAN
	}
	const groups: ShotState[] = []
	for (let state: ShotState | null = best; state !== null; state = state.previous) {
		groups.push(state)
	}
	const picked: Chip[] = []
	for (let i = groups.length - 1; i >= 0; i--) {
		const group = groups[i]!
		for (let cast = 0; cast < group.casts && group.chip !== null; cast++) {
			picked.push(group.chip)
		}
	}
	return {
		damage: best.damage,
		weapon: best.shots > 0 && weapon !== null ? (weapon.item as Weapon) : null,
		weaponShots: best.shots,
		chips: picked,
		tpUsed
	}
}
