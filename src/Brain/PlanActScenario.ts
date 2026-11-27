// @version:5.8
// file version: 9
import { Plannification } from "../Classes/Plannification/Plannification.js"
import { nearestEnemy } from "../Classes/Context/Targets.js"
import { LeekProfile } from "../Classes/LeekProfile.js"
import { TacticalContext } from "../Classes/Plannification/TacticalTypes.js"
import { evaluateTacticalPlans } from "../Classes/Plannification/TacticalPlanner.js"
import { executeTacticalPlan } from "../Classes/Plannification/TacticalExecution.js"
import { log, LOG_CONTEXT } from "../Toolbox/Logger.js"
import { executeReservePlan } from "../Classes/Plannification/ReservePlan.js"

export function planAct(me: Me, profile = createDefaultProfile(), context?: TacticalContext): void {
	const target = nearestEnemy()
	if (target === null) {
		return
	}

	const tactical = evaluateTacticalPlans(me, profile, context)
	if (tactical.plan !== null) {
		executeTacticalPlan(me, tactical.plan)
		return
	}
	log(() => `[Plannification] SkipShootOrChip: [Tactical] fallback: ${tactical.reason}; legacy planning entry → bounded reserve`,
		LOG_CONTEXT.PLANNING)
	if (executeReservePlan(me, profile, context, tactical.preparation)) return
	log("[Plannification] Execute: [Tactical] reserve API unavailable; historical compatibility queue only; " +
		"destinations/danger/legality remain conditional, not a complete tactical plan", LOG_CONTEXT.PLANNING)

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
