// @version:5.8
// file version: 3
import { planAct } from "../Brain/PlanActScenario.js"
import { LeekProfile } from "../Classes/LeekProfile.js"
import { withErrorReporting } from "../Toolbox/Debug.js"
import { initLeekLogging, LogConfig } from "../Toolbox/Logger.js"

/** Configuration de journalisation de ce poireau d'essai : tous les contextes actifs par défaut. */
export const leekLogConfig = new LogConfig()
initLeekLogging(leekLogConfig)

export function turn(): void {
	withErrorReporting("src/Main/Kassbi_test.ts", "turn", () => {
		const profile = new LeekProfile()
		profile.setRole("AGGRESSIVE")
		profile.setAggression(75)
		profile.setPreferredRange(2, 8)
		profile.setSupportOptions(true, true, false)
		planAct(Fight.me, profile)
	})
}
