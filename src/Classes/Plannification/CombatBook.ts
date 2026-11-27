// @version:5.8
// file version: 2
import { isCellInLaunchPattern } from "../Context/LaunchPattern.js"
import { ShotItem, chipUsesOf, maxUsesOf } from "../Context/ShotPlan.js"

/**
 * Table de combos précalculée (« CombatBook ») : au lieu de chercher les meilleurs tirs à chaque case et à chaque
 * tour, on la construit une fois par état de statistiques et on la lit par index. Aucun appel natif ici : la
 * géométrie (distance de Manhattan, ligne de vue, alignement) est fournie par l'appelant.
 *
 * Dégâts moyens sans critique ni plafond par PV (l'appelant plafonne). Le classement des combos se fait sur les dégâts NETS
 * des boucliers de la cible (`Shield`, une table par couple de boucliers) : relatif puis absolu par feature avec plancher
 * à 0, comme `netDamage`. `Combo.raw` garde les dégâts bruts par statistique, `Combo.total` les nets (valeur de classement).
 */

export type ScaleStat = "strength" | "magic" | "fixed"

/** Boucliers de la cible : relatif en % (0 à 100), absolu en points, appliqués par feature. */
export interface Shield { readonly relative: number; readonly absolute: number }
export const NO_SHIELD: Shield = { relative: 0, absolute: 0 }

export interface Stats { readonly strength: number; readonly magic: number }

export interface DamageByStat { readonly strength: number; readonly magic: number; readonly fixed: number }

/** Item offensif (arme ou puce) décrit sans API : toute la donnée dont la table a besoin. */
export interface BookItem {
	/** Objet du jeu d'origine, rendu tel quel dans les combos (inutilisé par la table). */
	readonly ref?: ShotItem
	readonly isWeapon: boolean
	/** Dégâts moyens de base (sans statistique) de chaque feature DAMAGE ; leur somme = dégâts bruts à statistique 0. */
	readonly hits: readonly number[]
	readonly cost: number
	readonly minRange: number
	readonly maxRange: number
	readonly needsLos: boolean
	/** Motif de lancer (`LAUNCH_TYPE_*`) ; absent = tout permis. */
	readonly launchType?: number
	/** Lancers permis dans un tour (maxUses, et 1 pour une puce à cooldown de base) ; Infinity permis. */
	readonly uses: number
	readonly stat: ScaleStat
	/** Cooldown de base d'une puce en tours (0 : aucun) ; sert à la propagation des cooldowns, pas à la table. */
	readonly cooldown?: number
}

/**
 * Item du jeu vers `BookItem`, ou null (aucun dégât, coût ou portée invalides, aucun lancer permis) : mêmes exclusions
 * que `toCandidate`. Tous les dégâts sont supposés proportionnels à la force (comme `meanDamage`) : `stat` = "strength".
 */
export function bookItemOf(item: ShotItem, isChip: boolean): BookItem | null {
	const hits: number[] = []
	for (const feature of item.features ?? []) {
		if (feature.type === Effect.DAMAGE) {
			const mean = (feature.minValue + feature.maxValue) / 2
			if (mean > 0) hits.push(mean)
		}
	}
	const uses = isChip ? chipUsesOf(item as Chip) : maxUsesOf(item)
	if (hits.length === 0 || !Number.isInteger(item.cost) || item.cost <= 0 || uses <= 0 ||
		!Number.isFinite(item.minRange) || !Number.isFinite(item.maxRange)) return null
	return {
		ref: item, isWeapon: !isChip, hits, cost: item.cost, minRange: item.minRange, maxRange: item.maxRange,
		needsLos: item.needsLos, launchType: item.launchType, uses, stat: "strength",
		cooldown: isChip && Number.isFinite((item as Chip).cooldown) ? (item as Chip).cooldown : 0
	}
}

/** Alignement du tireur sur la cible : le motif de lancer distingue ligne, diagonale et autres cases. */
export const SHAPE = { LINE: 0, DIAGONAL: 1, OTHER: 2 } as const

export function shapeOf(dx: number, dy: number): number {
	return dx === 0 || dy === 0 ? SHAPE.LINE : Math.abs(dx) === Math.abs(dy) ? SHAPE.DIAGONAL : SHAPE.OTHER
}

