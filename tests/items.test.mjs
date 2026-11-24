import assert from "node:assert/strict"
import test from "node:test"

import { ChipModel } from "../dist/Classes/Items/Chip.js"
import { EffectModel } from "../dist/Classes/Items/Effect.js"
import { EffectsModel } from "../dist/Classes/Items/Effects.js"
import { ItemModel } from "../dist/Classes/Items/Item.js"
import { WeaponModel } from "../dist/Classes/Items/Weapon.js"
import { ShootingOption } from "../dist/Classes/Plannification/ShootingOption.js"
import { ShootingOptions } from "../dist/Classes/Plannification/ShootingOptions.js"

const damage = { type: 1, minValue: 4, maxValue: 8, turns: 0, targets: 1, modifiers: 0 }
const repeatedDamage = { ...damage }
const heal = { type: 2, minValue: 5, maxValue: 15, turns: 0, targets: 1, modifiers: 0 }
const shieldFeature = { ...heal, type: 3 }
const weapon = {
	id: 10,
	name: "test weapon",
	cost: 2,
	minRange: 0,
	maxRange: 3,
	needsLos: false,
	features: [damage, repeatedDamage]
}
const bandage = {
	id: 20,
	name: "bandage",
	cost: 1,
	currentCooldown: 0,
	minRange: 0,
	maxRange: 0,
	needsLos: false,
	features: [heal]
}
const shield = { ...bandage, id: 21, name: "shield", features: [shieldFeature] }
const attackChip = { ...bandage, id: 22, name: "attack chip", features: [damage] }
const cell = { id: 1, x: 0, y: 0, empty: true, obstacle: false, entity: null }
const otherCell = { id: 2, x: 1, y: 0, empty: true, obstacle: false, entity: null }
const target = { id: 2, name: "target", cell: otherCell }

globalThis.Effect = {
	DAMAGE: 1,
	HEAL: 2,
	ABSOLUTE_SHIELD: 3,
	RELATIVE_SHIELD: 4,
	DEBUFF: 5,
	BUFF_STRENGTH: 6,
	BUFF_AGILITY: 7,
	BUFF_MP: 8,
	BUFF_TP: 9
}
globalThis.Chip = { bandage }
globalThis.Fight = {
	me: {},
	getNearestEnemy: () => target,
	weaponCells: () => [cell, otherCell],
	weaponTargets: () => [target],
	getEnemies: () => [target],
	getAliveEnemies: () => [target],
	getAllies: () => []
}
globalThis.Field = {
	distance: (from, to) => Math.abs(from.x - to.x) + Math.abs(from.y - to.y),
	lineOfSight: () => true,
	pathLength: () => 1
}

test("item wrappers preserve feature groups and weapon damage estimates", () => {
	const feature = new EffectModel(damage)
	const effects = new EffectsModel([damage, repeatedDamage, heal, shieldFeature])
	const weaponModel = new WeaponModel(weapon)
	const itemModel = new ItemModel(weapon)

	assert.equal(feature.min, 4)
	assert.equal(effects.damage.repeat, 2)
	assert.equal(effects.heal.min, 5)
	assert.equal(effects.absoluteShield.min, 5)
	assert.equal(itemModel.meanDamage, 12)
	assert.equal(weaponModel.getTurnDamage(5), 24)
	assert.deepEqual(
		[...weaponModel.fromWhereToUse(target, [cell])].map((candidate) => candidate.id),
		[1]
	)
})

test("chip wrappers query range and classify available chips", () => {
	const chipModel = new ChipModel(bandage)

	assert.equal(chipModel.currentCooldown, 0)
	assert.equal(chipModel.canReachCell(cell, cell), true)
	assert.deepEqual(ChipModel.getHealingChips([bandage, shield]), [bandage])
	assert.deepEqual(ChipModel.getShieldChips([bandage, shield]), [shield])
	assert.throws(() => new ItemModel(bandage).getActionEquip({}), TypeError)
})

test("shooting options account for TP, equipment, and item ordering", () => {
	const me = {
		id: 1,
		name: "me",
		cell,
		life: 50,
		maxLife: 100,
		mp: 3,
		tp: 5,
		weapon: null,
		weapons: [weapon],
		chips: [bandage, attackChip],
		setWeapon() { return true },
		canUseWeapon() { return true },
		useWeapon() { return 1 },
		canUseChip() { return true },
		useChip() { return 1 },
		chipCells() { return [cell] },
		moveToward() { return 1 },
		moveAwayFrom() { return 1 },
		distance() { return 1 }
	}
	const table = ShootingOption.buildDamagingItemsTable(me)
	const ordered = ShootingOptions.orderDamagingItems([
		new ItemModel(bandage),
		new ItemModel(weapon)
	])
	const options = new ShootingOptions()
	options.buildOptions(me, target, [cell], ordered)

	assert.equal(table.length, 7)
	assert.equal(ordered[0].meanDamage, 12)
	assert.ok(options.options.length > 0)
	assert.ok(options.options.every((option) => option.tpLeft >= 0))
})
