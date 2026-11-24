// @version:5.8
// file version: 1
export const CONST_COMPARISON = {
	EQUAL: 0,
	MIN_OR_EQUAL: 1,
	SUP_OR_EQUAL: 2,
	MIN: 3,
	SUP: 4
} as const

export const DANGER = {
	NO_SAFE_PLACE: -20_000,
	INITIAL_DANGER: 100
} as const

export const COLORS = {
	HIT: Color.rgb(250, 51, 153),
	SUCCESS: Color.rgb(0, 255, 20),
	WARNING: Color.rgb(255, 128, 0),
	PURPLE: Color.rgb(152, 51, 255),
	SALMON: Color.rgb(255, 229, 204),
	LIGHT_GREEN: Color.rgb(204, 255, 229),
	BROWN: Color.rgb(152, 76, 0),
	YELLOW: Color.rgb(255, 255, 102),
	DEBUG: Color.rgb(198, 131, 74)
} as const

export const ITEM_TYPE = {
	CHIP: "Chip",
	WEAPON: "Weapon"
} as const
