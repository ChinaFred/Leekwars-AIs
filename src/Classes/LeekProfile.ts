// @version:5.8
// file version: 5

/**
 * Profil du poireau : l'agressivité (0 à 100) est fixée à la construction. Elle pèse sur le choix des scénarios du livre
 * (`objectiveFor`, `BookObjective.ts`) et sur les seuils du repli gelé (`TacticalScore.ts`). Les comportements permis
 * (`allow*`) restent à revoir : tous permis.
 */
export class LeekProfile {
	public readonly aggression: number
	public allowHealing = true
	public allowShielding = true
	public allowHiding = true

	constructor(aggression = 50) {
		this.aggression = Math.max(0, Math.min(100, aggression))
	}
}
