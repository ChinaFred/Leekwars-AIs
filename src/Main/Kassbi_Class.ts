// @version:5.8
// file version: 3
import { planAct } from "../Brain/PlanActScenario.js"
import { withErrorReporting } from "../Toolbox/Debug.js"
import { getRandomMessage, SPEECH } from "../Toolbox/Speeches.js"

let isFirstTurn = true

export function turn(): void {
	withErrorReporting("src/Main/Kassbi_Class.ts", "turn", () => {
		const me = Fight.me

		if (isFirstTurn) {
			me.say(getRandomMessage(SPEECH.GREETINGS))
			isFirstTurn = false
		}

		const target = Fight.getNearestEnemy()
		const isNearlyDead = target !== null && target.life / target.maxLife <= 0.15

		if (isNearlyDead && target !== null) {
			me.say(getRandomMessage(SPEECH.TAUNTS))
		}

		planAct(me)
	})
}

