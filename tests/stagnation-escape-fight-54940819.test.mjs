import assert from "node:assert/strict"
import test from "node:test"
import { executeTacticalPlan, PASSIVE_DANGER_LIFE_FRACTION } from "../dist/Classes/Plannification/TacticalPlanner.js"
import { ActionHistory, actionHistory, HISTORY_TURNS } from "../dist/Classes/Context/StagnationTracker.js"
import { getLogConfig, LOG_CONTEXT } from "../dist/Toolbox/Logger.js"
import { planAct } from "../dist/Brain/PlanActScenario.js"
import {
	StagnationTracker, STAGNATION_TURNS, PASSIVE_TURNS_AT_FULL_RISK, PASSIVE_RISK_STEP
} from "../dist/Classes/Context/StagnationTracker.js"
import {
	cells, at, world, firingZone, walkDistances, distance, KASSBI_STUCK, KASSBI_BEFORE, ENEMY_CORNER
} from "./helpers/fight-54940819-world.mjs"

// Combat 54940819 (joué avec 22612f3) : dv3 (60/189 PV) immobile en 17 derrière un mur, Kassbi (339/339) immobile
// en 187 du tour 12 au tour 64 (53 tours). 187 est un minimum local de distance Manhattan : aucune case atteignable
// n'est plus proche (distance 10), la LOS est bloquée, et la route vers une zone de tir passe par des cases plus
// éloignées à vol d'oiseau. La sortie de stagnation suit la distance de MARCHE vers les zones de tir (machine_gun,
// neutrino, ice, rock), seulement sur des cases sûres. Stagnation = aucun dégât et aucun nouveau record de proximité
// (distance Manhattan minimale à l'ennemi depuis le dernier dégât). Opérations : aucune mesure moteur.

const ZONE = firingZone()
const walk = walkDistances(ZONE, [ENEMY_CORNER])
/** Le journal PLANNING est actif pour vérifier ses lignes : on évite seulement d'inonder la sortie des tests. */
const quiet = (action) => { const original = console.log; try { console.log = () => {}; return action() } finally { console.log = original } }
/** Observation de début de tour : Kassbi en `k`, dv3 en `e` avec `life` PV. */
const seen = (tracker, turn, k, life = 60, e = ENEMY_CORNER) => tracker.observe(turn, life, distance(cells[k], cells[e]))

/** Tracker tel qu'au tour 12 réel : Kassbi arrive en 187 au tour 11 (record 10), puis reste immobile. */
function stalled(idleTurns) {
	const tracker = new StagnationTracker()
	seen(tracker, 11, KASSBI_BEFORE)
	for (let turn = 12; turn <= 12 + idleTurns; turn++) seen(tracker, turn, KASSBI_STUCK)
	return tracker
}

test("tracker: stagnation = no damage and no new proximity record; oscillation and escape moves do not reset it", () => {
	assert.equal(STAGNATION_TURNS, 2)
	const tracker = new StagnationTracker()
	seen(tracker, 11, KASSBI_BEFORE)
	assert.equal(tracker.turns, 0)
	seen(tracker, 12, KASSBI_STUCK) // distance 11 -> 10 : nouveau record
	assert.equal(tracker.turns, 0)
	seen(tracker, 12, KASSBI_STUCK) // idempotent dans un même tour
	assert.equal(tracker.turns, 0)
	seen(tracker, 13, KASSBI_STUCK)
	assert.deepEqual([tracker.turns, tracker.active], [1, false])
	seen(tracker, 14, 133) // oscillation / sortie : 13 > record 10, aucun reset
	assert.deepEqual([tracker.turns, tracker.active], [2, true])
	seen(tracker, 15, KASSBI_STUCK) // retour sur la case du record (10) : égal, pas strictement meilleur
	assert.deepEqual([tracker.turns, tracker.active], [3, true])
	seen(tracker, 16, 133)
	seen(tracker, 17, KASSBI_STUCK)
	assert.equal(tracker.turns, 5, "A-B-A-B never resets the counter")
	tracker.observe(18, 60, 8) // nouveau record de proximité (aussi si c'est l'ennemi qui s'approche)
	assert.deepEqual([tracker.turns, tracker.active], [0, false])
	tracker.observe(19, 60, 8); tracker.observe(20, 60, 8)
	assert.equal(tracker.active, true)
	tracker.observe(21, 38, 8) // dégâts infligés
	assert.deepEqual([tracker.turns, tracker.active], [0, false])
	tracker.observe(22, 38, 8); tracker.observe(23, 38, 8)
	assert.equal(tracker.active, true)
	tracker.noteOffense() // l'ennemi entre dans une zone de tir
	assert.equal(tracker.turns, 0)
})

test("normal approach never triggers the rule: turns 1-5 of the fight, an approaching enemy, a single boost turn", () => {
	// Tours 1 à 6 réels : Kassbi avance de 4 cases par tour (distance 28, 26, 22, 18, 14, 10) : record battu chaque tour.
	const starts = [[107, 331], [144, 332], [216, 332], [288, 332], [290, 332], [292, 332]]
	const tracker = new StagnationTracker()
	starts.forEach(([k, e], i) => {
		seen(tracker, i + 1, k, 195, e)
		assert.equal(tracker.turns, 0, `turn ${i + 1}`)
		assert.equal(tracker.active, false)
	})
	// Tours 2 à 5 : même décision avec et sans compteur (la règle ne change rien à l'approche normale).
	for (let turn = 2; turn <= 5; turn++) {
		const [k, e] = starts[turn - 1]
		const kept = new StagnationTracker()
		for (let t = 1; t <= turn; t++) seen(kept, t, starts[t - 1][0], 195, starts[t - 1][1])
		const withTracker = world({ turn, k, e, enemyLife: 195, stagnation: kept }).evaluate()
		const without = world({ turn, k, e, enemyLife: 195 }).evaluate()
		assert.equal(withTracker.plan?.destination.id, without.plan?.destination.id, `turn ${turn}`)
		assert.equal(withTracker.plan?.progressModel, without.plan?.progressModel)
		assert.equal(withTracker.plan?.stagnation, undefined)
	}
	// Kassbi lance un boost sans bouger (PT) pendant que l'ennemi s'approche : record de proximité battu par l'ennemi.
	const approaching = new StagnationTracker()
	for (const [turn, d] of [[1, 20], [2, 16], [3, 12], [4, 9]]) approaching.observe(turn, 195, d)
	assert.equal(approaching.turns, 0)
	// Un seul tour d'attente isolé (boost) : compteur 1, règle inactive.
	const oneBoost = new StagnationTracker()
	oneBoost.observe(1, 195, 12); oneBoost.observe(2, 195, 12)
	assert.deepEqual([oneBoost.turns, oneBoost.active], [1, false])
})

test("turn 12 and 13 (before the threshold): unchanged, hold in 187, and the reason is the real cause", () => {
	for (const idleTurns of [0, 1]) {
		const w = world({ stagnation: stalled(idleTurns) })
		assert.equal(w.threat.dangerAt(w.me.cell), 0)
		const result = w.evaluate()
		assert.equal(result.plan, null)
		assert.equal(result.reason, "no improving progress", "no more 'offensive chip legality unverified'")
	}
	const without = world().evaluate()
	assert.equal(without.plan, null)
	assert.equal(without.reason, "no improving progress")
})

test("turn 14 (threshold reached): leaves the local minimum for a SAFE cell that shortens the WALKING distance", () => {
	const tracker = stalled(2)
	assert.equal(tracker.active, true)
	const w = world({ turn: 14, stagnation: tracker })
	const manhattanBefore = distance(w.me.cell, cells[ENEMY_CORNER])
	const reachable = [...w.threat.entries()]
	assert.equal(reachable.length, 22)
	assert.ok(reachable.every(({ cell }) => distance(cell, cells[ENEMY_CORNER]) >= manhattanBefore),
		"187 is a Manhattan local minimum: no reachable cell is closer")
	const plan = w.evaluate().plan
	assert.ok(plan, "stagnation escape plan")
	assert.equal(plan.progressModel, "stagnation walk route")
	assert.equal(plan.danger, 0)
	assert.equal(w.threat.dangerAt(plan.destination), 0)
	assert.equal(plan.weaponShots, 0)
	assert.deepEqual(plan.chips, [])
	assert.equal(plan.stagnation.turns, 2)
	assert.equal(plan.stagnation.walkBefore, walk.get(KASSBI_STUCK))
	assert.equal(plan.stagnation.walkAfter, walk.get(plan.destination.id), "walking distance checked by an independent BFS")
	assert.ok(plan.stagnation.walkAfter < plan.stagnation.walkBefore)
	assert.ok(distance(plan.destination, cells[ENEMY_CORNER]) >= manhattanBefore, "Manhattan distance does not improve")
	assert.ok(plan.afterMp > 0 && plan.afterMp <= w.me.mp)
	assert.equal(w.me.events.length, 0, "evaluation spends nothing")
	quiet(() => executeTacticalPlan(w.me, plan))
	assert.deepEqual(w.me.events, [`move:${plan.destination.id}`])
})

