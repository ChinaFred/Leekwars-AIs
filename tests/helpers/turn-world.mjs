import assert from "node:assert/strict"

/**
 * Monde minimal pour jouer un tour complet : grille vide 31 x 11, moi en (5,5) avec une arme de portée 1 à 6,
 * un ennemi faiblement armé en (10,5) : le plan conjoint tire deux fois sans bouger (10 PT, 4 PT par tir).
 */
export function installGlobals() {
	globalThis.Color = { rgb: () => 0 }
	globalThis.Debug = { log() {}, pause() {} }
	globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4, POISON: 5, BUFF_STRENGTH: 6, BUFF_MP: 7 }
	globalThis.Fight = { turn: 1 }
}

export function makeTurnWorld({
	turnNumber, say = () => {}, enemyLife = 300,
	// Options des tests portés depuis l'ancien repli : grille du fichier appelant (son `Field` est alors conservé),
	// identité, position et arme de l'ennemi, alliée éventuelle.
	grid = null, meName = "me", enemyId = 2, enemyName = "enemy", enemyAt = [10, 5], enemyWeapon = null,
	enemyMp = 3, enemyTp = 10, ally = null, allyAt = [5, 7]
}) {
	const gun = {
		id: 38, name: "machine_gun", cost: 4, minRange: 1, maxRange: 6, needsLos: false, maxUses: -1,
		features: [{ type: 1, minValue: 20, maxValue: 25 }]
	}
	const enemyGun = { id: 90, name: "enemy gun", cost: 3, minRange: 0, maxRange: 6, needsLos: false, features: [{ type: 1, minValue: 1, maxValue: 1 }] }
	const cells = grid === null ? new Map() : grid.cells
	if (grid === null) {
		for (let x = 0; x < 31; x++) for (let y = 0; y < 11; y++) {
			cells.set(`${x},${y}`, { id: y * 31 + x, x, y, empty: true, obstacle: false, entity: null })
		}
		globalThis.Field = { cellFromXY: (x, y) => cells.get(`${x},${y}`) ?? null, lineOfSight: () => true }
	}
	const place = (entity, x, y) => {
		const cell = cells.get(`${x},${y}`)
		cell.entity = entity
		cell.empty = false
		entity.cell = cell
		return entity
	}
	const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
	const inRange = (item, from, target) => distance(from, target.cell) >= item.minRange && distance(from, target.cell) <= item.maxRange
	const actions = []
	const me = place({
		id: 1, name: meName, level: 10, life: 300, maxLife: 300, mp: 3, tp: 10, strength: 0, science: 0, wisdom: 0,
		weapon: gun, weapons: [gun], chips: [], effects: [], launchedEffects: [],
		say,
		distance(other) { return distance(this.cell, other.cell) },
		canUseWeapon(target) { return this.tp >= this.weapon.cost && target.life > 0 && inRange(this.weapon, this.cell, target) },
		canUseChip: () => false,
		chipCells: () => [],
		setWeapon(weapon) { actions.push("equip"); this.tp -= 1; this.weapon = weapon; return true },
		moveToward(destination, max = this.mp) {
			const to = destination.cell ?? destination
			const cost = distance(this.cell, to)
			assert.ok(cost <= Math.min(this.mp, max), "move within MP")
			this.cell.entity = null
			this.cell.empty = true
			place(this, to.x, to.y)
			this.mp -= cost
			actions.push("move")
			return cost
		},
		moveAwayFrom() { actions.push("retreat"); return 0 },
		useWeapon(target) {
			assert.ok(this.canUseWeapon(target), "shot must be legal")
			this.tp -= this.weapon.cost
			target.life -= 22
			actions.push("shoot")
			return 1
		},
		useChip() { actions.push("chip"); return 0 }
	}, 5, 5)
	const enemy = place({
		id: enemyId, name: enemyName, level: 10, life: enemyLife, maxLife: 300, mp: enemyMp, tp: enemyTp, strength: 0,
		agility: 0, wisdom: 0, resistance: 0, science: 0, magic: 0, weapon: enemyWeapon ?? enemyGun, weapons: [], chips: [],
		effects: [], launchedEffects: []
	}, enemyAt[0], enemyAt[1])
	if (ally !== null) place(ally, allyAt[0], allyAt[1])
	const calls = { aliveEnemies: 0, allies: 0 }
	globalThis.Fight = {
		me, turn: turnNumber,
		getNearestEnemy: () => enemy,
		getEnemies: () => [enemy],
		getAliveEnemies: () => { calls.aliveEnemies++; return [enemy].filter((e) => e.life > 0) },
		getAllies: () => { calls.allies++; return ally === null ? [me] : [me, ally] },
		weaponCells: (target, weapon = me.weapon) => [...cells.values()].filter((cell) => inRange(weapon, cell, target))
	}
	globalThis.Weapon = { pistol: gun }
	globalThis.Chip = {}
	return { actions, me, enemy, ally, calls, cell: (x, y) => cells.get(`${x},${y}`) }
}

/** Joue `turn` et renvoie les lignes de `console.log` et de `Debug.log` (rapports d'erreur) dans l'ordre. */
export function captureLines(turn) {
	const lines = []
	const original = console.log
	console.log = (...args) => { lines.push(args.join(" ")) }
	globalThis.Debug = { log: (value) => { lines.push(String(value)) }, pause() {} }
	try {
		turn()
	} finally {
		console.log = original
		globalThis.Debug = { log() {}, pause() {} }
	}
	return lines
}
