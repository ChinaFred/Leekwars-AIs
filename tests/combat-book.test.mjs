import assert from "node:assert/strict"
import test from "node:test"

globalThis.Effect = { DAMAGE: 1, HEAL: 2 }
const { CombatBook, ANY, NONE, SHAPE, bookItemOf, boostFactor, boostedStats, shapeOf } =
	await import("../dist/Classes/Plannification/CombatBook.js")
const { attacks, attackChoices } = await import("../dist/Classes/Plannification/TacticalScore.js")
const { toCandidate } = await import("../dist/Classes/Context/ShotPlan.js")

const item = (isWeapon, hits, cost, minRange, maxRange, extra = {}) =>
	({ isWeapon, hits, cost, minRange, maxRange, needsLos: true, uses: Infinity, stat: "strength", ...extra })
const STATS = { strength: 0, magic: 0 }
const read = (book, q, stats = STATS) => book.read(stats, { los: true, shape: SHAPE.LINE, held: -1, mask: book.maskOf(() => true), ...q })

test("chip of range 4 and weapon of range 6, with and without line of sight", () => {
	const book = new CombatBook([
		item(true, [20], 4, 1, 6, { uses: 2 }), // 0 : arme, a besoin de la ligne de vue
		item(false, [10], 3, 1, 4, { needsLos: false, uses: 1 }) // 1 : puce, sans ligne de vue
	], 10)
	// Distance 3 avec LdV : arme x2 (8 PT, 40) ou arme + puce (7 PT, 30) ; le meilleur : arme x2 puis pas de PT pour la puce.
	assert.deepEqual([...read(book, { distance: 3, tp: 10 }).items], [0, 0], "10 PT : arme x2 (9 PT, 40) bat arme + puce (8 PT, 30)")
	const both = read(book, { distance: 3, tp: 8 })
	assert.deepEqual([...both.items].sort(), [0, 1], "8 PT : une arme (4) + la puce (3)")
	assert.equal(both.tp, 8, "PT exacts, arme non tenue : 4 + 3 + 1 de changement d'arme")
	assert.equal(both.minRange, 1); assert.equal(both.maxRange, 4, "portée utile = intersection")
	assert.equal(both.needsLos, true)
	// Distance 5 : la puce (portée 4) est hors portée, l'arme seule.
	assert.deepEqual([...read(book, { distance: 5, tp: 10 }).items], [0, 0])
	// Distance 3 sans LdV : l'arme est exclue, il reste la puce.
	const blind = read(book, { distance: 3, los: false, tp: 10 })
	assert.deepEqual([...blind.items], [1])
	assert.equal(blind.needsLos, false)
	// Distance 7 : rien.
	assert.equal(read(book, { distance: 7, tp: 10 }).items.length, 0)
	// Arme en main : plus de PT de changement.
	assert.equal(read(book, { distance: 3, tp: 7, held: 0 }).tp, 7, "7 PT suffisent avec l'arme en main")
	// Arme imposée : puces seules (NONE) ou l'arme.
	assert.deepEqual([...read(book, { distance: 3, tp: 10, weapon: NONE }).items], [1])
	assert.equal(read(book, { distance: 3, tp: 3, weapon: 0, held: 0 }).items.length, 0, "3 PT : l'arme coûte 4")
})

test("launch pattern: a diagonal-only weapon needs a diagonal shot", () => {
	const book = new CombatBook([item(true, [20], 4, 1, 8, { launchType: 2, needsLos: false })], 8)
	assert.equal(read(book, { distance: 4, tp: 8, held: 0, shape: shapeOf(2, 2) }).items.length, 2)
	assert.equal(read(book, { distance: 4, tp: 8, shape: shapeOf(4, 0) }).items.length, 0)
	assert.equal(read(book, { distance: 3, tp: 8, shape: shapeOf(2, 1) }).items.length, 0)
})

