// @version:5.8
// file version: 3
export const SPEECH = {
	GREETINGS: 0,
	BEGIN: 1,
	DAMAGES: 2,
	NOT_SHOOT: 3,
	RIP: 4
} as const

export const SPEECH_LEEK_LIFE = [
  "Je suis né dans la terre, prêt à en découdre.",
  "J'ai poussé à la dure, sous la pluie et le vent.",
  "Dès le potager, j'ai compris la loi du plus fort.",
  "Mes racines ont appris à s'ancrer pour encaisser.",
  "On m'a arraché du sol, mais jamais du combat.",
  "Je n'ai pas grandi pour finir dans une soupe.",
  "Ma seule marmite, c'est l'arène.",
  "J'ai affûté mes feuilles comme des lames.",
  "Mon fût blanc encaisse les coups sans broncher.",
  "Chaque cicatrice sur mon vert est un trophée.",
  "J'ai déjà croqué plus d'un bulbe prétentieux.",
  "Les faibles finissent en rondelles ; moi je reste entier.",
  "Rien ne vaut le croquant d'un adversaire vaincu.",
  "J'absorbe la sève de ceux qui tombent devant moi.",
  "Un poireau qui hésite finit au menu du vainqueur.",
  "J'ai mangé des congénères bien plus gros que toi.",
  "Le goût de la victoire ressemble à du poireau frais.",
  "Tes feuilles vont bientôt nourrir ma prochaine attaque.",
  "Dans ce jardin, on dévore ou on est dévoré.",
  "Je ne quitte jamais un duel le ventre vide.",
  "Encore un combat, encore un rival à croquer.",
  "Ma légende s'écrit à coups de crocs et de chlorophylle.",
  "Je suis le prédateur ultime du potager.",
  "Approche ; j'ai justement un petit creux."
];
export const SPEECH_GREETINGS = [
  "Salut à vous.",
  "Bien le bonjour.",
  "Hi!",
  "Bonjour, voyageurs.",
  "Par ici, mes amis.",
  "Ravi de vous voir.",
  "Hé, par là!",
  "Bienvenue parmi nous.",
  "Salutations!",
  "On se retrouve enfin.",
  "À la bonne heure!",
  "Soyez les bienvenus."
];

export const SPEECH_BEGIN = [
  "Chargez!",
  "À l'assaut!",
  "Tayooooo",
  "Pour Kassbi'",
  "Sus à l'ennemi!",
  "En avant toute!",
  "Frappez sans relâche!",
  "C'est l'heure!",
  "Tous sur eux!",
  "Pas de quartier!",
  "Montrons-leur de quoi on est capables!",
  "Pour la victoire!"
];
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

/** Indice de la prochaine ligne de `SPEECH_LEEK_LIFE` : persiste d'un tour à l'autre. */
let leekLifeNext = 0

/** Les `count` lignes suivantes du récit du poireau, en repartant de la première après la dernière. */
export function takeLeekLifeLines(count: number): string[] {
	const lines: string[] = []
	for (let i = 0; i < count; i++) {
		lines.push(SPEECH_LEEK_LIFE[leekLifeNext])
		leekLifeNext = (leekLifeNext + 1) % SPEECH_LEEK_LIFE.length
	}
	return lines
}

export function getRandomMessageFromArr(messages: readonly string[]): string {
	if (messages.length === 0) {
		throw new RangeError("Cannot choose a message from an empty list")
	}
	return messages[Math.floor(Math.random() * messages.length)]
}
