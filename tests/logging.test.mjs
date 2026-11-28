import assert from "node:assert/strict"
import test from "node:test"
import { makeTurnWorld } from "./helpers/turn-world.mjs"

globalThis.Color = { rgb: (red, green, blue) => (red << 16) | (green << 8) | blue }
const debugLogs = []
globalThis.Debug = { log: (...args) => debugLogs.push(args), pause() {} }
globalThis.System = { operations: 10, maxOperations: 100 }
globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4, POISON: 5, BUFF_STRENGTH: 6 }
globalThis.Fight = { turn: 1, me: { id: 7, name: "Kassbi" } }

// Instance neuve du module (jamais initialisée) pour vérifier le défaut « tous actifs sans init ».
const pristine = await import("../dist/Toolbox/Logger.js?pristine")
const logger = await import("../dist/Toolbox/Logger.js")
const debug = await import("../dist/Toolbox/Debug.js")
const { LOG_CONTEXT, LOG_CONTEXTS, LogConfig, log, initLeekLogging, resetLeekLogging, getLogConfig, isLogEnabled } = logger

const REQUIRED_CONTEXTS = [
	"MOVEMENT", "STRATEGY", "COMBAT", "WEAPON", "ARMOR", "CHIP", "PLANNING", "MEMORY",
	"REACHABLE", "THREAT", "OPERATIONS", "SPEECH", "ERROR", "SYSTEM", "SHOOTING", "DEBUG", "ACCESSIBLE_ZONE", "DANGER_ZONE",
	"TARGET_ZONE"
]

/** Capture `console.log` (arguments conservés tels quels) pendant `action`. */
function captureConsole(action) {
	const calls = []
	const original = console.log
	console.log = (...args) => calls.push(args)
	try {
		action()
	} finally {
		console.log = original
	}
	return calls
}

/** Exécute `action` puis remet la configuration par défaut (état du module partagé). */
function withConfig(config, action) {
	initLeekLogging(config)
	try {
		return action()
	} finally {
		resetLeekLogging()
		debugLogs.length = 0
	}
}

// --- configuration et API ----------------------------------------------------

test("the context set is closed, unique, and covers the required contexts", () => {
	for (const name of REQUIRED_CONTEXTS) {
		assert.equal(typeof LOG_CONTEXT[name], "string", name)
	}
	assert.equal(new Set(LOG_CONTEXTS).size, LOG_CONTEXTS.length)
	assert.deepEqual([...LOG_CONTEXTS], Object.values(LOG_CONTEXT))
})

test("default: every context is enabled without any init, and log prints the exact text with no prefix", () => {
	assert.deepEqual(pristine.getLogConfig().enabledContexts(), [...pristine.LOG_CONTEXTS])
	for (const context of pristine.LOG_CONTEXTS) {
		assert.equal(pristine.isLogEnabled(context), true, context)
	}
	const calls = captureConsole(() => {
		pristine.log("=== KASSBI BOOK TURN END ===\n", pristine.LOG_CONTEXT.SYSTEM)
		pristine.log("[Reachable] me:5 (3 MP)", pristine.LOG_CONTEXT.REACHABLE)
	})
	assert.deepEqual(calls, [["=== KASSBI BOOK TURN END ===\n"], ["[Reachable] me:5 (3 MP)"]])
	assert.deepEqual(new LogConfig().enabledContexts(), [...LOG_CONTEXTS])
})

