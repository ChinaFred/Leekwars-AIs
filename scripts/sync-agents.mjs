// Génère les fichiers GitHub Copilot à partir de la source Claude Code.
//   CLAUDE.md                -> .github/copilot-instructions.md
//   .claude/agents/<nom>.md  -> .github/agents/<nom>.agent.md
// `node scripts/sync-agents.mjs` écrit ; `--check` échoue si un fichier généré diverge.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const NOTICE = "<!-- Généré par `npm run agents:sync` depuis SOURCE : ne pas modifier à la main. -->"
const COPILOT_TOOLS = [
	["read", ["Read"]],
	["search", ["Grep", "Glob"]],
	["edit", ["Edit", "Write"]],
	["execute", ["Bash"]],
	["web", ["WebFetch", "WebSearch"]],
]

const read = (path) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")

/** Frontmatter simple : `clé: valeur` et listes `  - élément`. */
export function parseAgent(text) {
	const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
	if (!match) throw new Error("frontmatter manquant")
	const meta = {}
	let list = null
	for (const line of match[1].split("\n")) {
		const item = /^\s+-\s+(.+)$/.exec(line)
		const pair = /^([\w-]+):\s*(.*)$/.exec(line)
		if (item && list) list.push(item[1].trim())
		else if (pair) meta[pair[1]] = pair[2] === "" ? (list = []) : ((list = null), pair[2].trim())
	}
	return { meta, body: match[2].replace(/^\n+/, "") }
}

export function toCopilotAgent(text, source) {
	const { meta, body } = parseAgent(text)
	const granted = String(meta.tools ?? "").split(",").map((tool) => tool.trim())
	const tools = COPILOT_TOOLS.filter(([, names]) => names.some((name) => granted.includes(name)))
		.map(([tool]) => `'${tool}'`)
	const skills = [meta.skills ?? []].flat().filter(Boolean)
		.map((skill) => `Avant de commencer, lis et applique \`.claude/skills/${skill}/SKILL.md\`.`)
	return [
		"---", `name: ${meta.name}`, `description: ${meta.description}`, "target: github-copilot",
		`tools: [${tools.join(", ")}]`, "---", "", NOTICE.replace("SOURCE", `\`${source}\``), "",
		...(skills.length ? [...skills, ""] : []), body.replace(/\bCLAUDE\.md\b/g, ".github/copilot-instructions.md"),
	].join("\n")
}

export function generate() {
	const files = new Map()
	files.set(".github/copilot-instructions.md",
		`${NOTICE.replace("SOURCE", "`CLAUDE.md`")}\n\n${read("CLAUDE.md")}`)
	for (const name of readdirSync(join(root, ".claude/agents")).filter((file) => file.endsWith(".md")).sort()) {
		const source = `.claude/agents/${name}`
		files.set(`.github/agents/${name.replace(/\.md$/, ".agent.md")}`, toCopilotAgent(read(source), source))
	}
	return files
}

/** Fichiers générés absents, différents, ou agents Copilot sans source. */
export function differences(files = generate()) {
	const stale = [...files].filter(([path, content]) => !existsSync(join(root, path)) || read(path) !== content)
		.map(([path]) => path)
	const agents = join(root, ".github/agents")
	const orphans = existsSync(agents)
		? readdirSync(agents).map((file) => `.github/agents/${file}`).filter((path) => !files.has(path))
		: []
	return { stale, orphans }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const files = generate()
	const { stale, orphans } = differences(files)
	if (process.argv.includes("--check")) {
		if (stale.length || orphans.length) {
			console.error(`Agents Copilot désynchronisés : ${[...stale, ...orphans].join(", ")}\n` +
				"Lance `npm run agents:sync` puis ajoute les fichiers générés au commit.")
			process.exit(1)
		}
	} else {
		for (const path of orphans) rmSync(join(root, path))
		for (const [path, content] of files) {
			mkdirSync(dirname(join(root, path)), { recursive: true })
			writeFileSync(join(root, path), content)
		}
		console.log(`${files.size} fichiers générés, ${orphans.length} supprimés.`)
	}
}
