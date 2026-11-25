// @version:5.8
// file version: 1

// Politique prudente, PAS une borne mesurée des primitives natives :
// garder l'équivalent de la fenêtre de recherche courte (3 %) en fin de tour,
// plus deux segments du plus gros coût observé ENTRE contrôles d'exécution
// (prochain segment + marge d'erreur). Ne jamais y inclure la recherche passée.
const TAIL_FRACTION = 0.03
export const EXECUTION_BUDGET_POLICY =
	"remaining > 3% total + 2 * largest observed execution segment; opaque costs not guaranteed"

function room(used: number, maximum: number, peak: number): boolean {
	return Number.isFinite(used) && maximum - used > maximum * TAIL_FRACTION + 2 * peak
}

/** Décision déjà préparée : aucun nouveau budget de recherche n'est ouvert. */
export function hasExecutionRoom(): boolean {
	if (typeof System === "undefined" || !Number.isFinite(System.maxOperations) ||
		System.maxOperations <= 0) return true
	return room(System.operations, System.maxOperations, 0)
}

/** À construire APRÈS la sélection, AVANT l'aperçu et les actions. */
export class ExecutionBudget {
	private previous = typeof System === "undefined" ? 0 : System.operations
	private peak = 0

	available(): boolean {
		if (typeof System === "undefined" || !Number.isFinite(System.maxOperations) ||
			System.maxOperations <= 0) return true
		const used = System.operations
		this.peak = Math.max(this.peak, Math.max(0, used - this.previous))
		this.previous = used
		return room(used, System.maxOperations, this.peak)
	}
}