test("safety first: no escape into a cell more dangerous than the current one, and the hold is explained", () => {
	const closer = (cell) => (walk.get(cell.id) ?? Infinity) < walk.get(KASSBI_STUCK)
	const w = world({ turn: 14, stagnation: stalled(2), dangerOverride: (cell) => closer(cell) ? 100 : null })
	assert.ok([...w.threat.entries()].some(({ cell }) => closer(cell)), "there are closer cells, all dangerous")
	const messages = [], original = console.log
	let result
	try { console.log = (message) => messages.push(message); result = w.evaluate() } finally { console.log = original }
	assert.equal(result.plan, null)
	assert.match(result.reason, /^stagnation: no cell with danger <= 0 closer by walking/)
	assert.ok(messages.some((m) => m.includes("[Tactical] stagnation:") && m.includes("holding, safety first")))
	assert.equal(w.me.events.length, 0)
	// Le danger toléré est celui de la case actuelle : jamais au-delà.
	const tolerated = world({ turn: 14, stagnation: stalled(2),
		dangerOverride: (cell) => cell.id === KASSBI_STUCK ? 30 : closer(cell) ? 100 : 30 })
	const plan = tolerated.evaluate().plan
	assert.ok(plan === null || tolerated.threat.dangerAt(plan.destination) <= 30)
})

test("multi-turn route: idle at 12-13, escapes at 14-15 (its own moves do not reset), crosses the danger frontier at 16 (nil risk weight) and shoots there", () => {
	const tracker = new StagnationTracker()
	seen(tracker, 11, KASSBI_BEFORE)
	let position = KASSBI_STUCK
	const trace = []
	for (let turn = 12; turn <= 24; turn++) {
		seen(tracker, turn, position)
		const w = world({ turn, k: position, stagnation: tracker })
		const before = { turns: tracker.turns, walk: walk.get(position) }
		const { plan } = quiet(() => w.evaluate())
		if (plan) quiet(() => executeTacticalPlan(w.me, plan))
		position = w.me.cell.id
		trace.push({ turn, turns: before.turns, position, walk: walk.get(position), danger: w.threat.dangerAt(w.me.cell),
			shot: !!plan && (plan.weaponShots > 0 || plan.chips.length > 0) })
	}
	assert.deepEqual(trace.map(({ position: p }) => p).slice(0, 4), [KASSBI_STUCK, KASSBI_STUCK, 133, 81])
	assert.deepEqual(trace.slice(0, 4).map(({ turns }) => turns), [0, 1, 2, 3])
	assert.ok(trace.slice(0, 4).every(({ danger }) => danger === 0), "full then half risk weight: never entered a danger zone")
	const walks = trace.map(({ walk: w }) => w)
	assert.ok(walks[2] < walks[1] && walks[3] < walks[2], "each escape shortens the walking distance")
	assert.equal(walks[3], 4, "81: 4 PM from the ice firing cells, whose danger is modeled 114-162")
	// Avant la baisse du poids du risque : maintien en 81 jusqu'à la fin (refus de combat). Tour 16 : 4 tours passifs,
	// poids nul, la frontière est franchie (danger sous mes 339 PV). Depuis qu'une puce est créditée après déplacement,
	// ce tour-là est un plan de tir (4 PM jusqu'à 48 puis ice) ; avant, sortie au tour 16 et premier tir au tour 17.
	assert.ok(trace[4].walk < 4 && trace[4].danger > 0 && trace[4].danger < 339, `turn 16 enters the non-lethal danger zone: ${JSON.stringify(trace[4])}`)
	assert.equal(trace.find(({ shot }) => shot)?.turn, 16, "first shot planned at turn 16")
})

test("a 187 <-> 133 oscillation through the full planAct (tactical then reserve) reaches the threshold and is broken", () => {
	const tracker = new StagnationTracker()
	seen(tracker, 11, KASSBI_BEFORE)
	let position = KASSBI_STUCK, peak = 0
	const positions = [], escapes = []
	for (let turn = 12; turn <= 30; turn++) {
		seen(tracker, turn, position)
		peak = Math.max(peak, tracker.turns)
		const w = world({ turn, k: position, stagnation: tracker })
		const messages = [], original = console.log
		try { console.log = (m) => messages.push(m); planAct(w.me, undefined, w.context) } finally { console.log = original }
		if (messages.some((m) => m.includes("escaping to"))) escapes.push(turn)
		position = w.me.cell.id
		positions.push(position)
	}
	assert.ok(peak >= STAGNATION_TURNS, `counter peaked at ${peak}`)
	assert.ok(escapes.length >= 1, "the stagnation escape was triggered")
	assert.ok(escapes[0] <= 16, `first escape at turn ${escapes[0]}`)
	// Après la sortie, plus de va-et-vient : la position finale est stable (frontière de sécurité).
	const tail = positions.slice(-8)
	assert.equal(new Set(tail).size, 1, `no more oscillation, tail ${tail}`)
})

// RÉGRESSION (Testeur) : une case de tir de PUCE atteignable (ice depuis 432, tir décliné : trop dangereux) coupait le
// trajet futur vers les cases de tir d'ARME ; la progression retombait sur Manhattan et le plan retenu était vide (432>432).
test("a reachable but declined chip shot keeps the safe advance along the future weapon route (432 -> 379)", () => {
	const w = world({ turn: 2, k: 432, e: 262, enemyLife: 60 })
	const { plan } = quiet(() => w.evaluate())
	assert.deepEqual([plan.destination.id, plan.afterMp, plan.danger, plan.chips.length, plan.weaponShots], [379, 3, 0, 0, 0])
	assert.equal(plan.progressModel, "future firing route")
	quiet(() => executeTacticalPlan(w.me, plan))
	assert.deepEqual(w.me.events, ["move:379"])
})

test("a shot resets the counter: the rule stays off after damage was dealt", () => {
	const tracker = stalled(2)
	seen(tracker, 15, KASSBI_STUCK, 38) // dv3 a perdu des PV
	assert.equal(tracker.turns, 0)
	const result = world({ turn: 15, stagnation: tracker }).evaluate()
	assert.equal(result.plan, null)
	assert.equal(result.reason, "no improving progress")
})

test("an enemy in a firing zone resets the counter and the normal attack is unchanged (turn 7 of the fight)", () => {
	const tracker = new StagnationTracker()
	for (let t = 5; t <= 9; t++) seen(tracker, t, 310, 195, 262)
	assert.equal(tracker.active, true)
	const w = world({ turn: 7, k: 310, e: 262, enemyLife: 195, stagnation: tracker })
	const result = w.evaluate()
	// Tour 7 réel : deux tirs (82,5). rock (2-6, hors de portée de 310) est désormais créditée depuis 364 : un tir + rock (83,6).
	assert.deepEqual([result.plan.weaponShots, result.plan.chips.map((chip) => chip.name)], [1, ["rock"]],
		"same approach 364 and retreat 346 as the real turn 7")
	assert.equal(result.plan.shotCell.id, 364)
	assert.equal(result.plan.progressModel, undefined)
	assert.equal(tracker.turns, 0, "offense available: stagnation counter reset")
})

test("tracker: the record restarts from the CURRENT distance after damage (an enemy that flees then is chased)", () => {
	const tracker = new StagnationTracker()
	tracker.observe(1, 100, 5) // record 5
	tracker.observe(2, 60, 8) // dégâts infligés ; l'ennemi a fui à 8 : le record repart de 8 (pas min(5, 8))
	assert.equal(tracker.turns, 0)
	tracker.observe(3, 60, 7) // nouveau record depuis le dernier dégât : poursuite efficace, aucune stagnation
	assert.equal(tracker.turns, 0)
	tracker.observe(4, 60, 6)
	assert.equal(tracker.turns, 0)
	tracker.observe(5, 60, 6)
	assert.equal(tracker.turns, 1)
})

test("tracker: no enemy at all (infinite distance, zero life) and a dead enemy never blow up nor leave the counter stuck", () => {
	const tracker = new StagnationTracker()
	tracker.observe(1, 60, 6)
	tracker.observe(2, 0, Number.POSITIVE_INFINITY) // ennemi mort : somme des PV en baisse
	assert.equal(tracker.turns, 0)
	tracker.observe(3, 0, Number.POSITIVE_INFINITY)
	tracker.observe(4, 0, Number.POSITIVE_INFINITY)
	assert.equal(tracker.active, true, "counts, but the planner only uses it when an enemy is alive")
	const first = new StagnationTracker() // tout premier tour sans ennemi vivant
	first.observe(1, 0, Number.POSITIVE_INFINITY)
	assert.equal(first.turns, 0)
	first.observe(2, 60, 9) // un ennemi apparaît (invocation) : record
	assert.equal(first.turns, 0)
})