test("LogConfig: isEnabled / setEnabled / setAll / enabledContexts, partial flags, unknown contexts", () => {
	const config = new LogConfig()
	assert.equal(config.setEnabled(LOG_CONTEXT.COMBAT, false), config)
	assert.equal(config.isEnabled(LOG_CONTEXT.COMBAT), false)
	assert.equal(config.isEnabled(LOG_CONTEXT.WEAPON), true)
	assert.equal(config.enabledContexts().includes(LOG_CONTEXT.COMBAT), false)
	assert.equal(config.enabledContexts().length, LOG_CONTEXTS.length - 1)

	config.setAll(false)
	assert.deepEqual(config.enabledContexts(), [])
	config.setEnabled(LOG_CONTEXT.CHIP, true)
	assert.deepEqual(config.enabledContexts(), [LOG_CONTEXT.CHIP])
	config.setAll(true)
	assert.deepEqual(config.enabledContexts(), [...LOG_CONTEXTS])

	assert.equal(config.isEnabled("nope"), false)
	assert.doesNotThrow(() => config.setEnabled("nope", true))
	assert.equal(config.isEnabled("nope"), false)

	const partial = new LogConfig({ [LOG_CONTEXT.MOVEMENT]: false, [LOG_CONTEXT.CHIP]: "no", nope: false })
	assert.equal(partial.isEnabled(LOG_CONTEXT.MOVEMENT), false)
	assert.equal(partial.isEnabled(LOG_CONTEXT.CHIP), true) // valeur non booléenne ignorée
	assert.equal(partial.enabledContexts().length, LOG_CONTEXTS.length - 1)
	assert.doesNotThrow(() => new LogConfig(null))
	assert.doesNotThrow(() => new LogConfig(42))
})

test("an active context logs the exact text through console.log; a disabled one logs nothing at all", () => {
	const config = new LogConfig().setEnabled(LOG_CONTEXT.COMBAT, false)
	withConfig(config, () => {
		const calls = captureConsole(() => {
			log("Enemy HP: 50.0%", LOG_CONTEXT.COMBAT)
			log("[Threat] unavailable", LOG_CONTEXT.THREAT)
		})
		assert.deepEqual(calls, [["[Threat] unavailable"]])
		assert.deepEqual(debugLogs, [])
		assert.equal(isLogEnabled(LOG_CONTEXT.COMBAT), false)
		assert.equal(isLogEnabled(LOG_CONTEXT.THREAT), true)
		assert.equal(getLogConfig(), config)
	})
	assert.equal(getLogConfig().enabledContexts().length, LOG_CONTEXTS.length)
})

test("setAll(false) silences every context, setAll(true) restores them", () => {
	const config = new LogConfig().setAll(false)
	withConfig(config, () => {
		const silent = captureConsole(() => {
			for (const context of LOG_CONTEXTS) {
				log("x", context)
				log("y", context, { color: 5 })
				log("z", context, { sink: "debug" })
			}
		})
		assert.deepEqual(silent, [])
		assert.deepEqual(debugLogs, [])
		config.setAll(true)
		// ERROR sort désormais en rouge par Debug.log (et non plus par console.log) : adaptation de canal assumée.
		assert.equal(captureConsole(() => LOG_CONTEXTS.forEach((context) => log("x", context))).length, LOG_CONTEXTS.length - 1)
		assert.equal(debugLogs.length, 1)
	})
})

test("lazy text: not evaluated when the context is disabled, evaluated exactly once when enabled", () => {
	let evaluations = 0
	const lazy = () => {
		evaluations++
		return `value ${evaluations}`
	}
	withConfig(new LogConfig().setEnabled(LOG_CONTEXT.WEAPON, false), () => {
		const calls = captureConsole(() => log(lazy, LOG_CONTEXT.WEAPON))
		assert.deepEqual(calls, [])
		assert.equal(evaluations, 0)
		const active = captureConsole(() => log(lazy, LOG_CONTEXT.CHIP))
		assert.deepEqual(active, [["value 1"]])
		assert.equal(evaluations, 1)
	})
})

test("colored and debug-sink messages go through Debug.log (same text), plain ones through console.log", () => {
	withConfig(new LogConfig(), () => {
		const calls = captureConsole(() => {
			log("colored", LOG_CONTEXT.SYSTEM, { color: 123 })
			log("error-like", LOG_CONTEXT.ERROR, { sink: "debug" })
			log("plain", LOG_CONTEXT.SYSTEM)
		})
		assert.deepEqual(calls, [["plain"]])
		// ERROR sort en rouge : la couleur rouge est ajoutée (Color.rgb(255, 0, 0) du mock = 0xff0000).
		assert.deepEqual(debugLogs, [["colored", 123], ["error-like", 0xff0000]])
	})
})

