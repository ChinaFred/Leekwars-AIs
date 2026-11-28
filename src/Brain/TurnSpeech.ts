// @version:5.8
// file version: 1
import { log, LOG_CONTEXT } from "../Toolbox/Logger.js"
import { getRandomMessage, SPEECH, takeLeekLifeLines } from "../Toolbox/Speeches.js"

/** Le jeu n'affiche que 2 `say` par tour : au-delà, chacun coûte 1 PT pour rien. */
const MAX_SAYS_PER_TURN = 2
let saysThisTurn = 0
let greeted = false

/** À appeler au début de chaque tour : remet à zéro le compte de `say` du tour. */
export function startTurnSpeech(): void {
	saysThisTurn = 0
}

/** `say` compté dans la limite du tour. */
export function say(me: Me, message: string): void {
	me.say(message)
	saysThisTurn++
}

/** Salutation, une seule fois par combat (au premier appel). Retourne vrai si elle vient d'être dite. */
export function greetOnce(me: Me): boolean {
	if (greeted) return false
	greeted = true
	const greeting = getRandomMessage(SPEECH.GREETINGS)
	log(() => `[Speech] Greeting: "${greeting}"`, LOG_CONTEXT.SPEECH)
	say(me, greeting)
	return true
}

/** Fin de tour : un `say` du récit du poireau par PT non utilisé, dans la limite des `say` restants du tour. */
export function tellLeekLife(me: Me): void {
	const count = Math.min(me.tp, MAX_SAYS_PER_TURN - saysThisTurn)
	for (const line of takeLeekLifeLines(Math.max(0, count))) {
		log(() => `[Speech] Leek life: "${line}"`, LOG_CONTEXT.SPEECH)
		say(me, line)
	}
}
