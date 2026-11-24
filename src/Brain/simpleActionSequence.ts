// @version:5.8
// file version: 1
export function simpleActionSequence(me: Me): void {
	const enemy = Fight.getNearestEnemy()
	if (enemy === null) {
		return
	}

	if (me.weapon === null) {
		me.setWeapon(Weapon.pistol)
	}

	const weapon = me.weapon
	if (weapon === null) {
		console.log("No equipped weapon is available")
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
