// @version:5.8
// file version: 1
import { log, LOG_CONTEXT } from "../../Toolbox/Logger.js"

/** Tours conservés : la décision ne lit que le dernier tour (voir `StagnationTracker.observe`), le reste sert au diagnostic. */
export const HISTORY_TURNS = 8

/**
 * Libellé d'une action : `move`, `equip`, ou l'arme / la puce elle-même (ou une fonction), dont le nom n'est lu que
 * si la ligne `[History]` est réellement émise.
 */
export type ActionLabel = string | { readonly name: string } | (() => string)

/** Une action réellement exécutée (appel natif fait), dans l'ordre d'exécution. */
export interface ActionRecord {
	readonly action: ActionLabel
	/**
	 * Retour natif brut de l'appel. `useWeapon` / `useChip` : 2 critique, 1 succès, 0 échec, négatif = refus
	 * (-1 cible, -2 PT, -3 délai, -4 position, -7 utilisations max ; constantes `USE_*` du générateur officiel,
	 * `Attack.java`). `moveToward` / `moveAwayFrom` : PM utilisés. `setWeapon` : booléen.
	 */
	readonly result: unknown
	/** PV perdus par la cible entre juste avant et juste après l'appel ; null si non mesurable (pas de cible ennemie). */
	readonly damage: number | null
}

/** Un de mes tours. `tp` / `mp` : disponibles (début du tour + gains pendant le tour) ; restant = disponible − utilisé. */
export interface TurnRecord {
	readonly turn: number
	tp: number
	tpUsed: number
	mp: number
	mpUsed: number
	/** Dégâts infligés par MES actions de ce tour (somme des `damage`) : ni poison différé, ni allié, ni zone d'effet. */
	dealt: number
	/** PV perdus depuis la fin de mon tour précédent (net des soins reçus entre-temps). */
	readonly taken: number
	/** Tours passifs vus au début de ce tour (valeur utilisée par le plan de ce tour). */
	readonly passive: number
	readonly actions: ActionRecord[]
}

/**
 * Historique de ce que mon poireau a réellement fait, par tour, mesuré AUTOUR de chaque appel natif (`track`).
 * C'est la source de la passivité : un tour est actif si une de ses actions a fait perdre des PV à sa cible
 * (`dealt > 0`), quel que soit le soin adverse ensuite. Hors d'un tour ouvert (`begin`), `track` ne fait qu'appeler.
 */
export class ActionHistory {
	private readonly turns: TurnRecord[] = []
	private current: TurnRecord | null = null

	/** Tours conservés, du plus ancien au plus récent (`HISTORY_TURNS` au plus). */
	get records(): readonly TurnRecord[] { return this.turns }

	/** Dégâts infligés par mes actions pendant le dernier tour enregistré (0 sans historique). */
	get lastDealt(): number { return this.turns[this.turns.length - 1]?.dealt ?? 0 }

	/** Ouvre le tour : à appeler après les observations de début de tour, avant la première action. */
	begin(turn: number, me: Me, taken: number, passive: number): void {
		this.current = { turn, tp: me.tp, tpUsed: 0, mp: me.mp, mpUsed: 0, dealt: 0, taken, passive, actions: [] }
		this.turns.push(this.current)
		if (this.turns.length > HISTORY_TURNS) this.turns.shift()
	}

	/** Exécute `call` (l'appel natif) et l'enregistre : retour, PT/PM dépensés, PV perdus par `target` (ennemi) s'il y en a un. */
	track<T>(me: Me, action: ActionLabel, target: Entity | null, call: () => T): T {
		const record = this.current
		if (record === null) return call()
		const tp = me.tp, mp = me.mp
		const life = target !== null && target.id !== me.id ? target.life : null
		const result = call()
		const damage = life === null ? null : Math.max(0, life - target!.life)
		const tpSpent = tp - me.tp, mpSpent = mp - me.mp
		if (tpSpent > 0) record.tpUsed += tpSpent; else record.tp -= tpSpent
		if (mpSpent > 0) record.mpUsed += mpSpent; else record.mp -= mpSpent
		if (damage !== null) record.dealt += damage
		record.actions.push({ action, result, damage })
		return result
	}

	/** Ferme le tour et émet sa ligne `[History]` (contexte COMBAT). */
	end(): void {
		const record = this.current
		if (record === null) return
		this.current = null
		log(() => formatHistoryLine(record), LOG_CONTEXT.COMBAT)
	}
}

/**
 * `[History] T<tour> TP <utilisés>/<disponibles> MP <utilisés>/<disponibles> dealt <n> taken <n> passive <n> | ` puis
 * `<action>:<résultat>:<dégâts>` séparés par `; ` (`-` : dégâts non mesurables, `?` : appel sans retour). Sans action,
 * la ligne se termine par `|`.
 */
export function formatHistoryLine(record: TurnRecord): string {
	const actions = record.actions.map(({ action, result, damage }) =>
		`${typeof action === "string" ? action : typeof action === "function" ? action() : action.name}:${result === undefined || result === null ? "?" : String(result)}:${damage === null ? "-" : damage}`)
	return `[History] T${record.turn} TP ${record.tpUsed}/${record.tp} MP ${record.mpUsed}/${record.mp} ` +
		`dealt ${record.dealt} taken ${record.taken} passive ${record.passive} |` +
		(actions.length ? ` ${actions.join("; ")}` : "")
}

/** Historique du combat, partagé par les trois exécuteurs (plan conjoint, plan B, file historique). */
export const actionHistory = new ActionHistory()

/** Raccourci des exécuteurs : `track(me, "move", null, () => me.moveToward(cell, cost))`, `track(me, chip, target, ...)`. */
export function track<T>(me: Me, action: ActionLabel, target: Entity | null, call: () => T): T {
	return actionHistory.track(me, action, target, call)
}
