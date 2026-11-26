import assert from "node:assert/strict"
import test from "node:test"

globalThis.Color = { rgb: () => 0 }
globalThis.Debug = { log() {}, pause() {} }
// BUFF_STRENGTH = 6 ; RAW_BUFF_STRENGTH absent : l'identifiant officiel 38 est utilisé.
globalThis.Effect = { DAMAGE: 1, HEAL: 2, ABSOLUTE_SHIELD: 3, RELATIVE_SHIELD: 4, POISON: 5, BUFF_STRENGTH: 6 }
globalThis.Fight = { turn: 1 }

const { computeReachableCells } = await import("../dist/Classes/Context/ReachableCells.js")
const { planShots, toCandidate, sortByRatio, strengthBoostOf, tpBoostOf } = await import("../dist/Classes/Context/ShotPlan.js")
const {
	buildThreatMap, GeometricShotCells, MAX_SIGHT_CACHE, MAX_THREAT_BOOSTS, MAX_THREAT_WEAPONS
} = await import("../dist/Classes/Context/ThreatMap.js")
const { EnemyMemory } = await import("../dist/Classes/Context/EnemyMemory.js")

// --- générateur déterministe (graine fixe) ------------------------------------

function seeded(seed) {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

// --- grille : obstacles, ligne de vue qui échantillonne le segment ----------------

function makeGrid(width, height, isObstacle = () => false) {
	const cells = new Map()
	for (let x = 0; x < width; x++) {
		for (let y = 0; y < height; y++) {
			const obstacle = isObstacle(x, y)
			cells.set(`${x},${y}`, { id: y * width + x, x, y, empty: !obstacle, obstacle, entity: null })
		}
	}
	const stats = { lineOfSight: 0 }
	globalThis.Field = {
		cellFromXY: (x, y) => cells.get(`${x},${y}`) ?? null,
		lineOfSight(from, to) {
			stats.lineOfSight++
			const steps = Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y))
			for (let i = 1; i < steps; i++) {
				const x = Math.round(from.x + ((to.x - from.x) * i) / steps)
				const y = Math.round(from.y + ((to.y - from.y) * i) / steps)
				if (cells.get(`${x},${y}`)?.obstacle) {
					return false
				}
			}
			return true
		}
	}
	return {
		cells,
		stats,
		free: () => [...cells.values()].filter((cell) => !cell.obstacle),
		place(entity, cell) {
			cell.entity = entity
			cell.empty = false
			entity.cell = cell
			return entity
		}
	}
}

let nextId = 1000
const gun = (r, over = {}) => {
	const minRange = 1 + Math.floor(r() * 4)
	return {
		id: nextId++, name: "w", cost: 1 + Math.floor(r() * 6), minRange, maxRange: minRange + Math.floor(r() * 9),
		needsLos: r() < 0.5, launchType: r() < 0.5 ? 7 : 1 + Math.floor(r() * 7), maxUses: r() < 0.3 ? 1 + Math.floor(r() * 3) : -1,
		features: [{ type: 1, minValue: 1 + Math.floor(r() * 40), maxValue: 40 + Math.floor(r() * 41) }], ...over
	}
}
const attackChip = (r, over = {}) => {
	const minRange = Math.floor(r() * 4)
	return {
		id: nextId++, name: "c", cost: r() < 0.3 ? 1 : 1 + Math.floor(r() * 7), minRange, maxRange: minRange + Math.floor(r() * 10),
		needsLos: r() < 0.5, launchType: r() < 0.5 ? 7 : 1 + Math.floor(r() * 7), cooldown: 0,
		features: [{ type: 1, minValue: 5 + Math.floor(r() * 36), maxValue: 40 + Math.floor(r() * 51) }], ...over
	}
}
const boostOf = (cost, gain, type = 6, id = nextId++) => ({
	id, name: "b", cost, minRange: 0, maxRange: 0, needsLos: false, cooldown: 0, launchType: 7,
	features: [{ type, minValue: gain, maxValue: gain }]
})

function entity(id, mp, extra = {}) {
	return { id, name: `e${id}`, level: 10, life: 100, maxLife: 100, mp, tp: 10, strength: 0, weapons: [], chips: [], effects: [], launchedEffects: [], ...extra }
}

const reach = (ent, mp, ignore) => computeReachableCells(ent, mp, 1, { ignoreEntityId: ignore })

// --- implémentation de référence naïve ---------------------------------------------
// MAX sur : cases de tir S × armes × combinaisons de boosts, via `exactDamage` (indépendant de `planShots`, aucun cache, aucun pré-rejet de
// portée, `canHit` pour chaque item et chaque configuration). Elle applique seulement les trois élagages
// DOCUMENTÉS de la carte (jamais exacts à 100 %, voir docs/strategies.md) : au plus MAX_THREAT_WEAPONS armes,
// une arme dominée écartée, une configuration de boosts dominée (plus de PT pour moins de force) écartée.