export interface Combo {
	/** Indices (dans `book.items`) un par lancer : l'arme répétée par tir, puis les puces. */
	readonly items: readonly number[]
	/** Dégâts bruts (sans boucliers) par statistique. */
	readonly raw: DamageByStat
	/** Dégâts nets des boucliers de la cible : le critère de classement. */
	readonly total: number
	/** Nombre de features DAMAGE touchées (pour le bouclier absolu). */
	readonly hitCount: number
	/** PT dépensés, changement d'arme compris (1 PT si l'arme n'est pas en main). */
	readonly tp: number
	readonly weaponShots: number
	/** Portée utile du combo : intersection des portées (max des min, min des max) ; ligne de vue dès qu'un item la veut. */
	readonly minRange: number
	readonly maxRange: number
	readonly needsLos: boolean
}

const NO_DAMAGE: DamageByStat = { strength: 0, magic: 0, fixed: 0 }
export const EMPTY_COMBO: Combo = {
	items: [], raw: NO_DAMAGE, total: 0, hitCount: 0, tp: 0, weaponShots: 0, minRange: 0, maxRange: Infinity, needsLos: false
}

export interface BookQuery {
	/** Distance de Manhattan tireur-cible. */
	readonly distance: number
	readonly los: boolean
	/** `SHAPE` : voir `shapeOf`. */
	readonly shape: number
	/** PT disponibles (≤ `book.maxTp`, sinon la lecture se fait à `maxTp`). */
	readonly tp: number
	/** Items disponibles, un bit par indice d'item : armes toujours, puces sans cooldown (voir `CombatBook.maskOf`). */
	readonly mask: number
	/** Indice de l'arme en main, -1 si aucune. */
	readonly held: number
	/** Arme du combo : `ANY` (défaut, la meilleure, puces seules comprises), `NONE` (puces seules) ou un indice d'arme. */
	readonly weapon?: number
}

export const ANY = -2
export const NONE = -1

/** Boost de statistique : `turns` = tours restants (1 = actif ce tour seulement). */
export interface Boost { readonly stat: "strength" | "magic"; readonly value: number; readonly turns: number }

/** Facteur sur des dégâts à `stat` quand la statistique passe à `stat + boost` : (1 + (stat + boost)/100) / (1 + stat/100). */
export function boostFactor(stat: number, boost: number): number {
	return (1 + (stat + boost) / 100) / (1 + stat / 100)
}

/** Statistiques après les boosts encore actifs `offset` tours plus tard (0 = ce tour : actif si `turns` > `offset`). */
export function boostedStats(stats: Stats, boosts: readonly Boost[], offset = 0): Stats {
	let strength = stats.strength
	let magic = stats.magic
	for (const boost of boosts) {
		if (boost.turns <= offset) continue
		if (boost.stat === "strength") strength += boost.value
		else magic += boost.value
	}
	return { strength, magic }
}

interface State {
	readonly total: number
	readonly strength: number
	readonly magic: number
	readonly fixed: number
	readonly hitCount: number
	readonly shots: number
	readonly tp: number
	readonly items: readonly number[]
}

const EMPTY_STATE: State = { total: 0, strength: 0, magic: 0, fixed: 0, hitCount: 0, shots: 0, tp: 0, items: [] }
const STATS_KEY = (stats: Stats): string => `${stats.strength}|${stats.magic}`

function scaled(item: BookItem, stats: Stats): number {
	return item.stat === "strength" ? 1 + stats.strength / 100 : item.stat === "magic" ? 1 + stats.magic / 100 : 1
}

/** Dégâts bruts d'un item à `stats` (somme des features × (1 + statistique / 100)). */
function itemRaw(item: BookItem, stats: Stats): number {
	let base = 0
	for (const hit of item.hits) base += hit
	return base * scaled(item, stats)
}

/** Dégâts nets d'un item : par feature, bouclier relatif puis absolu, plancher à 0 (comme `netDamage`). */
function itemNet(item: BookItem, stats: Stats, shield: Shield): number {
	const factor = scaled(item, stats)
	const relative = Math.max(0, Math.min(100, shield.relative || 0))
	const absolute = Math.max(0, shield.absolute || 0)
	let net = 0
	for (const hit of item.hits) net += Math.max(0, hit * factor * (1 - relative / 100) - absolute)
	return net
}