test("safety first, boundary: a closer cell with danger one point above the current one is never chosen", () => {
	const closer = (cell) => (walk.get(cell.id) ?? Infinity) < walk.get(KASSBI_STUCK)
	const one = world({ turn: 14, stagnation: stalled(2), dangerOverride: (cell) => closer(cell) ? 1 : null })
	assert.equal(one.threat.dangerAt(one.me.cell), 0)
	const held = quiet(() => one.evaluate())
	assert.equal(held.plan, null, "danger 1 > current 0: hold")
	assert.match(held.reason, /^stagnation: no cell with danger <= 0 closer by walking/)
	const equal = world({ turn: 14, stagnation: stalled(2), dangerOverride: (cell) => closer(cell) ? 0 : null })
	assert.ok(quiet(() => equal.evaluate()).plan, "danger equal to the current one is accepted")
})

// PROPRIÉTÉ (Testeur, 2026-11-25) : la règle ne doit JAMAIS retarder le premier tir possible par rapport à la règle
// désactivée. Défaut d'origine : ennemi immobile en 568 (coin), Kassbi en 378, stagnation active. Sans la règle,
// 378 -> 396 puis 396 -> 466 et tir au 2e tour ; avec la première version, 378 -> 411 (marche 1 d'une zone de tir) puis
// maintien PERPÉTUEL en 411 : les seules cases de tir accessibles de 411 sont dans la zone de danger (114 à 162) pour une
// seule puce faible, et `noteOffense` remettait le compteur à zéro à chaque tour (hasOffense vrai sans tir joué).
// Correction : la sortie n'agit que si le plan NORMAL est bloqué (ni tir ni déplacement) ou si une sortie est déjà
// engagée ; `noteOffense` ne se déclenche que pour un tir RÉELLEMENT prévu. Tant que le plan normal progresse, la
// trajectoire est celle de la règle désactivée : le premier tir ne peut pas être retardé.
// Mesure sur la maquette (ennemi immobile, stagnation active au départ, 478 cases de départ) : ennemi en 568, 17 ou 310 :
// 0 plus lent, 0 plus rapide ; ennemi en 262 : 0 plus lent, 24 plus rapides. Ce fichier rejoue un échantillon fixe.
function turnsToFirstShot(k0, e, stagnationOn) {
	const tracker = new StagnationTracker()
	const d0 = distance(cells[k0], cells[e])
	tracker.observe(1, 60, d0); tracker.observe(2, 60, d0); tracker.observe(3, 60, d0) // stagnation active au départ
	let k = k0
	for (let turn = 4; turn < 24; turn++) {
		tracker.observe(turn, 60, distance(cells[k], cells[e]))
		const w = world({ turn, k, e, enemyLife: 60, stagnation: stagnationOn ? tracker : undefined })
		const { plan } = quiet(() => w.evaluate())
		if (plan && (plan.weaponShots > 0 || plan.chips.length > 0)) return turn - 3
		if (plan) { quiet(() => executeTacticalPlan(w.me, plan)); k = w.me.cell.id }
	}
	return Infinity
}

test("the walking rule never delays the first possible shot (static enemy in 568: starts 378, 343, 112; in 262: 114)", () => {
	for (const [k0, e] of [[378, 568], [343, 568], [112, 568], [114, 262]]) {
		const without = turnsToFirstShot(k0, e, false)
		const withRule = turnsToFirstShot(k0, e, true)
		assert.ok(withRule <= without, `start ${k0}, enemy ${e}: first shot after ${withRule} turn(s) with the rule, ${without} without`)
	}
	assert.equal(turnsToFirstShot(378, 568, true), 2, "378 -> 396 -> 466 then the shot, as without the rule")
})

test("property: over a fixed sample of starts and four static enemy positions, the rule is never slower", () => {
	const starts = cells.filter((cell) => !cell.obstacle).map((cell) => cell.id).filter((id, i) => i % 5 === 0)
	let compared = 0
	for (const e of [568, 262, ENEMY_CORNER, 310]) for (const k0 of starts) {
		if (k0 === e) continue
		const without = turnsToFirstShot(k0, e, false)
		const withRule = turnsToFirstShot(k0, e, true)
		assert.ok(withRule <= without, `start ${k0}, enemy ${e}: ${withRule} turn(s) with the rule, ${without} without`)
		compared++
	}
	assert.ok(compared > 300, `${compared} comparisons`)
})

test("an offense that is only AVAILABLE (never played: too dangerous) resets nothing and the rule is not engaged while the normal plan moves", () => {
	const tracker = new StagnationTracker()
	const d = distance(cells[378], cells[568])
	for (let turn = 1; turn <= 4; turn++) tracker.observe(turn, 60, d)
	assert.equal(tracker.turns, 3)
	// 378 : une case de tir de ice est à 3 pas, mais toute autre case que 378 est à danger 200 (aucun retour possible avec
	// 4 PM). Le cas d'origine (411) n'est plus « non joué » : ice est créditée depuis 428, avec retour en 411.
	const unplayed = quiet(() => world({ turn: 5, k: 378, e: 568, stagnation: tracker,
		dangerOverride: (cell) => cell.id === 378 ? null : 200 }).evaluate())
	assert.deepEqual([unplayed.plan?.weaponShots ?? 0, unplayed.plan?.chips.length ?? 0, unplayed.plan?.afterMp ?? 0], [0, 0, 0],
		"no shot is played from 378")
	assert.equal(tracker.turns, 3, "offense available but unplayed: the counter is NOT reset")
	assert.equal(tracker.escaping, false)
	const at378 = quiet(() => world({ turn: 5, k: 378, e: 568, stagnation: tracker }).evaluate())
	assert.notEqual(at378.plan?.progressModel, "stagnation walk route", "normal progress exists: the rule stays out of the way")
	assert.equal(tracker.escaping, false)
	assert.equal(tracker.turns, 3)
})

test("tracker: commit engages the escape, a record, damage or a real planned shot disengage it", () => {
	const tracker = new StagnationTracker()
	for (let turn = 1; turn <= 4; turn++) tracker.observe(turn, 60, 10)
	assert.equal(tracker.escaping, false)
	tracker.commit()
	assert.equal(tracker.escaping, true)
	tracker.observe(5, 60, 10)
	assert.equal(tracker.escaping, true, "a plain idle/escape turn keeps it engaged")
	tracker.observe(6, 60, 9) // record
	assert.deepEqual([tracker.escaping, tracker.turns], [false, 0])
	tracker.commit(); tracker.observe(7, 40, 9) // dégâts
	assert.equal(tracker.escaping, false)
	tracker.commit(); tracker.noteOffense() // tir réel prévu
	assert.deepEqual([tracker.escaping, tracker.turns], [false, 0])
	tracker.commit(cells[187], cells[133]); tracker.noteOffense() // un tir réel termine aussi l'épisode : mémoire vidée
	assert.deepEqual([tracker.visited(cells[187]), tracker.visited(cells[133])], [false, false])
})

test("real chronology of the fight (positions and PV embedded, no external data): chase T9-T12 unchanged, escape at T13", () => {
	// [Kassbi, dv3, PV dv3] au début des tours 1 à 13 réels (replay 54940819, recoupés avec les distances des logs).
	const starts = [[107, 331, 195], [144, 332, 195], [216, 332, 195], [288, 332, 195], [290, 332, 195], [292, 332, 195],
		[310, 262, 195], [346, 192, 60], [328, 122, 60], [258, 52, 60], [205, 17, 60], [187, 17, 60], [187, 17, 60]]
	const tracker = new StagnationTracker()
	const counters = []
	starts.forEach(([k, e, life], i) => {
		const turn = i + 1
		tracker.noteEnemyPositions(String(e))
		tracker.observe(turn, life, distance(cells[k], cells[e]), i > 0 ? starts[i - 1][2] - life : 0) // dégât de mon tir du tour 7
		counters.push(tracker.turns)
		if (turn < 8) return
		const withRule = quiet(() => world({ turn, k, e, enemyLife: life, stagnation: tracker }).evaluate())
		const off = quiet(() => world({ turn, k, e, enemyLife: life }).evaluate())
		if (turn <= 12) {
			// dv3 a bougé jusqu'au tour 10 : la règle reste hors jeu (ennemi mobile), puis il faut 2 tours d'immobilité.
			assert.equal(withRule.plan?.destination.id, off.plan?.destination.id, `turn ${turn}: same decision as the rule off`)
			assert.notEqual(withRule.plan?.progressModel, "stagnation walk route", `turn ${turn}`)
		} else {
			assert.equal(off.plan, null, "rule off: held in 187")
			assert.equal(withRule.plan.progressModel, "stagnation walk route")
			// 5 tours passifs depuis le dégât du tour 7 : poids nul, la sortie prend la case la plus proche à pied (116,
			// danger 38,88 sous mes PV) au lieu de la plus proche parmi les cases sûres (133).
			assert.equal(withRule.plan.destination.id, 116)
			assert.ok(withRule.plan.danger < 339)
		}
	})
	assert.deepEqual(counters, [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5], "0 while approaching and after the T7 shot")
})