// `prune: false` : aucune configuration écartée par dominance (énumération complète des sous-ensembles de boosts,
// force et PT) — le MAX doit être identique, la dominance n'étant qu'un élagage.
// Maximum des dégâts dans `tp` PT, écrit sans `planShots` : récursion sur les items (nombre d'usages de chacun,
// borné par `uses`), mémoïsée par (item, PT restants). Sert d'oracle aux plans de tir de la carte.
function exactDamage(tp, items) {
	const memo = new Map()
	const visit = (index, remaining) => {
		if (index === items.length) return 0
		const key = index * 4096 + remaining
		if (memo.has(key)) return memo.get(key)
		const { damage, cost, uses } = items[index]
		let best = 0
		for (let count = 0; count <= uses && count * cost <= remaining; count++) {
			best = Math.max(best, count * damage + visit(index + 1, remaining - count * cost))
		}
		memo.set(key, best)
		return best
	}
	return visit(0, Math.max(0, Math.floor(tp)))
}

function naiveBest(enemy, target, provider, counter, { prune = true, maskCap = Infinity } = {}) {
	const tp = Number.isFinite(enemy.tp) && enemy.tp > 0 ? Math.floor(enemy.tp) : 0
	const candidates = []
	for (const chip of enemy.boosts ?? []) {
		const gain = strengthBoostOf(chip, enemy.science ?? 0)
		const tpGain = tpBoostOf(chip, enemy.science ?? 0)
		if ((gain > 0 || tpGain > 0) && Number.isInteger(chip.cost) && chip.cost > 0) {
			candidates.push({ cost: chip.cost, gain, tpGain })
		}
	}
	// La limite porte sur les boosts successivement accessibles : un boost de PT
	// peut rendre sélectionnable un coût supérieur aux PT initiaux.
	const boosts = []
	let maxTp = tp
	while (boosts.length < MAX_THREAT_BOOSTS) {
		const index = candidates.findIndex((boost) =>
			boost.cost <= maxTp && boost.cost - boost.tpGain < maxTp)
		if (index < 0) break
		const boost = candidates.splice(index, 1)[0]
		boosts.push(boost)
		maxTp += Math.max(0, boost.tpGain - boost.cost)
	}
	const combos = []
	for (let mask = 0; mask < 1 << boosts.length; mask++) {
		let cost = 0
		let gain = 0
		let tpGain = 0
		boosts.forEach((boost, i) => { if (mask & (1 << i)) { cost += boost.cost; gain += boost.gain; tpGain += boost.tpGain } })
		const canCast = (remaining, unused) => {
			if (unused === 0) return true
			for (let i = 0; i < boosts.length; i++) {
				if ((unused & (1 << i)) === 0) continue
				const boost = boosts[i]
				if (boost.cost <= remaining &&
					canCast(remaining - boost.cost + boost.tpGain, unused ^ (1 << i))) return true
			}
			return false
		}
		if (canCast(tp, mask) && tp - cost + tpGain > 0) combos.push({ cost, gain, tpGain })
	}
	const configs = !prune ? combos : combos.filter((v, i) => !combos.some((o, j) => j !== i && o.gain >= v.gain &&
		o.tpGain >= v.tpGain && o.cost <= v.cost && (o.gain > v.gain || o.tpGain > v.tpGain || o.cost < v.cost || j < i)))
	let best = 0
	for (const { cost, gain, tpGain } of configs) {
		const tpLeft = Math.floor(tp - cost + tpGain)
		const strength = enemy.strength + gain
		const found = []
		if (enemy.weapon) {
			const candidate = toCandidate(enemy.weapon, false, strength)
			if (candidate && candidate.cost <= tpLeft) found.push({ candidate, swap: 0 })
		}
		for (const other of enemy.otherWeapons ?? []) {
			if (found.length >= MAX_THREAT_WEAPONS) break
			if (other === enemy.weapon || (enemy.weapon && other.id === enemy.weapon.id)) continue
			const candidate = toCandidate(other, false, strength)
			if (candidate && candidate.cost + 1 <= tpLeft && !found.some((f) => f.candidate.item.id === other.id)) {
				found.push({ candidate, swap: 1 })
			}
		}
		const alone = (f) => {
			const shots = Math.min(Math.floor((tpLeft - f.swap) / f.candidate.cost), f.candidate.uses)
			return shots > 0 ? shots * f.candidate.damage : 0
		}
		const dominates = (a, b) => {
			const x = a.candidate.item
			const y = b.candidate.item
			return x.minRange <= y.minRange && x.maxRange >= y.maxRange && x.launchType === y.launchType &&
				(!x.needsLos || y.needsLos) && alone(a) >= alone(b)
		}
		const weapons = found.filter((f) => !found.some((g) => g !== f && dominates(g, f) &&
			(!dominates(f, g) || found.indexOf(g) < found.indexOf(f))))
		const chips = sortByRatio(enemy.chips.map((c) => toCandidate(c, true, strength)).filter((c) => c && c.cost <= tpLeft)).slice(0, maskCap)
		for (const from of enemy.reachable.cells()) {
			if (from.x === target.x && from.y === target.y) continue
			const hitting = weapons.filter((f) => { counter.n++; return provider.canHit(from, target, f.candidate.item) })
			const usable = chips.filter((c) => { counter.n++; return provider.canHit(from, target, c.item) })
			if (hitting.length === 0 && usable.length === 0) continue
			// Puces seules toujours essayées : un plan sans tir d'arme ne paie pas le changement d'arme.
			for (const f of hitting) best = Math.max(best, exactDamage(tpLeft - f.swap, [f.candidate, ...usable]))
			best = Math.max(best, exactDamage(tpLeft, usable))
		}
	}
	return best
}