export class CombatBook {
	readonly items: readonly BookItem[]
	readonly maxTp: number
	/** Clé d'invalidation des items et de `maxTp` : un livre construit avec une autre clé est périmé. */
	readonly key: string
	/** Plus grande portée max des items : au-delà, aucun combo. */
	readonly maxDistance: number
	/** Unités de travail comptées (itérations élémentaires), pour mesurer le coût de construction : pas des opérations du jeu. */
	work = 0
	private readonly classUsable: Int32Array
	private readonly weaponBits: number
	private readonly tables = new Map<string, CombatTable>()
	/** Tables construites depuis la création du livre (mesure). */
	tablesBuilt = 0

	constructor(items: readonly BookItem[], maxTp: number) {
		this.items = items
		this.maxTp = Math.max(0, Math.floor(maxTp))
		this.key = CombatBook.keyOf(items, this.maxTp)
		let maxDistance = 0
		let weaponBits = 0
		items.forEach((item, i) => {
			maxDistance = Math.max(maxDistance, item.maxRange)
			if (item.isWeapon) weaponBits |= 1 << i
		})
		this.maxDistance = maxDistance
		this.weaponBits = weaponBits
		// Classes (distance, ligne de vue, alignement) : seul compte l'ensemble des items utilisables, partagé entre classes.
		this.classUsable = new Int32Array((maxDistance + 1) * 2 * 3)
		for (let distance = 0; distance <= maxDistance; distance++) {
			for (let los = 0; los < 2; los++) {
				for (let shape = 0; shape < 3; shape++) {
					// Décalage représentatif : ligne (d, 0), diagonale (d/2, d/2), autre (d-1, 1) ; absent si impossible.
					const offset: [number, number] | null = shape === SHAPE.LINE ? [distance, 0] :
						shape === SHAPE.DIAGONAL ? (distance > 0 && distance % 2 === 0 ? [distance / 2, distance / 2] : null) :
						(distance >= 3 ? [distance - 1, 1] : null)
					let usable = 0
					if (offset !== null) {
						for (let i = 0; i < items.length; i++) {
							this.work++
							const item = items[i]!
							if (distance >= item.minRange && distance <= item.maxRange && (los === 1 || !item.needsLos) &&
								isCellInLaunchPattern(item.launchType, offset[0], offset[1])) usable |= 1 << i
						}
					}
					this.classUsable[(distance * 2 + los) * 3 + shape] = usable
				}
			}
		}
	}

	static keyOf(items: readonly BookItem[], maxTp: number): string {
		return `${maxTp}#` + items.map((item) => [
			item.isWeapon ? "W" : "C", item.hits.join("+"), item.cost, item.minRange, item.maxRange, item.needsLos ? 1 : 0,
			item.launchType ?? "-", item.uses, item.stat, item.cooldown ?? 0
		].join(",")).join(";")
	}

	/** Masque des items disponibles : toutes les armes, et les puces pour lesquelles `ready` répond vrai (pas de cooldown). */
	maskOf(ready: (item: BookItem, index: number) => boolean): number {
		let mask = this.weaponBits
		this.items.forEach((item, i) => { if (!item.isWeapon && ready(item, i)) mask |= 1 << i })
		return mask
	}

	/** Items utilisables dans la classe (distance, ligne de vue, alignement), avant le masque de disponibilité. */
	usableAt(distance: number, los: boolean, shape: number): number {
		return this.classUsable[(distance * 2 + (los ? 1 : 0)) * 3 + shape]!
	}

	/** Table pour cet état de statistiques (mémoïsée : construite à la première lecture, une fois par état). */
	at(stats: Stats, shield: Shield = NO_SHIELD): CombatTable {
		const key = `${STATS_KEY(stats)}|${shield.relative}|${shield.absolute}`
		let table = this.tables.get(key)
		if (table === undefined) {
			this.tables.set(key, table = new CombatTable(this, stats, shield))
			this.tablesBuilt++
		}
		return table
	}

