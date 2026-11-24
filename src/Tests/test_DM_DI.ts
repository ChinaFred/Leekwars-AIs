// @version:5.8
// file version: 1
import { DangerInfo } from "../Classes/Context/DangerInfo.js"
import { DangerMap, DANGER_COMPARISON } from "../Classes/Context/DangerMap.js"
import { World } from "../Classes/Context/World.js"

export function inspectDangerMap(): {
	lowestDanger: DangerInfo<number> | null
	lowDangerCells: Set<number>
	placeToHide: number | null
} {
	const world = new World()
	const cells = world.cells
	const cellById = new Map(cells.map((cell) => [cell.id, cell]))
	const dangerMap = new DangerMap<number>()
	dangerMap.initialize(cells.map((cell) => cell.id))

	const first = cells[0]
	const second = cells[1]
	if (first !== undefined) {
		dangerMap.replaceDangerInfo(first.id, new DangerInfo(first.id, 20, 2, 3, 4))
	}
	if (second !== undefined) {
		dangerMap.replaceDangerInfo(second.id, new DangerInfo(second.id, 22, 2, 3, 4))
	}

	const pathLength = (from: number, to: number): number | null => {
		const fromCell = cellById.get(from)
		const toCell = cellById.get(to)
		return fromCell === undefined || toCell === undefined
			? null
			: Field.pathLength(fromCell, toCell)
	}
	const reachable = [first, second]
		.filter((cell): cell is Cell => cell !== undefined)
		.map((cell) => cell.id)
	const enemyCell = Fight.getNearestEnemy()?.cell

	return {
		lowestDanger: dangerMap.getDangerWithMinWeight(),
		lowDangerCells: dangerMap.getCellsFromWeight(22, DANGER_COMPARISON.MIN_OR_EQUAL),
		placeToHide: enemyCell === undefined
			? null
			: dangerMap.getPlaceToHide(
				reachable,
				enemyCell.id,
				pathLength,
				world.obstacles.map((cell) => cell.id)
			)
	}
}
