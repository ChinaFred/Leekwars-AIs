import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

/**
 * Politique de journalisation : toute sortie texte passe par `log(texte, contexte)` de
 * `src/Toolbox/Logger.ts`. Ce test lit les sources `.ts` actives (hors archives `_oldLeekScript`) et échoue
 * si un appel direct à `console.*`, `Debug.log`, `System.print` ou au global `debug(` apparaît ailleurs.
 * Les sorties visuelles `Debug.mark` / `markText` / `clearMarks` / `pause` / `show` ne sont pas des logs texte :
 * la règle « texte » les ignore, mais une seconde règle (« visuelle ») les confine à `src/Toolbox/Marker.ts`.
 */

const SRC_ROOT = fileURLToPath(new URL("../src/", import.meta.url))

/** Exceptions explicites et minimales (chemins relatifs à src/, séparateur `/`). */
const ALLOWED_FILES = new Set([
	// Le logger est, par conception, le seul point de sortie réelle (console.log / Debug.log).
	"Toolbox/Logger.ts"
])

/**
 * Seul point de sortie visuelle (Debug.mark / markText / clearMarks / pause / show). Aucune autre exception :
 * Debug.ts passe par Marker.ts.
 */
const VISUAL_ALLOWED_FILES = new Set([
	"Toolbox/Marker.ts"
])

