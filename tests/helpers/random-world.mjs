// Monde aléatoire déterministe (graine) pour comparer des décisions du plan conjoint, puis les exécuter de bout en bout
// (plan conjoint, sinon plan B). Écrit par le testeur pour la campagne du filtre « recul sans dégâts » ; `load(dir)` charge
// le dist d'un dossier donné (ancien ou nouveau build). Ne pas modifier `spec` : les graines des tests en dépendent.
export const EFFECT = { DAMAGE: 1, HEAL: 2, BUFF_STRENGTH: 3, BUFF_AGILITY: 4, RELATIVE_SHIELD: 5,
	ABSOLUTE_SHIELD: 6, BUFF_MP: 7, BUFF_TP: 8, DEBUFF: 9, POISON: 13, RAW_BUFF_TP: 32, RAW_BUFF_STRENGTH: 38 }

export function rng(seed) {
	let a = seed >>> 0
	return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }
}

export async function load(dir) {
	const P = await import(dir + "/dist/Classes/Plannification/TacticalPlanner.js")
	const R = await import(dir + "/dist/Classes/Context/ReachableCells.js")
	const T = await import(dir + "/dist/Classes/Context/ThreatMap.js")
	const L = await import(dir + "/dist/Classes/LeekProfile.js")
	const S = await import(dir + "/dist/Classes/Context/StagnationTracker.js")
	const G = await import(dir + "/dist/Toolbox/Logger.js")
	const V = await import(dir + "/dist/Classes/Plannification/ReservePlan.js")
	// Build d'avant le découpage du planificateur (`DIST_ROOT`) : `executeTacticalPlan` vient encore de TacticalPlanner.js.
	const executeTacticalPlan = P.executeTacticalPlan ??
		(await import(dir + "/dist/Classes/Plannification/TacticalExecution.js")).executeTacticalPlan
	return { ...P, ...R, ...T, ...L, ...S, ...G, executeTacticalPlan, executeReservePlan: V.executeReservePlan }
}

const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)

