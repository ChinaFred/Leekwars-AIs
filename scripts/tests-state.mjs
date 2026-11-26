// Mémorise que `src/` a changé depuis les derniers tests réussis (lu par le hook Stop de Claude Code).
//   node scripts/tests-state.mjs ok     -> appelé par `posttest` : les tests viennent de passer
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
export const MARKER = join(root, "node_modules", ".cache", "kassbi", "src-untested")

export const isUntested = () => existsSync(MARKER)
export function markUntested() {
	mkdirSync(dirname(MARKER), { recursive: true })
	writeFileSync(MARKER, "")
}
export const markTested = () => rmSync(MARKER, { force: true })

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === "ok") {
	markTested()
}
