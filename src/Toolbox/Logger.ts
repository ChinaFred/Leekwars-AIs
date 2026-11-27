// @version:5.8
// file version: 4
//
// Journalisation par contexte : TOUTE sortie texte (log de combat) passe par `log(texte, contexte)`.
// Ce fichier est le seul de `src/` autorisé à appeler `console.log` / `Debug.log` (voir
// tests/logging-policy.test.mjs). Les sorties VISUELLES (Debug.mark / markText / clearMarks / pause / show)
// vivent dans `Marker.ts`, qui s'appuie sur ce module pour l'activation des contextes. Ce fichier n'importe
// rien : aucun risque de dépendance circulaire.
//
// - Un contexte actif => le texte est émis tel quel (aucun préfixe ajouté) ; inactif => aucune sortie.
// - Par défaut TOUS les contextes sont actifs, même sans `initLeekLogging` explicite.
// - Désactiver `ERROR` masque aussi les rapports d'erreur de `reportError` (choix assumé : configurable).
// - Le contexte `ERROR` sort en ROUGE : `Debug.log(texte, rouge)`. Aucun équivalent TypeScript de `debugE`
//   n'est documenté (la doc officielle ne donne que la forme LeekScript) ; la forme à 2 arguments
//   `Debug.log(valeur, couleur)` n'est pas non plus confirmée par la doc TypeScript (voir `emit`).
// - `log` ne lève jamais (configuration absente, texte non chaîne, console indisponible, texte paresseux qui lève).

/** Ensemble fermé des contextes de log. Les valeurs sont stables (utilisables comme clés de configuration). */
export const LOG_CONTEXT = {
	/** Déplacement (actions et décisions de mouvement). */
	MOVEMENT: "movement",
	/** Décisions de stratégie (prédictions, vérifications de repli/défense). */
	STRATEGY: "strategy",
	/** État du combat (PV, PT, PM, distance) et journal des décisions de combat. */
	COMBAT: "combat",
	/** Armes (choix, équipement, tirs). */
	WEAPON: "weapon",
	/** Armures / boucliers. */
	ARMOR: "armor",
	/** Puces (attaque, soin). */
	CHIP: "chip",
	/** Plannification générale (exécution de la liste d'actions). */
	PLANNING: "planning",
	/** Options de tir (aucun émetteur actuellement). */
	SHOOTING: "shooting",
	/** Mémoire de l'adversaire. */
	MEMORY: "memory",
	/** Cases atteignables. */
	REACHABLE: "reachable",
	/** Carte de danger. */
	THREAT: "threat",
	/** Opérations (compteurs System.operations). */
	OPERATIONS: "operations",
	/** Répliques du poireau. */
	SPEECH: "speech",
	/** Rapports d'erreur. */
	ERROR: "error",
	/** Début et fin de tour. */
	SYSTEM: "system",
	/** Dumps de débogage génériques (ensembles, maps, monde). */
	DEBUG: "debug",
	/** Zone accessible de chaque poireau : log du nom + marques + pause (voir `Marker.ts`). */
	ACCESSIBLE_ZONE: "accessible_zone",
	/** Zone de danger de mon poireau : log, marques colorées avec les dégâts + pause (voir `Marker.ts`). */
	DANGER_ZONE: "danger_zone",
	/** Zone visée : toutes les cases qu'un ennemi peut toucher, mêmes marques que la zone de danger (voir `Marker.ts`). */
	TARGET_ZONE: "target_zone"
} as const

export type LogContext = (typeof LOG_CONTEXT)[keyof typeof LOG_CONTEXT]

/** Tous les contextes, dans l'ordre de déclaration. */
export const LOG_CONTEXTS: readonly LogContext[] = Object.values(LOG_CONTEXT)

/** Drapeaux partiels par contexte (les contextes absents restent actifs). */
export type LogFlags = Partial<Record<LogContext, boolean>>

/**
 * Texte à journaliser : chaîne, ou fonction évaluée seulement si le contexte est actif (évite le coût
 * des gabarits de chaîne et de `toFixed` quand le contexte est désactivé). Toute autre valeur (ex. tableau)
 * est transmise telle quelle à la sortie.
 */
export type LogText = string | (() => unknown)

export interface LogOptions {
	/** Couleur : le texte est alors émis par `Debug.log(texte, couleur)` (console.log ne colore pas). */
	color?: number
	/** Canal de sortie : « console » (défaut) ou « debug » (`Debug.log`, utilisé par les rapports d'erreur). */
	sink?: "console" | "debug"
}

/** Configuration de journalisation d'un poireau : un drapeau par contexte, tous actifs par défaut. */
export class LogConfig {
	private readonly flags = new Map<LogContext, boolean>()

