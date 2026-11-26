// PostToolUse (Edit|Write) : après une modification de src/**/*.ts, vérifie l'en-tête et le typage.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { markUntested } from "../../scripts/tests-state.mjs"
import { readInput, repoPath, root, tell } from "./lib.mjs"

const path = repoPath(readInput().tool_input?.file_path)
if (!path || !/^src\/(?!_oldLeekScript\/).+\.ts$/.test(path) || !existsSync(join(root, path))) process.exit(0)

markUntested()
const problems = []
const fileVersion = (text) => /^\/\/ file version: (\d+)$/m.exec(text.split(/\r?\n/).slice(0, 2).join("\n"))?.[1]
const text = readFileSync(join(root, path), "utf8")
if (!text.startsWith("// @version:5.8") || fileVersion(text) === undefined) {
	problems.push(`${path} doit commencer par « // @version:5.8 » puis « // file version: N ».`)
} else {
	try {
		const committed = execFileSync("git", ["show", `HEAD:${path}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
		if (fileVersion(committed) === fileVersion(text)) {
			problems.push(`${path} : incrémente « // file version: ${fileVersion(text)} » (fichier modifié depuis le dernier commit).`)
		}
	} catch {
		// Nouveau fichier : pas de version précédente.
	}
}
const tsc = join(root, "node_modules", "typescript", "bin", "tsc")
if (existsSync(tsc)) {
	try {
		execFileSync(process.execPath, [tsc, "--noEmit"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
	} catch (error) {
		problems.push(`tsc --noEmit échoue :\n${String(error.stdout ?? "").split("\n").slice(0, 20).join("\n")}`)
	}
}
if (problems.length) tell(problems.join("\n"))