function realizesBoostThreat(enemy, threat) {
	if (threat.boostTp === 0) {
		return threat.strengthGain === 0 && threat.tpGain === 0
	}
	const boosts = enemy.boosts ?? []
	const visit = (budget, used, cost, strength, tpGain) => {
		if (Math.abs(cost - threat.boostTp) < 1e-6 &&
			Math.abs(strength - threat.strengthGain) < 1e-6 &&
			Math.abs(tpGain - threat.tpGain) < 1e-6 && budget > 0) return true
		if (used.toString(2).replaceAll("0", "").length >= MAX_THREAT_BOOSTS) return false
		for (let i = 0; i < boosts.length; i++) {
			if (used & (1 << i)) continue
			const chip = boosts[i]
			const nextCost = cost + chip.cost
			const nextStrength = strength + strengthBoostOf(chip, enemy.science ?? 0)
			const nextTpGain = tpGain + tpBoostOf(chip, enemy.science ?? 0)
			if ((nextCost - threat.boostTp) > 1e-6 || nextStrength - threat.strengthGain > 1e-6 ||
				nextTpGain - threat.tpGain > 1e-6 || chip.cost > budget) continue
			if (visit(budget - chip.cost + tpBoostOf(chip, enemy.science ?? 0),
				used | (1 << i), nextCost, nextStrength, nextTpGain)) return true
		}
		return false
	}
	return visit(Math.floor(enemy.tp), 0, 0, 0, 0)
}

function randomScenario(seed) {
	const r = seeded(seed)
	const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1))
	const width = int(12, 20)
	const height = int(12, 20)
	const density = r() * 0.25
	const grid = makeGrid(width, height, () => r() < density)
	const free = grid.free()
	const pick = () => free.splice(int(0, free.length - 1), 1)[0]
	const me = grid.place(entity(1, 0), pick())
	const myMp = int(0, 4)
	const enemies = []
	const enemyCount = int(1, 3)
	for (let i = 0; i < enemyCount; i++) {
		const ent = grid.place(entity(2 + i, 0), pick())
		const weapons = Array.from({ length: int(0, 5) }, () => gun(r))
		const weapon = weapons.length > 0 && r() < 0.8 ? weapons[0] : null
		const tpBase = int(2, 14)
		enemies.push({
			ent,
			mp: r() < 0.2 ? 0 : int(1, 6),
			input: {
				id: ent.id, name: ent.name, strength: r() < 0.3 ? 0 : int(0, 300), tp: r() < 0.3 ? tpBase + r() * 0.99 : tpBase,
				weapon, otherWeapons: weapons.slice(weapon ? 1 : 0).concat(weapon && r() < 0.3 ? [weapon] : []),
				chips: Array.from({ length: int(0, 8) }, () => attackChip(r)),
				boosts: Array.from({ length: int(0, 4) }, () => boostOf(int(1, 5), int(20, 100), r() < 0.6 ? 6 : 38)),
				science: r() < 0.5 ? 0 : int(0, 200)
			}
		})
	}
	return { grid, me, myMp, enemies }
}

test("randomised equivalence (fixed seeds): the map equals a naive max over cells x weapons x boost subsets", () => {
	let cells = 0
	let positive = 0
	let boosted = 0
	let multiEnemy = 0
	let stationary = 0
	let reference = 0
	let actual = 0
	for (let seed = 1; seed <= 250; seed++) {
		const sc = randomScenario(seed)
		const inputs = sc.enemies.map((e) => ({ ...e.input, reachable: reach(e.ent, e.mp, sc.me.id) }))
		const myReach = reach(sc.me, sc.myMp)
		const counting = { n: 0 }
		const base = new GeometricShotCells()
		const map = buildThreatMap(sc.me, myReach, inputs, 1, {
			provider: { canHit: (a, b, c) => { counting.n++; return base.canHit(a, b, c) } }
		})
		assert.equal(map.truncated, false, `seed ${seed}`)
		assert.equal(map.size, myReach.size, `seed ${seed}`)
		actual += counting.n
		if (sc.enemies.length > 1) multiEnemy++
		if (sc.enemies.some((e) => e.mp === 0)) stationary++
		const naive = new GeometricShotCells()
		for (const mine of myReach.entries()) {
			cells++
			const ref = { n: 0 }
			let sum = 0
			const perEnemy = new Map()
			inputs.forEach((input) => {
				const best = naiveBest(input, mine.cell, naive, ref)
				if (best > 0) perEnemy.set(input.id, best)
				sum += best
			})
			reference += ref.n
			const where = `seed ${seed} cell ${mine.cell.x},${mine.cell.y}`
			assert.ok(Math.abs(map.dangerAt(mine.cell) - sum) < 1e-6, `${where}: ${map.dangerAt(mine.cell)} vs ${sum}`)
			const breakdown = map.breakdownAt(mine.cell)
			assert.deepEqual(breakdown.map((b) => b.enemyId).sort(), [...perEnemy.keys()].sort(), where)
			for (const threat of breakdown) {
				assert.ok(Math.abs(threat.damage - perEnemy.get(threat.enemyId)) < 1e-6, where)
				assert.equal(threat.boostTp > 0, threat.strengthGain > 0, where)
				if (threat.boostTp > 0) boosted++
			}
			if (sum > 0) positive++
		}
	}
	// Le jeu d'essai est réellement varié (sinon l'égalité ne prouverait rien).
	assert.ok(cells > 2000, `cells ${cells}`)
	assert.ok(positive > 1000, `positive ${positive}`)
	assert.ok(boosted > 50, `boosted ${boosted}`)
	assert.ok(multiEnemy > 50 && stationary > 50, `multi ${multiEnemy} stationary ${stationary}`)
	// Objectif de l'optimisation : nettement moins d'appels canHit que la référence naïve.
	assert.ok(actual < reference * 0.5, `canHit calls ${actual} vs naive ${reference}`)
})

