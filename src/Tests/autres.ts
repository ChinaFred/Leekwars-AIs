// @version:5.8
// file version: 1
import { Leek } from "../Classes/Leek.js"
import { ShootingOptions } from "../Classes/Plannification/ShootingOptions.js"

export function exploreShootingOptions(): ShootingOptions {
	const me = Fight.me
	const leek = new Leek(me)
	leek.setTarget(Fight.getNearestEnemy())
	const options = new ShootingOptions()
	options.exploreOptions(me, leek.target)
	if (leek.target !== null) {
		me.moveToward(leek.target)
	}
	return options
}
