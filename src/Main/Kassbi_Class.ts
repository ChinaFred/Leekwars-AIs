// @version:5.8
// file version: 11
import { planAct } from "../Brain/PlanActScenario.js"
import { EnemyMemory } from "../Classes/Context/EnemyMemory.js"
import { logTurnOperations, reportError, withErrorReporting } from "../Toolbox/Debug.js"
import { initLeekLogging, isLogEnabled, log, LogConfig, LOG_CONTEXT } from "../Toolbox/Logger.js"
import { AccessibleZoneSource, showAccessibleZones, showDangerZone } from "../Toolbox/Marker.js"
import { getRandomMessage, SPEECH } from "../Toolbox/Speeches.js"

/**
 * Configuration de journalisation de mon poireau : créée avec TOUS les contextes actifs et installée dès
 * l'import. Pour couper un contexte : `leekLogConfig.setEnabled(LOG_CONTEXT.WEAPON, false)`.
 */
export const leekLogConfig = new LogConfig()
initLeekLogging(leekLogConfig)

let isFirstTurn = true

/** Mémoire et cartes du tour ; seules les cartes sont transmises à planAct. */
export const enemyMemory = new EnemyMemory()

/**
 * Identifie les ennemis vivants nouveaux et met à jour les connus. Une erreur est journalisée
 * mais n'interrompt pas le tour : la collecte de données ne doit jamais empêcher de jouer.
 */
function observeEnemies(me: Me): void {
	try {
		const turnNumber = Fight.turn
		const enemies = Fight.getAliveEnemies()
		for (const enemy of enemies) {
			if (!enemyMemory.has(enemy.id)) {
				const profile = enemyMemory.identify(enemy, turnNumber)
				log(
					() => `[EnemyMemory] Identified ${profile.name} (#${profile.id}) lvl ${profile.level}, ` +
						`${profile.maxLife} HP, ${profile.knownWeapons.length} weapons, ${profile.knownChips.length} chips`,
					LOG_CONTEXT.MEMORY
				)
			}
			const update = enemyMemory.update(enemy, me, turnNumber, enemies.length)
			if (update === null) {
				continue
			}
			if (update.newItems.length > 0) {
				log(() => `[EnemyMemory] ${enemy.name} observed: ${update.newItems.join(", ")}`, LOG_CONTEXT.MEMORY)
			}
			if (update.hit !== null && update.hit.item !== null) {
				const hit = update.hit
				log(
					() => `[EnemyMemory] ${enemy.name} hit ${hit.amount} with ${hit.item?.name} (${hit.source})`,
					LOG_CONTEXT.MEMORY
				)
			}
		}
	} catch (error) {
		reportError("src/Main/Kassbi_Class.ts", "observeEnemies", error)
	}
}

/**
 * Calcule les cases atteignables utilisées par le planificateur et les visualisations.
 * Une erreur est journalisée sans interrompre le tour. Un seul log court par tour.
 */
function observeReachableCells(me: Me): void {
	try {
		const allies = Fight.getAllies().filter((ally) => ally.id !== me.id)
		const updates = enemyMemory.updateReachable(me, allies, Fight.getAliveEnemies(), Fight.turn)
		log(() => {
			const summary = updates
				.map((update) => {
					const who = update.side === "me" ? "me" : `${update.side}#${update.entityId}`
					return `${who}:${update.size}${update.truncated ? "+" : ""} (${update.mp} MP)`
				})
				.join(", ")
			return `[Reachable] ${summary}`
		}, LOG_CONTEXT.REACHABLE)
	} catch (error) {
		reportError("src/Main/Kassbi_Class.ts", "observeReachableCells", error)
	}
}

/**
 * Calcule la carte de danger utilisée par planAct à partir des cases atteignables.
 * Une erreur est journalisée sans interrompre le tour. Un seul log court par tour ; son coût
 * est inclus dans la ligne d'opérations de `logTurnOperations`.
 */
