// @version:5.8
// file version: 6
import { springChestTrap } from "../Brain/ChestTrap.js"
import { equipOpeningWeapon } from "../Brain/OpeningWeapon.js"
import { planAct } from "../Brain/PlanActScenario.js"
import { greetOnce, startTurnSpeech, tellLeekLife } from "../Brain/TurnSpeech.js"
import { enemyMemory, mpBoostCandidate, observeTurn, recordMyTurnEnd, stagnation } from "../Brain/TurnObservation.js"
import { actionHistory } from "../Classes/Context/StagnationTracker.js"
import { LeekProfile } from "../Classes/LeekProfile.js"
import { OBJECTIVES } from "../Classes/Plannification/BookObjective.js"
import { planWithBook } from "../Classes/Plannification/BookPlanner.js"
import { StandoffTracker } from "../Classes/Plannification/BookStandoff.js"
import { aliveEnemies } from "../Classes/Context/Targets.js"
import { executeTacticalPlan } from "../Classes/Plannification/TacticalExecution.js"
import { logTurnOperations, reportError, withErrorReporting } from "../Toolbox/Debug.js"
import { initLeekLogging, log, LogConfig, LOG_CONTEXT } from "../Toolbox/Logger.js"

/** Configuration de journalisation de mon poireau : tous les contextes actifs. */
export const leekLogConfig = new LogConfig()
initLeekLogging(leekLogConfig)

/**
 * Objectif du faisceau : le SEUL réglage à changer pour essayer un autre profil (`damage` par défaut, `heal`, `support`,
 * `survival` ; voir `BookObjective.ts`). La survie reste une pénalité létale quel que soit le profil.
 */
const OBJECTIVE = OBJECTIVES.damage

/** Profil : seuils de soin, bouclier et repli du faisceau, et profil du repli (plan conjoint existant). */
const leekProfile = new LeekProfile()
leekProfile.setRole("AGGRESSIVE")
leekProfile.setAggression(50)
leekProfile.setSupportOptions(true, true, true)

/** Compteur de duel (`BookStandoff.ts`) : nourri à chaque tour, lu par le faisceau en posture AGGRESSIVE seulement. */
const standoff = new StandoffTracker()

/** Paroles : une erreur est journalisée sans interrompre le tour. */
function guarded(name: string, action: () => void): void {
	try {
		action()
	} catch (error) {
		reportError("src/Main/Kassbi_Book.ts", name, error)
	}
}

function operations(): number {
	return typeof System === "undefined" ? 0 : System.operations
}

/**
 * Tour de l'IA principale : le plan du tour est décidé par LECTURE de la table de combos (`CombatBook.ts`,
 * `BookPlanner.ts`) : cases de tir par index, boost de force par facteur, puis exécution par `executeTacticalPlan`.
 * Paroles : salutation au tour 1, récit du poireau avec les PT restants. Le plan est un faisceau de 5 enchaînements sur
 * 2 à 3 tours (`BookBeam.ts`), seul le tour 1 du meilleur est exécuté. Sans plan par table (données absentes, budget
 * coupé, aucune action utile), le plan conjoint gelé (`planAct`) joue : un tour n'est jamais perdu. Les opérations de
 * chaque phase sont journalisées (`[Book]`).
 */
export function turn(): void {
	withErrorReporting("src/Main/Kassbi_Book.ts", "turn", () => {
		const me = Fight.me
		log(`\n=== KASSBI BOOK TURN START ===`, LOG_CONTEXT.SYSTEM)
		startTurnSpeech()
		guarded("greeting", () => greetOnce(me))
		// Avant `observeTurn` : il ouvre le tour dans l'historique, `lastDealt` serait alors celui du tour qui commence (0).
		const dealtLastTurn = actionHistory.lastDealt
		observeTurn(me)
		if (!springChestTrap(me)) {
			const context = {
				reachable: enemyMemory.getReachable(me.id), threat: enemyMemory.getThreatMap(), stagnation,
				mpBoost: mpBoostCandidate(me)
			}
			try {
				standoff.observe(Fight.turn, me.life, aliveEnemies(), dealtLastTurn)
			} catch (error) {
				reportError("src/Main/Kassbi_Book.ts", "standoff", error)
			}
			const before = operations()
			let plan = null
			try {
				plan = planWithBook(me, context, leekProfile, { objective: OBJECTIVE, standoff })
			} catch (error) {
				reportError("src/Main/Kassbi_Book.ts", "planWithBook", error)
			}
			log(() => `[Book] planning ops: ${operations() - before}, plan ${plan === null ? "none" : "found"}`, LOG_CONTEXT.OPERATIONS)
			if (plan !== null) executeTacticalPlan(me, plan)
			else planAct(me, leekProfile, context)
		}
		equipOpeningWeapon(me)
		recordMyTurnEnd(me)
		actionHistory.end()
		// Après l'historique : les PT restants sont ceux que le plan n'a pas utilisés.
		guarded("tellLeekLife", () => tellLeekLife(me))
		log(`=== KASSBI BOOK TURN END ===\n`, LOG_CONTEXT.SYSTEM)
		logTurnOperations()
	})
}
