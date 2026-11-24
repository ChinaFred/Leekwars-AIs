// @version:5.8
// file version: 4
import { planAct } from "../Brain/PlanActScenario.js"
import { withErrorReporting } from "../Toolbox/Debug.js"
import { getRandomMessage, SPEECH } from "../Toolbox/Speeches.js"

let isFirstTurn = true

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

		planAct(me)

		console.log(`=== KASSBI TURN END ===\n`)
	})
}

