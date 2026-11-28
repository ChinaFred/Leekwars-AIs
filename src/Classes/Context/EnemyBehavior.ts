// @version:5.8
// file version: 1

/** Nombre maximal de tours adverses conservés par ennemi (mémoire bornée). */
export const MAX_TURN_LOG = 8

/** Tours les plus récents pris en compte pour juger la posture. */
export const STANCE_WINDOW = 5

/** Nombre minimal de tours observés avant de conclure autre chose que « unknown ». */
export const MIN_TURNS_FOR_STANCE = 2

/** Écart (agressif − défensif) / total à partir duquel la posture est tranchée ; non calibré. */
export const STANCE_MARGIN = 0.34

/** Cellule réduite à ses coordonnées (les objets `Cell` du jeu ne sont pas conservés). */
export interface CellXY {
	x: number
	y: number
}

/** Photographie d'un ennemi à la fin de MON tour : référence pour mesurer ce qu'il fait à son tour. */
export interface EnemyAfterMyTurn {
	turn: number
	cell: CellXY
	life: number
	/** Ma case à la fin de mon tour (distance mesurée avant/après son déplacement). */
	myCell: CellXY
}

/** Ce qu'un ennemi a fait entre la fin de mon tour `turn - 1` et le début de mon tour `turn`. */
export interface EnemyTurnRecord {
	turn: number
	/** Distance (4-connexité) à ma case de fin de tour : après son tour moins avant ; > 0 = il s'est éloigné. */
	distanceDelta: number
	fled: boolean
	approached: boolean
	/** Dégâts qu'il m'a infligés avec cause attribuable (0 si aucun ou ambigu avec plusieurs ennemis). */
	damage: number
	/** Il a frappé : dégâts attribués ou usage détecté d'un item à dégâts. */
	attacked: boolean
	/** PV regagnés à son tour (écart de PV depuis la fin de mon tour, si positif). */
	healedLife: number
	/** Il s'est soigné : PV regagnés ou usage détecté d'un item de soin. */
	healed: boolean
	/** Usage détecté d'un item d'armure (bouclier absolu ou relatif). */
	shielded: boolean
}

export type EnemyStance = "unknown" | "aggressive" | "defensive" | "mixed"

export interface EnemyStanceReport {
	stance: EnemyStance
	/** Tours adverses pris en compte. */
	turns: number
	/** Points défensifs : tours de fuite + de soin + d'armure. */
	fled: number
	healed: number
	shielded: number
	/** Points agressifs : tours de frappe + d'approche. */
	attacked: number
	approached: number
	/** (agressif − défensif) / total, dans [−1 ; 1] ; 0 sans point. */
	score: number
}

type FeatureHolder = { readonly features: readonly { readonly type: number }[] }

export function manhattan(a: CellXY, b: CellXY): number {
	return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
}

function hasFeature(item: FeatureHolder, types: readonly number[]): boolean {
	return item.features.some((feature) => types.includes(feature.type))
}

/**
 * Décrit le tour d'un ennemi à partir de la photographie de fin de mon tour, de son état au début du suivant, des
 * usages d'items détectés et des dégâts qu'il m'a infligés (déjà filtrés : 0 si non attribuables). Fonction pure
 * (les constantes `Effect` sont lues à l'appel).
 */
export function describeEnemyTurn(
	turn: number,
	before: EnemyAfterMyTurn,
	now: { cell: CellXY, life: number },
	uses: readonly FeatureHolder[],
	damage: number
): EnemyTurnRecord {
	const distanceDelta = manhattan(now.cell, before.myCell) - manhattan(before.cell, before.myCell)
	const healedLife = Math.max(0, now.life - before.life)
	const attackKinds = [Effect.DAMAGE, Effect.POISON]
	const healKinds = [Effect.HEAL]
	const shieldKinds = [Effect.ABSOLUTE_SHIELD, Effect.RELATIVE_SHIELD]
	return {
		turn,
		distanceDelta,
		fled: distanceDelta >= 1,
		approached: distanceDelta <= -1,
		damage,
		attacked: damage > 0 || uses.some((item) => hasFeature(item, attackKinds)),
		healedLife,
		healed: healedLife > 0 || uses.some((item) => hasFeature(item, healKinds)),
		shielded: uses.some((item) => hasFeature(item, shieldKinds))
	}
}

/**
 * Posture d'un ennemi sur ses `STANCE_WINDOW` derniers tours : points défensifs (fuite, soin, armure) contre points
 * agressifs (frappe, approche), un point par type et par tour. « unknown » avant `MIN_TURNS_FOR_STANCE` tours ou
 * sans aucun point ; « mixed » quand l'écart relatif reste sous `STANCE_MARGIN`.
 */
export function assessStance(records: readonly EnemyTurnRecord[]): EnemyStanceReport {
	const recent = records.slice(-STANCE_WINDOW)
	const count = (pick: (record: EnemyTurnRecord) => boolean): number => recent.filter(pick).length
	const fled = count((record) => record.fled)
	const healed = count((record) => record.healed)
	const shielded = count((record) => record.shielded)
	const attacked = count((record) => record.attacked)
	const approached = count((record) => record.approached)
	const defensive = fled + healed + shielded
	const aggressive = attacked + approached
	const total = defensive + aggressive
	const score = total === 0 ? 0 : (aggressive - defensive) / total
	let stance: EnemyStance = "mixed"
	if (recent.length < MIN_TURNS_FOR_STANCE || total === 0) {
		stance = "unknown"
	} else if (score >= STANCE_MARGIN) {
		stance = "aggressive"
	} else if (score <= -STANCE_MARGIN) {
		stance = "defensive"
	}
	return { stance, turns: recent.length, fled, healed, shielded, attacked, approached, score }
}
