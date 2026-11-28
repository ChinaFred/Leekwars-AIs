import assert from "node:assert/strict"
import test from "node:test"

globalThis.Color = { rgb: () => 0 }
globalThis.Debug = { log() {}, pause() {} }
// RAW_BUFF_AGILITY absent : le code retombe sur l'identifiant officiel 41 (effet de la puce Étirement).
globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4, POISON: 5, BUFF_STRENGTH: 6, BUFF_AGILITY: 7 }
globalThis.Fight = { turn: 1 }

// Boost d'agilité « de remplissage » : ajouté au plan conjoint retenu, payé par les seuls PT que ce plan n'emploie pas.
const { turn } = await import("./helpers/joint-turn.mjs")
const { woundedRiskFactor, WOUNDED_RISK_FACTOR } = await import("../dist/Classes/Plannification/TacticalScore.js")

const machineGun = {
	id: 38, name: "machine_gun", cost: 4, minRange: 1, maxRange: 6, needsLos: false, maxUses: -1,
	features: [{ type: 1, minValue: 20, maxValue: 25 }]
}
// Étirement d'après `data/chips.json` du générateur officiel : effet 41 (agilité brute) 80 à 100, 2 tours, 3 PT, délai 3.
const stretching = (extra = {}) => ({
	id: 9, name: "stretching", cost: 3, cooldown: 3, currentCooldown: 0, minRange: 0, maxRange: 5, needsLos: false,
	features: [{ type: 41, minValue: 80, maxValue: 100, turns: 2 }], ...extra
})
const protein = () => ({
	id: 8, name: "protein", cost: 3, cooldown: 3, currentCooldown: 0, minRange: 0, maxRange: 0, needsLos: false,
	features: [{ type: 38, minValue: 90, maxValue: 90, turns: 2 }]
})
const enemyGun = { id: 90, name: "enemy gun", cost: 3, minRange: 0, maxRange: 6, needsLos: false, features: [{ type: 1, minValue: 40, maxValue: 45 }] }

function makeWorld({
	turnNumber, chips = [], effects = [], meAt = [5, 5], enemyAt = [9, 5], equipped = machineGun,
	life = 300, mp = 3, tp = 10, enemyLife = 300, enemyMaxLife = 300, chestAt = null, FakeChest = null, useChipImpl = null
} = {}) {
	const cells = new Map()
	for (let x = 0; x < 31; x++) for (let y = 0; y < 11; y++) {
		cells.set(`${x},${y}`, { id: y * 31 + x, x, y, empty: true, obstacle: false, entity: null })
	}
	globalThis.Field = { cellFromXY: (x, y) => cells.get(`${x},${y}`) ?? null, lineOfSight: () => true }
	const place = (entity, [x, y]) => {
		const cell = cells.get(`${x},${y}`)
		cell.entity = entity
		cell.empty = false
		entity.cell = cell
		return entity
	}
	const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
	const actions = []
	const trace = []
	// Actions ET lignes de journal, dans l'ordre : prouve que le plan est affiché avant la première action.
	const timeline = []
	const act = (name) => { actions.push(name); timeline.push(`action:${name}`) }
	const me = place({
		id: 1, name: "me", level: 10, life, maxLife: 300, mp, tp, strength: 10, science: 0, wisdom: 0,
		weapon: equipped, weapons: [machineGun], chips, effects, launchedEffects: [],
		say() {},
		distance(other) { return distance(this.cell, other.cell) },
		canUseWeapon(target) {
			return this.weapon !== null && this.tp >= this.weapon.cost && target.life > 0 &&
				distance(this.cell, target.cell) >= this.weapon.minRange && distance(this.cell, target.cell) <= this.weapon.maxRange
		},
		canUseChip(chip, target) { return chip.currentCooldown === 0 && this.tp >= chip.cost && target === this },
		chipCells() { return [this.cell] },
		setWeapon(weapon) { act("equip"); this.tp -= 1; this.weapon = weapon; return true },
		moveToward(destination, max = this.mp) {
			const to = destination.cell ?? destination
			const cost = distance(this.cell, to)
			assert.ok(cost <= Math.min(this.mp, max), "move within MP")
			this.cell.entity = null
			this.cell.empty = true
			place(this, [to.x, to.y])
			this.mp -= cost
			act("move")
			return cost
		},
		moveAwayFrom() { act("retreat"); return 0 },
		useWeapon(target) {
			assert.ok(this.canUseWeapon(target), "shot must be legal")
			trace.push({ shoot: true, tp: this.tp, strength: this.strength })
			this.tp -= this.weapon.cost
			target.life -= 22.5 * (1 + this.strength / 100)
			act("shoot")
			return 1
		},
		useChip(chip, target) {
			assert.ok(this.canUseChip(chip, target), "chip must be legal")
			trace.push({ chip: chip.name, tp: this.tp, strength: this.strength })
			if (useChipImpl) return useChipImpl(this, chip)
			this.tp -= chip.cost
			chip.currentCooldown = chip.cooldown
			// Comme le moteur (hypothèse du modèle) : force et PT s'ajoutent dès le lancer ; le soin rend des PV.
			for (const feature of chip.features) {
				if (feature.type === 38) { this.strength += feature.minValue; this.effects.push({ type: 38, turns: feature.turns }) }
				if (feature.type === 41) this.effects.push({ type: 41, turns: feature.turns })
				if (feature.type === 32) { this.tp += feature.minValue; this.effects.push({ type: 32, turns: feature.turns }) }
				if (feature.type === 2) this.life = Math.min(this.maxLife, this.life + feature.minValue)
			}
			act(chip.name)
			return 1
		}
	}, meAt)
	const enemy = place({
		id: 2, name: "enemy", level: 10, life: enemyLife, maxLife: enemyMaxLife, mp: 6, tp: 10, strength: 0, agility: 0, wisdom: 0,
		resistance: 0, science: 0, magic: 0, weapon: enemyGun, weapons: [], chips: [], effects: [], launchedEffects: []
	}, enemyAt)
	const enemies = [enemy]
	let chest = null
	if (chestAt !== null) {
		chest = place(Object.assign(Object.create(FakeChest.prototype), { ...enemy, id: 3, name: "chest" }), chestAt)
		enemies.unshift(chest)
	}
	globalThis.Fight = {
		me, turn: turnNumber,
		getNearestEnemy: () => enemies.reduce((best, e) => (distance(me.cell, e.cell) < distance(me.cell, best.cell) ? e : best)),
		getEnemies: () => enemies,
		getAliveEnemies: () => enemies.filter((e) => e.life > 0),
		getAllies: () => [me],
		weaponCells: (target, weapon = me.weapon) => [...cells.values()].filter((cell) =>
			distance(cell, target.cell) >= weapon.minRange && distance(cell, target.cell) <= weapon.maxRange)
	}
	globalThis.Weapon = { pistol: machineGun }
	globalThis.Chip = {}
	return { actions, trace, timeline, me, enemy, chest }
}

