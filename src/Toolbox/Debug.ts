// @version:5.8
// file version: 2
import { COLORS } from "./Constants.js"

export const DEBUGS = {
	CONST_DEBUG_PAUSE: false,
	CONST_MARK_DANGERMAP: false,
	CONST_REACHABLE_CELLS: false,
	MARK_CELLS_TO_SHOOT_FROM: false,
	SAFE_PLACES: false,
	OPERATIONS: false
}

export function reportError(file: string, functionName: string, error: unknown): void {
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
	Debug.log(JSON.stringify({
		level: "ERROR",
		file,
		function: functionName,
		error: details
	}))
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
		const used = operations - this.startCount
		const percentage = System.maxOperations === 0
			? 0
			: Math.floor(operations / System.maxOperations * 100)
		Debug.log(`${this.text} - # Operations: ${used}`, COLORS.DEBUG)
		Debug.log(`Total # of operations: ${operations}/${System.maxOperations} (${percentage}%)`, COLORS.DEBUG)
		if (this.paused) {
			Debug.pause()
		}
	}
}

export function debugPause(): void {
	if (DEBUGS.CONST_DEBUG_PAUSE) {
		Debug.pause()
	}
}

export function debugBeginTurn(): void {
	Debug.log("*********************************************", Color.rgb(0, 255, 0))
	Debug.log(`********** Tour ${Fight.turn}`, Color.rgb(0, 255, 0))
	Debug.log(`********** ${Fight.me.name} (${Fight.me.id})`, Color.rgb(0, 255, 0))
	Debug.log("*********************************************", Color.rgb(0, 255, 0))
}

export function debugEndTurn(): void {
	Debug.log(`End Turn ${Fight.turn}`, Color.rgb(0, 255, 0))
	Debug.log("-------", Color.rgb(0, 255, 0))
	Debug.log(`OPERATIONS: ${System.operations}/${System.maxOperations}`, Color.rgb(0, 255, 0))
	debugPause()
}

export function debugSet<T>(text: string, values: Iterable<T>): void {
	Debug.log("Debug set")
	for (const value of values) {
		Debug.log(`${text} ${String(value)}`)
	}
	Debug.log("fin debug set")
}

export function debugMap<K, V>(text: string, values: ReadonlyMap<K, V>): void {
	for (const [key, value] of values) {
		Debug.log(`${text} ${String(key)} : ${String(value)}`)
	}
}
