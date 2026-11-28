// @version:5.8
// file version: 1
/** Sous cette distance (Manhattan) à l'ennemi, le poireau est « trop près » pour `shouldHide`. */
export const MIN_SAFE_DISTANCE = 2

/**
 * Comportement du poireau, fixé par son agressivité (0 à 100, immuable). Une seule logique, sans rôle :
 * seuils de soin, de bouclier et de repli, que le plan conjoint et le plan B lisent. Reprend les valeurs de l'ancienne
 * posture AGGRESSIVE (comportement en combat inchangé). Valeurs heuristiques, NON calibrées en combat.
 */
export class LeekBehavior {
	public readonly aggression: number

	constructor(aggression = 50) {
		this.aggression = Math.max(0, Math.min(100, aggression))
	}

	/** Agressivité ramenée à [0, 1]. */
	get ratio(): number {
		return this.aggression / 100
	}

	/** Soin seulement à vie basse : la vie restante passe sous un seuil qui baisse avec l'agressivité. */
	shouldHeal(lifeRatio: number): boolean {
		return lifeRatio <= 0.40 - 0.15 * this.ratio
	}

	/** Comme `shouldHeal`, mais un ennemi à 10 cases ou moins déclenche le soin dès 50 % de vie. */
	shouldHealWithThreat(lifeRatio: number, distance: number): boolean {
		return (distance <= 10 && lifeRatio <= 0.50) || this.shouldHeal(lifeRatio)
	}

	/** Bouclier quand l'ennemi atteint le poireau (`threatRange` : PM + portée max) et que la vie est basse. */
	shouldShield(lifeRatio: number, distance: number, threatRange: number): boolean {
		return lifeRatio <= 0.45 - 0.15 * this.ratio && distance <= threatRange
	}

	/** Repli : trop près et blessé, au contact à vie moyenne, ou en panique (≤ 25 %) à 10 cases ou moins. */
	shouldHide(lifeRatio: number, distance: number): boolean {
		return (distance < MIN_SAFE_DISTANCE && lifeRatio <= 0.30 - 0.15 * this.ratio) ||
			(distance <= 1 && lifeRatio <= 0.50) ||
			(distance <= 10 && lifeRatio <= 0.25)
	}
}