test("without any boost the optimised map equals the naive one, shot cell and plan included", () => {
	for (let seed = 1000; seed < 1060; seed++) {
		const sc = randomScenario(seed)
		const inputs = sc.enemies.map((e) => ({ ...e.input, boosts: undefined, reachable: reach(e.ent, e.mp, sc.me.id) }))
		const myReach = reach(sc.me, sc.myMp)
		const map = buildThreatMap(sc.me, myReach, inputs, 1)
		for (const mine of myReach.entries()) {
			for (const threat of map.breakdownAt(mine.cell)) {
				assert.equal(threat.boostTp, 0)
				assert.equal(threat.strengthGain, 0)
				// Le plan annoncé est réalisable depuis la case de tir annoncée et rapporte exactement `damage`.
				const input = inputs.find((i) => i.id === threat.enemyId)
				const base = new GeometricShotCells()
				const usable = sortByRatio(input.chips.map((c) => toCandidate(c, true, input.strength))
					.filter((c) => c && c.cost <= input.tp && base.canHit(threat.shotCell, mine.cell, c.item)))
				const w = threat.weapon === null ? null : toCandidate(threat.weapon, false, input.strength)
				if (w !== null) assert.ok(base.canHit(threat.shotCell, mine.cell, threat.weapon))
				const replay = planShots(input.tp - threat.swapTp, w, usable)
				assert.ok(Math.abs(replay.damage - threat.damage) < 1e-6, `seed ${seed}`)
			}
		}
	}
})

// --- bornes de la clé du cache de plans ---------------------------------------------

test("bounds: 8 boost configurations x 4 weapons x 30 chips (key and 2^30 mask) still equal the naive result", () => {
	const grid = makeGrid(25, 25)
	const me = grid.place(entity(1, 0), grid.cells.get("12,12"))
	const enemyEntity = grid.place(entity(2, 0), grid.cells.get("9,12"))
	// costs 1, 2, 4 with gains proportional to cost: the 8 subsets are all non dominated.
	const boosts = [boostOf(1, 10), boostOf(2, 20), boostOf(4, 40)]
	// four weapons that never dominate each other (distinct launch types), each hitting something around.
	const weapons = [1, 2, 4, 5].map((launchType, i) => ({
		id: 5000 + i, name: "w", cost: 2 + i, minRange: 1, maxRange: 12, needsLos: false, launchType, maxUses: -1,
		features: [{ type: 1, minValue: 9 + i, maxValue: 11 + i }]
	}))
	const chips = Array.from({ length: 30 }, (_, i) => ({
		id: 6000 + i, name: "c", cost: 1 + (i % 3), minRange: 0, maxRange: 2 + (i % 12), needsLos: false, launchType: i % 2 === 0 ? 7 : 1 + (i % 7),
		cooldown: 0, features: [{ type: 1, minValue: 10 + i, maxValue: 14 + i }]
	}))
	const input = (reachableMp) => ({
		id: 2, name: "e2", strength: 20, tp: 30, weapon: weapons[0], otherWeapons: weapons.slice(1), chips, boosts,
		reachable: reach(enemyEntity, reachableMp, me.id)
	})
	const enemy = input(3)
	const myReach = computeReachableCells(me, 2, 1)
	const map = buildThreatMap(me, myReach, [enemy], 1)
	const naive = new GeometricShotCells()
	let multiple = 0
	for (const mine of myReach.entries()) {
		const expected = naiveBest(enemy, mine.cell, naive, { n: 0 })
		assert.ok(Math.abs(map.dangerAt(mine.cell) - expected) < 1e-6, `${mine.cell.x},${mine.cell.y}`)
		if (map.breakdownAt(mine.cell)[0]?.chips.length > 1) multiple++
	}
	assert.ok(multiple > 0)
})

