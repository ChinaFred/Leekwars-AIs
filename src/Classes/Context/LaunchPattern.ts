// @version:5.8
// file version: 1

/**
 * Types de lancer (constantes officielles LAUNCH_TYPE_*, `Item.LaunchType.*` en TypeScript). Les valeurs
 * numériques sont documentées (LAUNCH_TYPE_LINE = 1) ; elles sont recopiées ici pour ne pas dépendre
 * d'un global absent des mocks de test.
 */
export const LAUNCH_TYPE = {
	LINE: 1,
	DIAGONAL: 2,
	STAR: 3,
	STAR_INVERTED: 4,
	DIAGONAL_INVERTED: 5,
	LINE_INVERTED: 6,
	CIRCLE: 7
} as const

/** Bits du masque (hypothèse, voir `isCellInLaunchPattern`). */
const BIT_LINE = 1
const BIT_DIAGONAL = 2
const BIT_OTHER = 4

/** Type de lancer par défaut quand il est absent ou invalide : tout est permis (CIRCLE). */
export const DEFAULT_LAUNCH_TYPE = LAUNCH_TYPE.CIRCLE

/**
 * Le décalage (dx, dy) de la cible par rapport au lanceur est-il permis par le type de lancer ?
 *
 * HYPOTHÈSE NON VÉRIFIÉE : `launchType` se lit comme un masque de bits : 1 = cases alignées en ligne
 * (dx == 0 ou dy == 0, le décalage nul inclus), 2 = diagonales (|dx| == |dy| ≠ 0), 4 = toutes les autres
 * cases. LINE=1 → lignes ; DIAGONAL=2 → diagonales ; STAR=3 → lignes + diagonales ; STAR_INVERTED=4 →
 * autres cases seulement ; DIAGONAL_INVERTED=5 → lignes + autres (pas les diagonales) ; LINE_INVERTED=6 →
 * diagonales + autres (pas les lignes) ; CIRCLE=7 → tout. Seule la valeur de LAUNCH_TYPE_LINE est confirmée
 * par la doc officielle ; cette table est le seul endroit à corriger si l'hypothèse est fausse.
 *
 * `launchType` absent, non entier ou hors de 1..7 : traité comme CIRCLE (tout permis), sans lever.
 */
export function isCellInLaunchPattern(launchType: number | null | undefined, dx: number, dy: number): boolean {
	const mask = Number.isInteger(launchType) && (launchType as number) >= 1 && (launchType as number) <= 7
		? (launchType as number)
		: DEFAULT_LAUNCH_TYPE
	if (dx === 0 || dy === 0) {
		return (mask & BIT_LINE) !== 0
	}
	if (Math.abs(dx) === Math.abs(dy)) {
		return (mask & BIT_DIAGONAL) !== 0
	}
	return (mask & BIT_OTHER) !== 0
}
