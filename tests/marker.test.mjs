import assert from "node:assert/strict"
import test from "node:test"

// Mocks : tout appel à Debug.* et console.log est enregistré, dans l'ordre, dans `trace`.
globalThis.Color = { rgb: (red, green, blue) => (red << 16) | (green << 8) | blue }
globalThis.System = { operations: 10, maxOperations: 100 }
globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4, POISON: 5, BUFF_STRENGTH: 6 }
globalThis.Fight = { turn: 1, me: { id: 7, name: "Kassbi" } }

const trace = []

function installDebug(overrides = {}) {
	globalThis.Debug = {
		log: (...args) => trace.push(["Debug.log", ...args]),
		mark: (cells, color) => { trace.push(["mark", cells, color]); return true },
		markText: (cells, text, color) => { trace.push(["markText", cells, text, color]); return true },
		clearMarks: () => { trace.push(["clearMarks"]) },
		pause: () => { trace.push(["pause"]) },
		...overrides
	}
}

const logger = await import("../dist/Toolbox/Logger.js")
const marker = await import("../dist/Toolbox/Marker.js")
const debugModule = await import("../dist/Toolbox/Debug.js")
const { Coordinates } = await import("../dist/Classes/Context/Coordinates.js")
const { computeReachableCells } = await import("../dist/Classes/Context/ReachableCells.js")
const { ThreatMap } = await import("../dist/Classes/Context/ThreatMap.js")
const { LOG_CONTEXT, LogConfig, initLeekLogging, resetLeekLogging, log } = logger
const { showAccessibleZones, showDangerZone, showTargetZone, MARKER_SETTINGS, markCells, markTextCells, dangerTier, dangerLabel } = marker

const ZONE = LOG_CONTEXT.ACCESSIBLE_ZONE
const DANGER = LOG_CONTEXT.DANGER_ZONE
const TARGET = LOG_CONTEXT.TARGET_ZONE
const RED = 0xff0000

/** Exécute `action` avec console.log enregistré dans `trace` (["log", texte]) ; remet tout par défaut ensuite. */
function recording(config, action) {
	const originalLog = console.log
	const defaults = { ...MARKER_SETTINGS }
	trace.length = 0
	installDebug()
	console.log = (...args) => trace.push(["log", ...args])
	initLeekLogging(config)
	try {
		return action()
	} finally {
		console.log = originalLog
		resetLeekLogging()
		Object.assign(MARKER_SETTINGS, defaults)
		trace.length = 0
	}
}

const names = (calls) => calls.map((call) => call[0])

// --- grille et zones accessibles ---------------------------------------------------------------

let cellFromXYCalls = 0

function makeGrid(width, height) {
	const cells = new Map()
	for (let x = 0; x < width; x++) {
		for (let y = 0; y < height; y++) {
			cells.set(`${x},${y}`, { id: y * width + x, x, y, empty: true, obstacle: false, entity: null })
		}
	}
	cellFromXYCalls = 0
	globalThis.Field = {
		cellFromXY: (x, y) => { cellFromXYCalls++; return cells.get(`${x},${y}`) ?? null },
		lineOfSight: () => true
	}
	return {
		cells,
		place(entity, x, y) {
			const cell = cells.get(`${x},${y}`)
			cell.entity = entity
			cell.empty = false
			entity.cell = cell
			return entity
		}
	}
}

function zonesWorld() {
	const grid = makeGrid(15, 15)
	const entity = (id, name, mp, x, y) => grid.place({ id, name, mp, life: 100 }, x, y)
	const me = entity(1, "Kassbi", 3, 3, 3)
	const ally = entity(2, "Alliee-au-nom-tres-long", 2, 7, 3)
	const enemy = entity(3, "Ennemi", 4, 11, 11)
	const reach = (e) => computeReachableCells(e, e.mp, 5)
	const sources = [
		{ name: me.name, side: "me", reachable: reach(me) },
		{ name: ally.name, side: "ally", reachable: reach(ally) },
		{ name: enemy.name, side: "enemy", reachable: reach(enemy) }
	]
	return { sources, me, ally, enemy }
}

