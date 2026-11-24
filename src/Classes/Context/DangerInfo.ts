// @version:5.8
// file version: 1
export class DangerInfo<TKey = number> {
	key: TKey
	weight: number
	distance: number
	pathLength: number
	distanceToObstacle: number

	constructor(key: TKey)
	constructor(key: TKey, weight: number, distance: number, pathLength: number, distanceToObstacle: number)
	constructor(
		key: TKey,
		weight = 0,
		distance = 0,
		pathLength = 0,
		distanceToObstacle = 10_000
	) {
		this.key = key
		this.weight = weight
		this.distance = distance
		this.pathLength = pathLength
		this.distanceToObstacle = distanceToObstacle
	}

	add(one: DangerInfo<TKey>, two: DangerInfo<TKey>): DangerInfo<TKey> {
		return new DangerInfo<TKey>(
			one.key,
			one.weight + two.weight,
			one.distance,
			one.pathLength,
			one.distanceToObstacle
		)
	}
}
