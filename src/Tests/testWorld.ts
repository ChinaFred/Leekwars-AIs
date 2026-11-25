// @version:5.8
// file version: 2
import { log, LOG_CONTEXT } from "../Toolbox/Logger.js"
import { World } from "../Classes/Context/World.js"

export function inspectWorld(): World {
	const world = new World()
	log(() => world.cells, LOG_CONTEXT.DEBUG)
	return world
}
