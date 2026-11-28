// @version:5.8
// file version: 2
import {
	agilityBoostOf, agilityBoostTurns, isAgilityBoostType, isMpBoostType, isStrengthBoostType, isTpBoostType, mpBoostOf, mpBoostTurns,
	strengthBoostOf, strengthBoostTurns, tpBoostOf, tpBoostTurns
} from "../Context/ShotPlan.js"
import { CombatBook, bookItemOf } from "./CombatBook.js"
import { validCost } from "./TacticalTypes.js"

/** Boost actif sur moi : `turns` = tours restants, le tour courant compte (1 = dernier tour). */
export interface Buff { readonly stat: "strength" | "tp" | "agility" | "mp"; readonly value: number; readonly turns: number }

export interface BoostItem {
	readonly chip: Chip
	readonly stat: Buff["stat"]
	/** Force, PT ou PM (par tour d'effet, entiers) ou agilité ajoutés. */
	readonly gain: number
	/** Durée de l'effet en tours, le tour du lancer compris : PARAMÈTRE non vérifié en combat (`docs/strategies.md`, « Limites connues »). */
	readonly turns: number
	readonly cost: number
}

export interface SupportItem {
	readonly chip: Chip
	readonly cost: number
	/** Soin moyen × (1 + sagesse / 100). */
	readonly heal: number
	readonly absolute: number
	readonly relative: number
	readonly heals: boolean
	readonly shields: boolean
}

export interface Catalog {
	readonly book: CombatBook
	/** Toutes mes puces (sans doublon) : l'indice sert aux tableaux de cooldowns. */
	readonly chips: readonly Chip[]
	readonly chipIndex: ReadonlyMap<Chip, number>
	readonly boosts: readonly BoostItem[]
	readonly supports: readonly SupportItem[]
	/** Statistiques SANS les boosts actifs, et les boosts actifs à part (ils expirent). */
	readonly base: { readonly strength: number; readonly magic: number; readonly agility: number; readonly tp: number; readonly mp: number }
	readonly buffs: readonly Buff[]
}

function featureMean(chip: Chip, type: number): number {
	let value = 0
	for (const feature of chip.features) if (feature.type === type) value += (feature.minValue + feature.maxValue) / 2
	return Math.max(0, value)
}

let cached: { refs: readonly (Weapon | Chip)[]; book: CombatBook } | null = null

/** Plafond de PT de la table : PT du tour + meilleur boost de PT, arrondi à 5, au plus 30 (`TACTICAL_LIMITS.tp`). */
function bookTp(me: Me, tpGain: number): number {
	return Math.min(30, Math.ceil(Math.max(1, me.tp + tpGain) / 5) * 5)
}

/** Livre du combat : reconstruit seulement si les armes, les puces ou le plafond de PT changent. */
export function bookFor(me: Me, tpGain = 0): CombatBook {
	const refs = [...new Set([...(me.weapon ? [me.weapon] : []), ...me.weapons, ...me.chips])]
	const need = Math.min(30, Math.max(1, me.tp + tpGain))
	if (cached !== null && cached.book.maxTp >= need && cached.refs.length === refs.length &&
		cached.refs.every((ref, i) => ref === refs[i])) return cached.book
	const weapons = new Set<Weapon | Chip>([...(me.weapon ? [me.weapon] : []), ...me.weapons])
	const items = refs.map((ref) => ({ ref, item: validCost(ref.cost) ? bookItemOf(ref, !weapons.has(ref)) : null }))
		.filter((entry) => entry.item !== null)
	const book = new CombatBook(items.map((entry) => entry.item!), bookTp(me, tpGain))
	cached = { refs, book }
	return book
}

/** Oublie le livre (tests ; un nouveau combat repart d'un module neuf). */
export function resetBookCache(): void { cached = null }

/** Inventaire du tour : le livre d'attaque, les boosts, les puces de soin et de bouclier, et les boosts déjà actifs. */
export function catalogFor(me: Me): Catalog {
	const chips = [...new Set(me.chips)]
	const science = Number.isFinite(me.science) ? me.science : 0
	const boosts: BoostItem[] = []
	const supports: SupportItem[] = []
	let bestTp = 0
	for (const chip of chips) {
		if (!validCost(chip.cost)) continue
		const strength = strengthBoostOf(chip, science)
		const tp = tpBoostOf(chip, science)
		const agility = agilityBoostOf(chip, science)
		if (strength > 0) boosts.push({ chip, stat: "strength", gain: strength, turns: Math.max(1, strengthBoostTurns(chip)), cost: chip.cost })
		if (tp > 0) {
			boosts.push({ chip, stat: "tp", gain: Math.floor(tp), turns: Math.max(1, tpBoostTurns(chip)), cost: chip.cost })
			bestTp = Math.max(bestTp, Math.floor(tp))
		}
		const mp = Math.floor(mpBoostOf(chip, science))
		if (mp >= 1) boosts.push({ chip, stat: "mp", gain: mp, turns: Math.max(1, mpBoostTurns(chip)), cost: chip.cost })
		if (agility > 0) boosts.push({ chip, stat: "agility", gain: agility, turns: Math.max(1, agilityBoostTurns(chip)), cost: chip.cost })
		const heal = featureMean(chip, Effect.HEAL)
		const absolute = featureMean(chip, Effect.ABSOLUTE_SHIELD)
		const relative = featureMean(chip, Effect.RELATIVE_SHIELD)
		const heals = chip.features.some((feature) => feature.type === Effect.HEAL)
		const shields = chip.features.some((feature) => feature.type === Effect.ABSOLUTE_SHIELD || feature.type === Effect.RELATIVE_SHIELD)
		if (chip.features.length > 0 && (heals || shields) && chip.features.every((feature) =>
			feature.type === Effect.HEAL || feature.type === Effect.ABSOLUTE_SHIELD || feature.type === Effect.RELATIVE_SHIELD)) {
			supports.push({
				chip, cost: chip.cost, heal: heal * (1 + (me.wisdom || 0) / 100), absolute, relative: Math.min(100, relative), heals, shields
			})
		}
	}
	const buffs: Buff[] = []
	const removed = { strength: 0, tp: 0, agility: 0, mp: 0 }
	for (const effect of me.effects ?? []) {
		if (!(effect.turns > 0)) continue
		const stat = isStrengthBoostType(effect.type) ? "strength" : isTpBoostType(effect.type) ? "tp" :
			isAgilityBoostType(effect.type) ? "agility" : isMpBoostType(effect.type) ? "mp" : null
		if (stat === null) continue
		buffs.push({ stat, value: effect.value, turns: effect.turns })
		removed[stat] += effect.value
	}
	return {
		book: bookFor(me, bestTp), chips, chipIndex: new Map(chips.map((chip, i) => [chip, i])), boosts, supports,
		base: {
			strength: Math.max(0, me.strength - removed.strength), magic: me.magic || 0,
			agility: Math.max(0, (me.agility || 0) - removed.agility), tp: Math.max(0, me.tp - removed.tp),
			mp: Math.max(0, me.mp - removed.mp)
		},
		buffs
	}
}