/** Spécification aléatoire (pure donnée) : mêmes valeurs pour l'ancien et le nouveau. `force` écrase des champs. */
export function spec(seed, force = {}) {
	const r = rng(seed)
	const pick = (list) => list[Math.floor(r() * list.length)]
	const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1))
	const size = int(6, 10)
	const obstacleRate = pick([0, 0.05, 0.1, 0.18])
	const obstacles = []
	for (let x = -size; x <= size; x++) for (let y = -size; y <= size; y++) if ((x || y) && r() < obstacleRate) obstacles.push([x, y])
	const maxLife = int(250, 500)
	const lifeMode = r()
	const life = Math.max(1, Math.round(maxLife * (lifeMode < 0.4 ? 1 : lifeMode < 0.55 ? pick([0.24, 0.25, 0.26, 0.49, 0.5, 0.51]) : 0.05 + 0.95 * r())))
	const enemyCount = r() < 0.8 ? 1 : 2
	const enemies = []
	for (let i = 0; i < enemyCount; i++) {
		const d = pick([1, 2, 3, 5, 7, 9, 10, 11, 12, 14, 16])
		const ex = int(-Math.min(d, size), Math.min(d, size))
		const rest = d - Math.abs(ex)
		const ey = Math.max(-size, Math.min(size, r() < 0.5 ? rest : -rest))
		enemies.push({ x: ex, y: ey, life: pick([40, 120, 175, 335, 600]), absoluteShield: pick([0, 0, 0, 15, 40, 200]),
			relativeShield: pick([0, 0, 0, 20]), mp: int(3, 6), range: int(1, 8) })
	}
	const weaponCount = pick([0, 1, 1, 2, 2, 3])
	const weapons = []
	for (let i = 0; i < weaponCount; i++) {
		const minRange = pick([1, 1, 2, 4]); weapons.push({ name: "w" + i, cost: int(3, 7), damage: int(15, 70), minRange,
			maxRange: minRange + int(0, 7), maxUses: pick([-1, 2, 3]), needsLos: r() < 0.7 })
	}
	const equipped = weaponCount && r() < 0.8 ? int(0, weaponCount - 1) : -1
	const chipCount = pick([0, 0, 1, 2, 3, 5])
	const chips = []
	for (let i = 0; i < chipCount; i++) {
		const minRange = pick([0, 1, 2]); chips.push({ name: "c" + i, cost: int(2, 6), damage: int(8, 50), minRange,
			maxRange: minRange + int(1, 9), cooldown: pick([0, 1, 2]), currentCooldown: r() < 0.2 ? 1 : 0, needsLos: r() < 0.7 })
	}
	const support = { heal: r() < 0.6 ? { cost: int(2, 5), value: int(20, 90), cd: r() < 0.2 ? 1 : 0 } : null,
		shield: r() < 0.5 ? { cost: int(2, 4), value: int(10, 40), cd: r() < 0.2 ? 1 : 0 } : null,
		wall: r() < 0.25 ? { cost: int(2, 4), value: int(10, 30), cd: 0 } : null,
		protein: r() < 0.4 ? { cost: 3, value: int(40, 100), cd: r() < 0.3 ? 1 : 0 } : null,
		motivation: r() < 0.3 ? { cost: 4, value: 2, cd: r() < 0.3 ? 1 : 0 } : null }
	const dangerMode = pick(["gradient", "gradient", "zone", "zone", "flat", "noise", "zero"])
	const scale = pick([0.2, 0.5, 0.9, 1.0, 1.1, 1.6, 3]) * life
	const noise = Array.from({ length: 64 }, () => r())
	const productionProfile = r() < 0.7
	const profile = productionProfile ? { role: "AGGRESSIVE", aggression: 50, support: [true, true, true] }
		: { role: pick(["AGGRESSIVE", "BALANCED", "DEFENSIVE"]), aggression: pick([0, 30, 50, 80, 100]),
			// `legacyDraw` : tirage de l'ancien réglage de portée, gardé pour ne pas décaler les graines de `spec`.
			legacyDraw: pick([1, 3, 5]), support: [r() < 0.8, r() < 0.8, r() < 0.8] }
	const stag = r() < 0.35 ? { count: int(0, 4), stillTurns: int(0, 4), passive: int(0, 5), engaged: r() < 0.3, record: int(1, 20),
		visited: Array.from({ length: int(0, 4) }, () => [int(-3, 3), int(-3, 3)]) } : null
	return { seed, size, obstacles, maxLife, life, enemies, weapons, equipped, chips, support, dangerMode, scale, noise, profile, stag,
		tp: pick([0, 3, 4, 6, 10, 10, 14, 20]), mp: int(1, 7), turn: int(2, 20), strength: pick([0, 20, 100]), ...force }
}

/**
 * Exécute `evaluateTacticalPlans` d'un dist sur la spécification. `interruptAfter` : nombre de lectures de
 * `System.operations` avant de franchir le plafond de recherche (30 %) ; null = pas de `System` (recherche complète).
 */
