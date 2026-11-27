// @version:5.8
// file version: 10
import { log, LOG_CONTEXT } from "../../Toolbox/Logger.js"

/**
 * Nombre de tours consécutifs sans progrès réel à partir duquel la sortie de stagnation s'applique.
 * 2 : un seul tour d'attente isolé (tour de boost, ennemi qui bouge) n'est pas une stagnation ; au deuxième tour
 * sans progrès, la situation est la même et la décision est déterministe, donc un troisième tour identique
 * n'apporterait rien. Perdre 2 tours d'un combat de 64 tours reste négligeable.
 * Combat 54940819 : 53 tours d'immobilité (T12 à T64) faute de cette règle.
 */
export const STAGNATION_TURNS = 2

/**
 * Passivité : nombre de tours sans dégât infligé par mes actions pendant lesquels le risque garde son poids plein, puis part du poids
 * retirée à chaque tour passif de plus (2 et 0,5 : plein jusqu'à 2 tours, moitié au 3e, nul au 4e). Points de départ
 * choisis sur les combats 54944456, 54944868 et 54946689 (refus de combat), non calibrés en combat.
 */
export const PASSIVE_TURNS_AT_FULL_RISK = 2
export const PASSIVE_RISK_STEP = 0.5

/**
 * Compteur de tours consécutifs SANS PROGRÈS RÉEL. Mémorisé entre les tours par `TurnObservation.ts` (même mécanisme
 * que `enemyMemory`) et lu par le planificateur via `TacticalContext`.
 *
 * Définition : un tour est sans progrès s'il n'a ni infligé de dégâts (la somme des PV ennemis vivants n'a pas
 * baissé) ni établi un NOUVEAU RECORD de proximité, c'est-à-dire une distance de Manhattan à l'ennemi le plus proche
 * strictement inférieure au minimum atteint depuis le dernier dégât. Le record compte que ce soit moi qui avance ou
 * l'ennemi qui s'approche. Conséquences : rester immobile, ou osciller A → B → A → B (même entre 2 ou 3 cases), sans
 * jamais battre le record, est de la stagnation ; une approche normale bat le record à chaque tour ; un déplacement de
 * sortie de stagnation qui ne bat pas le record ne remet rien à zéro (le détour peut durer plusieurs tours).
 * Remise à zéro : dégâts infligés, nouveau record, ou tir RÉEL prévu par le planificateur normal (`noteOffense`) : une
 * offensive seulement « disponible » mais jamais jouée (danger trop élevé) ne remet RIEN à zéro.
 *
 * Garantie (combat 54940819, mesures du Testeur) : la sortie n'agit que si le plan normal est bloqué (ni tir ni
 * déplacement) ou si une sortie est déjà engagée (`commit`, `escaping`) ; sinon le plan normal est exécuté tel quel,
 * donc la règle ne retarde jamais un tir par rapport à la règle désactivée.
 *
 * Épisode : de la première sortie engagée jusqu'à un dégât, un record de proximité, un tir réel prévu ou un mouvement
 * des ennemis. Pendant tout l'épisode, les cases de départ (dont la case de stagnation d'origine) et d'arrivée des
 * sorties sont mémorisées : ni la sortie ni le plan normal ne peuvent s'y déplacer (anti-oscillation 187 → 133 → 187),
 * sauf un tir réel ou un record, qui terminent l'épisode. Limite acceptée : contre un ennemi qui alterne immobilité et
 * déplacement, la garantie « jamais plus lent » n'est pas démontrée (voir `docs/strategies.md`).
 *
 * Limite : la distance de Manhattan ignore les murs ; une route qui s'éloigne à vol d'oiseau n'est donc jamais un
 * « progrès » ici, ce qui est voulu (c'est précisément le minimum local à quitter par la distance de marche).
 */
export class StagnationTracker {
	private turnSeen = -1
	private enemyLifeSeen: number | null = null
	private record = Number.POSITIVE_INFINITY
	private count = 0
	private engaged = false
	/** Cases de départ et d'arrivée des sorties depuis le dernier dégât/record/tir : jamais re-choisies comme destination. */
	private readonly visitedCells = new Set<string>()
	private enemyKeySeen: string | null = null
	private pendingKey: string | undefined = undefined
	private stillTurns = 0
	private passive = 0
	private closest = Number.POSITIVE_INFINITY
	private enemyCountSeen = 0

	/** Positions des ennemis vivants (clé), à fournir juste avant `observe` du même tour. */
	noteEnemyPositions(key: string): void { this.pendingKey = key }

	/** Tours consécutifs sans progrès réel, vus au début du tour courant. */
	get turns(): number { return this.count }

	/**
	 * Tours passifs : tours où AUCUNE de mes actions n'a fait perdre de PV à sa cible (`dealt` de `observe`, mesuré autour
	 * de chaque appel par `ActionHistory`), hors tours d'approche (distance à l'ennemi le plus proche strictement inférieure
	 * au minimum depuis la dernière mort d'un ennemi : le compteur est alors gelé, pas remis à zéro). Seul un dégât de mes
	 * actions le remet à zéro : ni un tir prévu, ni un tir raté ou absorbé (0 PV), ni un dégât d'allié ou de poison, ni un
	 * ennemi qui bouge ; un soin adverse ne l'augmente pas. Une « danse » sans se toucher compte comme l'immobilité.
	 */
	get passiveTurns(): number { return this.passive }