/** Ennemi qui fuit : parmi les cases à <= 4 pas de lui (ma case bloquante), la plus éloignée de moi à pied (id minimal à égalité). */
function fleeStep(k, e) {
	const mine = walkDistances([k], [e]), reach = new Map([[e, 0]]), queue = [e]
	for (let head = 0; head < queue.length; head++) {
		const cell = cells[queue[head]]
		if (reach.get(cell.id) >= 4) continue
		for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
			const next = at(cell.x + dx, cell.y + dy)
			if (next && !next.obstacle && next.id !== k && !reach.has(next.id)) { reach.set(next.id, reach.get(cell.id) + 1); queue.push(next.id) }
		}
	}
	let best = e, far = -1
	for (const id of [...reach.keys()].sort((a, b) => a - b)) if ((mine.get(id) ?? -1) > far) { far = mine.get(id); best = id }
	return best
}
function fleeStepManhattan(k, e) {
	const reach = new Map([[e, 0]]), queue = [e]
	for (let head = 0; head < queue.length; head++) {
		const cell = cells[queue[head]]
		if (reach.get(cell.id) >= 4) continue
		for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
			const next = at(cell.x + dx, cell.y + dy)
			if (next && !next.obstacle && next.id !== k && !reach.has(next.id)) { reach.set(next.id, reach.get(cell.id) + 1); queue.push(next.id) }
		}
	}
	let best = e, far = -1
	for (const id of [...reach.keys()].sort((a, b) => a - b)) {
		const d = distance(cells[k], cells[id])
		if (d > far) { far = d; best = id }
	}
	return best
}
function turnsToFirstShotVsFleeing(k0, e0, stagnationOn, flee = fleeStep, activeAtStart = false) {
	const tracker = new StagnationTracker()
	let k = k0, e = e0
	if (activeAtStart) {
		const d = distance(cells[k], cells[e])
		for (let i = -3; i < 0; i++) { tracker.noteEnemyPositions(String(e)); tracker.observe(i, 60, d) }
	}
	for (let turn = 1; turn <= 30; turn++) {
		tracker.noteEnemyPositions(String(e)) // le jeu réel fournit les positions ennemies (Kassbi_Class.observeStagnation)
		tracker.observe(turn, 60, distance(cells[k], cells[e]))
		const w = world({ turn, k, e, enemyLife: 60, stagnation: stagnationOn ? tracker : undefined })
		const { plan } = quiet(() => w.evaluate())
		if (plan && (plan.weaponShots > 0 || plan.chips.length > 0)) return turn
		if (plan) { quiet(() => executeTacticalPlan(w.me, plan)); k = w.me.cell.id }
		e = flee(k, e)
	}
	return Infinity
}

// Contre un ennemi qui FUIT (ici : toujours vers la case la plus éloignée à pied de moi, 4 PM), la première version de la
// garantie ne tenait pas : la sortie engagée (`escaping`) n'était levée que par un tir prévu, un dégât ou un record de
// proximité. Engagée sans case sûre plus proche par la marche, `withStagnation` rendait `null` (maintien) MÊME si le plan
// normal proposait un déplacement sûr : départ 40, ennemi 310, plan normal 131 -> 200 ignoré du tour 18 à la fin des
// 30 tours (règle désactivée : premier tir au tour 15 ; règle activée : aucun tir en 30 tours). Correction : quand la
// sortie engagée n'a plus de case sûre plus proche, l'engagement est LEVÉ (`release`) et le plan normal s'exécute ; garde
// anti-oscillation : un déplacement normal vers une case déjà visitée par la sortie est refusé et la sortie ne se
// ré-engage jamais vers une case visitée.
test("against a fleeing enemy the engaged escape is lifted when no safe closer cell exists: no later first shot", () => {
	const without = turnsToFirstShotVsFleeing(40, 310, false)
	const withRule = turnsToFirstShotVsFleeing(40, 310, true)
	assert.equal(without, 9, "reference: the rule off shoots at turn 9 (15 before chips were credited after a move)")
	assert.ok(withRule <= without, `${withRule} turn(s) with the rule, ${without} without`)
})

test("fleeing-enemy bank (2 flee policies x 5 enemy starts x fixed starts, fresh and active counter): never slower", () => {
	const starts = cells.filter((cell) => !cell.obstacle).map((cell) => cell.id).filter((_, i) => i % 60 === 0)
	let compared = 0
	for (const flee of [fleeStep, fleeStepManhattan]) for (const e0 of [568, 262, ENEMY_CORNER, 310, 2]) {
		for (const k0 of starts) for (const active of [false, true]) {
			if (k0 === e0) continue
			const without = turnsToFirstShotVsFleeing(k0, e0, false, flee, active)
			const withRule = turnsToFirstShotVsFleeing(k0, e0, true, flee, active)
			assert.ok(withRule <= without, `${flee.name}, start ${k0}, enemy ${e0}, active ${active}: ${withRule} with the rule, ${without} without`)
			compared++
		}
	}
	assert.ok(compared >= 150, `${compared} comparisons`)
})

test("a MOVING enemy keeps the rule out of play (blocked plan is transient) and lifts an engaged escape", () => {
	const tracker = new StagnationTracker()
	for (let turn = 1; turn <= 4; turn++) { tracker.noteEnemyPositions("A"); tracker.observe(turn, 60, 10) }
	assert.equal(tracker.active, true, "static enemy, no record: active")
	tracker.commit(cells[187], cells[133])
	tracker.noteEnemyPositions("B"); tracker.observe(5, 60, 10) // l'ennemi a bougé
	assert.equal(tracker.active, false, "enemy moved: the rule is out of play")
	assert.deepEqual([tracker.escaping, tracker.visited(cells[133])], [false, false], "engagement lifted, memory cleared")
	tracker.noteEnemyPositions("B"); tracker.observe(6, 60, 10)
	assert.equal(tracker.active, false, "needs STAGNATION_TURNS still turns")
	tracker.noteEnemyPositions("B"); tracker.observe(7, 60, 10)
	assert.equal(tracker.active, true)
})

test("lifting the engagement: an engaged escape with no closer safe cell lets a SAFE normal move run (131, fleeing enemy)", () => {
	for (const e of [2, 37]) {
		const tracker = new StagnationTracker()
		const d = distance(cells[131], cells[e])
		for (let turn = 1; turn <= 4; turn++) tracker.observe(turn, 60, d)
		tracker.commit() // sortie déjà engagée
		const off = quiet(() => world({ turn: 5, k: 131, e, enemyLife: 60 }).evaluate())
		const on = quiet(() => world({ turn: 5, k: 131, e, enemyLife: 60, stagnation: tracker }).evaluate())
		assert.equal(on.plan?.destination.id, off.plan?.destination.id, `enemy ${e}: same safe move as the rule off`)
		assert.equal(on.plan?.danger ?? 0, 0)
		assert.equal(tracker.escaping, off.plan ? false : tracker.escaping)
	}
})

test("anti-oscillation after a lift: a normal move back to a cell the escape already visited is refused", () => {
	const tracker = new StagnationTracker()
	for (let turn = 1; turn <= 4; turn++) tracker.observe(turn, 60, 10)
	tracker.commit(cells[187], cells[133]) // sortie 187 -> 133
	assert.equal(tracker.visited(cells[187]), true)
	assert.equal(tracker.visited(cells[133]), true)
	assert.equal(tracker.visited(cells[81]), false)
	tracker.release()
	assert.deepEqual([tracker.escaping, tracker.active], [false, true], "lifted but the counter and the memory stay")
	tracker.observe(5, 60, 9) // record : tout est remis à zéro
	assert.equal(tracker.visited(cells[187]), false)
})

