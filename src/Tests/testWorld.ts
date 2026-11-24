// @version:5.8
// file version: 1
import { World } from "../Classes/Context/World.js"

export function inspectWorld(): World {
	const world = new World()
	Debug.log(world.cells)
	return world
}