	/** Lecture à statistiques actuelles (raccourci de `at(stats).read(query)`). */
	read(stats: Stats, query: BookQuery, shield: Shield = NO_SHIELD): Combo {
		return this.at(stats, shield).read(query)
	}

	/**
	 * Lecture avec boosts actifs `offset` tours plus tard. Si les boosts changent le facteur d'items de statistiques
	 * différentes (force contre magie ou dégâts fixes), ou si la cible a un bouclier absolu (net non proportionnel), le
	 * classement peut changer : la table de l'état virtuel est lue (construite une fois, mémoïsée). Sinon la table actuelle est lue et les dégâts reçoivent le facteur
	 * `boostFactor` de leur statistique ; `combo.raw` reste alors à statistiques actuelles, `raw` retourné est boosté.
	 */
	readBoosted(
		stats: Stats, boosts: readonly Boost[], query: BookQuery, offset = 0, shield: Shield = NO_SHIELD
	): { combo: Combo; raw: DamageByStat; net: number; rebuilt: boolean } {
		const virtual = boostedStats(stats, boosts, offset)
		if (virtual.strength === stats.strength && virtual.magic === stats.magic) {
			const combo = this.read(stats, query, shield)
			return { combo, raw: combo.raw, net: combo.total, rebuilt: false }
		}
		// Bouclier absolu : le net n'est plus proportionnel à la statistique, le facteur seul serait faux.
		if (shield.absolute > 0 || this.rankingMayChange(stats, virtual)) {
			const combo = this.read(virtual, query, shield)
			return { combo, raw: combo.raw, net: combo.total, rebuilt: true }
		}
		const combo = this.read(stats, query, shield)
		const strength = boostFactor(stats.strength, virtual.strength - stats.strength)
		const magic = boostFactor(stats.magic, virtual.magic - stats.magic)
		const first = combo.items.length > 0 ? this.items[combo.items[0]!]! : null
		const factor = first === null ? 1 : first.stat === "strength" ? strength : first.stat === "magic" ? magic : 1
		return {
			combo, rebuilt: false, net: combo.total * factor,
			raw: { strength: combo.raw.strength * strength, magic: combo.raw.magic * magic, fixed: combo.raw.fixed }
		}
	}

	/** Le classement des combos peut-il changer ? Oui si les items à dégâts n'ont pas tous le même facteur. */
	rankingMayChange(stats: Stats, virtual: Stats): boolean {
		let factor: number | null = null
		for (const item of this.items) {
			const f = item.stat === "strength" ? boostFactor(stats.strength, virtual.strength - stats.strength) :
				item.stat === "magic" ? boostFactor(stats.magic, virtual.magic - stats.magic) : 1
			if (factor === null) factor = f
			else if (Math.abs(f - factor) > 1e-9) return true
		}
		return false
	}

	/** Oublie les tables mémoïsées (changement d'items : construire plutôt un nouveau livre). */
	clear(): void { this.tables.clear() }

	/** Meilleur combo à `maxTp` budgets pour (items utilisables, arme en main, arme du combo) : tableau indexé par PT. */
	buildOption(stats: Stats, shield: Shield, usable: number, held: number, option: number): Array<State | null> {
		const { items, maxTp } = this
		const equip = option >= 0 && option !== held ? 1 : 0
		let states: Array<State | undefined> = new Array(maxTp + 1)
		// Combo à arme : seuls des états avec au moins un tir (un état sans arme au même coût exact masquerait le combo à arme).
		if (option < 0) states[0] = EMPTY_STATE
		else {
			const weapon = items[option]!
			const damage = itemNet(weapon, stats, shield)
			const raw = itemRaw(weapon, stats)
			const limit = Math.min(weapon.uses, Math.floor((maxTp - equip) / weapon.cost))
			for (let shots = 1; shots <= limit; shots++) {
				this.work++
				states[equip + shots * weapon.cost] = this.extend(EMPTY_STATE, weapon, damage, raw, option, shots, true, equip)
			}
		}
		for (let i = 0; i < items.length; i++) {
			const chip = items[i]!
			if (chip.isWeapon || (usable & (1 << i)) === 0) continue
			const damage = itemNet(chip, stats, shield)
			const raw = itemRaw(chip, stats)
			const casts = Math.min(chip.uses, Math.floor(maxTp / chip.cost))
			for (let cast = 0; cast < casts; cast++) {
				const next = states.slice()
				let improved = false
				for (let cost = 0; cost + chip.cost <= maxTp; cost++) {
					this.work++
					const state = states[cost]
					if (state === undefined) continue
					const total = state.total + damage
					if (total > (next[cost + chip.cost]?.total ?? -1)) {
						next[cost + chip.cost] = this.extend(state, chip, damage, raw, i, 1, false)
						improved = true
					}
				}
				if (!improved) break
				states = next
			}
		}
		// Meilleur état de coût ≤ T (le moins de PT à total égal) ; un combo à arme exige au moins un tir.
		const best: Array<State | null> = []
		let current: State | null = null
		for (let cost = 0; cost <= maxTp; cost++) {
			this.work++
			const state = states[cost]
			if (state !== undefined && state.total > 0 && (option < 0 || state.shots > 0) &&
				(current === null || state.total > current.total)) current = state
			best.push(current)
		}
		return best
	}