test("cooldown: a chip that is not available is excluded", () => {
	const book = new CombatBook([item(false, [30], 3, 0, 5, { uses: 1 }), item(false, [5], 3, 0, 5, { uses: 1 })], 6)
	assert.deepEqual([...read(book, { distance: 2, tp: 3 }).items], [0])
	const mask = book.maskOf((_, i) => i !== 0)
	assert.deepEqual([...read(book, { distance: 2, tp: 3, mask }).items], [1])
	assert.equal(read(book, { distance: 2, tp: 6, mask }).items.length, 1, "la puce bloquée n'est pas remplacée")
})

test("strength boost: same ranking, table untouched, factor (1 + (s+b)/100) / (1 + s/100)", () => {
	const book = new CombatBook([item(true, [30], 5, 1, 6, { uses: 2 }), item(false, [20], 3, 1, 6, { uses: 1 })], 10)
	const stats = { strength: 20, magic: 0 }
	const query = { distance: 3, los: true, shape: SHAPE.LINE, tp: 10, mask: book.maskOf(() => true), held: 0 }
	const boosts = [{ stat: "strength", value: 97, turns: 1 }]
	const plain = book.read(stats, query)
	const boosted = book.readBoosted(stats, boosts, query)
	const factor = (1 + 117 / 100) / (1 + 20 / 100)
	assert.equal(boostFactor(20, 97), factor)
	assert.equal(boosted.rebuilt, false)
	assert.equal(boosted.combo, plain, "la table actuelle est relue telle quelle")
	assert.ok(Math.abs(boosted.raw.strength - plain.raw.strength * factor) < 1e-9)
	// Même résultat qu'une table construite à la force boostée.
	const virtual = book.read({ strength: 117, magic: 0 }, query)
	assert.deepEqual([...virtual.items], [...plain.items])
	assert.ok(Math.abs(virtual.raw.strength - boosted.raw.strength) < 1e-9)
	// Tours restants : un boost d'un tour n'agit plus au tour suivant.
	assert.equal(boostedStats(stats, boosts, 1).strength, 20)
	assert.equal(boostedStats(stats, [{ stat: "strength", value: 97, turns: 2 }], 1).strength, 117)
	assert.equal(book.readBoosted(stats, boosts, query, 1).raw.strength, plain.raw.strength)
})

test("boost that reclassifies items of different statistics rebuilds the table for the virtual stats", () => {
	const book = new CombatBook([
		item(true, [40], 5, 1, 6, { uses: 1 }), // force
		item(false, [55], 5, 1, 6, { uses: 1, stat: "fixed" }) // dégâts fixes
	], 5)
	const query = { distance: 3, los: true, shape: SHAPE.LINE, tp: 5, mask: book.maskOf(() => true), held: 0 }
	assert.deepEqual([...book.read(STATS, query).items], [1], "sans boost : la puce fixe (55 > 40)")
	const boosts = [{ stat: "strength", value: 100, turns: 1 }]
	const result = book.readBoosted(STATS, boosts, query)
	assert.equal(result.rebuilt, true)
	assert.deepEqual([...result.combo.items], [0], "force +100 : l'arme (80 > 55)")
	assert.equal(result.raw.strength, 80)
	const naive = book.read(STATS, query).raw
	assert.equal(naive.fixed, 55, "le facteur seul aurait gardé la puce fixe : mauvais classement")
	assert.equal(book.at({ strength: 100, magic: 0 }), book.at({ strength: 100, magic: 0 }), "table mémoïsée par statistiques")
	assert.notEqual(book.at(STATS), book.at({ strength: 100, magic: 0 }))
})

test("invalidation key changes with items and maximum PT", () => {
	const a = [item(true, [20], 4, 1, 6)]
	assert.equal(CombatBook.keyOf(a, 10), new CombatBook(a, 10).key)
	assert.notEqual(CombatBook.keyOf(a, 10), CombatBook.keyOf(a, 15))
	assert.notEqual(CombatBook.keyOf(a, 10), CombatBook.keyOf([item(true, [20], 4, 1, 7)], 10))
})

