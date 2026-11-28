// @version:5.8
// file version: 6
import { planAct } from "../Brain/PlanActScenario.js"
import { enemyMemory, observeTurn, recordMyTurnEnd, stagnation } from "../Brain/TurnObservation.js"
import { actionHistory } from "../Classes/Context/StagnationTracker.js"
import { LeekProfile } from "../Classes/LeekProfile.js"
import { withErrorReporting } from "../Toolbox/Debug.js"
import { initLeekLogging, LogConfig } from "../Toolbox/Logger.js"

/** Configuration de journalisation de ce poireau d'essai : tous les contextes actifs par défaut. */
export const leekLogConfig = new LogConfig()
initLeekLogging(leekLogConfig)

/**
 * Variante d'essai : même observation et même contexte de plan que `Kassbi_Class.turn()` (cases atteignables, carte de
 * danger, stagnation, historique), avec son propre profil ; sans boost de PM d'avant plan ni arme du tour 1.
 */
export function turn(): void {
	withErrorReporting("src/Main/Kassbi_test.ts", "turn", () => {
		const me = Fight.me
		const profile = new LeekProfile(75)
		profile.allowHiding = false

		observeTurn(me)
		planAct(me, profile, {
			reachable: enemyMemory.getReachable(me.id),
			threat: enemyMemory.getThreatMap(),
			stagnation
		})
		// Références du tour suivant (dégâts subis) et ligne `[History]` du tour ouvert par `observeTurn`.
		recordMyTurnEnd(me)
		actionHistory.end()
	})
}