test("bounds: more than 30 offensive chips and more than 4 weapons never throw and keep the best plan when extras are weak", () => {
	const grid = makeGrid(21, 21)
	const me = grid.place(entity(1, 0), grid.cells.get("10,10"))
	const foe = grid.place(entity(2, 0), grid.cells.get("7,10"))
	// 35 chips of cost 1 with strictly decreasing damage: with 12 PT the 12 best are taken (cooldown: one cast each).
	const chips = Array.from({ length: 35 }, (_, i) => ({
		id: 7000 + i, name: "c", cost: 1, minRange: 1, maxRange: 8, needsLos: false, cooldown: 1, features: [{ type: 1, minValue: 100 - i, maxValue: 100 - i }]
	}))
	const input = { id: 2, name: "e2", strength: 0, tp: 12, weapon: null, otherWeapons: [], chips, reachable: reach(foe, 0, me.id) }
	const map = buildThreatMap(me, computeReachableCells(me, 0, 1), [input], 1)
	let expected = 0
	for (let i = 0; i < 12; i++) expected += 100 - i
	assert.equal(map.dangerAt(me.cell), expected)
	assert.equal(map.breakdownAt(me.cell)[0].chips.length, 12)
})

// Le mémo par signature (somme des 2^i des items qui touchent) n'est exact que jusqu'à 52 items : au-delà, 2^i dépasse
// la précision des nombres à virgule flottante et deux ensembles différents partageraient une signature. Chaque
// configuration de boosts garde ses 30 meilleures puces abordables (MAX_MASK_CHIPS) ; deux paliers de PT donnent donc
// des ensembles différents (35 puces chères à fort ratio, 35 bon marché), soit plus de 52 items distincts pour l'ennemi.
// Mutation (garde MAX_SIGNATURE_ITEMS relevé à 1000) : ce test échoue (graine 14, danger 167.7 au lieu de 225).
test("more than 52 distinct items: no signature collision, the map still equals the naive max (30 best chips per configuration)", () => {
	let widest = 0
	for (let seed = 1; seed <= 40; seed++) {
		const r = seeded(seed * 7919)
		const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1))
		const density = r() * 0.25
		const grid = makeGrid(int(12, 20), int(12, 20), () => r() < density)
		const free = grid.free()
		const pick = () => free.splice(int(0, free.length - 1), 1)[0]
		const me = grid.place(entity(1, 0), pick())
		const foe = grid.place(entity(2, 0), pick())
		const chips = Array.from({ length: 70 }, (_, k) => {
			const base = attackChip(r)
			return k < 35
				? { ...base, cost: int(6, 8), minRange: 0, maxRange: 20, features: [{ type: 1, minValue: 60, maxValue: 90 }] }
				: { ...base, cost: int(1, 3), minRange: 0, maxRange: 20, features: [{ type: 1, minValue: 5, maxValue: 12 }] }
		})
		const weapons = Array.from({ length: 2 }, () => gun(r))
		const input = {
			id: 2, name: "e2", strength: 0, tp: 20, weapon: weapons[0], otherWeapons: weapons.slice(1), chips,
			boosts: [boostOf(15, 50), boostOf(10, 30)], reachable: reach(foe, int(1, 6), me.id)
		}
		const myReach = computeReachableCells(me, int(1, 4), 1)
		const seen = new Set()
		const base = new GeometricShotCells()
		const map = buildThreatMap(me, myReach, [input], 1, {
			provider: { canHit: (a, b, c) => { seen.add(c.id); return base.canHit(a, b, c) } }
		})
		widest = Math.max(widest, seen.size)
		const naive = new GeometricShotCells()
		for (const mine of myReach.entries()) {
			const expected = naiveBest(input, mine.cell, naive, { n: 0 }, { maskCap: 30 })
			assert.ok(Math.abs(map.dangerAt(mine.cell) - expected) < 1e-6,
				`seed ${seed} cell ${mine.cell.x},${mine.cell.y}: ${map.dangerAt(mine.cell)} vs ${expected}`)
		}
	}
	assert.ok(widest > 52, `only ${widest} distinct items examined: the guard is not exercised`)
})

// --- pré-rejet des cases X hors de portée : jamais une case atteignable par un tir -----

test("range pre-rejection is exact at the boundary: movement + max range reaches X, one more cell does not", () => {
	for (const [mp, maxRange] of [[0, 3], [1, 4], [3, 4], [5, 8]]) {
		const reachDistance = mp + maxRange
		const grid = makeGrid(40, 5)
		const enemyAt = grid.cells.get("2,2")
		const foe = grid.place(entity(2, mp), enemyAt)
		const farCell = grid.cells.get(`${2 + reachDistance + 1},2`)
		const nearCell = grid.cells.get(`${2 + reachDistance},2`)
		const me = grid.place(entity(1, 0), nearCell)
		const input = {
			id: 2, name: "e2", strength: 0, tp: 5, chips: [], otherWeapons: [],
			weapon: { id: 9, name: "w", cost: 5, minRange: 1, maxRange, needsLos: false, launchType: 1, features: [{ type: 1, minValue: 10, maxValue: 10 }] },
			reachable: reach(foe, mp, me.id)
		}
		const near = buildThreatMap(me, computeReachableCells(me, 0, 1), [input], 1)
		assert.equal(near.dangerAt(nearCell), 10, `mp ${mp} range ${maxRange}`)
		assert.equal(near.breakdownAt(nearCell)[0].shotCell.x, 2 + mp)
		// the same enemy against the cell one step farther: no damage, whatever the shortcut.
		const farMe = grid.place(entity(1, 0), farCell)
		const far = buildThreatMap(farMe, computeReachableCells(farMe, 0, 1), [input], 1)
		assert.equal(far.dangerAt(farCell), 0, `mp ${mp} range ${maxRange} far`)
	}
})