test("planAct keeps the escape going: the counter is not reset by the escape move itself", () => {
	const tracker = stalled(2)
	const w = world({ turn: 14, stagnation: tracker })
	const messages = [], original = console.log
	try { console.log = (message) => messages.push(message); planAct(w.me, undefined, w.context) } finally { console.log = original }
	assert.equal(w.me.events.length, 1)
	assert.match(w.me.events[0], /^move:/)
	assert.ok(messages.some((m) => m.includes("[Tactical] stagnation: 2 turns without shot or progress")))
	assert.ok(messages.some((m) => m.includes('"progressModel":"stagnation walk route"')))
	assert.ok(!messages.some((m) => m.includes("[Reserve]")))
	seen(tracker, 15, w.me.cell.id)
	assert.equal(tracker.turns, 3, "the escape move did not reset the counter")
})

// Garde anti-oscillation, côté PLANIFICATEUR (le test du tracker seul ne la couvrait pas : retirer l'une ou l'autre
// des deux gardes `visited` de TacticalPlanner.ts ne faisait échouer aucun test). Scénario : sortie 187 -> 133 engagée,
// toutes les cases plus proches à pied sont dangereuses : pas de nouvelle sortie, l'engagement est levé et le plan
// normal voudrait retourner en 187 (distance Manhattan plus courte) : c'est exactement l'oscillation 187 <-> 133.
test("anti-oscillation in the planner: a lifted escape never walks back to a cell it visited (133 -> 187)", () => {
	const closer = (cell) => (walk.get(cell.id) ?? Infinity) < walk.get(133)
	const at133 = (commit) => {
		const tracker = stalled(2)
		seen(tracker, 15, 133)
		commit(tracker)
		assert.deepEqual([tracker.active, tracker.escaping], [true, true])
		const w = world({ turn: 15, k: 133, stagnation: tracker, dangerOverride: (cell) => closer(cell) ? 100 : null })
		return { tracker, result: quiet(() => w.evaluate()) }
	}
	// Contrôle : sans mémoire des cases visitées, le plan normal retourne bien en 187 (sinon le test ne prouverait rien).
	const control = at133((tracker) => tracker.commit())
	assert.equal(control.result.plan?.destination.id, KASSBI_STUCK, "the normal plan alone walks back to 187")
	const guarded = at133((tracker) => tracker.commit(cells[KASSBI_STUCK], cells[133]))
	assert.equal(guarded.result.plan, null, "visited 187: the move back is refused, hold in 133")
	assert.equal(guarded.tracker.escaping, false, "the engagement was lifted")
	assert.equal(guarded.tracker.visited(cells[KASSBI_STUCK]), true, "the memory is kept until a record, damage or shot")
})

// DÉFAUT CORRIGÉ (Testeur, 2026-11-25) : la garde anti-oscillation ne couvrait que le tour de la levée. Sortie 187 -> 133 ;
// toutes les cases plus proches à pied sont dangereuses (frontière) : au tour de la levée le retour en 187 était refusé,
// mais au tour SUIVANT l'engagement n'existait plus, le plan normal (non bloqué, 187 plus proche à vol d'oiseau) était
// exécuté tel quel : 187 -> 133 -> 187 -> 151 -> 98 -> 169 -> 187 -> 150 -> 187 -> 169 -> 187 -> 168 -> 187 (frontière 5,
// ennemi immobile en 17, tours 11 à 40 : 5 retours en 187, ~16 tours de va-et-vient). Correction : la mémoire des cases
// visitées dure TOUT l'épisode et le plan normal ne peut pas se déplacer vers une case visitée (tir réel et record exceptés).
test("episode-wide guard: no walk back to the stagnation cell 187 on the turns AFTER the lift (frontier 5, static enemy, T11-T40)", () => {
	for (const front of [4, 5, 6, 7]) {
		const tracker = new StagnationTracker()
		let k = KASSBI_STUCK, returns = 0, firstShot = Infinity
		const path = [k]
		for (let turn = 11; turn <= 40; turn++) {
			tracker.noteEnemyPositions(String(ENEMY_CORNER))
			tracker.observe(turn, 60, distance(cells[turn === 11 ? KASSBI_BEFORE : k], cells[ENEMY_CORNER]))
			const w = world({ turn, k, stagnation: tracker, dangerOverride: (cell) => (walk.get(cell.id) ?? Infinity) < front ? 100 : null })
			const { plan } = quiet(() => w.evaluate())
			if (plan && (plan.weaponShots > 0 || plan.chips.length > 0)) firstShot = Math.min(firstShot, turn)
			if (plan) {
				quiet(() => executeTacticalPlan(w.me, plan))
				if (w.me.cell.id === KASSBI_STUCK && k !== KASSBI_STUCK) returns++
				k = w.me.cell.id
				path.push(k)
			}
		}
		assert.equal(returns, 0, `frontier ${front}: ${returns} return(s) to ${KASSBI_STUCK}, path ${path}`)
		// Avant la baisse du poids du risque : maintien définitif sur la frontière (danger 100, non mortel). Désormais la
		// frontière est franchie au 4e tour passif et le premier tir part au tour 17 ou 18.
		assert.ok(firstShot <= 18, `frontier ${front}: first shot at turn ${firstShot}, path ${path}`)
	}
})

test("episode-wide guard: with the engagement already lifted, the normal plan is still refused a visited cell, but not a new one or a shot", () => {
	const closer = (cell) => (walk.get(cell.id) ?? Infinity) < walk.get(133)
	const lifted = () => {
		const tracker = stalled(2)
		seen(tracker, 15, 133)
		tracker.commit(cells[KASSBI_STUCK], cells[133])
		tracker.release() // engagement déjà levé aux tours précédents
		assert.deepEqual([tracker.active, tracker.escaping], [true, false])
		return tracker
	}
	const messages = [], original = console.log
	let refused
	try {
		console.log = (message) => messages.push(message)
		refused = world({ turn: 15, k: 133, stagnation: lifted(), dangerOverride: (cell) => closer(cell) ? 100 : null }).evaluate()
	} finally { console.log = original }
	assert.equal(refused.plan, null, "the move back to 187 is refused on a later turn")
	assert.ok(messages.some((m) => m.includes("[Tactical] stagnation: move back to visited cell")), "the refusal is logged")
	// Un déplacement vers une case NON visitée n'est pas bloqué (ici : la sortie vers 81 reste possible).
	const open = quiet(() => world({ turn: 15, k: 133, stagnation: lifted() }).evaluate())
	assert.equal(open.plan?.destination.id, 81)
	// Un tir réel n'est jamais refusé, même depuis/vers des cases visitées (tour 7 du combat : approche 364, repli 346).
	const tracker = new StagnationTracker()
	for (let t = 5; t <= 9; t++) seen(tracker, t, 310, 195, 262)
	tracker.commit(cells[364], cells[346])
	const shot = quiet(() => world({ turn: 7, k: 310, e: 262, enemyLife: 195, stagnation: tracker }).evaluate())
	assert.deepEqual([shot.plan.weaponShots, shot.plan.chips.map((chip) => chip.name)], [1, ["rock"]])
	assert.equal(shot.plan.shotCell.id, 364)
})

// Cases de la garde non couvertes par les mutations du Testeur (2026-11-25) : l'exception « record de proximité » et le
// plan de protection sur place. États construits directement (l'exception est inatteignable avec un ennemi immobile : une
// case visitée n'a jamais une distance inférieure au record, car battre le record vide la mémoire).
test("visited-cell guard exceptions: a cell that beats the proximity record is allowed, a protection cast in place is never refused", () => {
	const closer = (cell) => (walk.get(cell.id) ?? Infinity) < walk.get(133)
	const episode = () => { // record 13 (Kassbi observé en 133), sortie 133 -> 187 mémorisée : 187 (distance 10) battrait le record
		const tracker = new StagnationTracker()
		for (let turn = 1; turn <= 4; turn++) { tracker.noteEnemyPositions("A"); seen(tracker, turn, 133) }
		tracker.commit(cells[133], cells[187])
		return tracker
	}
	assert.equal(episode().beatsRecord(distance(cells[187], cells[ENEMY_CORNER])), true)
	const record = quiet(() => world({ turn: 5, k: 133, stagnation: episode(), dangerOverride: (cell) => closer(cell) ? 100 : null }).evaluate())
	assert.equal(record.plan?.destination.id, KASSBI_STUCK, "visited but a new record: not refused")
	// Protection sur place (afterMp = 0) depuis une case visitée, danger modéré : jamais assimilée à un déplacement refusé.
	// Le bouclier n'est candidat qu'au seuil du rôle : blessé (280/339 = 0,83 ≤ 0,85) et à portée de menace (7 PM + 6 ≥ 13).
	const protectedHere = (stagnation) => quiet(() => world({ turn: 5, k: 133, stagnation, life: 280, enemyMp: 7,
		dangerOverride: (cell) => cell.id === 133 ? 30 : 100 }).evaluate()).plan
	const off = protectedHere(undefined), on = protectedHere(episode())
	assert.deepEqual(off?.protection.map((chip) => chip.name), ["helmet"], "reference: the rule off casts the helmet in place")
	assert.deepEqual([on?.destination.id, on?.afterMp, on?.protection.map((chip) => chip.name)], [133, 0, ["helmet"]])
})