test("accessible zones: exact sequence per leek (clear, log, mark, markText, pause) in order me/allies/enemies, then a final clear", () => {
	const { sources } = zonesWorld()
	recording(new LogConfig(), () => {
		const before = cellFromXYCalls
		assert.equal(showAccessibleZones(sources), 3)
		assert.equal(cellFromXYCalls, before, "cells come from the stored ReachableCells: no Field.cellFromXY call")

		const expectedKinds = []
		for (let i = 0; i < 3; i++) {
			expectedKinds.push("clearMarks", "log", "mark", "markText", "pause")
		}
		expectedKinds.push("clearMarks")
		assert.deepEqual(names(trace), expectedKinds)

		const lines = trace.filter((call) => call[0] === "log").map((call) => call[1])
		assert.deepEqual(lines, [
			`Accessible zone: Kassbi (${sources[0].reachable.size} cells, 3 MP)`,
			`Accessible zone: Alliee-au-nom-tres-long (${sources[1].reachable.size} cells, 2 MP)`,
			`Accessible zone: Ennemi (${sources[2].reachable.size} cells, 4 MP)`
		])

		const marks = trace.filter((call) => call[0] === "mark")
		sources.forEach((source, index) => {
			assert.equal(marks[index][1].length, source.reachable.size, "marked cells = size of the zone")
			assert.deepEqual(marks[index][1], source.reachable.cells())
		})
		// couleurs distinctes par camp
		assert.equal(new Set(marks.map((call) => call[2])).size, 3)

		const texts = trace.filter((call) => call[0] === "markText")
		assert.deepEqual(texts.map((call) => call[2]), ["Kassbi", "Alliee-au-", "Ennemi"]) // 10 caractères max
		texts.forEach((call, index) => assert.equal(call[1], sources[index].reachable.startCell))
	})
})

test("accessible zones: inactive context => no Debug call, no console output, no cell list computed", () => {
	const { sources } = zonesWorld()
	let cellsCalls = 0
	const spied = sources.map((source) => ({
		...source,
		reachable: new Proxy(source.reachable, {
			get(target, property) {
				if (property === "cells") {
					return () => { cellsCalls++; return target.cells() }
				}
				const value = Reflect.get(target, property, target)
				return typeof value === "function" ? value.bind(target) : value
			}
		})
	}))
	recording(new LogConfig().setEnabled(ZONE, false), () => {
		assert.equal(showAccessibleZones(spied), 0)
		assert.deepEqual(trace, [])
		assert.equal(cellsCalls, 0)
		// les autres contextes ne sont pas affectés
		log("still here", LOG_CONTEXT.SYSTEM)
		assert.deepEqual(trace, [["log", "still here"]])
	})
	recording(new LogConfig(), () => {
		showAccessibleZones(spied)
		assert.equal(cellsCalls, 3)
	})
})

test("accessible zones: nothing for an empty list or leeks without cells; a failing Debug never throws and the sequence continues", () => {
	const { sources } = zonesWorld()
	recording(new LogConfig(), () => {
		assert.equal(showAccessibleZones([]), 0)
		assert.equal(showAccessibleZones([{ name: "x", side: "enemy", reachable: null }]), 0)
		assert.equal(showAccessibleZones(undefined), 0)
		assert.deepEqual(trace, [])
	})
	recording(new LogConfig(), () => {
		installDebug({ mark() { throw new Error("mark exploded") } })
		assert.doesNotThrow(() => showAccessibleZones(sources))
		// mark échoue mais le reste de la séquence est tenté : 3 x (clear, log, markText, pause) + clear final
		assert.equal(trace.filter((call) => call[0] === "pause").length, 3)
	})
	recording(new LogConfig(), () => {
		installDebug({ markText(cells, text, color) {
			if (color !== undefined) throw new Error("3-argument form rejected by the host")
			trace.push(["markText", cells, text, "fallback"])
			return true
		} })
		assert.doesNotThrow(() => showAccessibleZones(sources))
		assert.deepEqual(trace.filter((call) => call[0] === "markText").map((call) => call[3]), ["fallback", "fallback", "fallback"])
	})
	for (const broken of [undefined, null, {}, { log() {} }, { mark: 1, pause: "x", clearMarks: null }]) {
		recording(new LogConfig(), () => {
			globalThis.Debug = broken
			assert.doesNotThrow(() => showAccessibleZones(sources))
			assert.doesNotThrow(() => showDangerZone(new ThreatMap(1, 1, new Map(), emptyStats())))
		})
	}
	recording(new LogConfig(), () => {
		delete globalThis.Debug // global absent : ReferenceError attrapée
		assert.doesNotThrow(() => showAccessibleZones(sources))
		assert.equal(markCells({ x: 0, y: 0 }, 1, ZONE), false)
	})
})

// --- zone de danger ------------------------------------------------------------------------------

function emptyStats(overrides = {}) {
	return { truncated: false, inputsTruncated: false, enemyCount: 1, pairsEvaluated: 0, lineOfSightCalls: 0, candidateCells: 0, ...overrides }
}