const finish = (w) => { const lines = []; const o = console.log; console.log = (...a) => lines.push(a.join(" ")); try { turn() } finally { console.log = o } return lines }

// Combat 54995131, tour 5 : ennemi à 98/318 PV (31 %) en fuite à distance 13 (ici portée adverse 6 + 6 PM = 12 :
// toute case avancée est dangereuse, danger ~130), Kassbi 10 PT / 5 PM ne bougeait pas (plan 0 PT, 0 PM, danger 0).
const kassbiTurn5 = (enemyLife) => makeWorld({ turnNumber: 5, meAt: [5, 5], enemyAt: [18, 5], mp: 5, tp: 10, life: 300,
	enemyLife, enemyMaxLife: 318 })

test("woundedRiskFactor: under 30 % of the target's max life only", () => {
	assert.equal(woundedRiskFactor({ life: 95, maxLife: 318 }), WOUNDED_RISK_FACTOR) // 29,9 %
	assert.equal(woundedRiskFactor({ life: 96, maxLife: 318 }), 1) // 30,2 %
	assert.equal(woundedRiskFactor({ life: 1, maxLife: 0 }), 1)
	assert.equal(woundedRiskFactor(undefined), 1)
})

test("fight 54995131 turn 5: a fleeing enemy under 30 % life is chased instead of holding on a danger-free cell", () => {
	const wounded = kassbiTurn5(90)
	const lines = finish(wounded)
	assert.ok(wounded.me.cell.x > 5, `Kassbi must advance (x=${wounded.me.cell.x}); ${lines.filter((l) => l.includes("[Tactical]")).join(" | ")}`)
	assert.ok(lines.some((line) => line.includes("wounded enemy")), "the reduced risk weight is logged")
	// Même situation à 98/318 PV (30,8 %) : seuil 30 % non atteint, comportement d'avant (maintien).
	const healthy = kassbiTurn5(98)
	finish(healthy)
	assert.equal(healthy.me.cell.x, 5, "above 30 % the risk weight is unchanged")
})

test("wounded chase keeps the lethal guard: a danger reaching 0.75 x my life is still refused", () => {
	const frail = makeWorld({ turnNumber: 6, meAt: [5, 5], enemyAt: [18, 5], mp: 5, tp: 10, life: 100, enemyLife: 90, enemyMaxLife: 318 })
	finish(frail)
	assert.ok(frail.me.cell.x <= 5 + 1, `no suicidal advance (x=${frail.me.cell.x})`)
})
