// @version:5.8
// file version: 2
import { EnemyHit, EnemyProfile } from "./EnemyProfile.js"

/** Multiplicateur de coup critique : constante officielle CRITICAL_FACTOR = 1.3. */
export const CRITICAL_FACTOR = 1.3

/** Marge (en PV) sur les bornes de dégâts pour l'arrondi du moteur. */
export const DAMAGE_TOLERANCE = 1

type Item = Weapon | Chip

export interface EnemyUpdate {
	/** Noms des armes/puces vues pour la première fois pendant cet appel. */
	newItems: string[]
	/** Dernier coup journalisé pendant cet appel (null si aucun). */
	hit: EnemyHit | null
}

/**
 * Mémoire de l'adversaire : collecte de données uniquement, aucune décision tactique.
 * Les dégâts instantanés (arme, caillou, foudre) n'apparaissent pas dans les effets : l'attribution
 * des coups est une heuristique (voir docs/strategies.md, « Mémoire de l'adversaire »).
 */
export class EnemyMemory {
	private readonly profiles = new Map<number, EnemyProfile>()
	private lastLife: number | null = null
	private lastLifeTurn = 0

	has(enemyId: number): boolean {
		return this.profiles.has(enemyId)
	}

	/** Premier contact : instantané de l'ennemi (sans effet si déjà connu). */
	identify(entity: Entity, turn: number): EnemyProfile {
		const existing = this.profiles.get(entity.id)
		if (existing !== undefined) {
			return existing
		}
		const profile = new EnemyProfile(entity, turn)
		this.profiles.set(entity.id, profile)
		return profile
	}

	/**
	 * À appeler au début de MON tour, avant de planifier. `aliveEnemies` > 1 empêche d'attribuer
	 * une perte de PV à un ennemi précis (elle est alors journalisée « ambiguous »).
	 */
	update(entity: Entity, me: Me, turn: number, aliveEnemies = 1): EnemyUpdate | null {
		const profile = this.profiles.get(entity.id)
		if (profile === undefined) {
			return null
		}
		const result: EnemyUpdate = { newItems: [], hit: null }

		profile.advanceTo(turn)
		profile.maxTpSeen = Math.max(profile.maxTpSeen, entity.tp ?? 0)

		const weapon = entity.weapon ?? null
		if (weapon !== null) {
			const changed = profile.equippedWeapon?.id !== weapon.id
			if (profile.observeWeapon(weapon, turn, changed)) {
				result.newItems.push(weapon.name)
			}
		}
		profile.equippedWeapon = weapon

		// Usages détectés d'abord (sans toucher aux cooldowns), pour que les candidats de l'inférence
		// de dégâts soient jugés sur les cooldowns d'avant cet appel.
		const uses = this.collectUses(profile, entity, me, turn)
		result.hit = this.attributeDamage(profile, entity, me, turn, aliveEnemies)

		for (const item of uses) {
			if (isChipItem(item)) {
				if (profile.observeChip(item, turn)) {
					result.newItems.push(item.name)
				}
				profile.startCooldown(item)
			} else if (profile.observeWeapon(item, turn, true)) {
				result.newItems.push(item.name)
			}
		}
		return result
	}

	/** À appeler à la fin de MON tour : référence de PV pour mesurer ce que l'ennemi m'inflige ensuite. */
	endMyTurn(me: Me, turn: number): void {
		this.lastLife = me.life
		this.lastLifeTurn = turn
	}

	getProfile(enemyId: number): EnemyProfile | null {
		return this.profiles.get(enemyId) ?? null
	}

	/** Armes connues (liste initiale + observées). */
	knownWeapons(enemyId: number): readonly Weapon[] {
		return this.profiles.get(enemyId)?.knownWeapons ?? []
	}

	observedWeapons(enemyId: number): Weapon[] {
		const profile = this.profiles.get(enemyId)
		return profile === undefined ? [] : [...profile.observedWeapons.values()].map((seen) => seen.item)
	}

	observedChips(enemyId: number): Chip[] {
		const profile = this.profiles.get(enemyId)
		return profile === undefined ? [] : [...profile.observedChips.values()].map((seen) => seen.item)
	}

	/** Portée max parmi les armes connues (0 si ennemi ou armes inconnus). */
	maxKnownWeaponRange(enemyId: number): number {
		let range = 0
		for (const weapon of this.knownWeapons(enemyId)) {
			range = Math.max(range, weapon.maxRange)
		}
		return range
	}

	/** Cooldown restant estimé d'une puce de l'ennemi (0 si inconnu ou prête). */
	getCooldown(enemyId: number, chip: Chip): number {
		return this.profiles.get(enemyId)?.getCooldown(chip) ?? 0
	}

	isChipReady(enemyId: number, chip: Chip): boolean {
		return this.getCooldown(enemyId, chip) === 0
	}

	private collectUses(profile: EnemyProfile, entity: Entity, me: Me, turn: number): Item[] {
		// Effets regroupés par « item:cible » pour cet appel, en gardant la plus grande durée restante :
		// un item posant plusieurs effets de durées différentes n'est ainsi évalué qu'une fois.
		const grouped = new Map<string, { item: Item, itemKey: string, turns: number }>()
		const consider = (effect: Effect): void => {
			const item = resolveItem(profile, effect.item)
			if (item === null) {
				return
			}
			const itemKey = `${isChipItem(item) ? "chip" : "weapon"}:${item.id}`
			const key = `${itemKey}:${idOf(effect.target) ?? -1}`
			const current = grouped.get(key)
			if (current === undefined) {
				grouped.set(key, { item, itemKey, turns: effect.turns })
			} else {
				// Math.max : une durée finie l'emporte sur une durée permanente (< 0)
				current.turns = Math.max(current.turns, effect.turns)
			}
		}
		for (const effect of entity.launchedEffects ?? []) {
			consider(effect)
		}
		for (const effect of me.effects ?? []) {
			if (idOf(effect.caster) === entity.id) {
				consider(effect)
			}
		}

		const found = new Map<string, Item>()
		for (const [key, group] of grouped) {
			if (isNewEffect(profile, key, turn, group.turns)) {
				found.set(group.itemKey, group.item)
			}
		}
		return [...found.values()]
	}