function dangerMap(dangers, statsOverrides) {
	const byKey = new Map()
	dangers.forEach((danger, index) => {
		const cell = { id: index, x: index, y: 0, empty: true, obstacle: false, entity: null }
		byKey.set(cell.x * 4096 + cell.y, { cell, mpCost: index, danger, breakdown: [] })
	})
	return new ThreatMap(1, 1, byKey, emptyStats({ candidateCells: dangers.length, ...statsOverrides }))
}

test("danger zone: clear, log, one mark per tier, one markText per distinct rounded damage, pause, final clear", () => {
	const map = dangerMap([0, 10.4, 10.6, 25, 50, 50])
	recording(new LogConfig(), () => {
		showDangerZone(map)
		assert.deepEqual(names(trace), [
			"clearMarks", "log",
			"mark", "mark", "mark", "mark", // paliers 0, 1, 2 et 4 utilisés
			"markText", "markText", "markText", "markText", "markText", // "0", "10", "11", "25", "50"
			"pause", "clearMarks"
		])
		assert.equal(trace[1][1], "Danger zone: 6 cells, max 50.0")
		const marks = trace.filter((call) => call[0] === "mark")
		assert.deepEqual(marks.map((call) => call[1].map((cell) => cell.x)), [[0], [1, 2], [3], [4, 5]])
		// dégradé : couleurs toutes différentes, de vert à rouge
		const colors = marks.map((call) => call[2])
		assert.equal(new Set(colors).size, 4)
		assert.equal(colors[0], (0 << 16) | (200 << 8) | 0)
		assert.equal(colors.at(-1), 0xff0000)
		const texts = trace.filter((call) => call[0] === "markText")
		assert.deepEqual(texts.map((call) => call[2]), ["0", "10", "11", "25", "50"])
		assert.deepEqual(texts.at(-1)[1].map((cell) => cell.x), [4, 5]) // même texte : cases regroupées
		const labelled = texts.flatMap((call) => call[1])
		assert.equal(labelled.length, 6)
	})
})

test("danger zone: label = rounded damage within 10 characters, tiers are relative to the max", () => {
	assert.equal(dangerLabel(12.5), "13")
	assert.equal(dangerLabel(0), "0")
	assert.equal(dangerLabel(1e21), "9999999999")
	assert.equal(dangerLabel(-1e21), "-999999999")
	for (const value of [0, 0.4, 99.5, 123456789.6, 1e10, 1e300, -3, -1e300]) {
		assert.ok(dangerLabel(value).length <= 10, String(value))
	}
	assert.equal(dangerTier(0, 50), 0)
	assert.equal(dangerTier(50, 50), 4)
	assert.equal(dangerTier(24.9, 50), 2)
	assert.equal(dangerTier(5, 0), 0) // carte sans danger : tout vert
	assert.equal(dangerTier(Number.NaN, 50), 0)
})

test("danger zone: very large damage stays within 10 characters on the field", () => {
	recording(new LogConfig(), () => {
		showDangerZone(dangerMap([1e15, 3]))
		const texts = trace.filter((call) => call[0] === "markText").map((call) => call[2])
		assert.deepEqual(texts, ["9999999999", "3"])
		assert.ok(texts.every((text) => text.length <= 10))
	})
})

test("danger zone: the markText call cap is respected (nearest cells first), capped cells stay colored", () => {
	const map = dangerMap([1, 2, 3, 4, 5, 6, 7, 8])
	recording(new LogConfig(), () => {
		MARKER_SETTINGS.maxDangerTextCalls = 3
		showDangerZone(map)
		const texts = trace.filter((call) => call[0] === "markText")
		assert.equal(texts.length, 3)
		assert.deepEqual(texts.map((call) => call[2]), ["1", "2", "3"])
		const colored = trace.filter((call) => call[0] === "mark").flatMap((call) => call[1])
		assert.equal(colored.length, 8)
	})
	assert.equal(MARKER_SETTINGS.maxDangerTextCalls, 120) // réglage remis par défaut
})

test("danger zone: only evaluated cells are marked (truncated map), absent or empty map is a no-op", () => {
	const map = dangerMap([5, 9], { truncated: true, candidateCells: 40 })
	recording(new LogConfig(), () => {
		showDangerZone(map)
		assert.equal(trace[1][1], "Danger zone: 2 cells, max 9.0 (truncated)")
		const marked = trace.filter((call) => call[0] === "mark").flatMap((call) => call[1])
		assert.deepEqual(marked.map((cell) => cell.x).sort(), [0, 1])
	})
	recording(new LogConfig(), () => {
		showDangerZone(null)
		showDangerZone(undefined)
		showDangerZone(dangerMap([]))
		assert.deepEqual(trace, [])
	})
})

