import assert from "node:assert/strict"
import test from "node:test"

globalThis.Color = { rgb: () => 0 }
globalThis.Debug = { log() {}, pause() {} }
// RAW_BUFF_MP absent : le code retombe sur l'identifiant officiel 31 (comme 32 et 38 pour les PT et la force).
globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4, POISON: 5, BUFF_STRENGTH: 6, BUFF_MP: 7 }
globalThis.Fight = { turn: 1 }

// Le boost de PM est la seule action décidée avant le plan : `turn()` le lance, recalcule les cartes, puis planifie.
const { turn } = await import("../dist/Main/Kassbi_Class.js")
const { decideMpBoost, pickMpBoost } = await import("../dist/Brain/StrengthBoost.js")
const { computeReachableCells } = await import("../dist/Classes/Context/ReachableCells.js")
const { TACTICAL_LIMITS } = await import("../dist/Classes/Plannification/TacticalTypes.js")

const machineGun = {
	id: 38, name: "machine_gun", cost: 4, minRange: 1, maxRange: 6, needsLos: false, maxUses: -1,
	features: [{ type: 1, minValue: 20, maxValue: 25 }]
}
// Bottes en cuir d'après les données du générateur officiel : effet 31 (PM bruts), +2 PM, 2 tours, 3 PT, délai 5.
const boots = (extra = {}) => ({
	id: 14, name: "leather_boots", cost: 3, cooldown: 5, currentCooldown: 0, minRange: 0, maxRange: 5, needsLos: false,
	features: [{ type: 31, minValue: 2, maxValue: 2, turns: 2 }], ...extra
})
const spark = () => ({
	id: 18, name: "spark", cost: 3, cooldown: 0, currentCooldown: 0, minRange: 0, maxRange: 10, needsLos: false,
	features: [{ type: 1, minValue: 8, maxValue: 16 }]
})
// Ennemi armé mais presque inoffensif : le plan accepte d'aller tirer sur la case débloquée.
const enemyGun = { id: 90, name: "enemy gun", cost: 3, minRange: 0, maxRange: 6, needsLos: false, features: [{ type: 1, minValue: 1, maxValue: 1 }] }

/**
 * Grille vide 31 x 11 ; moi en (5,5), ennemi à distance 10 : hors de portée avec 3 PM (6 + 3), à portée avec 5.
 * `height` et `meAt` donnent un terrain ouvert (losange complet) : 17 lignes et moi en (8,8) jusqu'à 8 PM.
 */
function makeWorld({
	turnNumber, chips = [boots()], effects = [], enemyAt = [15, 5], life = 300, mp = 3, tp = 10, useChipImpl = null,
	height = 11, meAt = [5, 5]
} = {}) {
	const cells = new Map()
	for (let x = 0; x < 31; x++) for (let y = 0; y < height; y++) {
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
	const inRange = (item, from, target) =>
		distance(from, target.cell) >= item.minRange && distance(from, target.cell) <= item.maxRange
	const actions = []
	const timeline = []
	const native = { weaponCells: 0, chipCells: 0 }
	const act = (name) => { actions.push(name); timeline.push(`action:${name}`) }
	const me = place({
		id: 1, name: "me", level: 10, life, maxLife: 300, mp, tp, strength: 0, science: 0, wisdom: 0,
		weapon: machineGun, weapons: [machineGun], chips, effects, launchedEffects: [],
		say() {},
		distance(other) { return distance(this.cell, other.cell) },
		canUseWeapon(target) {
			return this.weapon !== null && this.tp >= this.weapon.cost && target.life > 0 && inRange(this.weapon, this.cell, target)
		},
		canUseChip(chip, target) {
			return chip.currentCooldown === 0 && this.tp >= chip.cost && (target === this || inRange(chip, this.cell, target))
		},
		chipCells(chip, target) { native.chipCells++; return [...cells.values()].filter((cell) => inRange(chip, cell, target)) },
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
			this.tp -= this.weapon.cost
			target.life -= 22.5
			act("shoot")
			return 1
		},
		useChip(chip, target) {
			assert.ok(this.canUseChip(chip, target), "chip must be legal")
			if (useChipImpl) return useChipImpl(this, chip)
			this.tp -= chip.cost
			chip.currentCooldown = chip.cooldown
			// Hypothèse du modèle (lecture du générateur) : les PM s'ajoutent dès le lancer.
			for (const feature of chip.features) {
				if (feature.type === 31) { this.mp += feature.minValue; this.effects.push({ type: 31, turns: feature.turns }) }
			}
			act(chip.name)
			return 1
		}
	}, meAt)
	const enemy = place({
		id: 2, name: "enemy", level: 10, life: 300, maxLife: 300, mp: 3, tp: 10, strength: 0, agility: 0, wisdom: 0,
		resistance: 0, science: 0, magic: 0, weapon: enemyGun, weapons: [], chips: [], effects: [], launchedEffects: []
	}, enemyAt)
	globalThis.Fight = {
		me, turn: turnNumber,
		getNearestEnemy: () => enemy,
		getEnemies: () => [enemy],
		getAliveEnemies: () => [enemy].filter((e) => e.life > 0),
		getAllies: () => [me],
		weaponCells: (target, weapon = me.weapon) => {
			native.weaponCells++
			return [...cells.values()].filter((cell) => inRange(weapon, cell, target))
		}
	}
	globalThis.Weapon = { pistol: machineGun }
	globalThis.Chip = {}
	return { actions, timeline, native, me, enemy }
}