	private extend(
		base: State, item: BookItem, damage: number, raw: number, index: number, count: number, weapon = true, equip = 0
	): State {
		const items = base.items.slice()
		for (let n = 0; n < count; n++) items.push(index)
		return {
			total: base.total + damage * count,
			strength: base.strength + (item.stat === "strength" ? raw * count : 0),
			magic: base.magic + (item.stat === "magic" ? raw * count : 0),
			fixed: base.fixed + (item.stat === "fixed" ? raw * count : 0),
			hitCount: base.hitCount + item.hits.length * count,
			shots: base.shots + (weapon ? count : 0),
			tp: base.tp + item.cost * count + equip,
			items
		}
	}

	comboOf(state: State | null): Combo {
		if (state === null) return EMPTY_COMBO
		let minRange = 0
		let maxRange = Infinity
		let needsLos = false
		for (const index of state.items) {
			const item = this.items[index]!
			minRange = Math.max(minRange, item.minRange)
			maxRange = Math.min(maxRange, item.maxRange)
			needsLos ||= item.needsLos
		}
		return {
			items: state.items, raw: { strength: state.strength, magic: state.magic, fixed: state.fixed },
			total: state.total, hitCount: state.hitCount, tp: state.tp, weaponShots: state.shots,
			minRange, maxRange, needsLos
		}
	}
}

/** Lecture par index pour un état de statistiques. */
export class CombatTable {
	private readonly cache = new Map<number, Array<Combo>>()

	constructor(private readonly book: CombatBook, readonly stats: Stats, readonly shield: Shield) {}

	read(query: BookQuery): Combo {
		const book = this.book
		const distance = query.distance
		if (!(distance >= 0 && distance <= book.maxDistance) || !(query.tp > 0)) return EMPTY_COMBO
		const tp = Math.min(Math.floor(query.tp), book.maxTp)
		const usable = book.usableAt(distance, query.los, query.shape) & query.mask
		const option = query.weapon ?? ANY
		const key = ((usable * 16 + query.held + 1) * 16) + option + 2
		let row = this.cache.get(key)
		if (row === undefined) this.cache.set(key, row = this.build(usable, query.held, option))
		return row[tp]!
	}

	private build(usable: number, held: number, option: number): Combo[] {
		const book = this.book
		const options: number[] = option === ANY ? [NONE] : [option]
		if (option === ANY) book.items.forEach((item, i) => { if (item.isWeapon && (usable & (1 << i)) !== 0) options.push(i) })
		else if (option >= 0 && (usable & (1 << option)) === 0) return new Array(book.maxTp + 1).fill(EMPTY_COMBO)
		const vectors = options.map((o) => book.buildOption(this.stats, this.shield, usable, held, o))
		const row: Combo[] = []
		for (let tp = 0; tp <= book.maxTp; tp++) {
			let best: State | null = null
			for (const vector of vectors) {
				const state = vector[tp]!
				if (state !== null && (best === null || state.total > best.total)) best = state
			}
			row.push(book.comboOf(best))
		}
		return row
	}
}