test("initLeekLogging: uses a LogConfig as is, accepts partial flags, falls back to all-enabled on invalid input", () => {
	const config = new LogConfig()
	try {
		assert.equal(initLeekLogging(config), config)
		assert.equal(getLogConfig(), config)
		config.setEnabled(LOG_CONTEXT.MEMORY, false) // la config installée reste modifiable
		assert.equal(isLogEnabled(LOG_CONTEXT.MEMORY), false)

		initLeekLogging({ [LOG_CONTEXT.SPEECH]: false })
		assert.equal(isLogEnabled(LOG_CONTEXT.SPEECH), false)
		assert.equal(isLogEnabled(LOG_CONTEXT.MEMORY), true)

		for (const invalid of [undefined, null, 42, "x", true]) {
			config.setAll(false)
			const installed = initLeekLogging(invalid)
			assert.deepEqual(installed.enabledContexts(), [...LOG_CONTEXTS], String(invalid))
		}
		initLeekLogging({ [LOG_CONTEXT.SPEECH]: false })
		const reset = resetLeekLogging()
		assert.deepEqual(reset.enabledContexts(), [...LOG_CONTEXTS])
		assert.equal(getLogConfig(), reset)
	} finally {
		resetLeekLogging()
	}
})

test("log never throws: odd texts, throwing lazy text, unknown context, console or Debug unavailable or failing", () => {
	const originalConsole = globalThis.console
	const originalDebug = globalThis.Debug
	try {
		const captured = captureConsole(() => {
			assert.doesNotThrow(() => log(undefined, LOG_CONTEXT.DEBUG))
			assert.doesNotThrow(() => log(null, LOG_CONTEXT.DEBUG))
			assert.doesNotThrow(() => log(12, LOG_CONTEXT.DEBUG))
			assert.doesNotThrow(() => log({ circular: undefined }, LOG_CONTEXT.DEBUG))
			assert.doesNotThrow(() => log(() => { throw new Error("lazy boom") }, LOG_CONTEXT.DEBUG))
			assert.doesNotThrow(() => log("x", "not-a-context"))
			assert.doesNotThrow(() => log("x"))
		})
		assert.deepEqual(captured.slice(0, 4).map((args) => args.length), [1, 1, 1, 1])
		assert.equal(captured.length, 4) // le texte paresseux qui lève et les contextes inconnus ne sortent rien

		console.log = () => { throw new Error("console broken") }
		assert.doesNotThrow(() => log("x", LOG_CONTEXT.SYSTEM))
		console.log = originalConsole.log

		globalThis.console = undefined
		debugLogs.length = 0
		assert.doesNotThrow(() => log("fallback", LOG_CONTEXT.SYSTEM))
		assert.deepEqual(debugLogs, [["fallback"]]) // repli sur Debug.log faute de console
		globalThis.Debug = undefined
		assert.doesNotThrow(() => log("nowhere", LOG_CONTEXT.SYSTEM))
		assert.doesNotThrow(() => log("nowhere", LOG_CONTEXT.SYSTEM, { color: 1 }))
	} finally {
		globalThis.console = originalConsole
		globalThis.Debug = originalDebug
		debugLogs.length = 0
		resetLeekLogging()
	}
	assert.equal(typeof console.log, "function")
})

// --- sites d'appel de la boîte à outils ----------------------------------------

test("reportError goes through the ERROR context: logged by default, hidden when ERROR is disabled", () => {
	withConfig(new LogConfig(), () => {
		debug.reportError("src/x.ts", "f", new TypeError("boom"))
		assert.equal(debugLogs.length, 1)
		const report = JSON.parse(debugLogs[0][0])
		assert.equal(report.level, "ERROR")
		assert.equal(report.error.message, "boom")
	})
	withConfig(new LogConfig().setEnabled(LOG_CONTEXT.ERROR, false), () => {
		const calls = captureConsole(() => debug.reportError("src/x.ts", "f", new Error("hidden")))
		assert.deepEqual(calls, [])
		assert.deepEqual(debugLogs, [])
		// les autres contextes restent actifs
		assert.equal(captureConsole(() => log("still", LOG_CONTEXT.SYSTEM)).length, 1)
	})
	withConfig(new LogConfig(), () => {
		assert.throws(() => debug.withErrorReporting("src/x.ts", "f", () => { throw new RangeError("kept") }), RangeError)
		assert.equal(debugLogs.length, 1)
	})
})