test("the escape never re-targets a cell it already visited, even when it is the closest by walking (133 -> 81)", () => {
	const at133 = (origin, destination) => {
		const tracker = stalled(2)
		seen(tracker, 15, 133)
		tracker.commit(cells[origin], cells[destination])
		return quiet(() => world({ turn: 15, k: 133, stagnation: tracker }).evaluate()).plan
	}
	assert.equal(at133(KASSBI_STUCK, 133)?.destination.id, 81, "control: 81 is the escape target when not visited")
	const plan = at133(KASSBI_STUCK, 81)
	assert.notEqual(plan?.destination.id, 81, "81 was visited: not chosen again")
})

// LIMITE ACCEPTÉE (décision de l'utilisateur, 2026-11-25) : contre un ennemi qui ALTERNE immobilité et déplacement, la
// garantie « jamais plus lent » n'est pas démontrée. Pendant les tours immobiles, la règle est active et engage une sortie
// qui éloigne Kassbi (117 -> 84 pour le départ 80 / ennemi 262) juste avant la fuite ; la trajectoire diverge et l'ennemi,
// acculé dans un coin, n'est plus atteint en 30 tours (règle désactivée : premier tir au tour 11). Ce test CARACTÉRISE
// la limite (aucun correctif prévu) : si ces chiffres changent, la décision d'acceptation est à revoir, pas à masquer.
// Banque : 16 départs x 5 ennemis (568, 262, 17, 310, 2) x compteur neuf/actif = 160 scénarios par alternance.
// Depuis la baisse du poids du risque avec la passivité (mesuré) : 0/56, 4/88, 2/98 (avant : 0/0, 18/20, 16/22), et le
// départ 80 / ennemi 262 tire au tour 9 (avant : jamais en 30 tours).
// Depuis qu'une puce offensive est créditée après déplacement (mesuré) : 0/38, 0/70, 2/64 : moins de « plus rapides »
// parce que la référence sans la règle tire elle-même plus tôt (sur les 480 scénarios, aucun premier tir plus tardif
// qu'avant, règle activée ou non). Départ 80 / ennemi 262 : règle désactivée 11, règle activée 8 (avant : 9).
const ALTERNATION_BANK = { 1: { slower: 0, faster: 38 }, 2: { slower: 0, faster: 70 }, 3: { slower: 2, faster: 64 } }
test("ACCEPTED LIMITATION (characterization): an enemy alternating N still turns and a flee move can make the rule slower", () => {
	const starts = cells.filter((cell) => !cell.obstacle).map((cell) => cell.id).filter((_, i) => i % 30 === 0)
	for (const [still, expected] of Object.entries(ALTERNATION_BANK)) {
		let scenarios = 0, slower = 0, faster = 0
		for (const e0 of [568, 262, ENEMY_CORNER, 310, 2]) for (const k0 of starts) for (const active of [false, true]) {
			if (k0 === e0) continue
			const alternating = () => { let calls = 0; return (k, e) => ++calls % (Number(still) + 1) === 0 ? fleeStep(k, e) : e }
			const without = turnsToFirstShotVsFleeing(k0, e0, false, alternating(), active)
			const withRule = turnsToFirstShotVsFleeing(k0, e0, true, alternating(), active)
			scenarios++
			if (withRule > without) slower++
			else if (withRule < without) faster++
		}
		assert.equal(scenarios, 160)
		assert.deepEqual({ slower, faster }, expected, `${still} still turn(s) then a flee move`)
	}
	const alternating = () => { let calls = 0; return (k, e) => ++calls % 3 === 0 ? fleeStep(k, e) : e }
	assert.equal(turnsToFirstShotVsFleeing(80, 262, false, alternating(), false), 11, "reference: rule off shoots at turn 11")
	assert.equal(turnsToFirstShotVsFleeing(80, 262, true, alternating(), false), 8, "rule on: first shot at turn 8")
})

// LIMITE ACCEPTÉE D1 (caractérisation ; la production n'est pas modifiée). La garde « case visitée » ne vit que dans le
// planificateur tactique. Quand il retient (plan nul), `planAct` bascule sur le plan de réserve (plan B), qui n'a pas la
// mémoire : il ramène Kassbi en 187 (« cached progress »). Les tests d'épisode ci-dessus appellent `evaluate()` seul et ne
// voient pas ce chemin, qui est pourtant celui de `Kassbi_Class.turn()`. Le même type de va-et-vient existe avec la règle
// désactivée : ce n'est pas une régression de la règle (même va-et-vient 187 <-> case de frontière), mais l'anti-oscillation
// « sur tout l'épisode » n'est pas effective via `planAct` sur une frontière de danger. Mesure (planAct complet, ennemi
// immobile en 17, tours 11 à 40) : frontière de danger 5 : 13 retours en 187 ; frontière 6 : 4 ; frontière 7 : 15 ; règle
// désactivée : 15 / 15 / 15. Si ces chiffres changent, revoir la décision.
test("ACCEPTED LIMITATION (characterization): planAct (tactical hold, then the reserve plan) still oscillates on a danger frontier, as with the rule off", () => {
	const returnsTo187 = (front, stagnationOn) => {
		const tracker = stagnationOn ? new StagnationTracker() : undefined
		let k = KASSBI_STUCK, returns = 0
		for (let turn = 11; turn <= 40; turn++) {
			if (tracker) {
				tracker.noteEnemyPositions(String(ENEMY_CORNER))
				tracker.observe(turn, 60, distance(cells[turn === 11 ? KASSBI_BEFORE : k], cells[ENEMY_CORNER]))
			}
			const w = world({ turn, k, stagnation: tracker, dangerOverride: (cell) => (walk.get(cell.id) ?? Infinity) < front ? 100 : null })
			quiet(() => planAct(w.me, undefined, w.context))
			if (w.me.cell.id === KASSBI_STUCK && k !== KASSBI_STUCK) returns++
			k = w.me.cell.id
		}
		return returns
	}
	// Règle désactivée (mesuré) : 15 retours quelle que soit la frontière (187 <-> case de frontière, 30 tours). Règle activée :
	// 13/4/15 avant la baisse du poids du risque avec la passivité, 2/2/2 depuis (la frontière est franchie au 4e tour passif).
	for (const [front, on, off] of [[5, 2, 15], [6, 2, 15], [7, 2, 15]]) {
		assert.equal(returnsTo187(front, true), on, `frontier ${front}: returns to ${KASSBI_STUCK} with the rule on`)
		assert.equal(returnsTo187(front, false), off, `frontier ${front}: returns to ${KASSBI_STUCK} with the rule off (same oscillation, not a regression)`)
	}
})

// DÉFAUT D2 CORRIGÉ : la garde refusait aussi une RETRAITE de sécurité vers une case visitée, et la sortie engagée
// remplaçait la retraite par une case plus exposée. Épisode 187 -> 133 (record 10), ennemi immobile, danger modélisé de 133
// monté à 150 (cooldown ennemi, par exemple), 187 sûr (0), tout le reste à 100. Règle désactivée : retraite en 187 (danger 0).
// Règle activée avant correction : retraite refusée, la sortie choisissait 100 (<= 150, « marche plus courte »).
// Pour un danger de 20 ou 60 en 133, le tactique retient (plan nul) mais le plan B retraite en 187 : le défaut est masqué.
// L'épisode ne compte que 2 tours passifs : le poids du risque est plein (à poids nul, aucune retraite n'est attendue).
function visitedEpisode187to133() {
	const tracker = new StagnationTracker()
	for (let turn = 1; turn <= 2; turn++) { tracker.noteEnemyPositions("A"); seen(tracker, turn, KASSBI_STUCK) }
	tracker.commit(cells[KASSBI_STUCK], cells[133])
	tracker.noteEnemyPositions("A"); seen(tracker, 3, 133)
	assert.deepEqual([tracker.active, tracker.riskFactor], [true, 1])
	return tracker
}
test("a safety retreat to a visited cell is never replaced by a more dangerous cell than the rule off would take", () => {
	const finalDanger = (stagnation) => {
		const danger = (cell) => cell.id === 133 ? 150 : cell.id === KASSBI_STUCK ? 0 : 100
		const w = world({ turn: 6, k: 133, stagnation: stagnation ? visitedEpisode187to133() : undefined, dangerOverride: danger })
		quiet(() => planAct(w.me, undefined, w.context))
		return danger(w.me.cell)
	}
	assert.equal(finalDanger(false), 0, "reference: the rule off retreats to 187")
	assert.equal(finalDanger(true), 0, "the rule on retreats to the visited, safe 187 too")
})

