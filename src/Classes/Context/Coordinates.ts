// @version:5.8
// file version: 1
export class Coordinates {
	readonly x: number
	readonly y: number
	readonly cell: Cell | null

	constructor()
	constructor(cell: Cell)
	constructor(x: number, y: number)
	constructor(cellOrX?: Cell | number, y?: number) {
		if (typeof cellOrX === "object" && cellOrX !== null) {
			this.cell = cellOrX
			this.x = cellOrX.x
			this.y = cellOrX.y
		} else if (typeof cellOrX === "number" && y !== undefined) {
			this.x = cellOrX
			this.y = y
			this.cell = Field.cellFromXY(this.x, this.y)
		} else {
			this.x = 0
			this.y = 0
			this.cell = Field.cellFromXY(0, 0)
		}
	}

	getDistance(other: Coordinates): number {
		return Field.distance(this.requireCell(), other.requireCell())
	}

	getPathLength(other: Coordinates): number | null {
		return Field.pathLength(this.requireCell(), other.requireCell())
	}

	mark(color: number): void {
		Debug.mark(this.requireCell(), color)
	}

	static getDistanceToCells(
		coordinates: Iterable<Coordinates>,
		position: Coordinates
	): Map<Coordinates, number | null> {
		const distances = new Map<Coordinates, number | null>()
		for (const coordinate of coordinates) {
			distances.set(coordinate, coordinate.getPathLength(position))
		}
		return distances
	}

	static getClosestCellFromSet(
		from: Coordinates,
		cells: Iterable<Coordinates>
	): Coordinates | null {
		let closest: Coordinates | null = null
		let minimumDistance = Number.POSITIVE_INFINITY
		for (const cell of cells) {
			const distance = from.getPathLength(cell)
			if (distance !== null && distance < minimumDistance) {
				closest = cell
				minimumDistance = distance
			}
		}
		return closest
	}

	static getFurthestCellFromSet(
		from: Coordinates,
		cells: Iterable<Coordinates>,
		obstacles: Iterable<Cell> = Field.getObstacles()
	): Coordinates | null {
		const blocked = new Set([...obstacles].map((cell) => cell.id))
		let furthest: Coordinates | null = null
		let maximumDistance = -1
		for (const cell of cells) {
			const nativeCell = cell.requireCell()
			if (blocked.has(nativeCell.id)) {
				continue
			}
			const distance = from.getPathLength(cell)
			if (distance !== null && distance > maximumDistance && distance !== 0) {
				furthest = cell
				maximumDistance = distance
			}
		}
		return furthest
	}

	static markArray(coordinates: Iterable<Coordinates>, color: number): void {
		Debug.mark([...coordinates].map((coordinate) => coordinate.requireCell()), color)
	}

	private requireCell(): Cell {
		if (this.cell === null) {
			throw new RangeError(`No field cell exists at (${this.x}, ${this.y})`)
		}
		return this.cell
	}
}