test("game items: damage features only, same exclusions as toCandidate", () => {
	const feature = (type, min, max) => ({ type, minValue: min, maxValue: max, turns: 0, targets: 31, modifiers: 0 })
	const shotgun = { id: 41, name: "shotgun", cost: 5, minRange: 1, maxRange: 5, needsLos: true, launchType: 1, maxUses: 2,
		features: [feature(1, 33, 43), feature(27, 25, 25)] }
	const bought = bookItemOf(shotgun, false)
	assert.deepEqual(bought.hits, [38]); assert.equal(bought.uses, 2); assert.equal(bought.isWeapon, true)
	const cure = { id: 4, name: "cure", cost: 4, cooldown: 2, currentCooldown: 0, minRange: 0, maxRange: 5, needsLos: true, features: [feature(2, 38, 46)] }
	assert.equal(bookItemOf(cure, true), null, "aucune feature de dégâts")
	const spark = { id: 18, name: "spark", cost: 3, cooldown: 0, currentCooldown: 0, minRange: 0, maxRange: 10, needsLos: false, maxUses: -1, features: [feature(1, 8, 16)] }
	assert.equal(bookItemOf(spark, true).uses, Infinity, "sans cooldown de base : relançable")
	assert.equal(bookItemOf({ ...spark, cooldown: 2 }, true).uses, 1)
	assert.equal(bookItemOf({ ...spark, maxUses: 0 }, true), null)
	assert.equal(toCandidate(spark, true, 0) !== null, true)
})

test("shields: net per hit with a floor at 0, ranking on the net, boosts with an absolute shield rebuild", () => {
	const book = new CombatBook([
		item(false, [12], 3, 0, 6, { uses: 3, needsLos: false }), // spark : 12 par coup
		item(false, [38], 5, 0, 6, { uses: 1, needsLos: false }) // rock
	], 9)
	const query = { distance: 2, los: true, shape: SHAPE.LINE, tp: 9, mask: book.maskOf(() => true), held: -1 }
	const bare = book.read(STATS, query)
	assert.deepEqual([...bare.items].sort(), [0, 1]); assert.equal(bare.total, 50, "sans bouclier : rock + spark")
	const shield = { relative: 0, absolute: 15 }
	const shielded = book.read(STATS, query, shield)
	assert.deepEqual([...shielded.items], [1], "spark (12 < 15) vaut 0 net : seul rock compte")
	assert.equal(shielded.total, 23, "38 - 15 par coup, plancher à 0 pour spark")
	assert.equal(shielded.raw.strength, 38, "le brut reste disponible")
	assert.equal(book.read(STATS, query, { relative: 50, absolute: 0 }).total, bare.total / 2)
	const boosted = book.readBoosted(STATS, [{ stat: "strength", value: 100, turns: 1 }], query, 0, shield)
	assert.equal(boosted.rebuilt, true, "net non proportionnel avec un bouclier absolu")
	assert.equal(boosted.net, 70, "rock 76 - 15 + spark 24 - 15")
	assert.deepEqual([...boosted.combo.items].sort(), [0, 1])
})

// --- cohérence avec une énumération exhaustive (oracle de test uniquement, jamais dans la table) -------------------

function rng(seed) {
	let s = seed >>> 0
	return () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), s | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

