// @version:5.8
// file version: 2
//
// Sorties VISUELLES du terrain : seul module de `src/` autorisé à appeler `Debug.mark`, `Debug.markText`,
// `Debug.clearMarks`, `Debug.pause` et `Debug.show` (voir tests/logging-policy.test.mjs). Le texte, lui,
// passe par `log` de `Logger.ts`.
//
// Règles communes :
// - Chaque fonction prend le CONTEXTE de journalisation en paramètre et ne fait rien (aucun appel `Debug.*`,
//   aucun calcul de cellules ni de couleurs) si ce contexte est inactif.
// - Marquages historiques (`DEBUGS.*`) : le paramètre `gate` reçoit le drapeau (faux par défaut) ; la sortie
//   exige contexte actif ET drapeau vrai. Sans drapeau, `gate` vaut vrai.
// - Aucune fonction ne lève : `Debug` absent, incomplet ou qui lève => la fonction renvoie `false`/rien, en silence.
// - Hypothèses NON vérifiées en combat réel : durée par défaut des marques (la durée n'est pas passée : les
//   marques sont effacées explicitement par `clearMarks`), effet réel de `pause()` hors combat de test,
//   coût en opérations de `mark`/`markText`/`pause` (la doc LeekScript indique 164 / 164 / 30 / 15 opérations
//   pour mark / markText / pause / clearMarks et 100 pour debug ; pas de chiffre TypeScript documenté),
//   plafond de 10 caractères de `markText` (documenté pour LeekScript).
import { isLogEnabled, log, LOG_CONTEXT, LogContext } from "./Logger.js"
import type { ReachableCells } from "../Classes/Context/ReachableCells.js"
import type { ThreatMap } from "../Classes/Context/ThreatMap.js"

/** Valeur ou fonction qui la produit (évaluée seulement si la sortie est réellement faite). */
export type Lazy<T> = T | (() => T)

/** Réglages modifiables (les tests les restaurent). */
export const MARKER_SETTINGS = {
	/** Pause après l'affichage de la zone de danger (`false` : les marques restent jusqu'au prochain nettoyage). */
	dangerZonePause: true,
	/**
	 * Plafond d'appels `markText` pour la zone de danger (un appel par texte distinct, cases de même texte
	 * regroupées). Les cases au-delà restent colorées mais sans texte ; les plus proches (parcours en largeur) d'abord.
	 */
	maxDangerTextCalls: 120
}

/** Longueur maximale d'un texte de `markText` (doc LeekScript : 10 caractères). */
export const MAX_MARK_TEXT_LENGTH = 10

/** Plus grande valeur écrite sur une case (10 chiffres : tient dans `MAX_MARK_TEXT_LENGTH`). */
export const MAX_DANGER_LABEL_VALUE = 9_999_999_999

/** Valeur absolue maximale d'un texte négatif (signe compris : 10 caractères). */
const MIN_DANGER_LABEL_VALUE = 999_999_999

export type ZoneSide = "me" | "ally" | "enemy"

/** Couleurs RVB par camp (zone accessible). */
export const ZONE_COLORS_RGB: Readonly<Record<ZoneSide, readonly [number, number, number]>> = {
	me: [0, 120, 255],
	ally: [0, 200, 60],
	enemy: [255, 40, 40]
}

/** Couleur RVB du texte écrit sur les cases. */
export const LABEL_COLOR_RGB: readonly [number, number, number] = [255, 255, 255]

/** Paliers de danger relatif (vert -> rouge), du plus faible au plus fort. */
export const DANGER_TIER_COLORS_RGB: ReadonlyArray<readonly [number, number, number]> = [
	[0, 200, 0],
	[140, 200, 0],
	[255, 200, 0],
	[255, 120, 0],
	[255, 0, 0]
]

function resolve<T>(value: Lazy<T>): T {
	return typeof value === "function" ? (value as () => T)() : value
}

function rgb(color: readonly [number, number, number]): number {
	return Color.rgb(color[0], color[1], color[2])
}

/** Exécute un appel `Debug.*` ; faux s'il lève ou renvoie explicitement `false`. */
function attempt(action: () => unknown): boolean {
	try {
		return action() !== false
	} catch (_error) {
		return false
	}
}

