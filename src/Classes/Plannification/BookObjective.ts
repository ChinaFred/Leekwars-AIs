// @version:5.8
// file version: 3

/**
 * Ce que le faisceau retient d'UN tour simulé (l'état « feuille » noté) : tout est déjà plafonné et net des boucliers
 * de la cible. Un objectif n'en fait qu'un nombre ; la survie n'est PAS un poids : `BookBeam.ts` ajoute la pénalité létale
 * (`LETHAL_PENALTY`) quel que soit l'objectif.
 */
export interface TurnOutcome {
	/** Dégâts utiles infligés à la cible (net des boucliers, critiques espérés, plafonnés par ses PV). */
	readonly damage: number
	/** Soin crédité : au plus mes PV manquants. */
	readonly heal: number
	/** Danger évité par les boucliers de ce tour : min(danger, A + danger × R / 100). */
	readonly shield: number
	/** Danger de la case finale après boucliers ; 0 si le tour tue le dernier ennemi. */
	readonly exposed: number
	/** Distance de Manhattan gagnée vers l'ennemi vivant le plus proche (négative si je recule). */
	readonly progress: number
	readonly kills: boolean
	readonly won: boolean
	readonly tpSpent: number
	readonly boostsCast: number
}

export interface BookObjective {
	readonly name: string
	/** Valeur d'un tour : plus grand = meilleur. */
	score(outcome: TurnOutcome): number
}

/** `kill` : prime en part des dégâts d'un tour qui tue la cible (un mort ne frappe plus ; sans elle, 40 sur un ennemi à 1000 PV battrait 30 pour tuer). */
interface Weights { damage: number; heal: number; shield: number; exposed: number; progress: number; kill: number }

/** Poids du progrès sans tir (comme `a` du plan conjoint) : seulement quand le tour n'inflige rien. Non calibré. */
export const PROGRESS_WEIGHT = 1.25

function weighted(name: string, w: Weights): BookObjective {
	return {
		name,
		score: (o) => w.damage * o.damage + w.heal * o.heal + w.shield * o.shield - w.exposed * o.exposed + (o.kills ? w.kill * o.damage : 0) +
			(o.damage > 0 ? 0 : w.progress * o.progress)
	}
}

/** Profils interchangeables (valeurs heuristiques, non calibrées en combat). Le profil par défaut est `damage`. */
export const OBJECTIVES: Readonly<Record<"damage" | "heal" | "support" | "survival", BookObjective>> = {
	damage: weighted("damage", { damage: 1, heal: 0.5, shield: 0, exposed: 0.5, progress: PROGRESS_WEIGHT, kill: 0.5 }),
	heal: weighted("heal", { damage: 0.2, heal: 1, shield: 0.3, exposed: 0.5, progress: 0.2, kill: 0.2 }),
	support: weighted("support", { damage: 0.3, heal: 0.6, shield: 0.6, exposed: 0.5, progress: 0.2, kill: 0.2 }),
	survival: weighted("survival", { damage: 0.2, heal: 1, shield: 0.5, exposed: 2, progress: 0, kill: 0.5 })
}

/** Poids à agressivité 0 (prudent : se soigne, se protège, pèse le danger) et 100 (ardent : va au contact et frappe). Non calibrés. */
const PRUDENT: Weights = { damage: 0.8, heal: 1, shield: 0.4, exposed: 1.2, progress: 0.4, kill: 0.3 }
const ARDENT: Weights = { damage: 1.2, heal: 0.1, shield: 0, exposed: 0.2, progress: 2.5, kill: 0.7 }
const BASE: Weights = { damage: 1, heal: 0.5, shield: 0, exposed: 0.5, progress: PROGRESS_WEIGHT, kill: 0.5 }

/**
 * Objectif du livre pour une agressivité de 0 à 100 : c'est elle qui départage les scénarios retenus. Peu agressif :
 * soin et bouclier valent plus, le danger exposé pèse plus, l'approche sans tir presque rien. Très agressif : les
 * dégâts, la mise à mort et l'approche priment, soin et bouclier ne servent plus que s'ils évitent la mort (la pénalité
 * létale de `BookBeam.ts` ne dépend pas de l'agressivité). 50 = `OBJECTIVES.damage`.
 */
export function objectiveFor(aggression: number): BookObjective {
	const a = Math.max(0, Math.min(100, aggression))
	const [from, to, t] = a <= 50 ? [PRUDENT, BASE, a / 50] : [BASE, ARDENT, (a - 50) / 50]
	const mix = (key: keyof Weights): number => from[key] + (to[key] - from[key]) * t
	return weighted(`aggression ${a}`, { damage: mix("damage"), heal: mix("heal"), shield: mix("shield"),
		exposed: mix("exposed"), progress: mix("progress"), kill: mix("kill") })
}