export function run(M, s, interruptAfter = null, act = false) {
	globalThis.Effect = EFFECT
	delete globalThis.System
	const grid = new Map()
	for (let x = -s.size; x <= s.size; x++) for (let y = -s.size; y <= s.size; y++) grid.set(x * 4096 + y, { id: grid.size, x, y, entity: null, obstacle: false, empty: true })
	const at = (x, y) => grid.get(x * 4096 + y) ?? null
	const taken = new Set(["0,0", ...s.enemies.map((e) => `${e.x},${e.y}`)])
	for (const [x, y] of s.obstacles) if (!taken.has(`${x},${y}`)) Object.assign(at(x, y), { obstacle: true, empty: false })
	const los = (a, b) => {
		const n = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
		for (let i = 1; i < n; i++) { const c = at(Math.round(a.x + (b.x - a.x) * i / n), Math.round(a.y + (b.y - a.y) * i / n)); if (c && c.obstacle) return false }
		return true
	}
	const hit = (from, to, item) => { const d = dist(from, to); return d >= item.minRange && d <= item.maxRange && (!item.needsLos || los(from, to)) }
	const dmg = (o) => ({ ...o, features: [{ type: EFFECT.DAMAGE, minValue: o.damage, maxValue: o.damage, turns: 0 }] })
	const weapons = s.weapons.map((w, i) => ({ id: 100 + i, ...dmg(w) }))
	const chips = s.chips.map((c, i) => ({ id: 200 + i, maxUses: -1, area: 1, ...dmg(c) }))
	const self = (name, o, type, turns) => o && ({ id: 300 + type, name, cost: o.cost, cooldown: 3, currentCooldown: o.cd, minRange: 0, maxRange: 0, maxUses: -1,
		needsLos: false, area: 1, features: [{ type, minValue: o.value, maxValue: o.value, turns }] })
	const extra = [self("heal", s.support.heal, EFFECT.HEAL, 0), self("shield", s.support.shield, EFFECT.ABSOLUTE_SHIELD, 2),
		self("wall", s.support.wall, EFFECT.RELATIVE_SHIELD, 2), self("protein", s.support.protein, EFFECT.RAW_BUFF_STRENGTH, 2),
		self("motivation", s.support.motivation, EFFECT.RAW_BUFF_TP, 3)].filter(Boolean)
	const enemies = s.enemies.map((e, i) => ({ id: 2 + i, name: "e" + i, cell: at(e.x, e.y), life: e.life, maxLife: e.life, absoluteShield: e.absoluteShield,
		relativeShield: e.relativeShield, mp: e.mp, tp: 10, weapon: { maxRange: e.range }, weapons: [], chips: [], effects: [], launchedEffects: [] }))
	const me = { id: 1, name: "me", cell: at(0, 0), life: s.life, maxLife: s.maxLife, strength: s.strength, wisdom: 0, science: 0, agility: 0, resistance: 0, magic: 0,
		level: 25, absoluteShield: 0, relativeShield: 0, tp: s.tp, mp: s.mp, weapon: s.equipped >= 0 ? weapons[s.equipped] : null, weapons,
		chips: [...chips, ...extra], effects: [], launchedEffects: [],
		canUseWeapon(t, w = this.weapon) { return !!w && this.tp >= w.cost && t.life > 0 && hit(this.cell, t.cell, w) },
		canUseChip(c, t) { return c.currentCooldown === 0 && this.tp >= c.cost && t.life > 0 && hit(this.cell, t.cell, c) },
		chipCells(c, t) { return [...grid.values()].filter((cell) => !cell.obstacle && hit(cell, t.cell, c)) },
		say() {}, distance(other) { return dist(this.cell, other.cell ?? other) },
		moveToward(destination, max = this.mp) { const goalCell = destination.cell ?? destination
			const options = walk(this.cell, Math.min(this.mp, max), (cell) => dist(cell, goalCell))
			const exact = options.find((o) => o.cell === goalCell)
			const best = exact ?? options.sort((x, y) => x.score - y.score || x.cost - y.cost)[0]
			return go(best.cell, best.cost) },
		moveAwayFrom(entity, max = this.mp) { const best = walk(this.cell, Math.min(this.mp, max), (cell) => -dist(cell, entity.cell ?? entity)).sort((x, y) => x.score - y.score || x.cost - y.cost)[0]
			events.push("moveAwayFrom"); return go(best.cell, best.cost) },
		setWeapon(w) { this.tp--; this.weapon = w; events.push(`equip:${w.name}`); return true },
		useWeapon(t) { if (!this.canUseWeapon(t)) { events.push("weapon-refused"); return -1 } apply(this.weapon, t); events.push(`shoot:${this.weapon.name}`); return 1 },
		useChip(c, t) { if (!this.canUseChip(c, t)) { events.push(`chip-refused:${c.name}`); return -1 } apply(c, t); c.currentCooldown = Math.max(1, c.cooldown); events.push(`chip:${c.name}`); return 1 } }
	// Exécution (mode `act`) : déplacements par plus court chemin, tirs et puces appliqués avec les boucliers.
	const events = []
	const state = { dealt: 0, absolute: 0, relative: 0 }
	const walk = (from, mp, goal) => { // BFS borné : case atteignable la plus proche de `goal` par la marche (à défaut Manhattan)
		const seen = new Map([[from, 0]]); const queue = [from]
		while (queue.length) { const c = queue.shift(); const k = seen.get(c); if (k >= mp) continue
			for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = at(c.x + dx, c.y + dy)
				if (n && !n.obstacle && !n.entity && !seen.has(n)) { seen.set(n, k + 1); queue.push(n) } } }
		return [...seen.entries()].map(([cell, cost]) => ({ cell, cost, score: goal(cell) }))
	}
	const go = (cell, cost) => { if (cell === me.cell) return 0; me.cell.entity = null; me.cell.empty = true; me.cell = cell; cell.entity = me; cell.empty = false; me.mp -= cost
		events.push(`move:${cell.x},${cell.y}:${cost}`); return cost }
	const apply = (item, t) => { me.tp -= item.cost
		for (const f of item.features) {
			if (f.type === EFFECT.DAMAGE) { const d = Math.max(0, f.minValue * (1 + me.strength / 100) * (1 - (t.relativeShield || 0) / 100) - (t.absoluteShield || 0)); const real = Math.min(t.life, d); t.life -= real; state.dealt += real }
			if (f.type === EFFECT.HEAL) me.life = Math.min(me.maxLife, me.life + f.minValue)
			if (f.type === EFFECT.ABSOLUTE_SHIELD) state.absolute += f.minValue
			if (f.type === EFFECT.RELATIVE_SHIELD) state.relative += f.minValue
			if (f.type === EFFECT.RAW_BUFF_STRENGTH) me.strength += f.minValue
			if (f.type === EFFECT.RAW_BUFF_TP) me.tp += f.minValue
		} }
	me.cell.entity = me; me.cell.empty = false
	for (const e of enemies) { e.cell.entity = e; e.cell.empty = false }
	globalThis.Field = { cellFromXY: at, lineOfSight: los, distance: dist, getObstacles: () => [] }
	globalThis.Fight = { turn: s.turn, me, getAliveEnemies: () => enemies, getNearestEnemy: () => enemies[0], getEnemies: () => enemies, getAllies: () => [me],
		weaponCells: (t, w) => [...grid.values()].filter((cell) => !cell.obstacle && hit(cell, t.cell, w)) }
	const config = new M.LogConfig(); config.setAll(false); config.setEnabled(M.LOG_CONTEXT.PLANNING, true); M.initLeekLogging(config)
	const reachable = M.computeReachableCells(me, me.mp, s.turn)
	const near = (cell) => Math.min(...enemies.map((e) => dist(cell, e.cell)))
	const danger = s.danger ?? ((cell) => {
		const n = s.noise[Math.abs(cell.x * 7 + cell.y * 13) % 64]
		const d = near(cell)
		if (s.dangerMode === "zero") return 0
		if (s.dangerMode === "flat") return Math.round(s.scale)
		if (s.dangerMode === "noise") return Math.round(s.scale * n * 10) / 10
		if (s.dangerMode === "zone") return enemies.some((e) => dist(cell, e.cell) <= e.mp + e.weapon.maxRange && los(cell, e.cell)) ? Math.round(s.scale * (0.6 + 0.4 * n)) : 0
		return Math.max(0, Math.round((s.scale * (1.3 - d / 12) + 20 * n) * 10) / 10)
	})
	const dangers = new Map()
	const threat = new M.ThreatMap(me.id, s.turn, new Map([...reachable.entries()].map(({ cell, cost }) => {
		const value = danger(cell); dangers.set(cell.x * 4096 + cell.y, value)
		return [cell.x * 4096 + cell.y, { cell, mpCost: cost, danger: value, breakdown: [] }]
	})), { candidateCells: reachable.size, truncated: false, inputsTruncated: false, enemyCount: enemies.length, pairsEvaluated: 0, lineOfSightCalls: 0 })
	const profile = new M.LeekProfile(); profile.setRole(s.profile.role); profile.setAggression(s.profile.aggression)
	profile.setSupportOptions(...s.profile.support)
	let stagnation
	if (s.stag) {
		stagnation = new M.StagnationTracker()
		Object.assign(stagnation, { count: s.stag.count, stillTurns: s.stag.stillTurns, passive: s.stag.passive, engaged: s.stag.engaged, record: s.stag.record,
			turnSeen: s.turn, enemyLifeSeen: 0, closest: 0, enemyCountSeen: enemies.length })
		for (const [x, y] of s.stag.visited) stagnation.visitedCells.add(`${x},${y}`)
	}
	let reads = 0
	if (interruptAfter !== null) {
		const step = 300000 / interruptAfter
		globalThis.System = { maxOperations: 1000000, get operations() { return Math.min(700000, Math.floor(reads++ * step)) } }
	}
	globalThis.__work = {}
	const logs = []; const print = console.log; console.log = (t) => logs.push(String(t))
	let result
	try { result = M.evaluateTacticalPlans(me, profile, { reachable, threat, stagnation }) } finally { console.log = print; delete globalThis.System }
	const work = globalThis.__work; globalThis.__work = null
	const startCell = me.cell, startLife = s.life
	let end = null
	if (act) {
		// Comme `planAct` : plan conjoint, sinon plan B avec la préparation. Après une interruption, le compteur d'opérations
		// repart de 300 000 et avance lentement (le plan B garde ses 3 %).
		if (interruptAfter !== null) { let slow = 0; globalThis.System = { maxOperations: 1000000, get operations() { return 300000 + (slow++) * 5 } } }
		console.log = (t) => logs.push(String(t))
		let via = "tactical"
		try {
			if (result.plan !== null) M.executeTacticalPlan(me, result.plan)
			else { via = M.executeReservePlan(me, profile, { reachable, threat, stagnation }, result.preparation) ? "reserve" : "legacy" }
		} finally { console.log = print; delete globalThis.System }
		const D = dangers.get(me.cell.x * 4096 + me.cell.y) ?? danger(me.cell)
		const exposed = D - Math.min(D, state.absolute + D * Math.min(100, state.relative) / 100)
		end = { via, cell: [me.cell.x, me.cell.y], danger: D, exposed, life: me.life, dead: exposed >= me.life, dealt: Math.round(state.dealt * 10) / 10,
			killedAll: enemies.every((e) => e.life <= 0), tpLeft: me.tp, mpLeft: me.mp, events,
			geo: Math.min(...enemies.map((e) => dist({ x: 0, y: 0 }, e.cell))) - near(me.cell), idle: events.length === 0 }
	}
	const p = result.plan
	const originDanger = dangers.get(0)
	const m = stagnation && stagnation.riskFactor < 1 ? 0.75 : 1
	let summary = null
	if (p) {
		let heal = 0, absolute = 0, relative = 0
		for (const chip of p.protection) for (const f of chip.features) {
			if (f.type === EFFECT.HEAL) heal += f.minValue
			if (f.type === EFFECT.ABSOLUTE_SHIELD) absolute += f.minValue
			if (f.type === EFFECT.RELATIVE_SHIELD) relative += f.minValue
		}
		heal = Math.min(s.maxLife - s.life, heal); relative = Math.min(100, relative)
		const exposed = p.danger - Math.min(p.danger, absolute + p.danger * relative / 100)
		const kill = enemies.length === 1 && p.usefulDamage >= p.target.life && p.usefulDamage > 0
		summary = { shot: [p.shotCell.x, p.shotCell.y], dest: [p.destination.x, p.destination.y], weapon: p.weapon?.name ?? null, shots: p.weaponShots,
			chips: p.chips.map((c) => c.name), protection: p.protection.map((c) => c.name), boost: (p.boost?.chips ?? []).map((c) => c.name),
			tpUsed: p.tpUsed, U: p.usefulDamage, danger: p.danger, score: Math.round(p.score * 1000) / 1000, progress: p.progress ?? null,
			stagnation: !!p.stagnation, status: p.searchStatus ?? null, exposed, lethal: exposed >= (s.life + heal) * m, lethalFull: exposed >= s.life + heal, kill,
			geo: dist(startCell, enemies[0].cell) - dist(p.destination, enemies[0].cell),
			noop: p.beforeMp + p.afterMp === 0 && p.weaponShots === 0 && p.chips.length === 0 && p.protection.length === 0 && !(p.boost?.chips ?? []).length }
	}
	const strategy = M.createStrategy(profile)
	const hide = profile.allowHiding && strategy.shouldHide(s.life / s.maxLife, near(startCell))
	return { end, plan: summary, reason: result.reason, logs, work, reads, originDanger, minDanger: Math.min(...dangers.values()), cells: reachable.size, hide,
		closest: near(startCell), m, stayLethal: originDanger >= s.life * m,
		refused: logs.filter((l) => l.startsWith("[Tactical] retreat without damage refused")).length, doomed: logs.some((l) => l.startsWith("[Tactical] doomed turn")) }
}

export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
export const show = (p) => p === null ? "null" : `${p.shot}->${p.dest} ${p.weapon ?? "-"}x${p.shots} [${p.chips}] prot[${p.protection}] boost[${p.boost}] tp=${p.tpUsed} U=${p.U} D=${p.danger} geo=${p.geo} score=${p.score}${p.lethal ? " LETHAL" : ""}${p.stagnation ? " STAG" : ""}${p.noop ? " NOOP" : ""}${p.status ? " (bounded)" : ""}`