function isActive(context: LogContext, gate: boolean): boolean {
	return gate === true && isLogEnabled(context)
}

/** `Debug.mark(cells, color)` si le contexte est actif (et `gate` vrai). Renvoie le succès. */
export function markCells(
	cells: Lazy<Cell | readonly Cell[]>,
	color: Lazy<number>,
	context: LogContext,
	gate: boolean = true
): boolean {
	if (!isActive(context, gate)) {
		return false
	}
	try {
		const target = resolve(cells) as Cell | Cell[]
		const value = resolve(color)
		return attempt(() => Debug.mark(target, value))
	} catch (_error) {
		return false
	}
}

/**
 * `Debug.markText(cells, texte, couleur)` ; texte tronqué à 10 caractères. Si l'appel avec couleur LÈVE (la
 * forme à 3 arguments n'est pas confirmée pour TypeScript), repli sur `markText(cells, texte)`.
 */
export function markTextCells(
	cells: Lazy<Cell | readonly Cell[]>,
	text: Lazy<string>,
	color: Lazy<number>,
	context: LogContext,
	gate: boolean = true
): boolean {
	if (!isActive(context, gate)) {
		return false
	}
	try {
		const target = resolve(cells) as Cell | Cell[]
		const label = String(resolve(text)).slice(0, MAX_MARK_TEXT_LENGTH)
		const value = resolve(color)
		try {
			return Debug.markText(target, label, value) !== false
		} catch (_error) {
			return attempt(() => Debug.markText(target, label))
		}
	} catch (_error) {
		return false
	}
}

/** `Debug.clearMarks()` si le contexte est actif (et `gate` vrai). */
export function clearAllMarks(context: LogContext, gate: boolean = true): boolean {
	if (!isActive(context, gate)) {
		return false
	}
	return attempt(() => Debug.clearMarks())
}

/** `Debug.pause()` si le contexte est actif (et `gate` vrai). */
export function pauseFight(context: LogContext, gate: boolean = true): boolean {
	if (!isActive(context, gate)) {
		return false
	}
	return attempt(() => Debug.pause())
}

/** Un poireau dont on affiche la zone accessible (cases fournies par `EnemyMemory.getReachable`). */
export interface AccessibleZoneSource {
	readonly name: string
	readonly side: ZoneSide
	readonly reachable: ReachableCells | null
}

/**
 * Zone accessible de chaque poireau, dans l'ordre reçu (moi, alliés, ennemis). Par poireau : clearMarks, log
 * `Accessible zone: <nom> (<n> cells, <mp> MP)`, mark des cases (couleur du camp), markText du nom (10
 * caractères) sur sa case, pause. Puis un clearMarks final. Les cases viennent des `Cell` déjà stockées dans
 * `ReachableCells` : aucun appel à `Field.cellFromXY`. Sans effet si le contexte est inactif ou sans source
 * exploitable. Ne lève jamais. Renvoie le nombre de zones affichées.
 */
export function showAccessibleZones(sources: readonly AccessibleZoneSource[]): number {
	const context = LOG_CONTEXT.ACCESSIBLE_ZONE
	if (!isLogEnabled(context) || sources === null || sources === undefined) {
		return 0
	}
	let shown = 0
	try {
		for (const source of sources) {
			const reachable = source?.reachable
			if (reachable === null || reachable === undefined) {
				continue
			}
			shown++
			clearAllMarks(context)
			log(
				() => `Accessible zone: ${source.name} (${reachable.size}${reachable.truncated ? "+" : ""} cells, ${reachable.mp} MP)`,
				context
			)
			markCells(() => reachable.cells(), () => rgb(ZONE_COLORS_RGB[source.side]), context)
			markTextCells(reachable.startCell, () => String(source.name), () => rgb(LABEL_COLOR_RGB), context)
			pauseFight(context)
		}
		if (shown > 0) {
			clearAllMarks(context)
		}
	} catch (_error) {
		// Un affichage ne doit jamais interrompre le tour.
	}
	return shown
}

