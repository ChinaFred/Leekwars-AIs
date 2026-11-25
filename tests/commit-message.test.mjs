import assert from "node:assert/strict"
import test from "node:test"
import { validateCommitMessage } from "../scripts/check-commit-message.mjs"

const AI_FILES = ["src/Brain/PlanActScenario.ts", "docs/strategies.md"]

test("un commit de code d'IA exige les lignes Stratégie et Tests", () => {
	const errors = validateCommitMessage("feat(planner): réserve de TP", AI_FILES)
	assert.equal(errors.length, 2)
	assert.match(errors[0], /Stratégie/)
	assert.match(errors[1], /Tests/)
})

test("un message complet est accepté, accents optionnels", () => {
	const message = "fix(movement): fuite si PV < 30 %\n\nStrategie: fuite dès 30 % de PV au lieu de 20 %\nTests: npm test"
	assert.deepEqual(validateCommitMessage(message, AI_FILES), [])
})

test("la ligne Stratégie ne peut pas être vide", () => {
	const errors = validateCommitMessage("perf: x y\n\nStratégie:\nTests: npm test", AI_FILES)
	assert.equal(errors.length, 1)
})

test("docs, tests et archives LeekScript n'exigent pas de Stratégie", () => {
	assert.deepEqual(validateCommitMessage("docs: précise les seuils", AI_FILES), [])
	assert.deepEqual(validateCommitMessage("feat: sync", ["LWGarden/src/Garden.py", "src/_oldLeekScript/a.ts"]), [])
})

test("sujet invalide, trop long ou sans ligne vide", () => {
	assert.equal(validateCommitMessage("V1 tactique basée sur le risque").length, 1)
	assert.match(validateCommitMessage(`docs: ${"x".repeat(80)}`)[0], /72/)
	assert.match(validateCommitMessage("docs: a b\ncorps collé")[0], /ligne vide/)
})

test("les messages automatiques et les commentaires git sont gérés", () => {
	assert.deepEqual(validateCommitMessage("Merge branch 'main'", AI_FILES), [])
	assert.deepEqual(validateCommitMessage("docs: ok\n# commentaire git"), [])
	assert.deepEqual(validateCommitMessage("# rien\n"), ["Le message est vide."])
})