function observeThreatMap(me: Me): void {
	try {
		const update = enemyMemory.updateThreatMap(me, Fight.getAliveEnemies(), Fight.turn)
		if (update === null) {
			log("[Threat] unavailable", LOG_CONTEXT.THREAT)
			return
		}
		log(() => {
			const safest = update.safestCell === null ? "none" : `(${update.safestCell.x},${update.safestCell.y})`
			return `[Threat] ${update.size}/${update.candidateCells} cells, danger max ${update.maxDanger.toFixed(1)} ` +
				`min ${update.minDanger.toFixed(1)}, safest ${safest}, ${update.enemies} armed enemies, ` +
				`${update.pairsEvaluated} pairs, ${update.lineOfSightCalls} LoS${update.truncated ? ", TRUNCATED" : ""}`
		}, LOG_CONTEXT.THREAT)
	} catch (error) {
		reportError("src/Main/Kassbi_Class.ts", "observeThreatMap", error)
	}
}

/**
 * Affichage visuel (contexte ACCESSIBLE_ZONE) de la zone accessible de chaque poireau vivant, dans l'ordre moi,
 * alliés, ennemis, à partir des cases déjà calculées par `observeReachableCells` (aucun appel API de plus pour
 * les cases). Sans effet (et sans calcul) si le contexte est inactif. Aucun effet sur planAct ; une erreur est
 * journalisée sans interrompre le tour.
 */
function displayAccessibleZones(me: Me): void {
	try {
		if (!isLogEnabled(LOG_CONTEXT.ACCESSIBLE_ZONE)) {
			return
		}
		const seen = new Set<number>([me.id])
		const sources: AccessibleZoneSource[] = [
			{ name: me.name, side: "me", reachable: enemyMemory.getReachable(me.id) }
		]
		for (const ally of Fight.getAllies()) {
			if (seen.has(ally.id) || !(ally.life > 0)) {
				continue
			}
			seen.add(ally.id)
			sources.push({ name: ally.name, side: "ally", reachable: enemyMemory.getReachable(ally.id) })
		}
		for (const enemy of Fight.getAliveEnemies()) {
			if (seen.has(enemy.id) || !(enemy.life > 0)) {
				continue
			}
			seen.add(enemy.id)
			sources.push({ name: enemy.name, side: "enemy", reachable: enemyMemory.getReachable(enemy.id) })
		}
		showAccessibleZones(sources)
	} catch (error) {
		reportError("src/Main/Kassbi_Class.ts", "displayAccessibleZones", error)
	}
}

/**
 * Affichage visuel (contexte DANGER_ZONE) de la carte de danger calculée par `observeThreatMap`. Sans effet si
 * le contexte est inactif ou si la carte est absente. Aucun effet sur planAct.
 */
function displayDangerZone(): void {
	try {
		if (!isLogEnabled(LOG_CONTEXT.DANGER_ZONE)) {
			return
		}
		showDangerZone(enemyMemory.getThreatMap())
	} catch (error) {
		reportError("src/Main/Kassbi_Class.ts", "displayDangerZone", error)
	}
}

function recordMyTurnEnd(me: Me): void {
	try {
		enemyMemory.endMyTurn(me, Fight.turn)
	} catch (error) {
		reportError("src/Main/Kassbi_Class.ts", "recordMyTurnEnd", error)
	}
}

export function turn(): void {
	withErrorReporting("src/Main/Kassbi_Class.ts", "turn", () => {
		const me = Fight.me
		const target = Fight.getNearestEnemy()

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

		observeEnemies(me)
		observeReachableCells(me)
		displayAccessibleZones(me)
		observeThreatMap(me)
		displayDangerZone()

		planAct(me, undefined, {
			reachable: enemyMemory.getReachable(me.id),
			threat: enemyMemory.getThreatMap()
		})

		recordMyTurnEnd(me)

		log(`=== KASSBI TURN END ===\n`, LOG_CONTEXT.SYSTEM)
		// En dernier : le total inclut tout sauf ce log (quelques opérations).
		logTurnOperations()
	})
}