test("range pre-rejection: obstacles lengthen the enemy's path, the shortcut never admits what the BFS cannot reach", () => {
	// A wall in front of the enemy: the enemy cannot step forward, so its only shot cell is its own cell.
	const grid = makeGrid(12, 5, (x) => x === 4)
	const foe = grid.place(entity(2, 3), grid.cells.get("3,2"))
	const me = grid.place(entity(1, 0), grid.cells.get("9,2"))
	const input = {
		id: 2, name: "e2", strength: 0, tp: 5, chips: [], otherWeapons: [],
		weapon: { id: 9, name: "w", cost: 5, minRange: 1, maxRange: 3, needsLos: false, launchType: 7, features: [{ type: 1, minValue: 10, maxValue: 10 }] },
		reachable: reach(foe, 3, me.id)
	}
	const map = buildThreatMap(me, computeReachableCells(me, 0, 1), [input], 1)
	assert.equal(map.dangerAt(me.cell), 0)
})

// --- cache de lignes de vue partagé ------------------------------------------------------

test("shared sight cache: ordered pairs, no key collision, and cleared once MAX_SIGHT_CACHE entries are held", () => {
	const grid = makeGrid(40, 40)
	const seen = []
	// LoS asymmetric on purpose: (a, b) and (b, a) must be cached separately.
	globalThis.Field.lineOfSight = (from, to) => { seen.push(`${from.x},${from.y}>${to.x},${to.y}`); return from.x < to.x }
	const sight = new Map()
	const provider = new GeometricShotCells(sight)
	const sighted = { id: 1, name: "w", cost: 1, minRange: 1, maxRange: 80, needsLos: true, launchType: 7, features: [] }
	const a = grid.cells.get("3,4")
	const b = grid.cells.get("20,21")
	assert.equal(provider.canHit(a, b, sighted), true)
	assert.equal(provider.canHit(b, a, sighted), false)
	assert.equal(provider.canHit(a, b, sighted), true)
	assert.equal(provider.canHit(b, a, sighted), false)
	assert.deepEqual(seen, ["3,4>20,21", "20,21>3,4"])
	assert.equal(sight.size, 2)

	// every ordered pair of a 6 x 6 block gets its own entry (no collision between distinct pairs).
	const block = []
	for (let x = 10; x < 16; x++) for (let y = 10; y < 16; y++) block.push(grid.cells.get(`${x},${y}`))
	const fresh = new Map()
	const pairs = new GeometricShotCells(fresh)
	let expectedPairs = 0
	for (const from of block) for (const to of block) if (from !== to) { pairs.canHit(from, to, sighted); expectedPairs++ }
	assert.equal(fresh.size, expectedPairs)
	assert.equal(pairs.lineOfSightCalls, expectedPairs)

	// cap: a cache already at the limit is emptied before the new entry is stored.
	const full = new Map()
	for (let i = 0; i < MAX_SIGHT_CACHE; i++) full.set(-1 - i, true)
	const capped = new GeometricShotCells(full)
	assert.equal(capped.canHit(a, b, sighted), true)
	assert.equal(full.size, 1)
	assert.equal(capped.canHit(a, b, sighted), true)
	assert.equal(capped.lineOfSightCalls, 1)
	assert.ok(full.size <= MAX_SIGHT_CACHE)
	assert.equal(MAX_SIGHT_CACHE, 20000)
	// and the cache never grows past the limit however many pairs are asked.
	const stream = new Map()
	const flow = new GeometricShotCells(stream)
	let peak = 0
	for (let i = 0; i < 3 * MAX_SIGHT_CACHE; i++) {
		const from = grid.cells.get(`${i % 40},${Math.floor(i / 40) % 40}`)
		const to = grid.cells.get(`${(i * 7 + 3) % 40},${(i * 13 + 5) % 40}`)
		if (from !== to) flow.canHit(from, to, sighted)
		peak = Math.max(peak, stream.size)
	}
	assert.ok(peak <= MAX_SIGHT_CACHE, `peak ${peak}`)
})

// --- boosts : seuils (juste en dessous / au-dessus) -----------------------------------------

function boostScenario({ tp, boosts, weaponCost = 1, weaponDamage = 10 }) {
	const grid = makeGrid(21, 21)
	const me = grid.place(entity(1, 0), grid.cells.get("10,10"))
	const foe = grid.place(entity(2, 0), grid.cells.get("7,10"))
	const input = {
		id: 2, name: "e2", strength: 0, tp, chips: [], otherWeapons: [], boosts,
		weapon: { id: 3, name: "w", cost: weaponCost, minRange: 1, maxRange: 8, needsLos: false, launchType: 7, features: [{ type: 1, minValue: weaponDamage, maxValue: weaponDamage }] },
		reachable: reach(foe, 0, me.id)
	}
	const map = buildThreatMap(me, computeReachableCells(me, 0, 1), [input], 1)
	return { threat: map.breakdownAt(me.cell)[0], danger: map.dangerAt(me.cell) }
}

