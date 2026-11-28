// @version:5.8
// file version: 2

/**
 * Parts de `System.maxOperations`. Politiques, pas des mesures du moteur. Les limites de volume (cases, ennemis,
 * unités de travail) et les seuils de stratégie restent dans leurs fichiers.
 */
export const OPS_BUDGET = {
	/** Arrêt de la recherche tactique, depuis son entrée (0,30 → 0,60 ; le plafond global SEARCH_GLOBAL borne toujours le tour). */
	TACTICAL_SEARCH: 0.60,
	/** Arrêt de la recherche du plan B, depuis son entrée. */
	RESERVE_SEARCH: 0.03,
	/** Plafond absolu du tour : au-delà, ni la recherche tactique, ni le plan B, ni la carte de danger ne continuent. */
	SEARCH_GLOBAL: 0.80,
	/** Réserve de fin de tour du garde d'exécution (avec deux fois le plus gros segment observé). */
	EXECUTION_TAIL: 0.03,
	/** Calcul de `N` (valeur de la case finale pour le tour suivant), depuis son entrée. */
	NEXT_TURN: 0.05,
	/** Plafond absolu de `buildTargetZone`, pour laisser sa fenêtre à la recherche tactique (50 % + fenêtre de recherche : la fenêtre de 60 % dépasse désormais ce reste de 30 %, le plafond global la coupe). */
	TARGET_ZONE: 0.50,
	/** Route de marche de la sortie de stagnation, depuis son entrée : part de base, multipliée par le nombre de tours bloqués. */
	STAGNATION_ROUTE: 0.04,
	/** Borne de cette part après multiplication (la recherche tactique n'en prend pas plus) ; le plafond global s'y ajoute. */
	STAGNATION_ROUTE_MAX: 0.30
} as const