function bruteBest(items, usable, held, tp, weapon, stats) {
	const dmg = (it) => it.hits.reduce((a, b) => a + b, 0) * (it.stat === "strength" ? 1 + stats.strength / 100 : 1)
	const weapons = items.map((it, i) => i).filter((i) => items[i].isWeapon && (usable >> i & 1))
	const chips = items.map((it, i) => i).filter((i) => !items[i].isWeapon && (usable >> i & 1))
	let best = 0
	if (weapon >= 0 && !(usable >> weapon & 1)) return 0
	// ANY : puces seules, une arme, ou deux armes différentes (au moins un tir de chacune ; l'arme en main d'abord, 1 PT par changement).
	const options = weapon === ANY ? [[], ...weapons.map((w) => [w]), ...weapons.flatMap((a, i) => weapons.slice(i + 1).map((b) => [a, b]))] : [weapon === NONE ? [] : [weapon]]
	for (const option of options) {
		const sizes = (k, left, total) => {
			if (k === option.length) {
				const walk = (c, rest, sum) => {
					if (c === chips.length) { best = Math.max(best, sum); return }
					const it = items[chips[c]]
					for (let n = 0; n <= Math.min(it.uses, Math.floor(rest / it.cost)); n++) walk(c + 1, rest - n * it.cost, sum + n * dmg(it))
				}
				walk(0, left, total)
				return
			}
			const w = items[option[k]]
			const equip = option[k] === held ? 0 : 1
			for (let shots = 1; shots <= Math.min(w.uses, Math.floor((left - equip) / w.cost)); shots++) sizes(k + 1, left - equip - shots * w.cost, total + shots * dmg(w))
		}
		sizes(0, tp, 0)
	}
	return best
}

test("table is the exact optimum of an exhaustive enumeration, on random item sets", () => {
	const random = rng(12345)
	let checked = 0
	for (let round = 0; round < 40; round++) {
		const items = []
		const weaponCount = 1 + Math.floor(random() * 3), chipCount = 1 + Math.floor(random() * 4)
		for (let i = 0; i < weaponCount + chipCount; i++) items.push(item(i < weaponCount, [5 + Math.floor(random() * 40)],
			2 + Math.floor(random() * 5), Math.floor(random() * 3), 3 + Math.floor(random() * 6), {
				uses: i < weaponCount ? 1 + Math.floor(random() * 3) : (random() < 0.5 ? 1 : 3), needsLos: random() < 0.5,
				stat: random() < 0.3 ? "fixed" : "strength" }))
		const book = new CombatBook(items, 12)
		const stats = { strength: Math.floor(random() * 200), magic: 0 }
		for (let n = 0; n < 15; n++) {
			const distance = Math.floor(random() * 10), los = random() < 0.5, tp = Math.floor(random() * 13)
			const held = Math.floor(random() * (weaponCount + 1)) - 1, weapon = [ANY, NONE, 0][Math.floor(random() * 3)]
			const mask = book.maskOf(() => random() < 0.7)
			const combo = book.read(stats, { distance, los, shape: SHAPE.LINE, tp, mask, held, weapon })
			const usable = book.usableAt(distance, los, SHAPE.LINE) & mask
			assert.ok(Math.abs(combo.total - bruteBest(items, usable, held, tp, weapon, stats)) < 1e-6,
				`round ${round} d${distance} los${los} tp${tp} held${held} weapon${weapon}`)
			assert.ok(combo.tp <= tp)
			if (combo.items.length) {
				assert.ok(combo.minRange <= distance && distance <= combo.maxRange, "le combo est utilisable à cette distance")
				assert.ok(los || !combo.needsLos)
			}
			checked++
		}
	}
	assert.equal(checked, 600)
})

// --- coût --------------------------------------------------------------------------------------------------------

// Items de Kassbi (combats archivés 54969530…) : neutrino, shotgun ; puces rock, spark.
const KASSBI = [
	item(true, [27.5], 4, 2, 6, { launchType: 2, uses: 3 }), item(true, [38], 5, 1, 5, { launchType: 1, uses: 2 }),
	item(false, [38.5], 5, 2, 6, { launchType: 7, uses: 1 }), item(false, [12], 3, 0, 10, { launchType: 7, needsLos: false })
]
// Boîte à outils large : 4 armes et 8 puces offensives (les bornes de `TACTICAL_LIMITS`).
const WIDE = [
	...[[25, 4, 1, 6, 3], [38, 5, 1, 5, 2], [20, 3, 1, 8, 4], [45, 6, 2, 7, 2]].map(([d, c, a, b, u], i) => item(true, [d], c, a, b, { uses: u, launchType: [1, 3, 7, 2][i] })),
	...[[38, 5, 2, 6, 1], [12, 3, 0, 10, Infinity], [20, 4, 1, 7, 1], [30, 5, 1, 8, 1], [9, 2, 0, 5, 2], [55, 7, 2, 7, 1], [18, 3, 1, 6, 1], [26, 4, 0, 9, 1]]
		.map(([d, c, a, b, u]) => item(false, [d], c, a, b, { uses: u, needsLos: c % 2 === 0 }))
]

