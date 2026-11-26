import { readFileSync } from "node:fs"
import { relative, resolve } from "node:path"

export const root = process.env.CLAUDE_PROJECT_DIR ? resolve(process.env.CLAUDE_PROJECT_DIR) : process.cwd()

export function readInput() {
	try {
		return JSON.parse(readFileSync(0, "utf8"))
	} catch {
		return {}
	}
}

/** Chemin relatif au dépôt, avec des `/`, ou null hors du dépôt. */
export function repoPath(file) {
	if (!file) return null
	const path = relative(root, resolve(root, file)).replace(/\\/g, "/")
	return path.startsWith("..") ? null : path
}

/** Renvoie le message à Claude (code 2 : bloque un PreToolUse/Stop, informe après un PostToolUse). */
export function tell(message) {
	console.error(message)
	process.exit(2)
}
