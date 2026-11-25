// @version:5.8
// file version: 2
// Poids de la distance « moi → cellule » dans le score de repli (pénalité légère).
const RETREAT_SELF_DISTANCE_WEIGHT = 0.1
// Voisins orthogonaux d'une cellule (x ± 1, y ± 1) — hypothèse sur la grille Leek Wars, voir docs/strategies.md.
const NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]]

export const MOVEMENT_BEHAVIOR = {
	RETREAT_TO_CORNER: "retreat_to_corner",
	AGGRESSIVE_KITING: "aggressive_kiting",
	ZONE_CONTROL: "zone_control",
	TERRAIN_AWARE: "terrain_aware",
	SIMPLE_RETREAT: "simple_retreat",
	SIMPLE_ADVANCE: "simple_advance"
} as const

export class MovementBehavior {
	constructor(
		private readonly leek: Me,
		private readonly target: Entity,
		private readonly myWeapon: Weapon | null,
		private readonly enemyWeapon: Weapon | null
	) {}

	getOptimalBehavior(
		scenario: { iCanShoot: boolean; enemyCanShoot: boolean; distance: number }
	): string {
		const { iCanShoot, enemyCanShoot, distance } = scenario

		if (enemyCanShoot && !iCanShoot) {
			return MOVEMENT_BEHAVIOR.RETREAT_TO_CORNER
		}

		if (iCanShoot && !enemyCanShoot) {
			return MOVEMENT_BEHAVIOR.AGGRESSIVE_KITING
		}

		if (iCanShoot && enemyCanShoot) {
			return MOVEMENT_BEHAVIOR.ZONE_CONTROL
		}

		return MOVEMENT_BEHAVIOR.SIMPLE_ADVANCE
	}

	executeRetreatToCorner(): void {
		const retreatCell = this.findRetreatCell()
		if (retreatCell !== null) {
			this.leek.moveToward(retreatCell)
		} else {
			this.leek.moveAwayFrom(this.target)
		}
	}

	/** L'ennemi peut-il me toucher (après avoir marché avec ses PM) depuis cette distance ? */
	isInEnemyReach(distance: number): boolean {
		return distance - this.target.mp <= this.getEnemyMaxRange()
	}

	/** Reculer de `mp` cases (au mieux) me sortirait-il de la portée de l'ennemi, PM de l'ennemi inclus ? */
	canLeaveEnemyReach(distance: number, mp: number): boolean {
		return distance + mp - this.target.mp > this.getEnemyMaxRange()
	}

	executeAggressiveKiting(): void {
		const distance = this.leek.distance(this.target)
		const myMaxRange = this.myWeapon?.maxRange ?? 1
		const enemyMaxRange = this.enemyWeapon?.maxRange ?? 1
		const optimalDistance = (myMaxRange + enemyMaxRange) / 2

		if (distance > optimalDistance) {
			this.leek.moveToward(this.target)
		} else if (distance < optimalDistance - 1) {
			this.leek.moveAwayFrom(this.target)
		}
	}

	/**
	 * Phase d'approche de zone_control : avance tant que je ne peux pas tirer.
	 * Ne recule jamais ici : un recul avant le tir pourrait me sortir de ma propre portée.
	 * Le recul se fait après les tirs via `executeZoneRetreat` (Plannification.planRetreatAfterShoot).
	 */
	executeZoneControl(): void {
		if (!this.leek.canUseWeapon(this.target)) {
			this.leek.moveToward(this.target)
		}
	}

	/** Phase de recul de zone_control, à exécuter après les tirs : s'éloigne si l'ennemi peut encore m'atteindre. */
	executeZoneRetreat(): void {
		if (this.isInEnemyReach(this.leek.distance(this.target))) {
			this.leek.moveAwayFrom(this.target)
		}
	}

	executeTerrainAwareMoveToward(): void {
		const optimalCell = this.findTerrainAwarePathToward()
		if (optimalCell !== null) {
			this.leek.moveToward(optimalCell)
		} else {
			this.leek.moveToward(this.target)
		}
	}

	executeSimpleAdvance(): void {
		if (!this.leek.canUseWeapon(this.target)) {
			this.leek.moveToward(this.target)
		}
	}

	executeBehavior(behavior: string): void {
		switch (behavior) {
			case MOVEMENT_BEHAVIOR.RETREAT_TO_CORNER:
				this.executeRetreatToCorner()
				break
			case MOVEMENT_BEHAVIOR.AGGRESSIVE_KITING:
				this.executeAggressiveKiting()
				break
			case MOVEMENT_BEHAVIOR.ZONE_CONTROL:
				this.executeZoneControl()
				break
			case MOVEMENT_BEHAVIOR.TERRAIN_AWARE:
				this.executeTerrainAwareMoveToward()
				break
			case MOVEMENT_BEHAVIOR.SIMPLE_ADVANCE:
				this.executeSimpleAdvance()
				break
			default:
				this.leek.moveToward(this.target)
		}
	}

	private getEnemyMaxRange(): number {
		return this.enemyWeapon?.maxRange ?? 1
	}

	/**
	 * Cellule libre de repli : voisine de l'obstacle qui maximise
	 * `distance(ennemi, cellule) − 0,1 × distance(moi, cellule)`, et strictement plus loin de l'ennemi que moi.
	 * Retourne null (→ `moveAwayFrom`) si l'API de terrain manque ou si aucune cellule libre ne convient.
	 * Coût : 2 `Field.distance` par obstacle + au plus 4 `cellFromXY` et 8 distances pour les voisins.
	 */
	private findRetreatCell(): Cell | null {
		if (
			typeof Field === "undefined" ||
			typeof Field.getObstacles !== "function" ||
			typeof Field.cellFromXY !== "function"
		) {
			return null
		}

		const myCell = this.leek.cell
		const enemyCell = this.target.cell
		const currentDistance = Field.distance(myCell, enemyCell)

		let bestObstacle: Cell | null = null
		let bestScore = Number.NEGATIVE_INFINITY
		for (const obstacle of Field.getObstacles()) {
			const score = Field.distance(enemyCell, obstacle) -
				RETREAT_SELF_DISTANCE_WEIGHT * Field.distance(myCell, obstacle)
			if (score > bestScore) {
				bestScore = score
				bestObstacle = obstacle
			}
		}
		if (bestObstacle === null) {
			return null
		}

		let bestCell: Cell | null = null
		bestScore = Number.NEGATIVE_INFINITY
		for (const [dx, dy] of NEIGHBOR_OFFSETS) {
			const cell = Field.cellFromXY(bestObstacle.x + dx, bestObstacle.y + dy)
			if (cell === null || !cell.empty) {
				continue
			}
			const enemyDistance = Field.distance(enemyCell, cell)
			if (enemyDistance <= currentDistance) {
				continue
			}
			const score = enemyDistance - RETREAT_SELF_DISTANCE_WEIGHT * Field.distance(myCell, cell)
			if (score > bestScore) {
				bestScore = score
				bestCell = cell
			}
		}
		return bestCell
	}

	private findTerrainAwarePathToward(): Cell | null {
		const field = Field as any
		if (!field || typeof field.getObstacles !== "function") {
			return null
		}

		const obstacles: Cell[] = field.getObstacles()
		const targetWeapons = this.leek.chipCells(Chip.bandage, this.target)

		for (const cell of targetWeapons) {
			const isNearObstacle = obstacles.some((obs: Cell) => Field.distance(cell, obs) <= 2)
			if (isNearObstacle) {
				return cell
			}
		}

		return null
	}
}