function captureTurn(w) {
	const lines = []
	const original = console.log
	console.log = (...args) => { lines.push(args.join(" ")); w.timeline.push(`log:${args.join(" ")}`) }
	// Les rapports d'erreur (`reportError`) sortent par `Debug.log`, pas par `console.log` : les capter aussi.
	globalThis.Debug = { log: (value) => { lines.push(String(value)) }, pause() {} }
	try {
		turn()
	} finally {
		console.log = original
		globalThis.Debug = { log() {}, pause() {} }
	}
	return lines
}

/** Décision seule, avec les cases atteignables du tour (comme `turn()` les fournit). */
function decide(options, { reachable, limit = TACTICAL_LIMITS.cells } = {}) {
	const w = makeWorld({ turnNumber: 20, ...options })
	const zone = reachable === undefined ? computeReachableCells(w.me, w.me.mp, 20) : reachable
	return { w, decision: decideMpBoost(w.me, zone, [w.enemy], limit) }
}

test("(a) no shot this turn and +2 MP unlocks a firing cell: cast before the plan, maps recomputed, the plan then shoots", () => {
	const w = makeWorld({ turnNumber: 1 })
	const lines = captureTurn(w)
	assert.deepEqual(w.actions, ["leather_boots", "move", "shoot"], lines.filter((text) => /Boost|Tactical|ERROR/.test(text)).join("\n"))
	assert.equal(w.me.tp, 10 - 3 - 4)
	assert.equal(w.me.cell.x, 9) // 4 des 5 PM : première case à portée 6
	// Décision et motif journalisés AVANT le lancer.
	const decided = w.timeline.findIndex((entry) => entry.includes("[Boost] MP: casting leather_boots (+2 MP, 3 TP)"))
	assert.ok(decided >= 0 && decided < w.timeline.indexOf("action:leather_boots"))
	assert.match(w.timeline[decided], /no firing cell in 25 cells with 3 MP; 61 cells with 5 MP reach machine_gun on enemy/)
	// Cartes recalculées avec les PM réels : le plan conjoint les accepte (pas de repli sur le plan B).
	assert.deepEqual(lines.filter((text) => text.includes("[Reachable] me:")).map((text) => /me:\d+ \(\d MP\)/.exec(text)[0]),
		["me:25 (3 MP)", "me:61 (5 MP)"])
	assert.equal(lines.filter((text) => text.includes("[Threat] ")).length, 2)
	assert.equal(lines.some((text) => text.includes("fallback") || text.includes("ERROR")), false)
	const plan = lines.find((text) => text.includes("[Tactical] plan before execution"))
	assert.ok(plan && JSON.parse(plan.slice(plan.indexOf("{"))).tp.available === 7, "the plan sees the TP left after the boost")
	// Le lancer figure dans l'historique du tour, avec les PM gagnés comptés comme disponibles.
	const history = lines.find((text) => text.includes("[History] T1 "))
	assert.match(history, /TP 7\/10 MP 4\/5 .*\| leather_boots:1:-; move:4:-; machine_gun:1:22\.5/)
})

test("(b) not cast when a shot is already possible: from my cell, after a move, or with a ready offensive chip", () => {
	const inContact = decide({ enemyAt: [10, 5] }) // distance 5 : l'arme équipée tire d'ici, aucune liste native
	assert.equal(inContact.decision.option, null)
	assert.match(inContact.decision.reason, /shot already possible: machine_gun/)
	assert.deepEqual(inContact.w.native, { weaponCells: 0, chipCells: 0 })
	const afterMove = decide({ enemyAt: [14, 5] }) // distance 9 : 3 PM puis portée 6
	assert.equal(afterMove.decision.option, null)
	assert.match(afterMove.decision.reason, /shot already possible: machine_gun/)
	const byChip = decide({ chips: [boots(), spark()] }) // distance 10 : la puce (portée 10) tire déjà
	assert.equal(byChip.decision.option, null)
	assert.match(byChip.decision.reason, /shot already possible: spark/)
	// De bout en bout : rien n'est lancé avant le plan, qui tire avec ses 10 PT.
	const w = makeWorld({ turnNumber: 21, enemyAt: [14, 5] })
	captureTurn(w)
	assert.deepEqual(w.actions, ["move", "shoot", "shoot"])
})

