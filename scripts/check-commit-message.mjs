import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

/**
 * Valide un message de commit. Garden enregistre ce message comme « version de la stratégie » :
 * les combats archivés sont ensuite analysés à travers lui.
 * Les commits qui modifient du code d'IA (src/ en .ts) de type feat, fix, perf ou refactor doivent
 * donc décrire l'effet attendu en combat (« Stratégie: ») et les validations faites (« Tests: »).
 */

export const TYPES = ["feat", "fix", "perf", "refactor", "docs", "test", "chore", "build", "ci", "style"]
export const TYPES_REQUIRING_STRATEGY = ["feat", "fix", "perf", "refactor"]
export const MAX_SUBJECT_LENGTH = 72

const SUBJECT = new RegExp(`^(${TYPES.join("|")})(\\([\\w./-]+\\))?!?: \\S`)
const STRATEGY_LINE = /^Strat[eé]gie[ \t]*:[ \t]*\S.{2,}$/im
const TESTS_LINE = /^Tests?[ \t]*:[ \t]*\S.+$/im
const AUTOMATIC_MESSAGE = /^(Merge |Revert |fixup! |squash! |amend! )/

export function touchesAiCode(stagedFiles) {
	return stagedFiles.some((file) => /^src\/(?!_oldLeekScript\/).+\.ts$/.test(file.replace(/\\/g, "/")))
}

/** Retourne la liste des problèmes (vide si le message est valide). */
export function validateCommitMessage(rawMessage, stagedFiles = []) {
	const message = rawMessage
		.split(/\r?\n/)
		.filter((line) => !line.startsWith("#"))
		.join("\n")
		.trim()
	if (!message) {
		return ["Le message est vide."]
	}
	if (AUTOMATIC_MESSAGE.test(message)) {
		return []
	}

	const errors = []
	const lines = message.split("\n")
	const subject = lines[0]
	const type = SUBJECT.exec(subject)?.[1]
	if (!type) {
		errors.push(`Sujet attendu : « type(portée): description » avec type parmi ${TYPES.join(", ")}.`)
	}
	if (subject.length > MAX_SUBJECT_LENGTH) {
		errors.push(`Le sujet dépasse ${MAX_SUBJECT_LENGTH} caractères (${subject.length}).`)
	}
	if (lines.length > 1 && lines[1].trim() !== "") {
		errors.push("Laisser une ligne vide entre le sujet et le corps.")
	}
	if (type && TYPES_REQUIRING_STRATEGY.includes(type) && touchesAiCode(stagedFiles)) {
		if (!STRATEGY_LINE.test(message)) {
			errors.push("Ligne « Stratégie: » manquante : effet attendu en combat, seuils ou conditions changés (ou « aucun changement de comportement »).")
		}
		if (!TESTS_LINE.test(message)) {
			errors.push("Ligne « Tests: » manquante : tests ajoutés ou exécutés.")
		}
	}
	return errors
}

function stagedFilesFromGit() {
	try {
		return execFileSync("git", ["diff", "--cached", "--name-only"], { encoding: "utf8" })
			.split(/\r?\n/)
			.filter(Boolean)
	} catch {
		return []
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const messageFile = process.argv[2]
	if (!messageFile) {
		console.error("Usage : node scripts/check-commit-message.mjs <fichier-du-message>")
		process.exit(2)
	}
	const errors = validateCommitMessage(readFileSync(messageFile, "utf8"), stagedFilesFromGit())
	if (errors.length > 0) {
		console.error("Message de commit refusé :")
		for (const error of errors) {
			console.error(` - ${error}`)
		}
		console.error("Modèle : voir .gitmessage (contournement exceptionnel : git commit --no-verify).")
		process.exit(1)
	}
}
