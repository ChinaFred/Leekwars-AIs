// @version:5.8
// file version: 32
import { springChestTrap } from "../Brain/ChestTrap.js"
import { equipOpeningWeapon } from "../Brain/OpeningWeapon.js"
import { planAct } from "../Brain/PlanActScenario.js"
import { greetOnce, say, startTurnSpeech, tellLeekLife } from "../Brain/TurnSpeech.js"
import { logChipInventory } from "../Brain/StrengthBoost.js"
import { enemyMemory, observeTurn, mpBoostCandidate, recordMyTurnEnd, stagnation } from "../Brain/TurnObservation.js"
import { actionHistory } from "../Classes/Context/StagnationTracker.js"
import { LeekProfile } from "../Classes/LeekProfile.js"
import { nearestEnemy } from "../Classes/Context/Targets.js"
import { logTurnOperations, reportError, withErrorReporting } from "../Toolbox/Debug.js"
import { initLeekLogging, log, LogConfig, LOG_CONTEXT } from "../Toolbox/Logger.js"
import { getRandomMessage, SPEECH } from "../Toolbox/Speeches.js"

/**
 * Configuration de journalisation de mon poireau : créée avec TOUS les contextes actifs et installée dès
 * l'import. Pour couper un contexte : `leekLogConfig.setEnabled(LOG_CONTEXT.WEAPON, false)`.
 */
export const leekLogConfig = new LogConfig()
initLeekLogging(leekLogConfig)

/**
 * Comportement de mon poireau : LE point de réglage, lu par `planAct` à chaque tour. Le rôle (`BALANCED`,
 * `AGGRESSIVE`, `DEFENSIVE`) et l'agressivité (0–100) fixent les seuils de soin, de bouclier et de repli, et la
 * posture du plan conjoint (`posture`, `TacticalScore.ts`) : poids du danger, poids de l'approche, plancher de
 * passivité, recul sans tir, arme visée par le trajet futur. `AGGRESSIVE` va à portée de sa meilleure arme et ne
 * recule qu'après avoir tiré ; `DEFENSIVE` reste à couvert ; `BALANCED` est entre les deux. Les trois
 * options autorisent soin, bouclier, repli. Effets détaillés :
 * `docs/strategies.md` (« Comportement configuré »).
 */
export const leekProfile = new LeekProfile()
leekProfile.setRole("AGGRESSIVE")
leekProfile.setAggression(100)
leekProfile.setSupportOptions(true, true, true)

let isFirstTurn = true

/** Exécute une étape annexe du tour : une erreur est journalisée (`ERROR`) sans interrompre le tour. */
function guarded(name: string, action: () => void): void {
	try {
		action()
	} catch (error) {
		reportError("src/Main/Kassbi_Class.ts", name, error)
	}
}

/**
 * Préambule du tour : PV et distance de l'ennemi le plus proche, salutation et inventaire des puces au premier
 * tour, provocation sous 15 % de PV. Journal et paroles uniquement : rien n'y est décidé.
 */
function announceTurn(me: Me): void {
	const target = nearestEnemy()

	log(() => `My HP: ${me.life}/${me.maxLife}, TP: ${me.tp}, MP: ${me.mp}`, LOG_CONTEXT.COMBAT)
	if (target) {
		log(
			() => `Enemy: ${target.name}, HP: ${target.life}/${target.maxLife}, Distance: ${me.distance(target)}`,
			LOG_CONTEXT.COMBAT
		)
	}

	if (isFirstTurn) {
		greetOnce(me)
		try {
			logChipInventory(me)
		} catch (error) {
			reportError("src/Brain/StrengthBoost.ts", "logChipInventory", error)
		}
		isFirstTurn = false
	}

	if (target !== null) {
		const lifePercentage = (target.life / target.maxLife) * 100
		log(() => `Enemy HP: ${lifePercentage.toFixed(1)}%`, LOG_CONTEXT.COMBAT)

		if (target.life > 0 && target.maxLife > 0 && lifePercentage <= 15) {
			const taunt = getRandomMessage(SPEECH.TAUNTS)
			log(() => `[Speech] Taunt (${lifePercentage.toFixed(1)}% HP): "${taunt}"`, LOG_CONTEXT.SPEECH)
			say(me, taunt)
		}
	}
}

export function turn(): void {
	withErrorReporting("src/Main/Kassbi_Class.ts", "turn", () => {
		const me = Fight.me
		log(`\n=== KASSBI TURN START ===`, LOG_CONTEXT.SYSTEM)
		startTurnSpeech()
		// Journal et paroles : une erreur y est journalisée, le tour continue vers l'observation et le plan.
		guarded("announceTurn", () => announceTurn(me))

		// Observation du tour (mémoire, coffres, cartes, stagnation, historique) : `src/Brain/TurnObservation.ts`.
		observeTurn(me)
		// Piège du coffre : frapper un coffre contesté puis fuir remplace le plan du tour. Sinon, toutes les décisions
		// d'action du tour (tous les boosts, PM compris) sont prises dans le plan : on observe, compare, planifie, exécute.
		if (!springChestTrap(me)) {
			planAct(me, leekProfile, {
				reachable: enemyMemory.getReachable(me.id),
				threat: enemyMemory.getThreatMap(),
				stagnation,
				mpBoost: mpBoostCandidate(me)
			})
		}

		// Après le plan : l'équipement du tour 1 n'utilise que des PT non dépensés par le plan.
		equipOpeningWeapon(me)
		recordMyTurnEnd(me)
		// Ligne `[History]` du tour, avant la ligne d'opérations : son coût est compris dans le total.
		actionHistory.end()
		// Après l'historique : les PT restants sont ceux que le plan n'a pas utilisés.
		guarded("tellLeekLife", () => tellLeekLife(me))

		log(`=== KASSBI TURN END ===\n`, LOG_CONTEXT.SYSTEM)
		// En dernier : le total inclut tout sauf ce log (quelques opérations).
		logTurnOperations()
	})
}