test("the visited-cell guard lets a move + protection plan through (187, 3 MP, helmet) even without any safety gain", () => {
	const danger = (cell) => cell.id === 133 ? 30 : cell.id === KASSBI_STUCK ? 30 : 100 // danger final 30 = danger courant 30
	const episode = visitedEpisode187to133 // record 10 (observé en 187), 187 visité et ne bat pas le record
	const shape = (stagnation) => {
		// Bouclier candidat au seuil du rôle : blessé (280/339 = 0,83 ≤ 0,85) et à portée de menace (7 PM + 6 ≥ 13).
		const plan = quiet(() => world({ turn: 6, k: 133, stagnation, life: 280, enemyMp: 7, dangerOverride: danger }).evaluate()).plan
		return [plan?.destination.id, plan?.afterMp, plan?.danger, plan?.protection.map((chip) => chip.name)]
	}
	assert.deepEqual(shape(undefined), [KASSBI_STUCK, 3, 30, ["helmet"]], "reference: the rule off moves to 187 and casts the helmet")
	assert.deepEqual(shape(episode()), [KASSBI_STUCK, 3, 30, ["helmet"]], "the rule on does not refuse it")
})

test("the visited-cell guard lets a safety retreat through at the tactical level (evaluate): destination 187, danger 0", () => {
	const danger = (cell) => cell.id === 133 ? 150 : cell.id === KASSBI_STUCK ? 0 : 100
	const plan = quiet(() => world({ turn: 6, k: 133, stagnation: visitedEpisode187to133(), dangerOverride: danger }).evaluate()).plan
	assert.deepEqual([plan?.destination.id, plan?.danger], [KASSBI_STUCK, 0])
})

// Boost dans le plan (les autres tests de ce fichier gardent les boosts en délai : voir le monde partagé).
test("with a boost ready: a hold becomes a boost-only plan, which still counts as blocked, and the escape keeps the boost", () => {
	// Tour 13 : sous le seuil, pas de sortie. Le plan ne bouge pas mais lance protein (ennemi à 10 ≤ 6 + 2 × 4 + 4).
	const hold = quiet(() => world({ turn: 13, stagnation: stalled(1), boosts: true }).evaluate()).plan
	assert.deepEqual([hold?.destination.id, hold?.afterMp, hold?.weaponShots], [KASSBI_STUCK, 0, 0])
	assert.deepEqual(hold?.boost?.chips.map((chip) => chip.name), ["protein"])
	// Tour 14 : seuil atteint. Un plan réduit à un boost reste « bloqué » : la sortie part, avec le même boost.
	const w = world({ turn: 14, stagnation: stalled(2), boosts: true })
	const escape = quiet(() => w.evaluate()).plan
	assert.equal(escape?.progressModel, "stagnation walk route")
	assert.equal(escape?.destination.id, 133)
	assert.deepEqual(escape?.boost?.chips.map((chip) => chip.name), ["protein"])
	quiet(() => executeTacticalPlan(w.me, escape))
	assert.deepEqual(w.me.events, ["chip:protein", "move:133"])
})

// REFUS DE COMBAT (combats 54944456, 54944868, 54946689, joués avec 1faccb2) : dès que le danger modélisé des cases de tir
// ou d'approche dépasse le gain d'un tour, rester l'emportait indéfiniment. Le poids du risque décroît désormais avec la
// passivité (`StagnationTracker.riskFactor`) ; un danger qui atteint mes PV reste refusé. États construits sur la carte de
// 54940819 (terrain ouvert, ennemi immobile), danger imposé : ce ne sont pas des rejeux exacts de ces combats.
test("tracker: passive turns are reset by damage dealt by my actions only, frozen by an approach, and counted through a dance", () => {
	assert.deepEqual([PASSIVE_TURNS_AT_FULL_RISK, PASSIVE_RISK_STEP], [2, 0.5])
	const tracker = new StagnationTracker()
	const factors = []
	// Approche 20 -> 12 -> 9 (minimum du combat battu : gelé), puis danse 5 <-> 9 avec un ennemi mobile (54944868).
	for (const [turn, d] of [[1, 20], [2, 12], [3, 9], [4, 5], [5, 9], [6, 5], [7, 9], [8, 5]]) {
		tracker.noteEnemyPositions(`E${turn}`)
		tracker.observe(turn, 100, d)
		factors.push([tracker.passiveTurns, tracker.riskFactor])
	}
	assert.deepEqual(factors, [[0, 1], [0, 1], [0, 1], [0, 1], [1, 1], [2, 1], [3, 0.5], [4, 0]])
	assert.equal(tracker.active, false, "moving enemy: the walking escape stays out of play, the risk weight still drops")
	tracker.noteOffense() // un tir seulement prévu ne remet pas la passivité à zéro
	tracker.observe(9, 100, 4) // nouveau minimum du combat : gelé, pas remis à zéro
	assert.deepEqual([tracker.passiveTurns, tracker.riskFactor], [4, 0])
	tracker.observe(10, 80, 9) // PV ennemis en baisse sans dégât de mes actions (allié, poison) : toujours passif
	assert.deepEqual([tracker.passiveTurns, tracker.riskFactor], [5, 0])
	tracker.observe(11, 80, 9, 20) // dégât infligé par mes actions au tour précédent
	assert.deepEqual([tracker.passiveTurns, tracker.riskFactor], [0, 1])
	// Deux ennemis : le proche (distance 2) meurt, l'approche du suivant (12 -> 8 -> 4) bat le minimum reparti de zéro.
	const two = new StagnationTracker()
	const counts = []
	for (const [turn, d, dealt, alive] of [[1, 6, 0, 2], [2, 2, 0, 2], [3, 12, 50, 1], [4, 8, 0, 1], [5, 4, 0, 1], [6, 4, 0, 1]]) {
		two.observe(turn, 100, d, dealt, alive)
		counts.push(two.passiveTurns)
	}
	assert.deepEqual(counts, [0, 0, 0, 0, 0, 1], "approaching the next enemy is not passive; holding at 4 is")
})

// HISTORIQUE DES ACTIONS (`ActionHistory`) : la passivité vient des dégâts mesurés autour de chaque appel natif, plus de
// la somme des PV ennemis d'un tour à l'autre. Choix : un tour est actif si une de mes actions a fait perdre des PV à sa
// cible ; un tir absorbé (0 PV) ou refusé laisse le tour passif, comme un tour sans tir.
test("history: an enemy healing more than I hit keeps passivity at 0; turns without damage dealt raise it as before", () => {
	const history = new ActionHistory(), tracker = new StagnationTracker()
	const me = { id: 1, tp: 10, mp: 4 }, enemy = { id: 2, life: 100 }
	const shot = (result, damage) => () => history.track(me, { name: "pistol" }, enemy,
		() => { if (result > 0) { me.tp -= 3; enemy.life -= damage } return result })
	const play = (turn, act) => {
		tracker.observe(turn, enemy.life, 5, history.lastDealt, 1)
		const seenAtStart = [tracker.passiveTurns, tracker.riskFactor]
		Object.assign(me, { tp: 10, mp: 4 })
		history.begin(turn, me, 0, tracker.passiveTurns)
		act?.()
		quiet(() => history.end())
		return seenAtStart
	}
	// PV ennemis au début de mes tours : 100, 105, 110, 115, 120, 125 (soin 15, tir 10) : jamais passif.
	for (let turn = 1; turn <= 6; turn++) {
		assert.deepEqual(play(turn, shot(1, 10)), [0, 1], `turn ${turn}, enemy life ${enemy.life}`)
		enemy.life += 15
	}
	assert.equal(history.records.at(-1).dealt, 10)
	// Puis : rien, un déplacement, un tir absorbé (succès, 0 PV), un tir refusé (-4) : la passivité monte 1, 2, 3, 4.
	const acts = [undefined, () => history.track(me, "move", null, () => { me.mp -= 2; return 2 }), shot(1, 0), shot(-4, 0), undefined]
	assert.deepEqual(acts.map((act, i) => play(7 + i, act)), [[0, 1], [1, 1], [2, 1], [3, 0.5], [4, 0]])
	assert.equal(history.records.length, HISTORY_TURNS, "bounded history")
	assert.deepEqual(history.records.at(-3).actions, [{ action: { name: "pistol" }, result: 1, damage: 0 }])
})

