// @version:5.8
// file version: 3
import { log, LOG_CONTEXT } from "../Toolbox/Logger.js"
import { nearestEnemy } from "../Classes/Context/Targets.js"

export function simpleActionSequence(me: Me): void {
	const enemy = nearestEnemy()
	if (enemy === null) {
		return
	}

	if (me.weapon === null) {
		me.setWeapon(Weapon.pistol)
	}

	const weapon = me.weapon
	if (weapon === null) {
		log("No equipped weapon is available", LOG_CONTEXT.WEAPON)
		return
	}

	while (me.mp > 0 && me.tp >= weapon.cost && !me.canUseWeapon(enemy)) {
		const previousMp = me.mp
		me.moveToward(enemy)
		if (me.mp >= previousMp) {
			break
		}
	}
	while (me.canUseWeapon(enemy)) {
		me.useWeapon(enemy)
	}
	me.moveAwayFrom(enemy)
}
