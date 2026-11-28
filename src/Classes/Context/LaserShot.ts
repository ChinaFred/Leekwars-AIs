// @version:5.8
// file version: 1
import { LaserHits, LaserKind, laserHits, laserLine } from "./LaserLine.js"
import { isChest } from "./Targets.js"

/**
 * Raccord au jeu de `LaserLine.ts` : `Field.cellFromXY` et les listes d'ennemis du moment. Les ennemis sont lus une fois
 * par instance (paresseusement) : une instance par évaluation de plan, une neuve à l'exécution (entités à jour).
 */
export function laserKinds(me: Me): (entity: Entity) => LaserKind {
	let enemies: Set<number> | null = null
	return (entity) => {
		if (entity.id === me.id) return "self"
		if (isChest(entity)) return "chest"
		enemies ??= new Set(Fight.getAliveEnemies().map((enemy) => enemy.id))
		return enemies.has(entity.id) ? "enemy" : "ally"
	}
}

/** Entités touchées par `weapon` tiré depuis `from` vers `aim`. */
export function laserHitsFrom(
	me: Me, from: Cell, aim: Cell, weapon: Weapon, kindOf: (entity: Entity) => LaserKind = laserKinds(me)
): LaserHits {
	return laserHits(laserLine(from, aim, weapon, (x, y) => Field.cellFromXY(x, y)), kindOf)
}

/** Tir réel : un laser ne doit toucher que les alliés prévus au plan, et aucun coffre. Renvoie la raison du refus, sinon null. */
export function laserRefusal(me: Me, target: Entity, weapon: Weapon, plannedAllies: readonly number[] | undefined): string | null {
	const hits = laserHitsFrom(me, me.cell, target.cell, weapon)
	if (hits.chests.length > 0) return `laser line hits chest #${hits.chests[0]!.id}`
	const planned = new Set(plannedAllies ?? [])
	const unplanned = hits.allies.find((ally) => !planned.has(ally.id))
	return unplanned === undefined ? null : `laser line hits unplanned ally #${unplanned.id}`
}