function wholeBookWork(items, maxTp) {
	const book = new CombatBook(items, maxTp)
	const built = book.work
	const mask = book.maskOf(() => true)
	for (let distance = 0; distance <= book.maxDistance; distance++) for (const los of [true, false]) for (let shape = 0; shape < 3; shape++) {
		book.at(STATS).read({ distance, los, shape, tp: maxTp, mask, held: 0 })
	}
	const all = book.work
	// Une seconde passe complète ne coûte rien de plus : tout est mémoïsé.
	for (let distance = 0; distance <= book.maxDistance; distance++) for (const los of [true, false]) for (let shape = 0; shape < 3; shape++) {
		book.at(STATS).read({ distance, los, shape, tp: maxTp, mask, held: 0 })
	}
	assert.equal(book.work, all)
	return { classes: built, total: all, tables: all - built }
}

test("cost: work units of construction, table build and read (counted iterations, not game operations)", (t) => {
	const lines = []
	for (const [name, items] of [["Kassbi", KASSBI], ["4 weapons + 8 chips", WIDE]]) {
		for (const maxTp of [10, 15, 20, 30]) {
			const w = wholeBookWork(items, maxTp)
			lines.push(`${name} maxTp ${maxTp}: classes ${w.classes}, all tables (every class, full mask, held 0) ${w.total - w.classes}, total ${w.total}`)
		}
	}
	// Une lecture sur table construite : aucune unité de travail comptée (index + 2 Map.get).
	const book = new CombatBook(KASSBI, 10)
	const query = { distance: 4, los: true, shape: SHAPE.DIAGONAL, tp: 10, mask: book.maskOf(() => true), held: 1 }
	book.read(STATS, query)
	const before = book.work
	for (let i = 0; i < 100; i++) book.read(STATS, query)
	assert.equal(book.work, before, "lecture mémoïsée : 0 unité de travail")
	// Même unité côté code actuel : un tick de `Budget` par itération, pour une case de tir (attacks + attackChoices).
	let ticks = 0
	const budget = { tick() { ticks++ } }
	const target = { life: 300, relativeShield: 0, absoluteShield: 0 }
	const candidate = (it, isChip) => ({ item: { features: [{ type: 1, minValue: it.hits[0], maxValue: it.hits[0] }], cost: it.cost, cooldown: 0 },
		isChip, damage: it.hits[0], cost: it.cost, uses: it.uses, ratio: 0 })
	const chips = KASSBI.slice(2).map((it) => candidate(it, true))
	attackChoices(attacks(10, candidate(KASSBI[1], false), chips, target, budget), target, true, budget)
	lines.push(`current planner, one shot cell, one weapon option, 10 PT: ${ticks} ticks (the planner caches by (target, weapon, chip mask), not by cell)`)
	t.diagnostic(lines.join("\n"))
	// Bornes larges : détecter une dérive d'ordre de grandeur, pas une valeur exacte.
	assert.ok(wholeBookWork(KASSBI, 10).total < 20000)
	assert.ok(wholeBookWork(WIDE, 30).total < 500000)
})

test("weapon combo is kept when a chip-only state costs the same (known gap of the current attacks() with weaponRequired)", () => {
	const book = new CombatBook([item(true, [10], 4, 0, 5, { uses: 2, needsLos: false }), item(false, [30], 4, 0, 5, { uses: 1, needsLos: false })], 8)
	const combo = read(book, { distance: 2, tp: 4, held: 0, weapon: 0 })
	assert.deepEqual([...combo.items], [0], "le tir d'arme seul existe à 4 PT ; l'ancien calcul rend `undefined` à ce coût")
})