test("danger zone: inactive context => no call, no computation; pause is a modifiable setting", () => {
	let entriesCalls = 0
	const map = dangerMap([1, 2, 3])
	const spied = new Proxy(map, {
		get(target, property) {
			if (property === "entries") {
				return () => { entriesCalls++; return target.entries() }
			}
			const value = Reflect.get(target, property, target)
			return typeof value === "function" ? value.bind(target) : value
		}
	})
	recording(new LogConfig().setEnabled(DANGER, false), () => {
		showDangerZone(spied)
		assert.deepEqual(trace, [])
		assert.equal(entriesCalls, 0)
	})
	recording(new LogConfig(), () => {
		MARKER_SETTINGS.dangerZonePause = false
		showDangerZone(map)
		assert.equal(trace.some((call) => call[0] === "pause"), false)
		assert.equal(names(trace).filter((name) => name === "clearMarks").length, 1) // marques conservées jusqu'au prochain clear
		assert.equal(names(trace).at(-1), "markText")
	})
	recording(new LogConfig(), () => {
		assert.doesNotThrow(() => showDangerZone({ size: 3, maxDanger: 1, entries() { throw new Error("broken map") } }))
	})
})

// --- ERROR en rouge ------------------------------------------------------------------------------

test("ERROR context is red through Debug.log and still obeys its activation; other contexts are not colored", () => {
	recording(new LogConfig(), () => {
		debugModule.reportError("src/x.ts", "f", new TypeError("boom"))
		assert.equal(trace.length, 1)
		assert.equal(trace[0][0], "Debug.log")
		assert.equal(JSON.parse(trace[0][1]).error.message, "boom") // texte inchangé
		assert.equal(trace[0][2], RED)
		trace.length = 0
		log("plain error text", LOG_CONTEXT.ERROR)
		assert.deepEqual(trace, [["Debug.log", "plain error text", RED]])
		trace.length = 0
		log("explicit", LOG_CONTEXT.ERROR, { color: 42 })
		assert.deepEqual(trace, [["Debug.log", "explicit", 42]]) // une couleur explicite est respectée
		trace.length = 0
		log("warning-ish", LOG_CONTEXT.SYSTEM)
		assert.deepEqual(trace, [["log", "warning-ish"]])
	})
	recording(new LogConfig().setEnabled(LOG_CONTEXT.ERROR, false), () => {
		debugModule.reportError("src/x.ts", "f", new Error("hidden"))
		log("hidden too", LOG_CONTEXT.ERROR)
		assert.deepEqual(trace, [])
	})
})

test("ERROR red: Color unavailable => plain message; 2-argument Debug.log rejected => message kept without color; no Debug => console", () => {
	recording(new LogConfig(), () => {
		const originalColor = globalThis.Color
		try {
			globalThis.Color = undefined
			log("no color api", LOG_CONTEXT.ERROR)
			assert.deepEqual(trace, [["log", "no color api"]]) // sans Debug.log demandé : console
		} finally {
			globalThis.Color = originalColor
		}
	})
	recording(new LogConfig(), () => {
		const seen = []
		globalThis.Debug = { log: (...args) => { seen.push(args); if (args.length > 1) throw new Error("arity") } }
		assert.doesNotThrow(() => log("kept", LOG_CONTEXT.ERROR))
		assert.deepEqual(seen, [["kept", RED], ["kept"]])
	})
	recording(new LogConfig(), () => {
		globalThis.Debug = undefined
		assert.doesNotThrow(() => log("console fallback", LOG_CONTEXT.ERROR))
		assert.deepEqual(trace, [["log", "console fallback"]])
	})
})

// --- anciens marquages DEBUGS.* : actifs seulement si drapeau ET contexte ------------------------------

test("legacy marks: DEBUGS flags are false by default (no pause) and require flag AND context when enabled", () => {
	const { DEBUGS, debugPause, Operations } = debugModule
	assert.equal(DEBUGS.CONST_DEBUG_PAUSE, false)
	assert.equal(DEBUGS.OPERATIONS, false)
	recording(new LogConfig(), () => {
		debugPause()
		new Operations("x", true).debugOperations()
		assert.deepEqual(trace, []) // défaut : aucun drapeau => aucune pause, tous contextes actifs
	})
	try {
		recording(new LogConfig(), () => {
			DEBUGS.CONST_DEBUG_PAUSE = true
			debugPause()
			assert.deepEqual(names(trace), ["pause"])
		})
		recording(new LogConfig().setEnabled(LOG_CONTEXT.SYSTEM, false), () => {
			DEBUGS.CONST_DEBUG_PAUSE = true
			debugPause()
			assert.deepEqual(trace, []) // drapeau vrai mais contexte inactif
		})
		recording(new LogConfig(), () => {
			DEBUGS.OPERATIONS = true
			new Operations("x", true).debugOperations()
			assert.deepEqual(names(trace), ["Debug.log", "Debug.log", "pause"])
		})
		recording(new LogConfig().setEnabled(LOG_CONTEXT.OPERATIONS, false), () => {
			DEBUGS.OPERATIONS = true
			new Operations("x", true).debugOperations()
			assert.deepEqual(trace, [])
		})
	} finally {
		DEBUGS.CONST_DEBUG_PAUSE = false
		DEBUGS.OPERATIONS = false
	}
})

