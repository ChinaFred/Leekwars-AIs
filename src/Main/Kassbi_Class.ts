// @version:5.8
// file version: 5
import { planAct } from "../Brain/PlanActScenario.js"
import { EnemyMemory } from "../Classes/Context/EnemyMemory.js"
import { reportError, withErrorReporting } from "../Toolbox/Debug.js"
import { getRandomMessage, SPEECH } from "../Toolbox/Speeches.js"

let isFirstTurn = true

/** Mémoire de l'adversaire : collecte seule, non transmise à planAct (aucun effet sur la tactique). */
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
				console.log(
					`[EnemyMemory] Identified ${profile.name} (#${profile.id}) lvl ${profile.level}, ` +
					`${profile.maxLife} HP, ${profile.knownWeapons.length} weapons, ${profile.knownChips.length} chips`
				)
			}
			const update = enemyMemory.update(enemy, me, turnNumber, enemies.length)
			if (update === null) {
				continue
			}
			if (update.newItems.length > 0) {
				console.log(`[EnemyMemory] ${enemy.name} observed: ${update.newItems.join(", ")}`)
			}
			if (update.hit !== null && update.hit.item !== null) {
				console.log(
					`[EnemyMemory] ${enemy.name} hit ${update.hit.amount} with ${update.hit.item.name} (${update.hit.source})`
				)
			}
		}
	} catch (error) {
		reportError("src/Main/Kassbi_Class.ts", "observeEnemies", error)
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

		console.log(`\n=== KASSBI TURN START ===`)
		console.log(`My HP: ${me.life}/${me.maxLife}, TP: ${me.tp}, MP: ${me.mp}`)
		if (target) {
			console.log(`Enemy: ${target.name}, HP: ${target.life}/${target.maxLife}, Distance: ${me.distance(target)}`)
		}

		if (isFirstTurn) {
			const greeting = getRandomMessage(SPEECH.GREETINGS)
			console.log(`[Speech] Greeting: "${greeting}"`)
			me.say(greeting)
			isFirstTurn = false
		}

		if (target !== null) {
			const lifePercentage = (target.life / target.maxLife) * 100
			console.log(`Enemy HP: ${lifePercentage.toFixed(1)}%`)

			if (target.life > 0 && target.maxLife > 0 && lifePercentage <= 15) {
				const taunt = getRandomMessage(SPEECH.TAUNTS)
				console.log(`[Speech] Taunt (${lifePercentage.toFixed(1)}% HP): "${taunt}"`)
				me.say(taunt)
			}
		}

		observeEnemies(me)

		planAct(me)

		recordMyTurnEnd(me)

		console.log(`=== KASSBI TURN END ===\n`)
	})
}

