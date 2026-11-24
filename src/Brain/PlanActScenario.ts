// @version:5.8
// file version: 3
import { Plannification } from "../Classes/Plannification/Plannification.js"
import { LeekProfile } from "../Classes/LeekProfile.js"

export function planAct(me: Me, profile = createDefaultProfile()): void {
	const target = Fight.getNearestEnemy()
	if (target === null) {
		return
	}

	const plan = new Plannification(me, target, profile)
	plan.chooseWeapon()
	plan.planEquipWeapon()
	
	// THREAT-AWARE PLANNING ORDER:
	// If situation is critical (close + wounded), prioritize HIDE before exhausting MP on zone_control
	const lifeRatio = me.life / me.maxLife
	const distance = me.distance(target)
	const isCriticalSituation = distance <= 8 && lifeRatio <= 0.60
	
	if (isCriticalSituation && plan.strategy.shouldHide(lifeRatio, distance, profile.preferredMinRange)) {
		// Prioritize escape when in danger zone
		plan.planHide()
		plan.planChipsActionsAfterShoot()
		plan.planShootOrChip()
		plan.planMove()
	} else {
		// Normal order: move → shoot → chips → hide
		plan.planMove()
		plan.planShootOrChip()
		plan.planChipsActionsAfterShoot()
		plan.planHide()
	}
	
	plan.execute()
}

function createDefaultProfile(): LeekProfile {
	const profile = new LeekProfile()
	profile.setRole("BALANCED")
	profile.setAggression(50)
	profile.setPreferredRange(3, 8)
	profile.setSupportOptions(true, true, true)
	return profile
}