test("Coordinates.mark / markArray go through the DEBUG context", () => {
	makeGrid(5, 5)
	const origin = new Coordinates(1, 1)
	const other = new Coordinates(2, 2)
	recording(new LogConfig(), () => {
		origin.mark(77)
		Coordinates.markArray([origin, other], 88)
		assert.deepEqual(names(trace), ["mark", "mark"])
		assert.equal(trace[0][1].x, 1)
		assert.equal(trace[1][1].length, 2)
	})
	recording(new LogConfig().setEnabled(LOG_CONTEXT.DEBUG, false), () => {
		origin.mark(77)
		Coordinates.markArray([origin, other], 88)
		assert.deepEqual(trace, [])
	})
	recording(new LogConfig(), () => {
		const missing = new Coordinates(99, 99)
		assert.throws(() => missing.mark(1), RangeError) // comportement historique conservé
	})
})

test("primitives: gate and context both required, text truncated to 10 characters", () => {
	recording(new LogConfig(), () => {
		assert.equal(markCells({ x: 0, y: 0 }, 5, ZONE, false), false)
		assert.equal(marker.pauseFight(ZONE, false), false)
		assert.equal(marker.clearAllMarks(ZONE, false), false)
		assert.deepEqual(trace, [])
		assert.equal(markTextCells({ x: 0, y: 0 }, "0123456789ABC", 5, ZONE), true)
		assert.equal(trace[0][2], "0123456789")
	})
})

// --- turn() complet ------------------------------------------------------------------------------

function makeCombatWorld(runId, { getAlliesFailsOnSecondCall = false } = {}) {
	const grid = makeGrid(21, 21)
	const actions = []
	let tp = 7
	let equippedWeapon = null
	let inRange = false
	const enemyGun = {
		id: 90, name: "enemy gun", cost: 3, minRange: 0, maxRange: 6, needsLos: false,
		features: [{ type: 1, minValue: 10, maxValue: 20 }]
	}
	const enemy = grid.place({
		id: 400 + 2 * runId, name: "Ennemi", level: 10, life: 10, maxLife: 100, mp: 2, tp: 5,
		strength: 0, agility: 0, wisdom: 0, resistance: 0, science: 0, magic: 0,
		weapon: enemyGun, weapons: [], chips: [], effects: [], launchedEffects: []
	}, 9, 5)
	const ally = grid.place({
		id: 401 + 2 * runId, name: "Alliee", level: 10, life: 100, maxLife: 100, mp: 2, tp: 10, strength: 0, wisdom: 0,
		weapon: null, weapons: [], chips: [], effects: [], launchedEffects: []
	}, 5, 7)
	const weakWeapon = { name: "weak", cost: 3, minRange: 0, maxRange: 2, features: [{ type: 1, minValue: 5, maxValue: 10 }] }
	const strongWeapon = { name: "strong", cost: 2, minRange: 1, maxRange: 5, features: [{ type: 1, minValue: 12, maxValue: 18 }] }
	const bandage = { name: "bandage", cost: 1, currentCooldown: 0, features: [{ type: 2, minValue: 5, maxValue: 15 }] }
	const attackChip = { name: "attack chip", cost: 1, currentCooldown: 0, features: [{ type: 1, minValue: 4, maxValue: 8 }] }
	const me = grid.place({
		id: 1, name: "Kassbi", level: 10, life: 70, maxLife: 100, mp: 3, tp,
		strength: 0, wisdom: 0,
		weapons: [weakWeapon, strongWeapon],
		chips: [bandage, attackChip],
		effects: [], launchedEffects: [],
		get weapon() { return equippedWeapon },
		distance: () => 4,
		say() {},
		setWeapon(weapon) { actions.push("equip"); equippedWeapon = weapon; tp -= 1 },
		useChip(chip) { actions.push(chip.name); tp -= chip.cost },
		chipCells: () => [me.cell],
		canUseWeapon: () => inRange && equippedWeapon !== null && tp >= equippedWeapon.cost,
		moveToward() { actions.push("move"); inRange = true },
		useWeapon() { actions.push("shoot"); tp -= equippedWeapon.cost },
		moveAwayFrom() { actions.push("retreat") }
	}, 5, 5)
	let allyCalls = 0
	globalThis.Fight = {
		me,
		turn: 300 + runId,
		getNearestEnemy: () => enemy,
		getEnemies: () => [enemy],
		getAliveEnemies: () => (enemy.life > 0 ? [enemy] : []),
		getAllies: () => {
			allyCalls++
			if (getAlliesFailsOnSecondCall && allyCalls === 2) {
				throw new Error("getAllies failed while displaying")
			}
			return [me, ally]
		}
	}
	globalThis.Weapon = { pistol: weakWeapon }
	globalThis.Chip = { bandage }
	return { actions }
}

