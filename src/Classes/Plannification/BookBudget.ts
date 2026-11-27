// @version:5.8
// file version: 2
import { SEARCH_GLOBAL_FRACTION } from "./ExecutionBudget.js"

/** Part du total d'opérations que le faisceau peut consommer depuis sa création. Politique, non mesurée. */
export const BOOK_SEARCH_FRACTION = 0.25

/** Même part pendant un duel (AGGRESSIVE, voir `BookStandoff.ts`) : le tour 2 est alors utile. Politique, non mesurée. */
export const BOOK_DUEL_SEARCH_FRACTION = 0.30

/** Au-delà de cette part déjà consommée, la profondeur facultative (3e tour) n'est pas tentée. Politique, non mesurée. */
export const BOOK_DEEPEN_FRACTION = 0.08

export class BookCut extends Error {}

/**
 * Budget du faisceau : unités de travail (itérations élémentaires, pas des opérations du jeu), plafond optionnel pour les
 * tests, et garde sur `System.operations` (même plafond global que la recherche existante). Lève `BookCut` à la coupure.
 * `link` rattache le compteur de travail d'un livre (construction des tables) aux unités du faisceau.
 */
export class BookBudget {
	work = 0
	private checked = 0
	private source: { work: number } | null = null
	private sourceSeen = 0
	private readonly start = typeof System === "undefined" ? 0 : System.operations
	readonly fraction: number
	constructor(private readonly workLimit = Infinity, fraction = BOOK_SEARCH_FRACTION) { this.fraction = fraction }

	/** Compte aussi le travail du livre (tables construites à la lecture) depuis maintenant. */
	link(source: { work: number }): void { this.source = source; this.sourceSeen = source.work }

	tick(count = 1): void {
		if (this.source !== null) { count += this.source.work - this.sourceSeen; this.sourceSeen = this.source.work }
		this.work += count
		if (this.work > this.workLimit) throw new BookCut("work limit")
		if (this.work - this.checked >= 64) { this.checked = this.work; this.guard() }
	}

	guard(): void {
		if (typeof System !== "undefined" && Number.isFinite(System.maxOperations) && System.maxOperations > 0 &&
			(System.operations >= System.maxOperations * SEARCH_GLOBAL_FRACTION ||
				System.operations - this.start >= System.maxOperations * this.fraction)) throw new BookCut("operations reserve")
	}

	/** `System.operations` (0 hors jeu) : pour mesurer une phase par différence. */
	ops(): number { return typeof System === "undefined" ? 0 : System.operations }

	/** Opérations consommées depuis la création, en fraction du total (0 hors jeu). */
	spent(): number {
		return typeof System === "undefined" || !(System.maxOperations > 0) ? 0 : (System.operations - this.start) / System.maxOperations
	}

	/** Opérations encore permises avant la coupure (Infinity hors jeu). */
	remainingOps(): number {
		if (typeof System === "undefined" || !(System.maxOperations > 0)) return Infinity
		return Math.min(System.maxOperations * this.fraction - (System.operations - this.start),
			System.maxOperations * SEARCH_GLOBAL_FRACTION - System.operations)
	}

	deepenOk(): boolean { return this.spent() < BOOK_DEEPEN_FRACTION }
}