test("logTurnOperations, begin/end-turn banners, debugSet/debugMap and Operations follow their contexts", () => {
	withConfig(new LogConfig().setEnabled(LOG_CONTEXT.OPERATIONS, false), () => {
		assert.deepEqual(captureConsole(() => debug.logTurnOperations()), [])
		debug.debugBeginTurn()
		debug.debugEndTurn()
		assert.equal(debugLogs.length, 4 + 2) // 4 lignes de début + 2 lignes SYSTEM de fin ; OPERATIONS masqué
	})
	withConfig(new LogConfig().setEnabled(LOG_CONTEXT.SYSTEM, false), () => {
		debug.debugBeginTurn()
		debug.debugEndTurn()
		assert.equal(debugLogs.length, 1) // seule la ligne OPERATIONS de fin
		assert.match(debugLogs[0][0], /^OPERATIONS: 10\/100$/)
	})
	withConfig(new LogConfig().setEnabled(LOG_CONTEXT.DEBUG, false), () => {
		let consumed = false
		function* values() {
			consumed = true
			yield 1
		}
		assert.deepEqual(captureConsole(() => {
			debug.debugSet("v", values())
			debug.debugMap("m", new Map([[1, 2]]))
		}), [])
		assert.equal(consumed, false) // la collection n'est même pas parcourue
	})
	withConfig(new LogConfig(), () => {
		const calls = captureConsole(() => {
			debug.debugSet("v", [1, 2])
			debug.debugMap("m", new Map([["a", "b"]]))
		})
		assert.deepEqual(calls, [["Debug set"], ["v 1"], ["v 2"], ["fin debug set"], ["m a : b"]])
	})
	withConfig(new LogConfig().setEnabled(LOG_CONTEXT.OPERATIONS, false), () => {
		debug.DEBUGS.OPERATIONS = true
		try {
			new debug.Operations("planner").debugOperations()
		} finally {
			debug.DEBUGS.OPERATIONS = false
		}
		assert.deepEqual(debugLogs, [])
	})
})

// --- turn() complet --------------------------------------------------------------

