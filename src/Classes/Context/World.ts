// @version:5.8
// file version: 1
export class World {
	private readonly cellCache: Cell[]

	constructor() {
		this.cellCache = []
		for (let x = -17; x <= 17; x++) {
			for (let y = -17; y <= 17; y++) {
				if (Math.abs(x) + Math.abs(y) > 17) {
					continue
				}
				const cell = Field.cellFromXY(x, y)
				if (cell !== null) {
					this.cellCache.push(cell)
				}
			}
		}
	}

	get enemies(): Entity[] {
		return Fight.getEnemies()
	}

	get aliveEnemies(): Entity[] {
		return Fight.getAliveEnemies()
	}

	get allies(): Entity[] {
		return Fight.getAllies()
	}

	get cells(): Cell[] {
		return this.cellCache
	}

	get obstacles(): Cell[] {
		return Field.getObstacles()
	}

	get cellsWithoutObstacles(): Cell[] {
		const obstacles = new Set(this.obstacles.map((cell) => cell.id))
		return this.cells.filter((cell) => !obstacles.has(cell.id))
	}

	getEnemiesById(id: number): Entity[] {
		return this.enemies.filter((enemy) => enemy.id === id)
	}
}