let runCounter = 1

async function playTurn(config, { debug, worldOptions } = {}) {
	const { turn } = await import("../dist/Main/Kassbi_Class.js")
	const { actions } = makeCombatWorld(runCounter++, worldOptions)
	const originalLog = console.log
	const originalRandom = Math.random
	Math.random = () => 0
	trace.length = 0
	installDebug()
	if (debug !== undefined) {
		debug()
	}
	console.log = (...args) => trace.push(["log", ...args])
	const fieldCallsBefore = cellFromXYCalls
	try {
		initLeekLogging(config)
		turn()
	} finally {
		console.log = originalLog
		Math.random = originalRandom
		resetLeekLogging()
	}
	const result = { actions, calls: trace.map((call) => [...call]), fieldCalls: cellFromXYCalls - fieldCallsBefore }
	trace.length = 0
	return result
}

test("turn(): zones are displayed after observeReachableCells / observeThreatMap and before planAct, with no extra Field.cellFromXY call", async () => {
	await playTurn(new LogConfig()) // 1er tour du module (salutation) : on mesure les suivants
	// TARGET_ZONE (nouveau contexte visuel, actif par défaut) est coupé ici : ce test porte sur les deux autres zones.
	const on = await playTurn(new LogConfig().setEnabled(TARGET, false))
	const off = await playTurn(new LogConfig().setEnabled(ZONE, false).setEnabled(DANGER, false).setEnabled(TARGET, false))

	const text = on.calls.filter((call) => call[0] === "log").map((call) => call[1])
	const index = (prefix) => text.findIndex((line) => String(line).startsWith(prefix))
	assert.ok(index("[Reachable]") < index("Accessible zone: Kassbi"))
	assert.ok(index("Accessible zone: Kassbi") < index("Accessible zone: Alliee"))
	assert.ok(index("Accessible zone: Alliee") < index("Accessible zone: Ennemi"))
	assert.ok(index("Accessible zone: Ennemi") < index("[Threat]"))
	assert.ok(index("[Threat]") < index("Danger zone:"))
	assert.ok(index("Danger zone:") < index("[Plannification] PredictContactNextTurn"))

	const kinds = on.calls.map((call) => call[0])
	assert.equal(kinds.filter((kind) => kind === "pause").length, 4) // 3 poireaux + 1 zone de danger
	// aucune marque dans le mode « tout désactivé » ; Field.cellFromXY identique (aucun appel de plus)
	assert.equal(off.calls.some((call) => ["mark", "markText", "clearMarks", "pause"].includes(call[0])), false)
	assert.equal(on.fieldCalls, off.fieldCalls)
	assert.deepEqual(on.actions, off.actions)
})

test("turn(): plays the same actions when Debug is missing, incomplete or throwing, or when building the zones fails", async () => {
	const baseline = await playTurn(new LogConfig().setEnabled(ZONE, false).setEnabled(DANGER, false))
	assert.ok(baseline.actions.length > 3)
	const brokenDebugs = {
		"mark throws": () => { globalThis.Debug.mark = () => { throw new Error("mark exploded") } },
		"all visual calls throw": () => {
			for (const name of ["mark", "markText", "clearMarks", "pause"]) {
				globalThis.Debug[name] = () => { throw new Error(`${name} exploded`) }
			}
		},
		"Debug incomplete": () => { globalThis.Debug = { log() {} } },
		"Debug undefined": () => { globalThis.Debug = undefined }
	}
	for (const [label, debug] of Object.entries(brokenDebugs)) {
		const result = await playTurn(new LogConfig(), { debug })
		assert.deepEqual(result.actions, baseline.actions, label)
	}

	// Une erreur DANS la construction de l'affichage : rapportée en rouge (ERROR), le tour continue.
	const failing = await playTurn(new LogConfig(), { worldOptions: { getAlliesFailsOnSecondCall: true } })
	assert.deepEqual(failing.actions, baseline.actions)
	const reports = failing.calls.filter((call) => call[0] === "Debug.log" && String(call[1]).includes("displayAccessibleZones"))
	assert.equal(reports.length, 1)
	assert.equal(reports[0][2], RED)
	assert.ok(failing.calls.some((call) => call[0] === "log" && String(call[1]).startsWith("Danger zone:")), "the danger zone is still shown")

	// ERROR désactivé : l'erreur d'affichage est masquée, le tour joue quand même.
	const hidden = await playTurn(new LogConfig().setEnabled(LOG_CONTEXT.ERROR, false), { worldOptions: { getAlliesFailsOnSecondCall: true } })
	assert.deepEqual(hidden.actions, baseline.actions)
	assert.equal(hidden.calls.some((call) => call[0] === "Debug.log"), false)
})