	private attributeDamage(
		profile: EnemyProfile,
		entity: Entity,
		me: Me,
		turn: number,
		aliveEnemies: number
	): EnemyHit | null {
		if (this.lastLife === null) {
			return null
		}
		const elapsed = Math.max(1, turn - this.lastLifeTurn)
		let loss = this.lastLife - me.life
		let reported: EnemyHit | null = null

		// Dégâts sur la durée lancés par cet ennemi : lus sur l'effet (supposés appliqués une fois par tour).
		for (const effect of me.effects ?? []) {
			if (idOf(effect.caster) !== entity.id || (effect.type !== Effect.DAMAGE && effect.type !== Effect.POISON)) {
				continue
			}
			reported = { turn, amount: effect.value, item: resolveItem(profile, effect.item), source: "effect" }
			profile.addHit(reported)
			loss -= effect.value
		}
		if (loss <= 0) {
			return reported
		}

		let item: Item | null = null
		if (aliveEnemies <= 1) {
			const strength = entity.strength ?? 0
			const compatible: Item[] = []
			if (entity.weapon !== null && entity.weapon !== undefined &&
				isCompatible(entity.weapon, loss, strength, profile.maxTpSeen, elapsed)) {
				compatible.push(entity.weapon)
			}
			for (const chip of profile.knownChips) {
				if (profile.isChipReady(chip) && isCompatible(chip, loss, strength, profile.maxTpSeen, elapsed)) {
					compatible.push(chip)
				}
			}
			item = compatible.length === 1 ? (compatible[0] ?? null) : null
		}
		reported = { turn, amount: loss, item, source: item === null ? "ambiguous" : "inferred" }
		profile.addHit(reported)
		return reported
	}
}

function isChipItem(item: Item): item is Chip {
	return "cooldown" in item || "currentCooldown" in item
}

/** Id d'une entité/item donné soit par un objet soit par un id numérique (forme non précisée par la doc). */
function idOf(value: Entity | Item | number | null | undefined): number | null {
	if (value === null || value === undefined) {
		return null
	}
	return typeof value === "number" ? value : value.id
}

/**
 * Objet fourni : utilisé tel quel. Id numérique : retrouvé parmi les armes/puces connues de l'ennemi,
 * seulement si un unique item correspond (les espaces d'ids armes/puces peuvent se recouvrir).
 */
function resolveItem(profile: EnemyProfile, raw: Item | number | null | undefined): Item | null {
	if (raw === null || raw === undefined) {
		return null
	}
	if (typeof raw === "object") {
		return raw
	}
	const chips = profile.knownChips.filter((chip) => chip.id === raw)
	const weapons = profile.knownWeapons.filter((weapon) => weapon.id === raw)
	return chips.length + weapons.length === 1 ? (chips[0] ?? weapons[0] ?? null) : null
}

/**
 * Un effet déjà vu et toujours actif n'est pas un nouvel usage. Nouvel usage si : jamais vu,
 * ou expiré depuis, ou durée restante supérieure à celle attendue (relancé). Effet permanent (turns < 0) : une seule fois.
 * `turns` est la plus grande durée restante des effets de l'item sur cette cible dans l'appel courant.
 */
function isNewEffect(profile: EnemyProfile, key: string, turn: number, turns: number): boolean {
	const previous = profile.effectSeen.get(key)
	profile.effectSeen.set(key, { turn, turns })
	if (previous === undefined) {
		return true
	}
	if (turns < 0 || previous.turns < 0) {
		return false
	}
	const expected = previous.turns - (turn - previous.turn)
	return expected <= 0 || turns > expected
}

function baseDamage(item: Item): { min: number, max: number } {
	let min = 0
	let max = 0
	for (const feature of item.features) {
		if (feature.type === Effect.DAMAGE) {
			min += feature.minValue
			max += feature.maxValue
		}
	}
	return { min, max }
}

/**
 * Plage de dégâts plausible : min = valeur min × (1 + force/100) pour 1 utilisation sans critique ;
 * max = valeur max × (1 + force/100) × CRITICAL_FACTOR × utilisations × tours écoulés.
 * Utilisations par tour : floor(PT max vus / coût) pour une arme ; 1 pour une puce à cooldown.
 * Les boucliers réduisent les dégâts reçus et peuvent faire sortir la perte observée de la plage.
 */
function isCompatible(item: Item, amount: number, strength: number, tpBudget: number, elapsedTurns: number): boolean {
	const base = baseDamage(item)
	if (base.max <= 0) {
		return false
	}
	const scale = 1 + strength / 100
	const limitedByCooldown = isChipItem(item) && (item.cooldown ?? 0) !== 0
	const usesPerTurn = limitedByCooldown ? 1 : Math.max(1, Math.floor(tpBudget / Math.max(1, item.cost)))
	const min = base.min * scale
	const max = base.max * scale * CRITICAL_FACTOR * usesPerTurn * elapsedTurns
	return amount + DAMAGE_TOLERANCE >= min && amount - DAMAGE_TOLERANCE <= max
}
