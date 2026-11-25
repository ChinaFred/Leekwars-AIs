// @version:5.8
// file version: 1

/** Un coffre n'est pas un adversaire : suivi à part, jamais ciblé ni compté dans le danger. */
export function isChest(entity: Entity): boolean {
	return typeof Chest !== "undefined" && entity instanceof Chest
}

/** Ennemis vivants hors coffres : seule liste à utiliser pour cibler et évaluer le danger. */
export function aliveEnemies(): Entity[] {
	return Fight.getAliveEnemies().filter((enemy) => !isChest(enemy))
}

/** Coffres vivants (sans appel API si le moteur ne fournit pas la classe `Chest`). */
export function aliveChests(): Entity[] {
	if (typeof Chest === "undefined") {
		return []
	}
	return Fight.getAliveEnemies().filter((enemy) => isChest(enemy))
}

/** Ennemi le plus proche hors coffres ; null s'il n'en reste aucun. */
export function nearestEnemy(): Entity | null {
	const nearest = Fight.getNearestEnemy()
	if (nearest === null || !isChest(nearest)) {
		return nearest
	}
	const me = Fight.me
	let best: Entity | null = null
	let bestDistance = Number.POSITIVE_INFINITY
	for (const enemy of aliveEnemies()) {
		const distance = me.distance(enemy)
		if (distance < bestDistance) {
			best = enemy
			bestDistance = distance
		}
	}
	return best
}