	constructor(initial?: LogFlags) {
		for (const context of LOG_CONTEXTS) {
			this.flags.set(context, true)
		}
		if (initial !== null && initial !== undefined && typeof initial === "object") {
			for (const context of LOG_CONTEXTS) {
				const value = initial[context]
				if (typeof value === "boolean") {
					this.flags.set(context, value)
				}
			}
		}
	}

	/** Vrai si le contexte est actif ; faux pour un contexte inconnu. */
	isEnabled(context: LogContext): boolean {
		return this.flags.get(context) === true
	}

	/** Active/désactive un contexte ; un contexte inconnu est ignoré. */
	setEnabled(context: LogContext, enabled: boolean): this {
		if (this.flags.has(context)) {
			this.flags.set(context, enabled === true)
		}
		return this
	}

	/** Active/désactive tous les contextes. */
	setAll(enabled: boolean): this {
		for (const context of LOG_CONTEXTS) {
			this.flags.set(context, enabled === true)
		}
		return this
	}

	/** Contextes actifs, dans l'ordre de `LOG_CONTEXTS`. */
	enabledContexts(): LogContext[] {
		return LOG_CONTEXTS.filter((context) => this.flags.get(context) === true)
	}
}

/** Configuration courante (état du module) : tous les contextes actifs tant qu'aucune init n'a eu lieu. */
let currentConfig = new LogConfig()

/**
 * Installe la configuration de journalisation du poireau et la renvoie. Accepte une `LogConfig` (utilisée
 * telle quelle, donc modifiable ensuite) ou des drapeaux partiels ; toute autre valeur (absente, `null`,
 * non objet) donne une configuration par défaut, tous contextes actifs.
 */
export function initLeekLogging(config?: LogConfig | LogFlags | null): LogConfig {
	if (config instanceof LogConfig) {
		currentConfig = config
	} else if (config !== null && config !== undefined && typeof config === "object") {
		currentConfig = new LogConfig(config)
	} else {
		currentConfig = new LogConfig()
	}
	return currentConfig
}

/** Réinitialise : nouvelle configuration par défaut, tous contextes actifs (utile aux tests). */
export function resetLeekLogging(): LogConfig {
	currentConfig = new LogConfig()
	return currentConfig
}

/** Configuration courante. */
export function getLogConfig(): LogConfig {
	return currentConfig
}

/** Vrai si le contexte est actif ; permet d'éviter une boucle ou un calcul coûteux avant `log`. Ne lève jamais. */
export function isLogEnabled(context: LogContext): boolean {
	try {
		return currentConfig.isEnabled(context)
	} catch (_error) {
		return false
	}
}

/** Rouge des messages d'erreur (composantes RVB). */
export const ERROR_COLOR_RGB: readonly [number, number, number] = [255, 0, 0]

/** Couleur rouge via `Color.rgb` (évaluée seulement quand une erreur est réellement émise) ; null si indisponible. */
function errorColor(): number | null {
	try {
		const color = Color.rgb(ERROR_COLOR_RGB[0], ERROR_COLOR_RGB[1], ERROR_COLOR_RGB[2])
		return typeof color === "number" ? color : null
	} catch (_error) {
		return null
	}
}

function emit(value: unknown, options?: LogOptions): void {
	const color = options?.color
	const hasColor = typeof color === "number"
	if ((hasColor || options?.sink === "debug") && typeof Debug !== "undefined" && typeof Debug.log === "function") {
		try {
			if (hasColor) {
				try {
					Debug.log(value, color)
					return
				} catch (_error) {
					// La forme à 2 arguments n'est pas confirmée par la doc TypeScript : repli sans couleur
					// plutôt que de perdre le message (ex. erreur d'arité de l'hôte).
				}
			}
			Debug.log(value)
			return
		} catch (_error) {
			// Debug.log inutilisable : dernier repli sur console.log ci-dessous.
		}
	}
	if (typeof console !== "undefined" && typeof console.log === "function") {
		console.log(value)
		return
	}
	if (typeof Debug !== "undefined" && typeof Debug.log === "function") {
		Debug.log(value)
	}
}

/**
 * Fonction unique de sortie. Si `context` est actif, `text` (ou son évaluation, si c'est une fonction)
 * est émis sans modification ; sinon rien n'est affiché ni évalué. Ne lève jamais.
 */
export function log(text: LogText, context: LogContext, options?: LogOptions): void {
	try {
		if (!currentConfig.isEnabled(context)) {
			return
		}
		let effective = options
		if (context === LOG_CONTEXT.ERROR && options?.color === undefined) {
			// Erreurs en rouge ; la couleur n'est calculée que pour un message réellement émis.
			const red = errorColor()
			if (red !== null) {
				effective = { ...options, color: red }
			}
		}
		emit(typeof text === "function" ? text() : text, effective)
	} catch (_error) {
		// Un log de diagnostic ne doit jamais interrompre le tour.
	}
}
