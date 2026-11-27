// @version:5.8
// file version: 23
import { equipOpeningWeapon } from "../Brain/OpeningWeapon.js"
import { planAct } from "../Brain/PlanActScenario.js"
import { decideMpBoost, logChipInventory } from "../Brain/StrengthBoost.js"
import { enemyMemory, observeTurn, recordMyTurnEnd, refreshMaps, stagnation } from "../Brain/TurnObservation.js"
import { actionHistory } from "../Classes/Context/StagnationTracker.js"
import { LeekProfile } from "../Classes/LeekProfile.js"
import { aliveEnemies, nearestEnemy } from "../Classes/Context/Targets.js"
import { TACTICAL_LIMITS } from "../Classes/Plannification/TacticalTypes.js"
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
 * `AGGRESSIVE`, `DEFENSIVE`) et l'agressivité (0–100) fixent le poids du danger et les seuils de soin, de bouclier
 * et de repli ; la portée préférée minimale définit « trop près » ; les trois options autorisent soin, bouclier,
 * repli. Effets détaillés : `docs/strategies.md`.
 */
export const leekProfile = new LeekProfile()
leekProfile.setRole("AGGRESSIVE")
leekProfile.setAggression(50)
leekProfile.setPreferredRange(3, 8)
leekProfile.setSupportOptions(true, true, true)

let isFirstTurn = true

/**
 * Boost de PM : seule action décidée AVANT le plan, parce qu'elle en change les entrées (cases atteignables, carte de
 * danger). Décision et motif (`decideMpBoost`) journalisés avant le lancer ; puis les deux cartes sont recalculées avec
 * les PM et PT réels, que le lancer ait réussi ou non. Une erreur est journalisée sans interrompre le tour.
 */
function castMpBoost(me: Me): void {
	try {
		const decision = decideMpBoost(me, enemyMemory.getReachable(me.id), aliveEnemies(), TACTICAL_LIMITS.cells)
		const option = decision.option
		if (option === null) {
			if (decision.reason !== "") {
				log(() => `[Boost] MP: not cast: ${decision.reason}`, LOG_CONTEXT.CHIP)
			}
			return
		}
		const chip = option.chip
		log(() => `[Boost] MP: casting ${chip.name} (+${option.gain} MP, ${chip.cost} TP) before the plan: ${decision.reason}`,
			LOG_CONTEXT.CHIP)
		const result = actionHistory.track(me, chip, me, () => me.useChip(chip, me))
		log(() => `[Boost] MP: ${chip.name} result ${result}; now ${me.mp} MP, ${me.tp} TP`, LOG_CONTEXT.CHIP)
		refreshMaps(me)
	} catch (error) {
		reportError("src/Main/Kassbi_Class.ts", "castMpBoost", error)
	}
}

export function turn(): void {
	withErrorReporting("src/Main/Kassbi_Class.ts", "turn", () => {
		const me = Fight.me
		const target = nearestEnemy()

		log(`\n=== KASSBI TURN START ===`, LOG_CONTEXT.SYSTEM)
		log(() => `My HP: ${me.life}/${me.maxLife}, TP: ${me.tp}, MP: ${me.mp}`, LOG_CONTEXT.COMBAT)
		if (target) {
			log(
				() => `Enemy: ${target.name}, HP: ${target.life}/${target.maxLife}, Distance: ${me.distance(target)}`,
				LOG_CONTEXT.COMBAT
			)
		}

		if (isFirstTurn) {
			const greeting = getRandomMessage(SPEECH.GREETINGS)
			log(() => `[Speech] Greeting: "${greeting}"`, LOG_CONTEXT.SPEECH)
			me.say(greeting)
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
				me.say(taunt)
			}
		}

		// Observation du tour (mémoire, coffres, cartes, stagnation, historique) : `src/Brain/TurnObservation.ts`.
		observeTurn(me)
		// Après l'ouverture de l'historique (le lancer y figure), avant le plan (il reçoit les cartes recalculées).
		castMpBoost(me)

		// Toutes les autres décisions du tour (boosts de force et de PT compris) sont prises dans le plan.
		planAct(me, leekProfile, {
			reachable: enemyMemory.getReachable(me.id),
			threat: enemyMemory.getThreatMap(),
			stagnation
		})

		// Après le plan : l'équipement du tour 1 n'utilise que des PT non dépensés par le plan.
		equipOpeningWeapon(me)
		recordMyTurnEnd(me)
		// Ligne `[History]` du tour, avant la ligne d'opérations : son coût est compris dans le total.
		actionHistory.end()

		log(`=== KASSBI TURN END ===\n`, LOG_CONTEXT.SYSTEM)
		// En dernier : le total inclut tout sauf ce log (quelques opérations).
		logTurnOperations()
	})
}