test("each zone context can be disabled independently inside turn()", async () => {
	const onlyDanger = await playTurn(new LogConfig().setEnabled(ZONE, false).setEnabled(TARGET, false))
	assert.equal(onlyDanger.calls.some((call) => String(call[1]).startsWith("Accessible zone:")), false)
	assert.equal(onlyDanger.calls.filter((call) => call[0] === "pause").length, 1)
	const onlyZones = await playTurn(new LogConfig().setEnabled(DANGER, false).setEnabled(TARGET, false))
	assert.equal(onlyZones.calls.some((call) => String(call[1]).startsWith("Danger zone:")), false)
	assert.equal(onlyZones.calls.filter((call) => call[0] === "pause").length, 3)
})

// --- compléments QA : cas qui laissaient survivre des mutants -------------------------------------

test("turn(): with ACCESSIBLE_ZONE inactive, the zone source list is not even built (one Fight.getAllies call less)", async () => {
	await playTurn(new LogConfig()) // 1er tour du module (salutation)
	let calls = 0
	const count = () => {
		const original = globalThis.Fight.getAllies
		globalThis.Fight.getAllies = () => {
			calls++
			return original()
		}
	}
	await playTurn(new LogConfig(), { debug: count })
	const withZone = calls
	calls = 0
	await playTurn(new LogConfig().setEnabled(ZONE, false), { debug: count })
	assert.ok(withZone >= 1)
	assert.equal(calls, withZone - 1)
})

test("ERROR red fallback keeps the message exactly once: 2-argument rejection retries Debug.log(value) and never touches console", () => {
	recording(new LogConfig(), () => {
		const seen = []
		globalThis.Debug = { log: (...args) => { seen.push(args); if (args.length > 1) throw new Error("arity") } }
		log("kept once", LOG_CONTEXT.ERROR)
		assert.deepEqual(seen, [["kept once", RED], ["kept once"]])
		assert.deepEqual(trace.filter((call) => call[0] === "log"), []) // pas de doublon sur console.log
	})
})

test("ERROR message falls back to console.log once when Debug.log throws for both forms", () => {
	recording(new LogConfig(), () => {
		const seen = []
		globalThis.Debug = { log: (...args) => { seen.push(args); throw new Error("broken") } }
		assert.doesNotThrow(() => log("never lost", LOG_CONTEXT.ERROR))
		assert.deepEqual(seen, [["never lost", RED], ["never lost"]])
		assert.deepEqual(trace.filter((call) => call[0] === "log"), [["log", "never lost"]])
	})
})

test("text on the cells is white in both zones (accessible name and danger damage)", () => {
	const WHITE = 0xffffff
	const { sources } = zonesWorld()
	recording(new LogConfig(), () => {
		showAccessibleZones(sources)
		const accessible = trace.filter((call) => call[0] === "markText")
		assert.equal(accessible.length, 3)
		assert.deepEqual(accessible.map((call) => call[3]), [WHITE, WHITE, WHITE])
		trace.length = 0
		showDangerZone(dangerMap([1, 2, 2, 9]))
		const danger = trace.filter((call) => call[0] === "markText")
		assert.equal(danger.length, 3)
		assert.deepEqual(danger.map((call) => call[3]), [WHITE, WHITE, WHITE])
	})
})

test("danger zone: cells with a non-finite danger are skipped (neither colored nor labelled) and the others are still shown", () => {
	recording(new LogConfig(), () => {
		assert.doesNotThrow(() => showDangerZone(dangerMap([5, Number.NaN, Number.POSITIVE_INFINITY, 10])))
		const colored = trace.filter((call) => call[0] === "mark").flatMap((call) => call[1].map((cell) => cell.x))
		const labelled = trace.filter((call) => call[0] === "markText").flatMap((call) => call[1].map((cell) => cell.x))
		assert.deepEqual(colored.sort(), [0, 3])
		assert.deepEqual(labelled.sort(), [0, 3])
		assert.deepEqual(trace.filter((call) => call[0] === "markText").map((call) => call[2]), ["5", "10"])
		assert.equal(names(trace).at(-1), "clearMarks") // la séquence va jusqu'au bout
	})
})

