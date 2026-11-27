// @version:5.8
// file version: 1
import { SEARCH_GLOBAL_FRACTION } from "./ExecutionBudget.js"

/** Part du total d'opérations que le faisceau peut consommer depuis sa création. Politique, non mesurée. */
export const BOOK_SEARCH_FRACTION = 0.25

/** Au-delà de cette part déjà consommée, la profondeur facultative (3e tour) n'est pas tentée. Politique, non mesurée. */
export const BOOK_DEEPEN_FRACTION = 0.08

export class BookCut extends Error {}

/**
 * Budget du faisceau : unités de travail (itérations élémentaires, pas des opérations du jeu), plafond optionnel pour les
 * tests, et garde sur `System.operations` (même plafond global que la recherche existante). Lève `BookCut` à la coupure.
 */
export class BookBudget {
	work = 0
	private checked = 0
	private readonly start = typeof System === "undefined" ? 0 : System.operations
	constructor(private readonly workLimit = Infinity, private readonly fraction = BOOK_SEARCH_FRACTION) {}

	tick(count = 1): void {
		this.work += count
		if (this.work > this.workLimit) throw new BookCut("work limit")
		if (this.work - this.checked >= 64) { this.checked = this.work; this.guard() }
	}

	guard(): void {
		if (typeof System !== "undefined" && Number.isFinite(System.maxOperations) && System.maxOperations > 0 &&
			(System.operations >= System.maxOperations * SEARCH_GLOBAL_FRACTION ||
				System.operations - this.start >= System.maxOperations * this.fraction)) throw new BookCut("operations reserve")
	}

	/** Opérations consommées depuis la création, en fraction du total (0 hors jeu). */
	spent(): number {
		return typeof System === "undefined" || !(System.maxOperations > 0) ? 0 : (System.operations - this.start) / System.maxOperations
	}

	deepenOk(): boolean { return this.spent() < BOOK_DEEPEN_FRACTION }
}