test("(c) not cast when the boosted zone exceeds the joint-plan bound, or when +gain MP still reaches no firing cell", () => {
	// Terrain ouvert, 6 PM + 2 = 8 PM : 145 cases > 113 ; l'ennemi à distance 13 serait pourtant débloqué.
	const open = { height: 17, meAt: [8, 8] }
	assert.equal(TACTICAL_LIMITS.cells, 113)
	const wide = decide({ ...open, mp: 6, enemyAt: [21, 8] })
	assert.equal(wide.decision.option, null)
	assert.match(wide.decision.reason, /145 cells with 8 MP > 113/)
	assert.deepEqual(wide.w.native, { weaponCells: 0, chipCells: 0 })
	assert.ok(decide({ ...open, mp: 6, enemyAt: [21, 8] }, { limit: 145 }).decision.option, "the bound is the only refusal here")
	const far = decide({ enemyAt: [25, 5] }) // distance 20 > 6 + 5 : aucune liste native demandée
	assert.equal(far.decision.option, null)
	assert.match(far.decision.reason, /no firing cell within 5 MP/)
	assert.deepEqual(far.w.native, { weaponCells: 0, chipCells: 0 })
	// À portée de Manhattan mais sans case de tir native (ligne de vue bouchée) : la liste native décide.
	const blind = makeWorld({ turnNumber: 20 })
	Fight.weaponCells = () => []
	assert.match(decideMpBoost(blind.me, computeReachableCells(blind.me, 3, 20), [blind.enemy], TACTICAL_LIMITS.cells).reason, /no firing cell within 5 MP/)
	const w = makeWorld({ ...open, turnNumber: 22, mp: 6, enemyAt: [21, 8] })
	captureTurn(w)
	assert.equal(w.actions.includes("leather_boots"), false)
})

test("5 MP + 2 on open ground (113 cells): the boots are cast when they unlock a shot, and the joint plan keeps the turn", () => {
	// Ennemi à distance 12 : hors de portée à 5 PM (6 + 5), à portée à 7 PM. Refusé tant que la borne était de 85 cases.
	const w = makeWorld({ turnNumber: 23, mp: 5, height: 17, meAt: [8, 8], enemyAt: [20, 8] })
	const lines = captureTurn(w)
	const report = lines.filter((text) => /Boost|Tactical|Reserve|ERROR/.test(text)).join("\n")
	assert.deepEqual(w.actions, ["leather_boots", "move", "shoot"], report)
	assert.ok(lines.some((text) => text.includes("no firing cell in 61 cells with 5 MP; 113 cells with 7 MP reach machine_gun on enemy")), report)
	assert.deepEqual(lines.filter((text) => text.includes("[Reachable] me:")).map((text) => /me:\d+ \(\d MP\)/.exec(text)[0]),
		["me:61 (5 MP)", "me:113 (7 MP)"])
	// Plan conjoint retenu sur 113 cases : ni repli (bornes, carte tronquée), ni plan B.
	assert.equal(lines.some((text) => /fallback|TRUNCATED|\[Reserve\]|ERROR/.test(text)), false, report)
	assert.ok(lines.some((text) => text.includes("[Tactical] plan before execution")), report)
	assert.equal(w.me.tp, 10 - 3 - 4)
})

test("(d) not cast below 50 % life, in cooldown, or while an MP boost is active; exactly 50 % casts", () => {
	assert.match(decide({ life: 149 }).decision.reason, /life below 50 %/)
	assert.equal(decide({ life: 149 }).decision.option, null)
	assert.equal(decide({ life: 150 }).decision.option?.chip.name, "leather_boots")
	assert.deepEqual(decide({ chips: [boots({ currentCooldown: 2 })] }).decision, { option: null, reason: "" })
	for (const type of [31, 7]) {
		assert.deepEqual(decide({ effects: [{ type, turns: 1 }] }).decision, { option: null, reason: "" })
	}
	for (const options of [{ life: 149 }, { chips: [boots({ currentCooldown: 2 })] }, { effects: [{ type: 31, turns: 1 }] }]) {
		const w = makeWorld({ turnNumber: 23, ...options })
		captureTurn(w)
		assert.equal(w.actions.includes("leather_boots"), false)
	}
})