function makeGrid(width, height) {
	const cells = new Map()
	for (let x = 0; x < width; x++) {
		for (let y = 0; y < height; y++) {
			cells.set(`${x},${y}`, { id: y * width + x, x, y, empty: true, obstacle: false, entity: null })
		}
	}
	globalThis.Field = {
		cellFromXY: (x, y) => cells.get(`${x},${y}`) ?? null,
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

const makeEntity = (id, mp) => ({
	id, name: `e${id}`, level: 10, life: 100, maxLife: 100, mp, tp: 10, cell: null, strength: 0, wisdom: 0,
	weapon: null, weapons: [], chips: [], effects: [], launchedEffects: []
})

/** Monde jouable par les plans actuels (`helpers/turn-world.mjs`) : alliée en (5,7), ennemi armé à 4 cases. */
function makeCombatWorld(runId, { enemyLife = 100, turnNumber = 100 + runId } = {}) {
	const grid = makeGrid(21, 21)
	return makeTurnWorld({
		turnNumber, grid, enemyId: 200 + 2 * runId, enemyAt: [9, 5], enemyMp: 2, enemyTp: 5, enemyLife,
		ally: makeEntity(201 + 2 * runId, 2),
		enemyWeapon: {
			id: 90, name: "enemy gun", cost: 3, minRange: 0, maxRange: 6, needsLos: false,
			features: [{ type: 1, minValue: 10, maxValue: 20 }]
		}
	})
}

let runCounter = 1

/** Joue un tour dans un monde neuf (ids et tour distincts : `enemyMemory` est partagé) et renvoie ses lignes normalisées. */
async function playTurn(config, options) {
	const { turn } = await import("../dist/Main/Kassbi_Book.js")
	const { actions } = makeCombatWorld(runCounter++, options)
	const originalLog = console.log
	const lines = []
	// `[History]` : le tour et la passivité viennent de l'état partagé du module (un tour de plus à chaque monde).
	console.log = (...args) => lines.push(args.join(" ").replace(/#\d+/g, "#N").replace(/\be\d+\b/g, "eN")
		.replace(/^\[Speech\] Leek life: ".*"$/, "[Speech] Leek life: N")
		.replace(/"(target|id|awayFrom)":\d+/g, '"$1":N')
		.replace(/^\[History\] T\d+ (.*) passive \d+ \|/, "[History] TN $1 passive N |")
		// Le compteur de duel du livre (`BookStandoff`) vit entre les tours : le détail de la recherche change d'un tour à l'autre.
		.replace(/^\[Book\] (profile|beam|unchosen|chosen)\b.*/, "[Book] $1")
		.replace(/"searchStatus":"book beam depth \d"/, '"searchStatus":"book beam depth N"'))
	try {
		initLeekLogging(config)
		turn()
	} finally {
		console.log = originalLog
		resetLeekLogging()
	}
	return { lines, actions }
}

const CONTEXT_LINES = {
	[LOG_CONTEXT.SYSTEM]: (line) => line.includes("=== KASSBI BOOK TURN START ===") || line.startsWith("Version : ") || line.includes("=== KASSBI BOOK TURN END ==="),
	[LOG_CONTEXT.COMBAT]: (line) => /^(My HP:|Enemy:|Enemy HP:|\[History\] )/.test(line),
	[LOG_CONTEXT.SPEECH]: (line) => line.startsWith("[Speech]"),
	[LOG_CONTEXT.MEMORY]: (line) => line.startsWith("[EnemyMemory]"),
	[LOG_CONTEXT.REACHABLE]: (line) => line.startsWith("[Reachable]"),
	[LOG_CONTEXT.THREAT]: (line) => line.startsWith("[Threat]"),
	[LOG_CONTEXT.ACCESSIBLE_ZONE]: (line) => line.startsWith("Accessible zone:"),
	[LOG_CONTEXT.DANGER_ZONE]: (line) => line.startsWith("Danger zone:"),
	[LOG_CONTEXT.TARGET_ZONE]: (line) => line.startsWith("Target zone:"),
	[LOG_CONTEXT.OPERATIONS]: (line) => line.startsWith("Operations: ") || line.startsWith("[Book] planning ops"),
	[LOG_CONTEXT.WEAPON]: (line) => line.startsWith("[Weapon] "),
	[LOG_CONTEXT.CHIP]: (line) => line.startsWith("[Boost] "),
	[LOG_CONTEXT.PLANNING]: (line) => /^\[(Tactical|Reserve|Plannification)\] |^\[Book\] (?!planning ops)/.test(line)
}
// Ni arme à équiper au tour 1 (une seule arme, déjà en main) ni boost dans ce scénario.
const SCENARIO_DEPENDENT = new Set([LOG_CONTEXT.WEAPON, LOG_CONTEXT.CHIP])

test("turn() with every context enabled: unchanged lines and order (TURN END, then Operations last)", async () => {
	const originalRandom = Math.random
	Math.random = () => 0
	try {
		// Premier tour du module : salutation (SPEECH), une seule fois.
		const first = await playTurn(new LogConfig(), { enemyLife: 10 })
		assert.equal(first.lines.filter((line) => line.startsWith("[Speech] Greeting:")).length, 1)

		const { lines, actions } = await playTurn(new LogConfig(), { enemyLife: 10 })
		assert.deepEqual(actions, ["shoot"]) // 10 PV : le premier tir (22) tue, le second est annulé
		assert.equal(lines[0], "\n=== KASSBI BOOK TURN START ===")
		assert.equal(lines.some((line) => line.startsWith("Version : ")), false) // la version n'est écrite qu'au tour 1
		assert.equal(lines.at(-1), "Operations: 10/100 (10.0%)")
		assert.equal(lines.at(-2), "=== KASSBI BOOK TURN END ===\n")
		// Sans provocation, les 2 `say` du tour sont des lignes du récit du poireau.
		assert.equal(lines.at(-3), "[Speech] Leek life: N")
		assert.equal(lines.at(-4), "[Speech] Leek life: N")
		assert.equal(lines.at(-5), "[History] TN TP 4/10 MP 0/3 dealt 22 taken 0 passive N | machine_gun:1:22")
		assert.ok(lines.some((line) => line.startsWith("[Tactical] plan before execution")))
		assert.ok(lines.some((line) => line.startsWith("[Reachable] me:")))
		assert.ok(lines.some((line) => line.startsWith("[Threat] ")))
		assert.ok(lines.some((line) => line.startsWith("[EnemyMemory] Identified")))
		// chaque ligne est attribuée à (au moins) un contexte : plus aucune ligne « orpheline »
		const unclaimed = lines.filter((line) => !Object.values(CONTEXT_LINES).some((matches) => matches(line)))
		assert.deepEqual(unclaimed, [])
	} finally {
		Math.random = originalRandom
	}
})

for (const context of Object.keys(CONTEXT_LINES)) {
	test(`turn() with only ${context} disabled: its lines disappear, the others and the planned actions are identical`, async () => {
		const originalRandom = Math.random
		Math.random = () => 0
		try {
			const baseline = await playTurn(new LogConfig(), { enemyLife: 10 })
			const disabled = await playTurn(new LogConfig().setEnabled(context, false), { enemyLife: 10 })
			const belongs = CONTEXT_LINES[context]

			const removed = baseline.lines.filter(belongs)
			if (!SCENARIO_DEPENDENT.has(context)) {
				assert.ok(removed.length > 0, `the scenario must produce ${context} lines`)
			}
			assert.equal(disabled.lines.some(belongs), false)
			assert.deepEqual(disabled.lines, baseline.lines.filter((line) => !belongs(line)))
			assert.deepEqual(disabled.actions, baseline.actions)
		} finally {
			Math.random = originalRandom
		}
	})
}

test("turn() logs the deployed version right after TURN START, at turn 1 only", async () => {
	const originalRandom = Math.random
	Math.random = () => 0
	try {
		const first = await playTurn(new LogConfig(), { turnNumber: 1 })
		// `DEPLOYED_VERSION` : réécrit par Garden à chaque PUSH.
		assert.equal(first.lines[1], "Version : locale (non déployée)")
		const later = await playTurn(new LogConfig(), { turnNumber: 2 })
		assert.equal(later.lines.some((line) => line.startsWith("Version : ")), false)
	} finally {
		Math.random = originalRandom
	}
})

test("turn() with setAll(false): no log line at all, same actions; the config is restored afterwards", async () => {
	const baseline = await playTurn(new LogConfig())
	const silent = await playTurn(new LogConfig().setAll(false))
	assert.deepEqual(silent.lines, [])
	assert.deepEqual(silent.actions, baseline.actions)
	assert.ok(baseline.lines.length > 10)
	assert.deepEqual(getLogConfig().enabledContexts(), [...LOG_CONTEXTS])
})

test("Kassbi_Book's leekLogConfig disables the three zone contexts and keeps every other one enabled", async () => {
	const { leekLogConfig } = await import("../dist/Main/Kassbi_Book.js")
	const zones = [LOG_CONTEXT.ACCESSIBLE_ZONE, LOG_CONTEXT.DANGER_ZONE, LOG_CONTEXT.TARGET_ZONE]
	assert.deepEqual(leekLogConfig.enabledContexts(), LOG_CONTEXTS.filter((context) => !zones.includes(context)))
	for (const zone of zones) assert.equal(leekLogConfig.isEnabled(zone), false)
})

test("importing Kassbi_Book installs its own config (leekLogConfig) that can be tuned per context", async () => {
	const { leekLogConfig, turn } = await import("../dist/Main/Kassbi_Book.js")
	initLeekLogging(leekLogConfig)
	try {
		leekLogConfig.setEnabled(LOG_CONTEXT.OPERATIONS, false)
		makeCombatWorld(runCounter++)
		const lines = []
		const original = console.log
		console.log = (...args) => lines.push(args.join(" "))
		try {
			turn()
		} finally {
			console.log = original
		}
		assert.equal(lines.some((line) => line.startsWith("Operations: ")), false)
		assert.equal(lines.at(-1), "=== KASSBI BOOK TURN END ===\n")
	} finally {
		leekLogConfig.setEnabled(LOG_CONTEXT.OPERATIONS, true)
		resetLeekLogging()
	}
})
