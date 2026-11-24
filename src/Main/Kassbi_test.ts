// @version:5.8
// file version: 1
import { planAct } from "../Brain/PlanActScenario.js"
import { LeekProfile } from "../Classes/LeekProfile.js"

const profile = new LeekProfile()
profile.setRole("AGGRESSIVE")
profile.setAggression(75)
profile.setPreferredRange(2, 8)
profile.setSupportOptions(true, true, false)

export function turn(): void {
	planAct(Fight.me, profile)
}
