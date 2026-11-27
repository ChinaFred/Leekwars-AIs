// @version:5.8
// file version: 10
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
	// Le plan B ne refuse que si `Field.cellFromXY`, `Fight.weaponCells` ou `me.canUseChip` manque (API du jeu actuel :
	// jamais observé en combat) : rien n'est tenté.
	log("[Plannification] Execute: [Tactical] reserve API unavailable; no action", LOG_CONTEXT.PLANNING)
}

function createDefaultProfile(): LeekProfile {
	const profile = new LeekProfile()
	profile.setRole("BALANCED")
	profile.setAggression(50)
	profile.setPreferredRange(3, 8)
	profile.setSupportOptions(true, true, true)
	return profile
}