// --- zone visée (TARGET_ZONE) ----------------------------------------------------------------------

test("target zone: same sequence as the danger zone under its own context and label", () => {
	const map = dangerMap([10.4, 10.6, 25, 50, 50], { truncated: true })
	recording(new LogConfig(), () => {
		showDangerZone(map)
		const danger = trace.map((call) => [...call])
		trace.length = 0
		showTargetZone(map)
		assert.deepEqual(names(trace), [
			"clearMarks", "log", "mark", "mark", "mark", "markText", "markText", "markText", "markText", "pause", "clearMarks"
		])
		assert.equal(trace[1][1], "Target zone: 5 cells, max 50.0 (truncated)")
		assert.equal(danger[1][1], "Danger zone: 5 cells, max 50.0 (truncated)")
		// hors libellé du log : appels strictement identiques (cases, couleurs, textes)
		assert.deepEqual(trace.filter((call) => call[0] !== "log"), danger.filter((call) => call[0] !== "log"))
	})
	recording(new LogConfig(), () => {
		showTargetZone(dangerMap([3]))
		assert.equal(trace[1][1], "Target zone: 1 cells, max 3.0")
	})
})

test("target zone: inactive context => no call, no computation; each of the two contexts is independent", () => {
	let entriesCalls = 0
	const map = dangerMap([1, 2, 3])
	const spied = new Proxy(map, {
		get(target, property) {
			if (property === "entries") {
				return () => { entriesCalls++; return target.entries() }
			}
			const value = Reflect.get(target, property, target)
			return typeof value === "function" ? value.bind(target) : value
		}
	})
	recording(new LogConfig().setEnabled(TARGET, false), () => {
		showTargetZone(spied)
		assert.deepEqual(trace, [])
		assert.equal(entriesCalls, 0)
		showDangerZone(map) // DANGER_ZONE reste actif
		assert.equal(trace[1][1], "Danger zone: 3 cells, max 3.0")
	})
	recording(new LogConfig().setEnabled(DANGER, false), () => {
		showDangerZone(map)
		assert.deepEqual(trace, [])
		showTargetZone(map)
		assert.equal(trace[1][1], "Target zone: 3 cells, max 3.0")
	})
	recording(new LogConfig(), () => {
		showTargetZone(null)
		showTargetZone(undefined)
		showTargetZone(dangerMap([]))
		assert.deepEqual(trace, [])
		assert.doesNotThrow(() => showTargetZone({ size: 3, maxDanger: 1, entries() { throw new Error("broken map") } }))
	})
})

test("turn(): the target zone is shown right after the danger zone and before the plan; inactive => not computed, same actions", async () => {
	const { enemyMemory } = await import("../dist/Main/Kassbi_Class.js")
	await playTurn(new LogConfig()) // 1er tour du module (salutation) si ce test tourne seul
	let computed = 0
	const original = enemyMemory.computeTargetZone
	enemyMemory.computeTargetZone = function (...args) { computed++; return original.apply(this, args) }
	try {
		const on = await playTurn(new LogConfig())
		assert.equal(computed, 1)
		const text = on.calls.filter((call) => call[0] === "log").map((call) => String(call[1]))
		const index = (prefix) => text.findIndex((line) => line.startsWith(prefix))
		assert.equal(text.filter((line) => line.startsWith("Target zone:")).length, 1)
		assert.equal(index("Target zone:"), index("Danger zone:") + 1)
		assert.ok(index("Target zone:") < index("[Plannification] PredictContactNextTurn"))
		assert.equal(on.calls.filter((call) => call[0] === "pause").length, 5) // 3 poireaux + zone de danger + zone visée

		computed = 0
		const off = await playTurn(new LogConfig().setEnabled(TARGET, false))
		assert.equal(computed, 0)
		assert.equal(off.calls.some((call) => String(call[1]).startsWith("Target zone:")), false)
		assert.equal(off.calls.filter((call) => call[0] === "pause").length, 4)
		assert.ok(off.fieldCalls < on.fieldCalls) // l'énumération des cases visées n'a pas eu lieu
		assert.deepEqual(on.actions, off.actions)

		// Une erreur dans le calcul de la zone : rapportée (ERROR), le tour joue les mêmes actions.
		enemyMemory.computeTargetZone = () => { throw new Error("zone exploded") }
		const failing = await playTurn(new LogConfig())
		assert.deepEqual(failing.actions, off.actions)
		assert.equal(failing.calls.filter((call) => call[0] === "Debug.log" && String(call[1]).includes("displayTargetZone")).length, 1)
	} finally {
		enemyMemory.computeTargetZone = original
	}
})
