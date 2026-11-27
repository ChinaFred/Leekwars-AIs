import assert from "node:assert/strict"
import test from "node:test"
import { load, spec, run } from "./helpers/random-world.mjs"

// Le refus du recul sans dégâts (docs/strategies.md, « Recul sans tir ») ne doit jamais rendre un tour pire que le recul :
// ni plan nul (le plan B rejoue le recul, ou avance sur une case létale), ni plan vide, ni plan létal ou à un critique de
// l'être, ni recherche interrompue qui perd le recul. Reproductions du testeur (campagne ancien / nouveau, graines de
// `spec`), toutes en échec sur la première version du filtre (f1b2216) ; `DIST_ROOT` : autre build à contrôler.
const M = await load(process.env.DIST_ROOT ?? new URL("..", import.meta.url).pathname.replace(/\/$/, ""))
const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
const PROD = { role: "AGGRESSIVE", aggression: 50, range: [3, 8], support: [true, true, true] }
const none = { heal: null, shield: null, wall: null, protein: null, motivation: null }
const brief = (r) => r.plan && [r.plan.dest, r.plan.protection, r.plan.danger]

test("no acting plan besides the retreat (no weapon, 150/400 life): the retreat is kept, the plan is not null", () => {
	// 4 PT, 3 PM, ennemi à 7 ; danger 100 sur ma case, -30 par case de recul, +30 par case d'approche (130 >= 0,75 x 150).
	const s = { ...spec(1), size: 14, obstacles: [], maxLife: 400, life: 150, weapons: [], equipped: -1, chips: [], support: none, profile: PROD,
		stag: null, tp: 4, mp: 3, turn: 5, strength: 0, enemies: [{ x: 7, y: 0, life: 300, absoluteShield: 0, relativeShield: 0, mp: 4, range: 6 }],
		danger: (cell) => Math.max(0, Math.min(200, 100 - 30 * (dist(cell, { x: 7, y: 0 }) - 7))) }
	const r = run(M, s, null, true)
	assert.deepEqual([brief(r), r.refused, r.end.via, r.end.dead], [[[-3, 0], [], 10], 0, "tactical", false])
})

test("seed 115438 (enemy under a 200 absolute shield, staying is the best admitted plan): retreat kept, no plan B advance onto a lethal cell", () => {
	// PV 344/344, 10 PT, 2 PM ; ma case 259,6 ; recul (1,-1) : 170,5. Première version : plan nul, le plan B finissait à 354.
	const r = run(M, spec(115438), null, true)
	assert.deepEqual([brief(r), r.end.via, r.end.cell, r.end.dead], [[[1, -1], [], 170.5], "tactical", [1, -1], false])
})

test("seed 127265, search interrupted after 442 operation reads: the bounded plan is the retreat found, not a lethal cell", () => {
	// PV 303/306, ma case 431,5 (létale). Première version : plan borné (1,0), danger 355 >= 303.
	const r = run(M, spec(127265), 442, true)
	assert.deepEqual([brief(r), r.plan.lethal, r.plan.status !== null], [[[3, 0], [], 208.8], false, true])
})

test("seed 104726 (offensive branch, staying is the best admitted plan): never an empty plan instead of the retreat", () => {
	// Ma case 262,3 ; recul (2,0) : 201,4. Première version : plan sans action, rien d'autre ne prenait le relais.
	const r = run(M, spec(104726), null, true)
	assert.deepEqual([brief(r), r.plan.noop, r.end.idle], [[[2, 0], [], 201.4], false, false])
})

test("seed 754: a shield that covers nothing does not buy the retreat, and an advance one critical hit from death does not replace it", () => {
	// PV 354, ma case 381 (létale) ; recul (-1,0) : danger 0. Première version : bouclier de 2 PT (crédit nul à danger 0) acheté
	// pour faire admettre le recul. Seul autre plan qui agit : bouclier + avance en (0,-1), exposé 310 >= 0,75 x 354.
	const r = run(M, spec(754), null, true)
	assert.deepEqual([brief(r), r.plan.boost, r.refused], [[[-1, 0], [], 0], ["motivation"], 0])
})

test("the filter is off with several enemies (G only measures the first one) and while the stagnation rule is engaged", () => {
	// PV 400/400, 0 PT, 3 PM, ennemi à 12 ; danger 60 partout sauf 0 à 3 cases de recul. Un ennemi : recul refusé, avance.
	const base = (o) => ({ ...spec(1), size: 14, obstacles: [], maxLife: 400, life: 400, weapons: [], equipped: -1, chips: [], support: none, profile: PROD,
		stag: null, tp: 0, mp: 3, turn: 5, strength: 0, enemies: [{ x: 12, y: 0, life: 300, absoluteShield: 0, relativeShield: 0, mp: 4, range: 6 }],
		danger: (cell) => dist(cell, { x: 12, y: 0 }) >= 15 ? 0 : 60, ...o })
	const second = { x: 0, y: 13, life: 300, absoluteShield: 0, relativeShield: 0, mp: 4, range: 6 }
	const engaged = { count: 3, stillTurns: 3, passive: 0, engaged: false, record: 12, visited: [] }
	for (const [label, change, destination, refused] of [
		["one enemy: refused, advance at equal danger", {}, [3, 0], 1],
		["two enemies: retreat kept", { enemies: [base({}).enemies[0], second] }, [-3, 0], 0],
		["stagnation rule active: retreat kept", { stag: engaged }, [-3, 0], 0]
	]) {
		const r = run(M, base(change))
		assert.deepEqual([r.plan.dest, r.refused], [destination, refused], label)
	}
})
