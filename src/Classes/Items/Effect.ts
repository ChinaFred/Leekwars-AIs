// @version:5.8
// file version: 1
export class EffectModel {
	readonly type: number
	readonly min: number
	readonly max: number
	readonly turns: number
	readonly targets: number
	readonly modifiers: number
	repeat = 1

	constructor(feature: Feature) {
		this.type = feature.type
		this.min = feature.minValue
		this.max = feature.maxValue
		this.turns = feature.turns
		this.targets = feature.targets
		this.modifiers = feature.modifiers
	}
}