const fourBoosts = [1, 2, 3, 4].map((i) => boostOf(1, 100, 6, 8800 + i))

// [label, tp, boosts, expected danger, expected boostTp, expected strengthGain (undefined = not checked)]
const boostThresholdCases = [
	["cost = TP - 1 is castable (1 PT left: 1 shot of 10 x (1 + 1000/100))", 10, [boostOf(9, 1000)], 110, 9],
	["cost = TP is not castable", 10, [boostOf(10, 1000)], 100, 0],
	["payoff tie (5 shots x 20 = 10 shots x 10): not cast", 10, [boostOf(5, 100)], 100, 0, 0],
	["payoff: one more point of strength is cast", 10, [boostOf(5, 101)], 100.5, 5],
	["payoff: one point of strength fewer is not cast", 10, [boostOf(5, 99)], 100, 0],
	["MAX_THREAT_BOOSTS: the fourth of 4 boosts is ignored (17 shots x 4, not 16 x 5)", 20, fourBoosts, 680, 3, 300],
	["MAX_THREAT_BOOSTS: exactly 3 boosts", 20, fourBoosts.slice(0, 3), 680, 3],
	["MAX_THREAT_BOOSTS: 2 boosts", 20, fourBoosts.slice(0, 2), 540, 2]
]

test("MAX_THREAT_BOOSTS is 3", () => {
	assert.equal(MAX_THREAT_BOOSTS, 3)
})

for (const [label, tp, boosts, danger, boostTp, strengthGain] of boostThresholdCases) {
	test(`boost thresholds: ${label}`, () => {
		const result = boostScenario({ tp, boosts })
		assert.ok(Math.abs(result.danger - danger) < 1e-9, `danger ${result.danger} != ${danger}`)
		assert.equal(result.threat.boostTp, boostTp)
		if (strengthGain !== undefined) assert.equal(result.threat.strengthGain, strengthGain)
	})
}

test("science amplifies BUFF_STRENGTH boosts but not the raw boost, at the threshold of the payoff", () => {
	const grid = makeGrid(21, 21)
	const me = grid.place(entity(1, 0), grid.cells.get("10,10"))
	const foe = grid.place(entity(2, 0), grid.cells.get("7,10"))
	const make = (type, science) => buildThreatMap(me, computeReachableCells(me, 0, 1), [{
		id: 2, name: "e2", strength: 0, tp: 10, chips: [], otherWeapons: [], boosts: [boostOf(5, 51, type)], science,
		weapon: { id: 3, name: "w", cost: 1, minRange: 1, maxRange: 8, needsLos: false, launchType: 7, features: [{ type: 1, minValue: 10, maxValue: 10 }] },
		reachable: reach(foe, 0, me.id)
	}], 1).breakdownAt(me.cell)[0].boostTp
	assert.equal(make(6, 100), 5) // 51 x 2 = 102 : pays (5 shots x 20.4)
	assert.equal(make(6, 0), 0) // 51: 5 x 15.1 = 75.5 < 100
	assert.equal(make(38, 100), 0) // raw: 51 only
	assert.equal(make(38, 0), 0)
})

// --- boosts de PT : équivalence avec l'énumération complète ----------------------------------------------