const FORBIDDEN = [
	// Tout usage de l'identifiant `console` (appel direct, `console["log"]`, alias `const c = console`).
	{ name: "console", pattern: /\bconsole\b/ },
	// Tout usage de `Debug` sauf les sorties visuelles : couvre aussi `Debug["log"]` et les alias.
	{ name: "Debug.log", pattern: /\bDebug\b(?!\s*\.\s*(mark|markText|pause|clearMarks|show)\b)/ },
	{ name: "System.print", pattern: /\bSystem\s*(\.\s*print|\[)/ },
	// Global historique `debug(...)` (pas `this.debug(`, ni la déclaration d'une méthode `debug(`).
	{ name: "debug()", pattern: /(^|[^.\w$])debug\s*\(/, skipLine: /\b(private|public|protected|static|function)\s+debug\s*\(/ }
]

/**
 * Retire commentaires et texte littéral des chaînes/gabarits (les sauts de ligne sont conservés). Les
 * expressions `${ ... }` d'un gabarit restent du CODE (un `${console.log(x)}` doit être détecté).
 */
function stripCommentsAndStrings(source) {
	let out = ""
	let state = "code"
	let quote = ""
	// Profondeurs d'accolades auxquelles un `${` de gabarit est ouvert (gabarits imbriqués).
	const templates = []
	let depth = 0
	for (let i = 0; i < source.length; i++) {
		const char = source[i]
		const next = source[i + 1]
		if (state === "code") {
			if (char === "/" && next === "/") {
				state = "line"
				i++
			} else if (char === "/" && next === "*") {
				state = "block"
				i++
			} else if (char === "`") {
				state = "template"
				out += char
			} else if (char === "\"" || char === "'") {
				state = "string"
				quote = char
				out += char
			} else if (char === "{") {
				depth++
				out += char
			} else if (char === "}") {
				if (templates.length > 0 && templates[templates.length - 1] === depth) {
					templates.pop()
					state = "template"
				} else {
					depth--
				}
				out += char
			} else {
				out += char
			}
		} else if (state === "template") {
			if (char === "\\") {
				i++
			} else if (char === "`") {
				state = "code"
				out += char
			} else if (char === "$" && next === "{") {
				templates.push(depth)
				state = "code"
				out += "${"
				i++
			} else if (char === "\n") {
				out += char
			}
		} else if (state === "line") {
			if (char === "\n") {
				state = "code"
				out += char
			}
		} else if (state === "block") {
			if (char === "*" && next === "/") {
				state = "code"
				i++
			} else if (char === "\n") {
				out += char
			}
		} else if (char === "\\") {
			i++
		} else if (char === quote) {
			state = "code"
			out += char
		} else if (char === "\n") {
			out += char
		}
	}
	return out
}

function findViolations(source) {
	return scan(source, FORBIDDEN)
}

/** Sorties visuelles directes (`Debug.mark(...)`, `Debug . pause()`...). */
const VISUAL_FORBIDDEN = [
	{ name: "Debug.visual", pattern: /\bDebug\s*\.\s*(mark|markText|pause|clearMarks|show)\b/ }
]

function findVisualViolations(source) {
	return scan(source, VISUAL_FORBIDDEN)
}

function scan(source, rules) {
	const violations = []
	const lines = stripCommentsAndStrings(source).split("\n")
	lines.forEach((line, index) => {
		for (const rule of rules) {
			if (rule.skipLine?.test(line)) {
				continue
			}
			if (rule.pattern.test(line)) {
				violations.push({ line: index + 1, rule: rule.name, text: line.trim() })
			}
		}
	})
	return violations
}

function listSources(directory) {
	const files = []
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name)
		if (entry.isDirectory()) {
			if (entry.name !== "_oldLeekScript") {
				files.push(...listSources(path))
			}
		} else if (entry.name.endsWith(".ts")) {
			files.push(path)
		}
	}
	return files
}

test("policy scanner flags direct log calls and ignores comments, strings and visual debug marks", () => {
	assert.equal(findViolations("console.log('x')").length, 1)
	assert.equal(findViolations("console.warn(x)").length, 1)
	assert.equal(findViolations("console . error(x)").length, 1)
	assert.equal(findViolations("Debug.log(x)").length, 1)
	assert.equal(findViolations("Debug.log (x, color)").length, 1)
	assert.equal(findViolations("System.print(x)").length, 1)
	assert.equal(findViolations("debug(x)").length, 1)
	assert.equal(findViolations("  debug(x)").length, 1)

	assert.equal(findViolations("this.debug(x, ctx)").length, 0)
	assert.equal(findViolations("private debug(message: string): void {").length, 0)
	assert.equal(findViolations("debugOperations()").length, 0)
	assert.equal(findViolations("Debug.mark(cell, color)").length, 0)
	assert.equal(findViolations("Debug.markText(cell, 'x', color)").length, 0)
	assert.equal(findViolations("Debug.pause()").length, 0)
	assert.equal(findViolations("// console.log(x)\n/* Debug.log(x) */\n/**\n * System.print(x)\n */").length, 0)
	assert.equal(findViolations("const text = \"console.log(x)\"").length, 0)
	assert.equal(findViolations("const text = `Debug.log ${1}`").length, 0)
	assert.equal(findViolations("const a = 'don\\'t'\nconsole.log(a)").length, 1)
	assert.equal(findViolations("/* a\nb */ console.log(x)")[0].line, 2)
})

test("policy scanner sees code inside template ${} expressions, bracket access and aliases (mutation gaps)", () => {
	assert.equal(findViolations("const t = `a ${console.log(1)} b`").length, 1)
	assert.equal(findViolations("const t = `a ${Debug.log(1)} b`").length, 1)
	assert.equal(findViolations("const t = `a ${ {k: 1}.k + System.print(2) } b`").length, 1)
	assert.equal(findViolations("const t = `a ${`b ${console.log(1)}`} c`").length, 1)
	assert.equal(findViolations("const t = `a ${ {k: 1}.k } console.log(x)`").length, 0)
	assert.equal(findViolations("const t = `a ${1}`\nconsole.log(t)").length, 1)
	assert.equal(findViolations("console['log']('x')").length, 1)
	assert.equal(findViolations("const c = console\nc.log('x')").length, 1)
	assert.equal(findViolations("Debug['log']('x')").length, 1)
	assert.equal(findViolations("const d = Debug").length, 1)
	assert.equal(findViolations("System['print']('x')").length, 1)
	assert.equal(findViolations("System.operations + System.maxOperations").length, 0)
	assert.equal(findViolations("Debug.mark(cell, color)\nDebug.markText(cell, 'x', color)\nDebug.pause()").length, 0)
})

test("policy: only Logger.ts calls console.log / Debug.log / System.print directly in active sources", () => {
	const files = listSources(SRC_ROOT)
	assert.ok(files.length > 20, `expected the active sources to be found, got ${files.length}`)
	assert.equal(files.some((file) => file.includes("_oldLeekScript")), false)

	const offenders = []
	for (const file of files) {
		const relativePath = relative(SRC_ROOT, file).split(sep).join("/")
		if (ALLOWED_FILES.has(relativePath)) {
			continue
		}
		for (const violation of findViolations(readFileSync(file, "utf8"))) {
			offenders.push(`${relativePath}:${violation.line} [${violation.rule}] ${violation.text}`)
		}
	}
	assert.deepEqual(offenders, [], `direct log calls must go through log(text, context):\n${offenders.join("\n")}`)
})

test("policy: the exception list is needed and minimal (the logger really is the output point)", () => {
	for (const allowed of ALLOWED_FILES) {
		const violations = findViolations(readFileSync(join(SRC_ROOT, allowed), "utf8"))
		assert.ok(violations.length > 0, `${allowed} no longer calls the console directly: remove it from the exceptions`)
	}
	assert.equal(ALLOWED_FILES.size, 1)
})

test("visual policy scanner flags Debug.mark / markText / clearMarks / pause / show, even spaced, and ignores comments and strings", () => {
	for (const call of ["mark(cell, color)", "markText(cell, 't', color)", "clearMarks()", "pause()", "show(cell)"]) {
		assert.equal(findVisualViolations(`Debug.${call}`).length, 1, call)
		assert.equal(findVisualViolations(`  Debug . ${call}`).length, 1, call)
		assert.equal(findViolations(`Debug.${call}`).length, 0, `${call}: not a text log`)
	}
	assert.equal(findVisualViolations("const t = `a ${Debug.pause()} b`").length, 1)
	assert.equal(findVisualViolations("// Debug.pause()\n/* Debug.mark(x) */\nconst s = 'Debug.clearMarks()'").length, 0)
	assert.equal(findVisualViolations("Debug.log(x)").length, 0) // texte : autre règle
	assert.equal(findVisualViolations("this.markCells(x)\nclearAllMarks(ctx)\npauseFight(ctx)").length, 0)
})

test("visual policy: only Marker.ts calls Debug.mark / markText / clearMarks / pause / show in active sources", () => {
	const offenders = []
	for (const file of listSources(SRC_ROOT)) {
		const relativePath = relative(SRC_ROOT, file).split(sep).join("/")
		if (VISUAL_ALLOWED_FILES.has(relativePath)) {
			continue
		}
		for (const violation of findVisualViolations(readFileSync(file, "utf8"))) {
			offenders.push(`${relativePath}:${violation.line} [${violation.rule}] ${violation.text}`)
		}
	}
	assert.deepEqual(offenders, [], `visual output must go through Toolbox/Marker.ts:\n${offenders.join("\n")}`)
})

test("visual policy: the exception list is needed and minimal (Marker really is the visual output point)", () => {
	for (const allowed of VISUAL_ALLOWED_FILES) {
		const source = readFileSync(join(SRC_ROOT, allowed), "utf8")
		assert.ok(findVisualViolations(source).length > 0, `${allowed} no longer calls Debug visual output: remove it from the exceptions`)
		// Marker ne fait aucune sortie texte directe : il passe par le logger.
		assert.deepEqual(findViolations(source), [], `${allowed} must not log text directly`)
	}
	assert.equal(VISUAL_ALLOWED_FILES.size, 1)
	for (const call of ["mark", "markText", "clearMarks", "pause"]) {
		assert.match(readFileSync(join(SRC_ROOT, "Toolbox/Marker.ts"), "utf8"), new RegExp(`Debug\\.${call}\\(`))
	}
})
