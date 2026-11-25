// @version:5.8
// file version: 5
import { COLORS } from "./Constants.js"
import { isLogEnabled, log, LOG_CONTEXT } from "./Logger.js"
import { pauseFight } from "./Marker.js"

export const DEBUGS = {
	CONST_DEBUG_PAUSE: false,
	CONST_MARK_DANGERMAP: false,
	CONST_REACHABLE_CELLS: false,
	MARK_CELLS_TO_SHOOT_FROM: false,
	SAFE_PLACES: false,
	OPERATIONS: false
}

/**
 * Rapport d'erreur structuré (JSON) via le contexte ERROR, sur le canal `Debug.log` comme avant ; le contexte
 * ERROR sort en rouge (couleur ajoutée par `log`, voir Logger.ts).
 * Désactiver le contexte ERROR masque aussi ces rapports.
 */
export function reportError(file: string, functionName: string, error: unknown): void {
	log(() => {
		const details = error instanceof Error
			? {
				name: error.name,
				message: error.message,
				stack: error.stack ?? null
			}
			: {
				name: typeof error,
				message: String(error),
				stack: null
			}
		return JSON.stringify({
			level: "ERROR",
			file,
			function: functionName,
			error: details
		})
	}, LOG_CONTEXT.ERROR, { sink: "debug" })
}

export function withErrorReporting<T>(
	file: string,
	functionName: string,
	action: () => T
): T {
	try {
		return action()
	} catch (error) {
		reportError(file, functionName, error)
		throw error
	}
}

/**
 * Pourcentage d'utilisation (non arrondi, 0 à 100 en fonctionnement normal) ; 0 si le maximum est absent,
 * nul, négatif ou non fini, ou si le nombre d'opérations n'est pas un nombre fini. Ne lève jamais.
 */
export function operationsPercentage(operations: number | null | undefined, maxOperations: number | null | undefined): number {
	if (typeof operations !== "number" || typeof maxOperations !== "number") {
		return 0
	}
	if (!Number.isFinite(operations) || !Number.isFinite(maxOperations) || maxOperations <= 0) {
		return 0
	}
	return operations / maxOperations * 100
}

/** Ligne de log pure, ex. `Operations: 1234567/20000000 (6.2%)` (pourcentage à une décimale). */
export function formatOperationsLine(operations: number | null | undefined, maxOperations: number | null | undefined): string {
	const used = typeof operations === "number" && Number.isFinite(operations) ? operations : 0
	const max = typeof maxOperations === "number" && Number.isFinite(maxOperations) ? maxOperations : 0
	return `Operations: ${used}/${max} (${operationsPercentage(used, max).toFixed(1)}%)`
}

/**
 * Journalise les opérations du tour. `System.operations` est remis à zéro à chaque tour (doc officielle :
 * « opérations utilisées depuis le début du tour »), donc la valeur lue en fin de tour est celle du tour.
 * Le log lui-même consomme quelques opérations : le total inclut tout sauf ce log. Ne lève jamais
 * (System absent ou incomplet : 0/0 (0.0%)).
 */
export function logTurnOperations(): void {
	try {
		if (!isLogEnabled(LOG_CONTEXT.OPERATIONS)) {
			return
		}
		let operations: number | undefined
		let maxOperations: number | undefined
		try {
			operations = System.operations
			maxOperations = System.maxOperations
		} catch (_error) {
			// System indisponible (hors jeu) : valeurs par défaut.
		}
		log(formatOperationsLine(operations, maxOperations), LOG_CONTEXT.OPERATIONS)
	} catch (_error) {
		// Un log de diagnostic ne doit jamais interrompre le tour.
	}
}

export class Operations {
	private readonly startCount = System.operations
	private readonly text: string
	private readonly paused: boolean

	constructor(text = "", paused = false) {
		this.text = text
		this.paused = paused
	}

	debugOperations(): void {
		if (!DEBUGS.OPERATIONS) {
			return
		}
		const operations = System.operations
		if (isLogEnabled(LOG_CONTEXT.OPERATIONS)) {
			const used = operations - this.startCount
			const percentage = Math.floor(operationsPercentage(operations, System.maxOperations))
			log(`${this.text} - # Operations: ${used}`, LOG_CONTEXT.OPERATIONS, { color: COLORS.DEBUG })
			log(`Total # of operations: ${operations}/${System.maxOperations} (${percentage}%)`, LOG_CONTEXT.OPERATIONS, { color: COLORS.DEBUG })
		}
		if (this.paused) {
			// Pause historique : drapeau DEBUGS.OPERATIONS (déjà vérifié ci-dessus) ET contexte OPERATIONS actif.
			pauseFight(LOG_CONTEXT.OPERATIONS, DEBUGS.OPERATIONS)
		}
	}
}

export function debugPause(): void {
	// Pause historique : drapeau DEBUGS.CONST_DEBUG_PAUSE (faux par défaut) ET contexte SYSTEM actif.
	pauseFight(LOG_CONTEXT.SYSTEM, DEBUGS.CONST_DEBUG_PAUSE)
}

export function debugBeginTurn(): void {
	if (!isLogEnabled(LOG_CONTEXT.SYSTEM)) {
		return
	}
	const green = { color: Color.rgb(0, 255, 0) }
	log("*********************************************", LOG_CONTEXT.SYSTEM, green)
	log(() => `********** Tour ${Fight.turn}`, LOG_CONTEXT.SYSTEM, green)
	log(() => `********** ${Fight.me.name} (${Fight.me.id})`, LOG_CONTEXT.SYSTEM, green)
	log("*********************************************", LOG_CONTEXT.SYSTEM, green)
}

export function debugEndTurn(): void {
	const green = { color: Color.rgb(0, 255, 0) }
	log(() => `End Turn ${Fight.turn}`, LOG_CONTEXT.SYSTEM, green)
	log("-------", LOG_CONTEXT.SYSTEM, green)
	log(() => `OPERATIONS: ${System.operations}/${System.maxOperations}`, LOG_CONTEXT.OPERATIONS, green)
	debugPause()
}

export function debugSet<T>(text: string, values: Iterable<T>): void {
	if (!isLogEnabled(LOG_CONTEXT.DEBUG)) {
		return
	}
	log("Debug set", LOG_CONTEXT.DEBUG)
	for (const value of values) {
		log(`${text} ${String(value)}`, LOG_CONTEXT.DEBUG)
	}
	log("fin debug set", LOG_CONTEXT.DEBUG)
}

export function debugMap<K, V>(text: string, values: ReadonlyMap<K, V>): void {
	if (!isLogEnabled(LOG_CONTEXT.DEBUG)) {
		return
	}
	for (const [key, value] of values) {
		log(`${text} ${String(key)} : ${String(value)}`, LOG_CONTEXT.DEBUG)
	}
}