test("(e) not cast when the TP left after the boost pay no shot, nor when the turn's reachable cells are missing or stale", () => {
	const tight = decide({ tp: 6 }) // 6 − 3 = 3 PT < 4 PT de l'arme
	assert.equal(tight.decision.option, null)
	assert.match(tight.decision.reason, /no weapon shot affordable after the boost/)
	assert.equal(decide({ tp: 7 }).decision.option?.gain, 2)
	// Seule l'arme NON équipée (8 PT + 1 de changement) atteint une case débloquée, à distance 12 : il faut
	// 9 PT après le boost. L'arme équipée, payable mais hors de portée même boostée, ne suffit pas.
	const sniper = {
		id: 39, name: "sniper", cost: 8, minRange: 1, maxRange: 8, needsLos: false, maxUses: -1,
		features: [{ type: 1, minValue: 40, maxValue: 50 }]
	}
	const twoWeapons = (tp) => {
		const world = makeWorld({ turnNumber: 20, tp, enemyAt: [17, 5] })
		world.me.weapons = [machineGun, sniper]
		return decideMpBoost(world.me, computeReachableCells(world.me, 3, 20), [world.enemy], TACTICAL_LIMITS.cells)
	}
	assert.match(twoWeapons(11).reason, /no firing cell within 5 MP/)
	assert.match(twoWeapons(12).reason, /reach sniper on enemy/)
	// Garde d'opérations : rien ne démarre à 80 % ; juste en dessous, le boost est décidé.
	try {
		globalThis.System = { operations: 80, maxOperations: 100 }
		assert.match(decide({}).decision.reason, /operations budget/)
		globalThis.System.operations = 79
		assert.equal(decide({}).decision.option?.gain, 2)
	} finally {
		delete globalThis.System
	}
	const w = makeWorld({ turnNumber: 24, tp: 6 })
	captureTurn(w)
	assert.equal(w.actions.includes("leather_boots"), false)
	assert.match(decide({}, { reachable: null }).decision.reason, /reachable cells unavailable/)
	const stale = makeWorld({ turnNumber: 25 })
	assert.match(decideMpBoost(stale.me, computeReachableCells(stale.me, 3, 24), [stale.enemy], TACTICAL_LIMITS.cells).reason, /reachable cells unavailable/)
	// Hôte sans liste native de cases de tir : ne pas décider.
	const old = makeWorld({ turnNumber: 26 })
	old.me.chipCells = undefined
	assert.match(decideMpBoost(old.me, computeReachableCells(old.me, 3, 26), [old.enemy], TACTICAL_LIMITS.cells).reason, /native firing cells unavailable/)
})

test("a refused cast or a failing decision does not stop the turn: maps match the real MP, the plan goes on", () => {
	const w = makeWorld({ turnNumber: 27, useChipImpl: () => 0 })
	const lines = captureTurn(w)
	assert.equal(w.actions.includes("leather_boots"), false)
	assert.equal(w.me.tp, 10)
	assert.ok(lines.some((text) => text.includes("[Boost] MP: leather_boots result 0; now 3 MP, 10 TP")))
	// Cartes recalculées avec les PM réels (3) : le plan conjoint ne les rejette pas comme périmées.
	assert.equal(lines.filter((text) => text.includes("[Reachable] me:25 (3 MP)")).length, 2)
	assert.equal(lines.some((text) => text.includes("fallback: stale/inconsistent") || text.includes('"level":"ERROR"')), false)
	assert.match(lines.find((text) => text.includes("[History] T27 ")), /leather_boots:0:-/)
	// Exception pendant la décision : journalisée (ERROR), rien n'est lancé, le plan tire comme sans puce de PM.
	const broken = makeWorld({ turnNumber: 28, enemyAt: [14, 5] })
	const canUseChip = broken.me.canUseChip
	broken.me.canUseChip = function (chip, target) {
		if (chip.name === "leather_boots") throw new Error("boom")
		return canUseChip.call(this, chip, target)
	}
	const report = captureTurn(broken).filter((text) => text.includes('"level":"ERROR"'))
	assert.equal(report.length, 1)
	assert.match(report[0], /"function":"castMpBoost".*boom/)
	assert.deepEqual(broken.actions, ["move", "shoot", "shoot"])
})

test("pickMpBoost: largest integer gain; BUFF_MP is amplified by science and floored; no gain below 1 MP", () => {
	const unit = (chips, science = 0) => ({ id: 1, tp: 10, mp: 3, science, chips, effects: [] })
	const sevenLeague = boots({ id: 12, name: "seven_league_boots", features: [{ type: 7, minValue: 0.4, maxValue: 0.5, turns: 3 }] })
	assert.equal(pickMpBoost(unit([sevenLeague]), 10), null) // 0,45 PM
	assert.equal(pickMpBoost(unit([sevenLeague], 200), 10).gain, 1) // 0,45 × 3 = 1,35
	assert.equal(pickMpBoost(unit([sevenLeague, boots()], 200), 10).chip.name, "leather_boots")
	assert.equal(pickMpBoost(unit([boots()], 200), 10).gain, 2) // PM bruts : non amplifiés
	assert.equal(pickMpBoost(unit([boots()]), 2), null)
	assert.equal(pickMpBoost(unit([boots({ cost: 0 })]), 10), null)
})
