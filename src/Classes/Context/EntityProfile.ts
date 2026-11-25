// @version:5.8
// file version: 1
import { ReachableCells } from "./ReachableCells.js"

/**
 * Ce que l'on sait d'une entité (moi, allié ou ennemi) : identité, PM observés et cases atteignables.
 * Collecte de données uniquement : aucune décision tactique n'en dépend. `EnemyProfile` en hérite.
 */
export class EntityProfile {
	readonly id: number
	readonly name: string
	readonly level: number
	readonly identifiedTurn: number
	/**
	 * Plus grand `entity.mp` vu pendant mon tour. Pour un autre poireau, `entity.mp` peut être les PM restants
	 * de SON dernier tour (non vérifié) : le maximum observé est l'estimation de ses PM au prochain tour.
	 */
	maxMpSeen = 0
	/** Cases atteignables calculées au début de mon dernier tour (null : jamais calculées ou entité morte). */
	reachable: ReachableCells | null = null

	constructor(entity: Entity, turn: number) {
		this.id = entity.id
		this.name = entity.name
		this.level = entity.level
		this.identifiedTurn = turn
	}

	/** PM utilisés pour `reachable` (null s'il n'y en a pas). */
	get reachableMp(): number | null {
		return this.reachable?.mp ?? null
	}

	/** Tour de calcul de `reachable` (null s'il n'y en a pas). */
	get reachableTurn(): number | null {
		return this.reachable?.turn ?? null
	}

	observeMp(mp: number): void {
		if (Number.isFinite(mp)) {
			this.maxMpSeen = Math.max(this.maxMpSeen, mp)
		}
	}

	setReachable(reachable: ReachableCells): void {
		this.reachable = reachable
	}

	clearReachable(): void {
		this.reachable = null
	}
}
