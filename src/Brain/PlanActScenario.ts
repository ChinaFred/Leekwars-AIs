// @version:5.8
// file version: 1
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
	plan.planChipsActions()
	plan.planMove()
	plan.planShootOrChip()
	plan.planHide()
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