test("randomised equivalence with TP boosts (fixed seeds): the map equals the naive max over ALL boost subsets", () => {
	globalThis.Effect.BUFF_TP = 8 // BUFF_TP (amplifié par la science) en plus du brut (32)
	try {
		let cells = 0
		let tpBoosted = 0
		let mixed = 0
		let positive = 0
		for (let seed = 4000; seed < 4200; seed++) {
			const sc = randomScenario(seed)
			const r = seeded(seed ^ 0x7a11)
			const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1))
			const inputs = sc.enemies.map((e) => {
				const tpBoosts = Array.from({ length: int(1, 2) }, () => boostOf(int(1, 7), int(1, 9), r() < 0.5 ? 8 : 32))
				return { ...e.input, boosts: [...tpBoosts, ...(e.input.boosts ?? [])], reachable: reach(e.ent, e.mp, sc.me.id) }
			})
			const myReach = reach(sc.me, sc.myMp)
			const map = buildThreatMap(sc.me, myReach, inputs, 1)
			assert.equal(map.truncated, false, `seed ${seed}`)
			const naive = new GeometricShotCells()
			for (const mine of myReach.entries()) {
				cells++
				let sum = 0
				let sumUnpruned = 0
				const perEnemy = new Map()
				for (const input of inputs) {
					const pruned = naiveBest(input, mine.cell, naive, { n: 0 })
					const full = naiveBest(input, mine.cell, naive, { n: 0 }, { prune: false })
					assert.ok(Math.abs(pruned - full) < 1e-6, `seed ${seed}: dominance changed the maximum`)
					if (full > 0) perEnemy.set(input.id, full)
					sum += pruned
					sumUnpruned += full
				}
				const where = `seed ${seed} cell ${mine.cell.x},${mine.cell.y}`
				assert.ok(Math.abs(map.dangerAt(mine.cell) - sumUnpruned) < 1e-6, `${where}: ${map.dangerAt(mine.cell)} vs ${sumUnpruned}`)
				for (const threat of map.breakdownAt(mine.cell)) {
					assert.ok(Math.abs(threat.damage - perEnemy.get(threat.enemyId)) < 1e-6, where)
					assert.equal(threat.boostTp > 0, threat.strengthGain > 0 || threat.tpGain > 0, where)
					const input = inputs.find((i) => i.id === threat.enemyId)
					assert.ok(realizesBoostThreat(input, threat),
						`${where}: boost costs ${threat.boostTp} PT but is not a feasible cast sequence`)
					if (threat.tpGain > 0) tpBoosted++
					if (threat.tpGain > 0 && threat.strengthGain > 0) mixed++
				}
				if (sum > 0) positive++
			}
		}
		assert.ok(cells > 800, `cells ${cells}`)
		assert.ok(positive > 400, `positive ${positive}`)
		assert.ok(tpBoosted > 30, `tpBoosted ${tpBoosted}`)
		assert.ok(mixed > 5, `mixed ${mixed}`)
	} finally {
		delete globalThis.Effect.BUFF_TP
	}
})

// --- EnemyMemory : ennemi « armé » ou non ---------------------------------------------------------

function memoryScenario({ weapon = null, chips = [], tp = 10 } = {}) {
	const grid = makeGrid(21, 21)
	const memory = new EnemyMemory()
	const me = grid.place(entity(1, 0), grid.cells.get("10,10"))
	const enemy = grid.place(entity(2, 0, { weapon, weapons: weapon === null ? [] : [weapon], chips, tp }), grid.cells.get("7,10"))
	memory.identify(enemy, 1)
	memory.update(enemy, me, 1, 1)
	return { grid, memory, me, enemy }
}

test("EnemyMemory: an enemy without equipped weapon whose only chip is a strength boost is not armed", () => {
	const scenario = memoryScenario({ chips: [boostOf(3, 100)] })
	let cellCalls = 0
	const original = globalThis.Field.cellFromXY
	globalThis.Field.cellFromXY = (x, y) => { cellCalls++; return original(x, y) }
	scenario.memory.updateReachable(scenario.me, [], [scenario.enemy], 1)
	const before = cellCalls
	const update = scenario.memory.updateThreatMap(scenario.me, [scenario.enemy], 1)
	assert.equal(cellCalls, before) // no BFS for this enemy
	assert.equal(update.maxDanger, 0)
	assert.equal(update.enemies, 0)
	assert.equal(scenario.memory.getThreatMap().dangerAt(scenario.me.cell), 0)
})

test("EnemyMemory: the same boost chip raises the danger only once the enemy has something to shoot with", () => {
	const protein = boostOf(3, 100)
	const shooter = { id: 31, name: "w", cost: 3, minRange: 1, maxRange: 8, needsLos: false, features: [{ type: 1, minValue: 10, maxValue: 10 }] }
	const armed = memoryScenario({ weapon: shooter, chips: [protein] })
	armed.memory.updateReachable(armed.me, [], [armed.enemy], 1)
	armed.memory.updateThreatMap(armed.me, [armed.enemy], 1)
	assert.equal(armed.memory.getThreatMap().dangerAt(armed.me.cell), 40) // 7 PT: 2 shots x 20 > 3 shots x 10
	const plain = memoryScenario({ weapon: shooter })
	plain.memory.updateReachable(plain.me, [], [plain.enemy], 1)
	plain.memory.updateThreatMap(plain.me, [plain.enemy], 1)
	assert.equal(plain.memory.getThreatMap().dangerAt(plain.me.cell), 30)
})

test("EnemyMemory keeps the sight cache for the whole fight, bounded by MAX_SIGHT_CACHE", () => {
	const sighted = { id: 32, name: "w", cost: 3, minRange: 1, maxRange: 8, needsLos: true, features: [{ type: 1, minValue: 10, maxValue: 10 }] }
	const scenario = memoryScenario({ weapon: sighted })
	scenario.enemy.mp = 2
	scenario.memory.update(scenario.enemy, scenario.me, 1, 1)
	scenario.memory.updateReachable(scenario.me, [], [scenario.enemy], 1)
	scenario.memory.updateThreatMap(scenario.me, [scenario.enemy], 1)
	const first = scenario.grid.stats.lineOfSight
	assert.ok(first > 0)
	for (let turn = 2; turn < 6; turn++) {
		scenario.memory.updateReachable(scenario.me, [], [scenario.enemy], turn)
		const update = scenario.memory.updateThreatMap(scenario.me, [scenario.enemy], turn)
		assert.equal(update.lineOfSightCalls, 0)
	}
	assert.equal(scenario.grid.stats.lineOfSight, first)
})
