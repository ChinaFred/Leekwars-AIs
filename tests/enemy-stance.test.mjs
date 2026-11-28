import assert from "node:assert/strict"
import test from "node:test"

globalThis.Color = { rgb: () => 0 }
globalThis.Debug = { log() {}, pause() {} }
globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4, POISON: 5, BUFF_STRENGTH: 6 }

const { EnemyMemory } = await import("../dist/Classes/Context/EnemyMemory.js")
const { MAX_TURN_LOG, STANCE_WINDOW, assessStance } = await import("../dist/Classes/Context/EnemyBehavior.js")

const pistol = { id: 37, name: "pistol", cost: 3, minRange: 1, maxRange: 7, features: [{ type: 1, minValue: 15, maxValue: 20 }] }
const shield = { id: 20, name: "shield", cost: 3, cooldown: 4, currentCooldown: 0, features: [{ type: 3, minValue: 10, maxValue: 10 }] }
const cure = { id: 24, name: "cure", cost: 4, cooldown: 2, currentCooldown: 0, features: [{ type: 2, minValue: 20, maxValue: 20 }] }

const me = (x, life = 100, effects = []) => ({ id: 1, name: "me", life, maxLife: 100, cell: { x, y: 5 }, effects })
const enemy = (x, overrides = {}) => ({
	id: 2, name: "enemy", level: 50, life: 100, maxLife: 100, tp: 10, mp: 3, strength: 0, agility: 0, wisdom: 0,
	resistance: 0, science: 0, magic: 0, weapon: pistol, weapons: [pistol], chips: [shield, cure],
	cell: { x, y: 5 }, effects: [], launchedEffects: [], ...overrides
})
const cast = (item, turns = 2) => ({ type: item.features[0].type, value: 10, caster: 2, turns, critical: false, item, target: 2, modifiers: 0 })

/** Fin de mon tour avec l'ennemi en `from`, puis début du suivant avec l'ennemi en `to` : un tour adverse historisé. */
function enemyTurn(memory, turn, { from, to, life = 100, lifeAfter = life, myLife = 100, myLifeAfter = myLife, launched = [] }) {
	memory.endMyTurn(me(0, myLife), turn - 1, [enemy(from, { life })])
	memory.update(enemy(to, { life: lifeAfter, launchedEffects: launched }), me(0, myLifeAfter), turn)
}

test("an enemy turn is only recorded once a post-turn snapshot exists", () => {
	const memory = new EnemyMemory()
	memory.identify(enemy(8), 1)
	memory.update(enemy(8), me(0), 1)
	assert.equal(memory.getProfile(2).turnLog.length, 0)
	assert.equal(memory.stanceOf(2).stance, "unknown")
	assert.equal(memory.stanceOf(99), null)
	enemyTurn(memory, 2, { from: 8, to: 6 })
	assert.equal(memory.getProfile(2).turnLog.length, 1)
	assert.equal(memory.getProfile(2).afterMyTurn, null)
})

test("movement is measured against my end-of-turn cell: flee and approach", () => {
	const memory = new EnemyMemory()
	memory.identify(enemy(8), 1)
	enemyTurn(memory, 2, { from: 8, to: 12 })
	enemyTurn(memory, 3, { from: 12, to: 9 })
	enemyTurn(memory, 4, { from: 9, to: 9 })
	const [fled, approached, still] = memory.getProfile(2).turnLog
	assert.deepEqual([fled.distanceDelta, fled.fled, fled.approached], [4, true, false])
	assert.deepEqual([approached.distanceDelta, approached.fled, approached.approached], [-3, false, true])
	assert.deepEqual([still.distanceDelta, still.fled, still.approached], [0, false, false])
})

test("an enemy that retreats, heals and shields is defensive", () => {
	const memory = new EnemyMemory()
	memory.identify(enemy(8), 1)
	enemyTurn(memory, 2, { from: 8, to: 11, life: 60, lifeAfter: 80, launched: [cast(cure, 0)] })
	enemyTurn(memory, 3, { from: 11, to: 14, life: 50, lifeAfter: 50, launched: [cast(shield)] })
	enemyTurn(memory, 4, { from: 14, to: 17, life: 40, lifeAfter: 40 })
	const log = memory.getProfile(2).turnLog
	assert.equal(log[0].healed, true)
	assert.equal(log[0].healedLife, 20)
	assert.equal(log[1].shielded, true)
	const report = memory.stanceOf(2)
	assert.equal(report.stance, "defensive")
	assert.deepEqual([report.fled, report.healed, report.shielded, report.attacked, report.approached], [3, 1, 1, 0, 0])
	assert.ok(report.score < 0)
})

test("an enemy that closes in and hits me is aggressive", () => {
	const memory = new EnemyMemory()
	memory.identify(enemy(10), 1)
	enemyTurn(memory, 2, { from: 10, to: 6, myLife: 100, myLifeAfter: 82 })
	enemyTurn(memory, 3, { from: 6, to: 3, myLife: 82, myLifeAfter: 64 })
	const log = memory.getProfile(2).turnLog
	assert.equal(log[0].attacked, true)
	assert.ok(log[0].damage > 0)
	assert.equal(memory.stanceOf(2).stance, "aggressive")
})

test("one turn of evidence is not enough and balanced behaviour is mixed", () => {
	const memory = new EnemyMemory()
	memory.identify(enemy(8), 1)
	enemyTurn(memory, 2, { from: 8, to: 12 })
	assert.equal(memory.stanceOf(2).stance, "unknown")
	enemyTurn(memory, 3, { from: 12, to: 9 })
	assert.equal(memory.stanceOf(2).stance, "mixed")
})

test("damage from an ongoing effect or with several living enemies is not a new strike", () => {
	const memory = new EnemyMemory()
	memory.identify(enemy(8), 1)
	memory.endMyTurn(me(0, 100), 1, [enemy(8)])
	memory.update(enemy(8), me(0, 80), 2, 2)
	assert.equal(memory.getProfile(2).turnLog[0].attacked, false)
	assert.equal(memory.getProfile(2).turnLog[0].damage, 0)
})

test("the log is bounded and the stance reads the latest turns only", () => {
	const memory = new EnemyMemory()
	memory.identify(enemy(8), 1)
	let x = 8
	for (let turn = 2; turn < 2 + MAX_TURN_LOG + 4; turn++) {
		enemyTurn(memory, turn, { from: x, to: x + 1 })
		x++
	}
	const profile = memory.getProfile(2)
	assert.equal(profile.turnLog.length, MAX_TURN_LOG)
	assert.equal(profile.turnLog[0].turn, 2 + 4)
	const old = Array.from({ length: 6 }, (_, i) => ({ turn: i, fled: true, approached: false, attacked: false, healed: false, shielded: false }))
	const recent = Array.from({ length: STANCE_WINDOW }, (_, i) => ({ turn: 10 + i, fled: false, approached: true, attacked: true, healed: false, shielded: false }))
	assert.equal(assessStance([...old, ...recent]).stance, "aggressive")
})
