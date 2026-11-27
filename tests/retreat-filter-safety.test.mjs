import assert from "node:assert/strict"
import test from "node:test"
import { load, spec, run } from "./helpers/random-world.mjs"

// Le refus du recul sans dégâts (docs/strategies.md, « Recul sans tir ») ne doit jamais rendre un tour pire que le recul :
// ni plan nul (le plan B rejoue le recul, ou avance sur une case létale), ni plan vide, ni plan létal ou à un critique de
// l'être, ni recherche interrompue qui perd le recul. Reproductions du testeur (campagne ancien / nouveau, graines de
// `spec`), toutes en échec sur la première version du filtre (f1b2216) ; `DIST_ROOT` : autre build à contrôler.
const M = await load(process.env.DIST_ROOT ?? new URL("..", import.meta.url).pathname.replace(/\/$/, ""))
const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
const PROD = { role: "AGGRESSIVE", aggression: 50, support: [true, true, true] }
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

test("the retreat is replaced only by a damaging plan under the margin; never with several enemies, under the role threshold, or by a move without damage", () => {
	// Arme 1-5 (2 tirs de 10), ennemi à 7, 10 PT, 4 PM : 2 PM d'approche, tir depuis (2,0) (danger 60 comme ma case), U 20 ; ou recul
	// de 3 cases (danger 0). Le score préfère le recul (BALANCED, w = 1 : 20 - 60 + N 15 < 0).
	// Profil BALANCED depuis la posture du rôle (référence inchangée du filtre ; seuil de repli : vie <= 0,40 à distance <= 8).
	// Avec le profil de production (AGGRESSIVE, w = 0,5, a = 1,25) les tirs sont en tête d'eux-mêmes (20 - 30 + 18,75 > 0) et,
	// sans plan à dégâts, l'avance remplace le recul : lignes AGGRESSIVE en fin de tableau.
	const gun = { name: "gun", cost: 4, damage: 10, minRange: 1, maxRange: 5, maxUses: -1, needsLos: false }
	const BALANCED = { ...PROD, role: "BALANCED" }
	const base = (o) => ({ ...spec(1), size: 14, obstacles: [], maxLife: 400, life: 400, weapons: [gun], equipped: 0, chips: [], support: none, profile: BALANCED,
		stag: null, tp: 10, mp: 4, turn: 5, strength: 0, enemies: [{ x: 7, y: 0, life: 300, absoluteShield: 0, relativeShield: 0, mp: 4, range: 6 }],
		danger: (cell) => dist(cell, { x: 7, y: 0 }) >= 10 ? 0 : 60, ...o })
	const second = { x: 0, y: 13, life: 300, absoluteShield: 0, relativeShield: 0, mp: 4, range: 6 }
	const ADVANCED = "[Tactical] aggressive posture: retreat without damage refused"
	for (const [label, change, damage, destination, refused, advanced] of [
		["one enemy, full life: replaced by the shots", {}, 20, [2, 0], 1, 0],
		["two enemies (G only measures the first one): kept", { enemies: [base({}).enemies[0], second] }, 0, [-3, 0], 0, 0],
		["no damaging plan (0 TP): kept, not replaced by an advance or a side step", { tp: 0 }, 0, [-3, 0], 0, 0],
		["just above the BALANCED retreat threshold (161/400 at distance 7): replaced", { life: 161 }, 20, [2, 0], 1, 0],
		["at the threshold (160/400): kept", { life: 160 }, 0, [-3, 0], 0, 0],
		["danger margin, 81 life (60 < 0.75 x 81): replaced", { life: 81, maxLife: 81 }, 20, [2, 0], 1, 0],
		["danger margin, 80 life (60 >= 0.75 x 80): kept", { life: 80, maxLife: 80 }, 0, [-3, 0], 0, 0],
		["DEFENSIVE: the retreat without a shot is never filtered", { profile: { ...PROD, role: "DEFENSIVE" } }, 0, [-3, 0], 0, 0],
		["AGGRESSIVE: the shots lead on their own, nothing to refuse", { profile: PROD }, 20, [2, 0], 0, 0],
		["AGGRESSIVE, no damaging plan (0 TP): the advance replaces the retreat", { profile: PROD, tp: 0 }, 0, [4, 0], 0, 1],
		["AGGRESSIVE, 0 TP, 80 life (60 >= 0.75 x 80): no advance under the margin, retreat kept", { profile: PROD, tp: 0, life: 80, maxLife: 80 }, 0, [-3, 0], 0, 0],
		["AGGRESSIVE, 0 TP, just above its retreat threshold (104/400): the advance replaces the retreat", { profile: PROD, tp: 0, life: 104 }, 0, [4, 0], 0, 1],
		["AGGRESSIVE, 0 TP, at its retreat threshold (100/400): kept", { profile: PROD, tp: 0, life: 100 }, 0, [-3, 0], 0, 0],
		// Sans la garde, l'avance vers la case visitée serait refusée ensuite par la règle de stagnation : plan nul.
		["AGGRESSIVE, 0 TP, advance cell (4,0) already visited by a stagnation exit: retreat kept, not a null plan", { profile: PROD, tp: 0,
			stag: { count: 0, stillTurns: 0, passive: 0, engaged: false, record: 1, visited: [[4, 0]] } }, 0, [-3, 0], 0, 0],
		["AGGRESSIVE, 0 TP, two enemies: kept", { profile: PROD, tp: 0, enemies: [base({}).enemies[0], second] }, 0, [-3, 0], 0, 0]
	]) {
		const r = run(M, base(change))
		assert.deepEqual([r.plan.U, r.plan.dest, r.refused, r.logs.filter((l) => l.startsWith(ADVANCED)).length],
			[damage, destination, refused, advanced], label)
	}
})

test("exclusions kept: a move that closes the Manhattan distance is not a retreat (seed 85), a replacement aiming at a visited cell is not taken (seed 9092)", () => {
	// 85 : (0,1) rapproche en Manhattan (G du trajet futur < 0), danger 306 -> 229 ; sans la condition Manhattan : (-1,1), 233.
	// 9092 : compteur de stagnation inactif, (-1,-3) déjà visitée ; sans la garde : recul (0,-4) remplacé par (-1,-3), danger 105,8.
	for (const [seed, expected] of [[85, [[0, 1], [], 229]], [9092, [[0, -4], [], 75.8]]]) {
		const r = run(M, spec(seed))
		assert.deepEqual([brief(r), r.refused], [expected, 0], `seed ${seed}`)
	}
})
