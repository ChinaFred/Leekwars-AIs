// @version:5.8
// file version: 1
export const SPEECH = {
	TAUNTS: 0,
	GREETINGS: 1,
	BEGIN: 2,
	DAMAGES: 3,
	NOT_SHOOT: 4,
	RIP: 5
} as const

export const SPEECH_TAUNTS = [
	"Je vais te dégorger",
	"Hahaha, tu ne me fais pas peur",
	"Tremble devant ma puissance",
	"Tu ne fais pas le poids",
	"Je te mangerai par les radicelles",
	"Je vais te hacher menu",
	"Je vais t'étuver",
	"Tu aimes le beurre? Car tu baigneras bientôt dedans",
	"Je vais te manger tout cru",
	"Un de nous deux est de trop dans ce potager",
	"T'as des vapeurs? T'es tout ramolli"
]

export const SPEECH_GREETINGS = ["Salut à vous.", "Bien le bonjour.", "Hi!"]
export const SPEECH_BEGIN = ["Chargez!", "À l'assaut!", "Tayooooo", "Pour Kassbi'"]
export const SPEECH_DAMAGES = [
	"Ça fait mal, hein!",
	"Prends ça!",
	"Eat this!",
	"T'en veux encore?",
	"Les coups et les douleurs cela ne se discute pas!"
]
export const SPEECH_NOT_SHOOT = [
	"Tu ne perds rien pour attendre",
	"Tu peux fuir mais je t'aurai",
	"Saigne déjà, j'arrive..."
]
export const SPEECH_RIP = [
	"Tu l'as bien méritée!",
	"Tu ne manqueras à personne.",
	"Je t'ai renvoyé au paradis des poireaux sans tête!",
	"Grille en enfer!"
]
export const SPEECH_DESIGNATE_TARGET = ["Sus à ", "On défonce ", "Tous sur "]
export const SPEECH_HELP = ["Help!", "S.O.S.", "Oufti, ça fait mal.", "Arg, je meurs."]

const speechGroups = [
	SPEECH_TAUNTS,
	SPEECH_GREETINGS,
	SPEECH_BEGIN,
	SPEECH_DAMAGES,
	SPEECH_NOT_SHOOT,
	SPEECH_RIP
]

export function getRandomMessage(type: number): string {
	const messages = speechGroups[type]
	if (messages === undefined) {
		throw new RangeError(`Unknown speech category: ${type}`)
	}
	return getRandomMessageFromArr(messages)
}

export function getRandomMessageFromArr(messages: readonly string[]): string {
	if (messages.length === 0) {
		throw new RangeError("Cannot choose a message from an empty list")
	}
	return messages[Math.floor(Math.random() * messages.length)]
}