/** Palier de danger relatif (0 = vert ... paliers - 1 = rouge). */
export function dangerTier(danger: number, maxDanger: number, tiers: number = DANGER_TIER_COLORS_RGB.length): number {
	if (!(maxDanger > 0) || !(danger > 0)) {
		return 0
	}
	return Math.min(tiers - 1, Math.floor((danger / maxDanger) * tiers))
}

/** Texte écrit sur une case : dégâts arrondis, borné pour tenir en 10 caractères. */
export function dangerLabel(danger: number): string {
	const rounded = Math.round(danger)
	return String(Math.max(-MIN_DANGER_LABEL_VALUE, Math.min(MAX_DANGER_LABEL_VALUE, rounded)))
}

/**
 * Zone de danger de mon poireau. Séquence : clearMarks, log `Danger zone: <n> cells, max <x>`, un `mark` par
 * palier de danger relatif (au plus 5 appels, cases regroupées), un `markText` par texte distinct (dégâts
 * arrondis ; cases de même texte regroupées, plafond `MARKER_SETTINGS.maxDangerTextCalls`), puis `pause()` si
 * `MARKER_SETTINGS.dangerZonePause` et, dans ce cas seulement, clearMarks final (sans pause, effacer tout de
 * suite rendrait les marques invisibles : elles restent jusqu'au prochain clearMarks). Seules les cases
 * ÉVALUÉES de la carte sont marquées. Sans effet si le contexte est inactif ou si la carte est absente ou vide.
 * Ne lève jamais.
 */
export function showDangerZone(map: ThreatMap | null | undefined): void {
	showThreatZone(map, LOG_CONTEXT.DANGER_ZONE, "Danger zone")
}

/**
 * Zone visée (`buildTargetZone` : toutes les cases qu'un ennemi peut toucher, atteignables par moi ou non). Même
 * séquence et mêmes réglages (`MARKER_SETTINGS`) que `showDangerZone`, sous le contexte `TARGET_ZONE`, avec le log
 * `Target zone: <n> cells, max <x>`. Sans pause, son clearMarks initial efface les marques de la zone de danger.
 */
export function showTargetZone(map: ThreatMap | null | undefined): void {
	showThreatZone(map, LOG_CONTEXT.TARGET_ZONE, "Target zone")
}

function showThreatZone(map: ThreatMap | null | undefined, context: LogContext, label: string): void {
	if (!isLogEnabled(context) || map === null || map === undefined) {
		return
	}
	try {
		if (!(map.size > 0)) {
			return
		}
		const tierCount = DANGER_TIER_COLORS_RGB.length
		const maxDanger = map.maxDanger
		const tiers: Cell[][] = []
		for (let tier = 0; tier < tierCount; tier++) {
			tiers.push([])
		}
		const labels = new Map<string, Cell[]>()
		const maxTextCalls = MARKER_SETTINGS.maxDangerTextCalls
		for (const entry of map.entries()) {
			const danger = entry.danger
			if (!Number.isFinite(danger)) {
				continue
			}
			const tierCells = tiers[dangerTier(danger, maxDanger, tierCount)] as Cell[]
			tierCells.push(entry.cell)
			const text = dangerLabel(danger)
			let group = labels.get(text)
			if (group === undefined) {
				if (labels.size >= maxTextCalls) {
					continue
				}
				group = []
				labels.set(text, group)
			}
			group.push(entry.cell)
		}

		clearAllMarks(context)
		log(() => `${label}: ${map.size} cells, max ${maxDanger.toFixed(1)}${map.truncated ? " (truncated)" : ""}`, context)
		tiers.forEach((cells, tier) => {
			if (cells.length > 0) {
				markCells(cells, () => rgb(DANGER_TIER_COLORS_RGB[tier] as readonly [number, number, number]), context)
			}
		})
		let labelColor: number | null = null
		for (const [text, cells] of labels) {
			markTextCells(cells, text, () => (labelColor ??= rgb(LABEL_COLOR_RGB)), context)
		}
		if (MARKER_SETTINGS.dangerZonePause) {
			pauseFight(context)
			clearAllMarks(context)
		}
	} catch (_error) {
		// Un affichage ne doit jamais interrompre le tour.
	}
}
