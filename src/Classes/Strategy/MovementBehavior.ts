// @version:5.8
// file version: 1
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
		const safeCorner = this.findNearestCorner()
		if (safeCorner !== null) {
			this.leek.moveToward(safeCorner)
		} else {
			this.leek.moveAwayFrom(this.target)
		}
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

	executeZoneControl(): void {
		if (!this.leek.canUseWeapon(this.target)) {
			this.leek.moveToward(this.target)
			return
		}

		const distance = this.leek.distance(this.target)
		const enemyMaxRange = this.enemyWeapon?.maxRange ?? 1

		if (distance < enemyMaxRange) {
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

	private findNearestCorner(): Cell | null {
		const field = Field as any
		if (!field || typeof field.getObstacles !== "function") {
			return null
		}

		const obstacles = field.getObstacles()
		const me = this.leek

		let bestCorner: Cell | null = null
		let bestScore = Number.NEGATIVE_INFINITY

		for (const obstacle of obstacles) {
			const scoreAwayFromEnemy = this.leek.distance(this.target) - this.target.distance(obstacle)
			const scoreDistance = Field.distance(me.cell, obstacle)

			const score = scoreAwayFromEnemy - scoreDistance * 0.1

			if (score > bestScore) {
				bestScore = score
				bestCorner = obstacle
			}
		}

		return bestCorner
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
