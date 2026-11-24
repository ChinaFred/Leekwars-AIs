// @version:5.8
// file version: 1
import { EffectModel } from "./Effect.js"

export class EffectsModel {
	damage: EffectModel | null = null
	heal: EffectModel | null = null
	absoluteShield: EffectModel | null = null
	relativeShield: EffectModel | null = null
	debuff: EffectModel | null = null
	buffStrength: EffectModel | null = null
	buffAgility: EffectModel | null = null
	buffMp: EffectModel | null = null
	buffTp: EffectModel | null = null

	constructor(features: readonly Feature[] = []) {
		for (const feature of features) {
			switch (feature.type) {
				case Effect.DAMAGE:
					if (this.damage === null) {
						this.damage = new EffectModel(feature)
					} else {
						this.damage.repeat++
					}
					break
				case Effect.HEAL:
					this.heal = new EffectModel(feature)
					break
				case Effect.ABSOLUTE_SHIELD:
					this.absoluteShield = new EffectModel(feature)
					break
				case Effect.RELATIVE_SHIELD:
					this.relativeShield = new EffectModel(feature)
					break
				case Effect.DEBUFF:
					this.debuff = new EffectModel(feature)
					break
				case Effect.BUFF_STRENGTH:
					this.buffStrength = new EffectModel(feature)
					break
				case Effect.BUFF_AGILITY:
					this.buffAgility = new EffectModel(feature)
					break
				case Effect.BUFF_MP:
					this.buffMp = new EffectModel(feature)
					break
				case Effect.BUFF_TP:
					this.buffTp = new EffectModel(feature)
					break
			}
		}
	}
}
