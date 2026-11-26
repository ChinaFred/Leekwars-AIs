// Vérifie le budget de taille de la documentation légère (voir .claude/skills/doc-light/SKILL.md).
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
export const BUDGETS = [
	{ file: "README.md", maxLines: 120 },
	{ file: "docs/strategies.md", maxLines: 250 },
	{ file: "ChangeLog.md", maxLines: 200, maxLineLength: 200 },
	{ file: "CLAUDE.md", maxLines: 80 },
]

export function check(budget, text) {
	const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n")
	const errors = []
	if (lines.length > budget.maxLines) {
		errors.push(`${budget.file} : ${lines.length} lignes (budget ${budget.maxLines}).`)
	}
	lines.forEach((line, index) => {
		if (budget.maxLineLength && !line.startsWith("#") && line.length > budget.maxLineLength) {
			errors.push(`${budget.file}:${index + 1} : ${line.length} caractères (budget ${budget.maxLineLength}).`)
		}
	})
	return errors
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const errors = BUDGETS.filter(({ file }) => existsSync(join(root, file)))
		.flatMap((budget) => check(budget, readFileSync(join(root, budget.file), "utf8")))
	if (errors.length) {
		console.error(`Documentation hors budget : condense, ne relève pas le budget.\n${errors.join("\n")}`)
		process.exit(1)
	}
}