test("history: one [History] line per turn (shot, chip, move), through the joint plan and through the reserve plan", () => {
	const turnLine = (turn, options, taken, passiveTurns) => {
		const w = world({ turn, ...options })
		w.me.useWeapon = function (target) { this.tp -= this.weapon.cost; target.life -= 30; this.events.push("shoot"); return 2 }
		w.me.useChip = function (chip) { this.tp -= chip.cost; this.events.push(`chip:${chip.name}`); return 1 }
		getLogConfig().setEnabled(LOG_CONTEXT.COMBAT, true)
		const messages = [], original = console.log
		try {
			console.log = (message) => messages.push(message)
			actionHistory.begin(turn, w.me, taken, passiveTurns)
			planAct(w.me, undefined, w.context)
			actionHistory.end()
		} finally { console.log = original }
		return { events: w.me.events, reserve: messages.some((m) => m.includes("[Reserve]")),
			lines: messages.filter((m) => m.startsWith("[History]")) }
	}
	// Tour 7 du combat, blessé (200/339) : approche 364, bandage, deux tirs critiques de 30, repli 346.
	const joint = turnLine(7, { k: 310, e: 262, enemyLife: 195, life: 200 }, 12, 0)
	assert.deepEqual(joint.events, ["move:364", "chip:bandage", "shoot", "shoot", "move:346"])
	assert.deepEqual(joint.lines, ["[History] T7 TP 10/10 MP 4/4 dealt 60 taken 12 passive 0 | " +
		"move:3:-; bandage:1:-; machine_gun:2:30; machine_gun:2:30; move:1:-"])
	// Tour 12 sans compteur : le plan conjoint retient, le plan B avance en 133 ; sa ligne sort aussi.
	const reserve = turnLine(12, {}, 0, 3)
	assert.equal(reserve.reserve, true)
	assert.deepEqual(reserve.lines, ["[History] T12 TP 0/10 MP 3/4 dealt 0 taken 0 passive 3 | move:3:-"])
	assert.equal(actionHistory.lastDealt, 0)
	// Hors d'un tour ouvert, `track` ne fait qu'appeler : rien n'est enregistré.
	const w = world({ turn: 13 })
	assert.equal(actionHistory.track(w.me, "move", null, () => 7), 7)
	assert.equal(actionHistory.records.at(-1).actions.length, 1)
})

const OPEN_ENEMY = 332
/** Compteur après `passiveTurns` tours sans dégât face à un ennemi immobile à distance `d`. */
function passive(passiveTurns, d) {
	const tracker = new StagnationTracker()
	for (let turn = 1; turn <= passiveTurns + 1; turn++) { tracker.noteEnemyPositions("E"); tracker.observe(turn, 151, d) }
	assert.equal(tracker.passiveTurns, passiveTurns)
	return tracker
}
/** `inner` : danger des cases plus proches de l'ennemi que ma case ; `outer` : danger des autres (dont la mienne). */
function refusal({ k, e = OPEN_ENEMY, passiveTurns, inner, outer, life }) {
	const d = distance(cells[k], cells[e])
	return quiet(() => world({ turn: passiveTurns + 1, k, e, enemyLife: 151, life, stagnation: passive(passiveTurns, d),
		dangerOverride: (cell) => distance(cell, cells[e]) < d ? inner : outer }).evaluate()).plan
}

test("combat refusal: the risk weight drops with passive turns (advance by the 3rd, shot retained), a lethal danger stays refused", () => {
	// Type 54944456 T7 : ennemi 151 PV immobile à distance 11, danger 52,5 sur toutes les cases plus proches. Seule ice (0-8)
	// atteint la cible, depuis une case à 4 PM : 19,8 de dégâts contre 52,5 de danger. Le tir est connu mais décliné : le plan
	// retenu est le maintien sur place sans action (avant le crédit des puces après déplacement : plan nul).
	const shape = (plan) => plan && [plan.beforeMp + plan.afterMp, plan.weaponShots, plan.chips.map((chip) => chip.name), plan.tpUsed]
	for (const passiveTurns of [0, 2]) {
		assert.deepEqual(shape(refusal({ k: 274, passiveTurns, inner: 52.5, outer: 0 })), [0, 0, [], 0], `${passiveTurns} passive turn(s): hold`)
	}
	// Puces sans cooldown lancées plusieurs fois : deux ice (39,6) battent le danger à poids réduit dès le 3e tour passif
	// (avant : une seule ice, 19,8, maintien jusqu'au 4e tour).
	assert.deepEqual(shape(refusal({ k: 274, passiveTurns: 3, inner: 52.5, outer: 0 })), [4, 0, ["ice", "ice"], 8], "3rd passive turn: advance and cast ice twice")
	const advance = refusal({ k: 274, passiveTurns: 4, inner: 52.5, outer: 0 })
	assert.deepEqual(shape(advance), [4, 0, ["ice", "ice"], 8], "4th passive turn: the plan moves 4 MP and casts ice twice on arrival")
	assert.equal(distance(advance.destination, cells[OPEN_ENEMY]), 7, "from distance 11 to 7 (4 MP)")
	assert.equal(advance.danger, 52.5)
	// Type 54946689 T10 : blessé (200/339), distance 9, case à danger 39,4, cases de tir à danger 150 : `bandage` seul.
	const wounded = (passiveTurns) => refusal({ k: 310, e: 262, passiveTurns, inner: 150, outer: 39.4, life: 200 })
	const held = wounded(2)
	assert.deepEqual([held.weaponShots, held.afterMp, held.protection.map((chip) => chip.name)], [0, 0, ["bandage", "helmet"]])
	const fired = wounded(4)
	assert.deepEqual([fired.weaponShots, fired.shotCell.id], [2, 364], "nil risk weight: the two-shot plan is retained")
	assert.deepEqual(fired.protection.map((chip) => chip.name), ["bandage"], "the heal credit is not reduced")
	// Danger ≥ mes PV (339) sur les cases plus proches : refusé quel que soit le nombre de tours passifs, sortie comprise.
	for (const passiveTurns of [4, 6, 12]) for (const [k, e] of [[274, OPEN_ENEMY], [310, 262], [KASSBI_STUCK, ENEMY_CORNER]]) {
		const plan = refusal({ k, e, passiveTurns, inner: 339, outer: 0 })
		assert.ok(plan === null || plan.danger < 339, `${passiveTurns} passive turns from ${k}: danger ${plan?.danger}`)
	}
	const closer = (cell) => (walk.get(cell.id) ?? Infinity) < walk.get(KASSBI_STUCK)
	const walled = (danger) => quiet(() => world({ turn: 20, stagnation: passive(6, 10),
		dangerOverride: (cell) => closer(cell) ? danger : null }).evaluate()).plan
	assert.equal(walled(339), null, "walking escape: a lethal closer cell is still refused at nil weight")
})

// MARGE SOUS LES PV (`PASSIVE_DANGER_LIFE_FRACTION`) : le danger est un modèle (ni critiques ni items inconnus). Dès que
// la passivité réduit le poids du risque, le danger accepté reste sous 75 % de mes PV : 339 PV -> seuil 254,25.
test("life margin: at a reduced risk weight a modeled danger at or above 75 % of my life is refused; full weight unchanged", () => {
	assert.equal(PASSIVE_DANGER_LIFE_FRACTION, 0.75)
	// Avance de 4 PM puis ice (type 54944456), poids nul : 254 accepté, 255 refusé (maintien sur place, danger 0).
	assert.equal(refusal({ k: 274, passiveTurns: 4, inner: 254, outer: 0 })?.danger, 254)
	const refused = refusal({ k: 274, passiveTurns: 4, inner: 255, outer: 0 })
	assert.deepEqual([refused.destination.id, refused.danger, refused.chips.length, refused.tpUsed], [274, 0, 0, 0])
	// Tir (tour 7 du combat : un tir et rock depuis 364), ma case et les autres à 250 : `[tirs, danger]` du plan retenu.
	const shot = (passiveTurns, inner) => {
		const plan = refusal({ k: 310, e: 262, passiveTurns, inner, outer: 250 })
		return [plan.weaponShots, plan.danger]
	}
	for (const passiveTurns of [0, 2]) assert.deepEqual(shot(passiveTurns, 260), [1, 260], "full weight: only my life (339) is the limit")
	for (const passiveTurns of [3, 4]) {
		assert.deepEqual(shot(passiveTurns, 254), [1, 254], `${passiveTurns} passive turns: just under the margin`)
		assert.deepEqual(shot(passiveTurns, 255), [0, 250], `${passiveTurns} passive turns: just above the margin`)
	}
	// Sortie de stagnation à poids nul : même marge.
	const closer = (cell) => (walk.get(cell.id) ?? Infinity) < walk.get(KASSBI_STUCK)
	const walled = (danger) => quiet(() => world({ turn: 20, stagnation: passive(6, 10),
		dangerOverride: (cell) => closer(cell) ? danger : null }).evaluate()).plan
	assert.equal(walled(255), null)
	assert.equal(walled(254)?.progressModel, "stagnation walk route")
})
