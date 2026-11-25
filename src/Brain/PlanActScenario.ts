// @version:5.8
// file version: 5
import { Plannification } from "../Classes/Plannification/Plannification.js"
import { LeekProfile } from "../Classes/LeekProfile.js"
import { TacticalContext, evaluateTacticalPlans, executeTacticalPlan } from "../Classes/Plannification/TacticalPlanner.js"
import { log, LOG_CONTEXT } from "../Toolbox/Logger.js"

export function planAct(me: Me, profile = createDefaultProfile(), context?: TacticalContext): void {
	const target = Fight.getNearestEnemy()
	if (target === null) {
		return
	}

	const tactical = evaluateTacticalPlans(me, profile, context)
	if (tactical.plan !== null) {
		executeTacticalPlan(me, tactical.plan)
		return
	}
	log(() => `[Plannification] SkipShootOrChip: [Tactical] fallback: ${tactical.reason}; legacy planning`,
		LOG_CONTEXT.PLANNING)

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

	// Recul après tir : planifié en dernier dans les deux ordres. No-op si planHide ou planMove
	// ont déjà consommé les PM (mpLeft = 0), donc l'ordre critique n'est pas modifié.
	plan.planRetreatAfterShoot()

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
