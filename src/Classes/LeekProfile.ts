// @version:5.8
// file version: 4
import { LeekBehavior } from "./LeekBehavior.js"

/**
 * Profil du poireau : son agressivité est fixée à la construction (plus de rôle ni de setters) et `behavior` en tire
 * les seuils de soin, bouclier et repli. Les comportements autorisés (`allow*`) restent à revoir : tous permis.
 */
export class LeekProfile {
	public readonly aggression: number
	public readonly behavior: LeekBehavior
	public allowHealing = true
	public allowShielding = true
	public allowHiding = true

	constructor(aggression = 50) {
		this.behavior = new LeekBehavior(aggression)
		this.aggression = this.behavior.aggression
	}
}
