// Tour du plan conjoint seul (le repli gelé du livre) : observation, piège du coffre, `planAct`, arme du tour 1, historique.
// Les tests du plan conjoint passent par ce tour plutôt que par `Kassbi_Book.turn()`, où le livre décide d'abord.
const { springChestTrap } = await import("../../dist/Brain/ChestTrap.js")
const { equipOpeningWeapon } = await import("../../dist/Brain/OpeningWeapon.js")
const { planAct } = await import("../../dist/Brain/PlanActScenario.js")
const { enemyMemory, mpBoostCandidate, observeTurn, recordMyTurnEnd, stagnation } = await import("../../dist/Brain/TurnObservation.js")
const { actionHistory } = await import("../../dist/Classes/Context/StagnationTracker.js")
const { LeekProfile } = await import("../../dist/Classes/LeekProfile.js")
const { initLeekLogging, LogConfig } = await import("../../dist/Toolbox/Logger.js")

initLeekLogging(new LogConfig())

/** Profil du plan conjoint : agressif, soin, bouclier et repli autorisés. Les tests le modifient. */
export const leekProfile = new LeekProfile(100)

export function turn() {
	const me = Fight.me
	observeTurn(me)
	if (!springChestTrap(me)) {
		planAct(me, leekProfile, {
			reachable: enemyMemory.getReachable(me.id),
			threat: enemyMemory.getThreatMap(),
			stagnation,
			mpBoost: mpBoostCandidate(me)
		})
	}
	equipOpeningWeapon(me)
	recordMyTurnEnd(me)
	actionHistory.end()
}
