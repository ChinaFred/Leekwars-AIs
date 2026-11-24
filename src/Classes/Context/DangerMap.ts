// @version:5.8
// file version: 1
import { DangerInfo } from "./DangerInfo.js"

export const DANGER = {
	NO_SAFE_PLACE: -20_000,
	INITIAL_DANGER: 100
} as const

export const DANGER_COMPARISON = {
	EQUAL: 0,
	MIN_OR_EQUAL: 1,
	SUP_OR_EQUAL: 2,
	MIN: 3,
	SUP: 4
} as const

export interface WeaponThreat<TKey = number> {
	cells: Iterable<TKey>
	meanDamage: number
}

export class DangerMap<TKey = number> {
	readonly map = new Map<TKey, DangerInfo<TKey>>()
	maxDamage = 0

	initialize(cells: Iterable<TKey>): void {
		this.resetMap()
		for (const cell of cells) {
			if (typeof cell !== "number" || cell >= 0) {
				const info = new DangerInfo<TKey>(cell)
				info.weight = DANGER.INITIAL_DANGER
				this.map.set(cell, info)
			}
		}
	}

	resetMap(): void {
		this.map.clear()
	}

	replaceDangerInfo(cell: TKey, dangerInfo: DangerInfo<TKey>): void {
		this.map.delete(cell)
		this.map.set(cell, dangerInfo)
	}

	removeObstaclesFromMap(obstacles: Iterable<TKey>): void {
		for (const obstacle of obstacles) {
			this.map.delete(obstacle)
		}
	}

	getDangerWithMinWeight(): DangerInfo<TKey> | null {
		let min: DangerInfo<TKey> | null = null
		for (const danger of this.map.values()) {
			if (min === null || min.weight >= danger.weight) {
				min = danger
			}
		}
		return min
	}

	getCellFromDangerInfo(dangerInfo: DangerInfo<TKey>): TKey | null {
		for (const [cell, info] of this.map) {
			if (info === dangerInfo) {
				return cell
			}
		}
		return null
	}

	getCellsFromWeight(weight: number, comparison: number): Set<TKey> {
		const cells = new Set<TKey>()
		for (const [cell, danger] of this.map) {
			const matches =
				(comparison === DANGER_COMPARISON.EQUAL && danger.weight === weight) ||
				(comparison === DANGER_COMPARISON.MIN_OR_EQUAL && danger.weight <= weight) ||
				(comparison === DANGER_COMPARISON.MIN && danger.weight < weight) ||
				(comparison === DANGER_COMPARISON.SUP_OR_EQUAL && danger.weight >= weight) ||
				(comparison === DANGER_COMPARISON.SUP && danger.weight > weight)
			if (matches) {
				cells.add(cell)
			}
		}
		return cells
	}

	getFurthestLessDangerous(
		fromCell: TKey,
		reachableCells: Iterable<TKey>,
		pathLength: (from: TKey, to: TKey) => number | null,
		obstacles: Iterable<TKey> = []
	): TKey | null {
		const reachable = new Set(reachableCells)
		const blocked = new Set(obstacles)
		let minimumWeight = Number.POSITIVE_INFINITY
		for (const [cell, danger] of this.map) {
			if (reachable.has(cell) && !blocked.has(cell) && danger.weight < minimumWeight) {
				minimumWeight = danger.weight
			}
		}
		if (minimumWeight === Number.POSITIVE_INFINITY) {
			return null
		}

		let furthestCell: TKey | null = null
		let maxDistance = -1
		for (const [cell, danger] of this.map) {
			if (!reachable.has(cell) || blocked.has(cell) || danger.weight !== minimumWeight) {
				continue
			}
			const distance = pathLength(fromCell, cell)
			if (distance !== null && distance > maxDistance && distance !== 0) {
				furthestCell = cell
				maxDistance = distance
			}
		}
		return furthestCell
	}

	getPlaceToHide(
		reachableCells: Iterable<TKey>,
		enemyCell: TKey,
		pathLength: (from: TKey, to: TKey) => number | null,
		obstacles: Iterable<TKey> = []
	): TKey | null {
		const reachable = new Set(reachableCells)
		const dangerous = this.getCellsFromWeight(DANGER.INITIAL_DANGER, DANGER_COMPARISON.SUP)
		const safePlaces = new Set([...reachable].filter((cell) => !dangerous.has(cell)))
		if (safePlaces.size > 0) {
			const furthestSafePlace = getFurthestCell(enemyCell, safePlaces, pathLength, obstacles)
			if (furthestSafePlace !== null) {
				return furthestSafePlace
			}
		}
		return this.getFurthestLessDangerous(enemyCell, reachable, pathLength, obstacles)
	}

	buildDangerMap(threats: Iterable<WeaponThreat<TKey>>): Map<TKey, DangerInfo<TKey>> {
		for (const threat of threats) {
			const cells = new Set(threat.cells)
			if (cells.size === 0) {
				continue
			}
			if (threat.meanDamage > this.maxDamage) {
				this.maxDamage = threat.meanDamage
			}
			for (const cell of cells) {
				const danger = this.map.get(cell) ?? new DangerInfo(cell)
				danger.weight += threat.meanDamage
				this.map.set(cell, danger)
			}
		}
		return this.map
	}
}

function getFurthestCell<TKey>(
	fromCell: TKey,
	cells: Iterable<TKey>,
	pathLength: (from: TKey, to: TKey) => number | null,
	obstacles: Iterable<TKey>
): TKey | null {
	const blocked = new Set(obstacles)
	let furthestCell: TKey | null = null
	let maxDistance = -1
	for (const cell of cells) {
		if (blocked.has(cell)) {
			continue
		}
		const distance = pathLength(fromCell, cell)
		if (distance !== null && distance > maxDistance && distance !== 0) {
			furthestCell = cell
			maxDistance = distance
		}
	}
	return furthestCell
}