	/** Facteur appliqué au poids du risque du plan conjoint : 1 jusqu'à `PASSIVE_TURNS_AT_FULL_RISK`, puis décroît jusqu'à 0. */
	get riskFactor(): number {
		return Math.max(0, Math.min(1, 1 - PASSIVE_RISK_STEP * (this.passive - PASSIVE_TURNS_AT_FULL_RISK)))
	}

	/**
	 * Stagnation à traiter : au moins `STAGNATION_TURNS` tours sans progrès réel ET ennemis immobiles pendant tout ce
	 * temps. Un ennemi qui bouge (fuite, approche) rend un plan normal bloqué transitoire : la règle reste hors jeu,
	 * le plan normal est exécuté tel quel (contre un ennemi qui fuit, l'engagement dérivait la trajectoire).
	 */
	get active(): boolean { return this.count >= STAGNATION_TURNS && this.stillTurns >= STAGNATION_TURNS }

	/** Une sortie de stagnation est engagée : elle continue (distance de marche) jusqu'à levée ou interruption. */
	get escaping(): boolean { return this.engaged }

	/** Cette case a-t-elle déjà servi de départ ou d'arrivée à une sortie depuis la dernière remise à zéro ? */
	visited(cell: Cell): boolean { return this.visitedCells.has(`${cell.x},${cell.y}`) }

	/** Une distance de Manhattan à l'ennemi battrait-elle le record de proximité (ce qui terminerait l'épisode) ? */
	beatsRecord(enemyDistance: number): boolean { return enemyDistance < this.record }

	/**
	 * À appeler au début de MON tour, avant la planification (idempotent dans un même tour).
	 * `enemyLife` = somme des PV des ennemis vivants (une mort ou un coup la fait baisser) ;
	 * `enemyDistance` = distance de Manhattan de ma case à l'ennemi vivant le plus proche.
	 * Les positions ennemies (`noteEnemyPositions`, appelé juste avant) sont facultatives : sans elles, ennemis supposés immobiles.
	 * `dealt` = dégâts infligés par mes actions à mon tour précédent (`ActionHistory.lastDealt`) : seule source de la
	 * passivité. `enemyCount` = ennemis vivants : s'il baisse, le minimum de distance de la passivité repart de zéro
	 * (l'approche de l'ennemi suivant n'est pas passive).
	 */
	observe(turn: number, enemyLife: number, enemyDistance: number, dealt = 0, enemyCount = this.enemyCountSeen): void {
		if (turn === this.turnSeen) return
		const enemyKey = this.pendingKey
		this.pendingKey = undefined
		if (this.turnSeen >= 0) {
			const moved = enemyKey !== undefined && this.enemyKeySeen !== null && enemyKey !== this.enemyKeySeen
			if (moved) { this.stillTurns = 0; this.engaged = false; this.visitedCells.clear() } else this.stillTurns++
			const damaged = this.enemyLifeSeen !== null && enemyLife < this.enemyLifeSeen
			if (damaged || enemyDistance < this.record) {
				this.count = 0
				this.engaged = false
				this.visitedCells.clear()
				this.record = enemyDistance
			} else this.count++
			if (enemyCount < this.enemyCountSeen) this.closest = Number.POSITIVE_INFINITY
			if (dealt > 0) this.passive = 0
			else if (enemyDistance >= this.closest) this.passive++
		} else this.record = enemyDistance
		this.enemyCountSeen = enemyCount
		this.closest = Math.min(this.closest, enemyDistance)
		this.enemyKeySeen = enemyKey ?? null
		this.turnSeen = turn
		this.enemyLifeSeen = enemyLife
	}

	/** Le planificateur engage la sortie origin -> destination : elle continue tant qu'aucune levée ni interruption. */
	commit(origin?: Cell, destination?: Cell): void {
		this.engaged = true
		for (const cell of [origin, destination]) if (cell) this.visitedCells.add(`${cell.x},${cell.y}`)
	}

	/**
	 * Lève l'engagement (plus aucune case sûre plus proche par la marche) : le plan normal reprend la main. Le compteur
	 * et les cases visitées sont conservés : la sortie ne peut se ré-engager que si le plan normal est de nouveau bloqué,
	 * et jamais vers une case déjà visitée (pas d'oscillation A → B → A).
	 */
	release(): void { this.engaged = false }

	/** Un tir RÉEL est prévu ce tour par le planificateur normal : il garde la main, la sortie est désengagée. */
	noteOffense(): void { this.count = 0; this.engaged = false; this.visitedCells.clear() }
}

// --- Historique des actions (même fichier : la clé API ne peut pas créer une nouvelle IA sur Leek Wars) ---

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
