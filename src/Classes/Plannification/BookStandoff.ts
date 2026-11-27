// @version:5.8
// file version: 3
import { PASSIVE_RISK_STEP } from "../Context/StagnationTracker.js"

/**
 * Compteur de duel (« progrès net »), indépendant de la passivité de `StagnationTracker.ts` : un duel où chacun soigne ce
 * que l'autre inflige n'est pas « passif » (des dégâts sont faits) mais ne mène nulle part (combat 55005067 : 2479 infligés,
 * 2269 soignés, net 210 en 64 tours). Entrée : mes PV et les PV adverses au DÉBUT de chaque de mes tours (soins compris), et
 * les dégâts que j'ai infligés au tour précédent. Sans ces dégâts, une approche de 6 tours (aucun coup échangé) ou un refus
 * de combat (passivité, `StagnationTracker.ts`) passerait pour un duel : sur les combats archivés, 4 des 16 combats gagnés
 * franchissaient le seuil par les PV seuls (approche) et un seul franchit encore le seuil avec les dégâts (54992730, 1 fenêtre).
 */
/** Nombre de débuts de tour observés pour juger le duel. */
export const STANDOFF_WINDOW = 6
/** Baisse des PV adverses (part de leur maximum) sur la fenêtre sous laquelle le duel est bloqué. */
export const STANDOFF_MIN_NET_FRACTION = 0.15
/** Hausse de la limite létale acceptée par tour de duel au-delà de la fenêtre. */
export const STANDOFF_ACCEPT_STEP = 0.25
/** Plafond de la limite létale acceptée (× mes PV). */
export const STANDOFF_ACCEPT_MAX = 2.0
/** Un danger exposé d'au moins ce multiple de mes PV n'est JAMAIS accepté, duel ou non. */
export const STANDOFF_NEVER_EXPOSED = 2.0

interface Observation {
	readonly turn: number
	readonly life: number
	readonly enemyLife: number
	readonly enemyMax: number
	/** Dégâts que j'ai infligés pendant mon tour précédent. */
	readonly dealt: number
}

export class StandoffTracker {
	private history: Observation[] = []
	private streak = 0
	private streakBefore = 0

	/** À appeler une fois par tour, avant de planifier ; un second appel du même tour remplace le premier. */
	observe(turn: number, myLife: number, enemies: ReadonlyArray<{ life: number; maxLife: number }>, dealt = 0): void {
		const last = this.history[this.history.length - 1]
		if (last !== undefined && last.turn === turn) { this.history.pop(); this.streak = this.streakBefore }
		else if (last !== undefined && last.turn > turn) { this.history = []; this.streak = 0 }
		this.streakBefore = this.streak
		this.history.push({
			turn, life: myLife, enemyLife: enemies.reduce((sum, enemy) => sum + Math.max(0, enemy.life), 0),
			enemyMax: enemies.reduce((sum, enemy) => sum + Math.max(0, enemy.maxLife), 0), dealt: Math.max(0, dealt)
		})
		if (this.history.length > STANDOFF_WINDOW) this.history.shift()
		this.streak = this.blocked() ? this.streak + 1 : 0
	}

	/**
	 * Mes PV n'ont pas baissé, j'ai infligé au moins `STANDOFF_MIN_NET_FRACTION` de leur maximum en dégâts bruts sur la fenêtre,
	 * et les PV adverses ont pourtant baissé de moins que cela (les soins annulent les dégâts).
	 */
	private blocked(): boolean {
		if (this.history.length < STANDOFF_WINDOW) return false
		const first = this.history[0]!
		const last = this.history[this.history.length - 1]!
		const dealt = this.history.slice(1).reduce((sum, observation) => sum + observation.dealt, 0)
		return last.life >= first.life && first.enemyMax > 0 && dealt >= STANDOFF_MIN_NET_FRACTION * first.enemyMax &&
			first.enemyLife - last.enemyLife < STANDOFF_MIN_NET_FRACTION * first.enemyMax
	}

	get active(): boolean { return this.streak > 0 }

	/** Tours de duel au-delà de la fenêtre (0 au premier tour où le duel est constaté). */
	get beyond(): number { return Math.max(0, this.streak - 1) }

	/** Limite létale en multiple de mes PV : 1 + `STANDOFF_ACCEPT_STEP` × `beyond`, au plus `STANDOFF_ACCEPT_MAX`. 1 hors duel. */
	get accept(): number { return this.active ? Math.min(STANDOFF_ACCEPT_MAX, 1 + STANDOFF_ACCEPT_STEP * this.beyond) : 1 }

	/** Facteur du poids du danger exposé : 1 hors duel, puis décroît de `PASSIVE_RISK_STEP` par tour de duel jusqu'à 0. */
	get riskScale(): number { return this.active ? Math.max(0, 1 - PASSIVE_RISK_STEP * (this.beyond + 1)) : 1 }
}
