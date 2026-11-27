// @version:5.8
// file version: 3
import { MIN_LIFE_RATIO_FOR_BOOST } from "../../Brain/StrengthBoost.js"
import { BookBudget, BookCut } from "./BookBudget.js"
import { BoostItem, Buff, Catalog, SupportItem } from "./BookCatalog.js"
import { EnemyMover } from "./BookEnemyModel.js"
import { BookObjective, TurnOutcome } from "./BookObjective.js"
import { Boost, Combo, EMPTY_COMBO, Shield, shapeOf } from "./CombatBook.js"
import { KILL_MARGIN, LETHAL_PENALTY } from "./TacticalScore.js"

/**
 * Faisceau multi-tours sur la table de combos. Un nœud = un état simulé minimal (ma case, mes PV, mes PT, cooldowns,
 * boosts actifs, ennemis : case et PV) et le chemin qui y mène. Chaque tour : tous les couples (case atteignable, cible,
 * variante de boost) sont lus dans la table, les meilleurs reçoivent soin/bouclier et case de repli, puis les
 * `BEAM_WIDTH` meilleurs enchaînements sont gardés, dédupliqués par clé. Seul le tour 1 du meilleur est exécuté.
 */
export const BEAM_WIDTH = 5
/** Tours simulés : 2 toujours, un 3e seulement si le budget le permet (`BookBudget.deepenOk`). */
export const BEAM_DEPTH = 3
/** Poids du tour t dans le score d'un enchaînement : décroissant, le tour 2 vaut moins que le tour 1. Non calibré. */
export const TURN_WEIGHTS: readonly number[] = [1, 0.6, 0.4]
/** Candidats d'un tour gardés pour l'enrichissement (soin, bouclier, repli). */
export const REFINE_KEEP = 12
/** Part des dégâts modélisés (danger de la case finale) retranchée de mes PV au tour simulé suivant. Heuristique. */
export const DAMAGE_TAKEN_FRACTION = 0.5
/** Multiplicateur d'un coup critique (CRITICAL_FACTOR officiel = 1,3), chance = agilité / 1000. */
const CRITICAL_FACTOR = 1.3

export interface SimEnemy { readonly enemy: Entity; readonly cell: Cell; readonly life: number }

export interface SimState {
	readonly cell: Cell
	readonly life: number
	/** PT disponibles au début du tour simulé (boosts de PT actifs compris). */
	readonly tp: number
	/** Tours avant que la puce `catalog.chips[i]` soit relançable : 0 = prête. */
	readonly cooldowns: readonly number[]
	readonly buffs: readonly Buff[]
	readonly enemies: readonly SimEnemy[]
	/** Indice (dans `book.items`) de l'arme en main, -1 si aucune. */
	readonly held: number
}

export interface ZoneCell { readonly cell: Cell; readonly cost: number }
export interface Zone { readonly cells: readonly ZoneCell[]; readonly byKey: ReadonlyMap<number, number> }

export interface BeamEnv {
	readonly me: Me
	readonly catalog: Catalog
	readonly objective: BookObjective
	readonly budget: BookBudget
	readonly mp: number
	readonly mover: EnemyMover
	/** Cases atteignables au tour simulé `k` (0 = tour courant) depuis la case de l'état. */
	zone(state: SimState, k: number): Zone
	/** Danger de la case au tour simulé `k` : carte du jeu au tour 0, hypothèse de `BookEnemyModel` ensuite. */
	dangerAt(cell: Cell, k: number): number
	lineOfSight(from: Cell, to: Cell): boolean
	/** Soin et bouclier permis par les seuils du profil (`LeekStrategy`) à cet état. */
	supportAllowed(state: SimState): { heal: boolean; shield: boolean }
	/** Retraite après tir permise (`allowHiding`). */
	readonly allowRetreat: boolean
}

export interface TurnStep {
	readonly target: SimEnemy | null
	readonly shotCell: Cell
	readonly finalCell: Cell
	readonly beforeMp: number
	readonly afterMp: number
	readonly combo: Combo
	/** Dégâts nets lus dans la table (avant critiques et plafond par PV). */
	readonly net: number
	readonly boosts: readonly BoostItem[]
	readonly supports: readonly SupportItem[]
	readonly tpGain: number
	readonly tpUsed: number
	readonly danger: number
	readonly outcome: TurnOutcome
	readonly lethal: boolean
	readonly score: number
	/** Clé de distinction : actions et cases. */
	readonly key: string
	/** Clé des seules actions (items, boosts, soins, cible) : sert à la diversité du faisceau. */
	readonly group: string
}

export interface BeamNode { readonly state: SimState; readonly score: number; readonly steps: readonly TurnStep[]; readonly key: string; readonly group: string }

export interface BeamResult {
	/** Meilleur enchaînement du dernier niveau COMPLET ; null si aucun tour n'a pu être évalué. */
	readonly best: BeamNode | null
	readonly beam: readonly BeamNode[]
	readonly depth: number
	readonly cut: string | null
}

function nearestAlive(enemies: readonly SimEnemy[], cell: Cell): { enemy: SimEnemy; distance: number } | null {
	let best: { enemy: SimEnemy; distance: number } | null = null
	for (const enemy of enemies) {
		if (enemy.life <= 0) continue
		const distance = Math.abs(enemy.cell.x - cell.x) + Math.abs(enemy.cell.y - cell.y)
		if (best === null || distance < best.distance) best = { enemy, distance }
	}
	return best
}

interface Variant { readonly boosts: readonly BoostItem[]; readonly cost: number; readonly tpGain: number; readonly buffs: readonly Buff[]; readonly tp: number }

/**
 * Variantes de boost du tour : aucune, ou un sous-ensemble du meilleur boost PRÊT par statistique (force, PT, agilité),
 * sans empiler un effet déjà actif. Sous le seuil de PV `MIN_LIFE_RATIO_FOR_BOOST` : aucune. Le boost de PT est lancé
 * d'abord (ses PT servent aux autres).
 */
export function boostVariants(env: BeamEnv, state: SimState): Variant[] {
	const none: Variant = { boosts: [], cost: 0, tpGain: 0, buffs: [], tp: state.tp }
	if (state.life / env.me.maxLife < MIN_LIFE_RATIO_FOR_BOOST) return [none]
	const best = new Map<string, BoostItem>()
	for (const boost of env.catalog.boosts) {
		if (state.cooldowns[env.catalog.chipIndex.get(boost.chip)!] !== 0 || boost.cost > state.tp) continue
		if (state.buffs.some((buff) => buff.stat === boost.stat && buff.turns > 0)) continue
		const known = best.get(boost.stat)
		if (known === undefined || boost.gain > known.gain || (boost.gain === known.gain && boost.cost < known.cost)) best.set(boost.stat, boost)
	}
	const ready = ["tp", "strength", "agility"].map((stat) => best.get(stat)).filter((boost) => boost !== undefined) as BoostItem[]
	const variants: Variant[] = [none]
	for (let bits = 1; bits < 1 << ready.length; bits++) {
		const boosts = ready.filter((_, i) => (bits & (1 << i)) !== 0)
		if (new Set(boosts.map((boost) => boost.chip)).size !== boosts.length) continue
		const tpBoost = boosts.find((boost) => boost.stat === "tp")
		const tpGain = tpBoost?.gain ?? 0
		const cost = boosts.reduce((sum, boost) => sum + boost.cost, 0)
		if ((tpBoost?.cost ?? 0) > state.tp || cost > state.tp + tpGain) continue
		variants.push({
			boosts, cost, tpGain, tp: state.tp - cost + tpGain,
			buffs: boosts.map((boost) => ({ stat: boost.stat, value: boost.gain, turns: boost.turns }))
		})
	}
	return variants
}

/** Sous-ensembles non vides de puces de soin/bouclier prêtes, permis par les seuils, abordables avec `tp` PT. */
function supportSubsets(env: BeamEnv, state: SimState, tp: number): SupportItem[][] {
	const allowed = env.supportAllowed(state)
	const ready = env.catalog.supports.filter((support) =>
		state.cooldowns[env.catalog.chipIndex.get(support.chip)!] === 0 && support.cost <= tp &&
		(!support.heals || allowed.heal) && (!support.shields || allowed.shield))
	const subsets: SupportItem[][] = []
	for (let bits = 1; bits < 1 << ready.length; bits++) {
		const subset = ready.filter((_, i) => (bits & (1 << i)) !== 0)
		if (subset.reduce((sum, support) => sum + support.cost, 0) <= tp) subsets.push(subset)
	}
	return subsets
}

interface Plan {
	state: SimState
	k: number
	target: SimEnemy | null
	shotCell: Cell
	finalCell: Cell
	beforeMp: number
	afterMp: number
	combo: Combo
	net: number
	variant: Variant
	supports: readonly SupportItem[]
	critical: number
	/** Plus petite distance d'ennemi depuis ma case de départ (pour le progrès). */
	startDistance: number
}

function stepOf(env: BeamEnv, p: Plan): TurnStep {
	const { state, variant } = p
	const danger = env.dangerAt(p.finalCell, p.k)
	let heal = 0
	let absolute = 0
	let relative = 0
	for (const support of p.supports) {
		heal += support.heal
		absolute += support.absolute
		relative += support.relative
	}
	heal = Math.min(Math.max(0, env.me.maxLife - state.life), heal)
	relative = Math.min(100, relative)
	const damage = p.target === null ? 0 : Math.min(p.target.life, p.net * p.critical)
	const aliveCount = state.enemies.filter((enemy) => enemy.life > 0).length
	const won = p.target !== null && aliveCount === 1 && p.net * p.critical >= p.target.life * KILL_MARGIN
	const credit = Math.min(danger, absolute + danger * relative / 100)
	const exposed = won ? 0 : danger - credit
	const nearest = nearestAlive(state.enemies, p.finalCell)
	const outcome: TurnOutcome = {
		damage, heal, shield: won ? 0 : credit, exposed, kills: p.target !== null && damage >= p.target.life, won,
		progress: nearest === null ? 0 : p.startDistance - nearest.distance, tpSpent: 0, boostsCast: variant.boosts.length
	}
	const limit = state.life + heal
	const lethal = !won && exposed >= limit
	const tpUsed = p.combo.tp + variant.cost + p.supports.reduce((sum, support) => sum + support.cost, 0)
	const score = env.objective.score({ ...outcome, tpSpent: tpUsed }) - (lethal ? LETHAL_PENALTY + exposed - limit : 0)
	const group = [p.target?.enemy.id ?? "-", [...p.combo.items].sort().join("."),
		variant.boosts.map((boost) => boost.chip.id).join("."), p.supports.map((support) => support.chip.id).join(".")].join(":")
	const key = `${p.finalCell.id}:${p.shotCell.id}:${group}`
	return {
		target: p.target, shotCell: p.shotCell, finalCell: p.finalCell, beforeMp: p.beforeMp, afterMp: p.afterMp, combo: p.combo, net: p.net,
		boosts: variant.boosts, supports: p.supports, tpGain: variant.tpGain, tpUsed, danger,
		outcome: { ...outcome, tpSpent: tpUsed }, lethal, score, key, group
	}
}

function betterStep(a: TurnStep, b: TurnStep): number {
	return b.score - a.score || a.danger - b.danger || a.tpUsed - b.tpUsed || a.beforeMp + a.afterMp - b.beforeMp - b.afterMp
}

/**
 * Les `width` meilleurs éléments de clés distinctes, DIVERSIFIÉS : d'abord le meilleur de chaque groupe d'actions (sans cela,
 * des cases équivalentes occupent tout le faisceau et un plan qui investit, comme un boost, est élagué avant de payer), puis
 * les suivants par score. Le résultat est trié par `compare`.
 */
export function selectTop<T extends { key: string; group: string }>(
	items: T[], width: number, compare: (a: T, b: T) => number
): T[] {
	items.sort(compare)
	const seen = new Set<string>()
	const groups = new Set<string>()
	const top: T[] = []
	for (const item of items) {
		if (top.length >= width) break
		if (groups.has(item.group) || seen.has(item.key)) continue
		groups.add(item.group)
		seen.add(item.key)
		top.push(item)
	}
	for (const item of items) {
		if (top.length >= width) break
		if (seen.has(item.key)) continue
		seen.add(item.key)
		top.push(item)
	}
	return top.sort(compare)
}

/** Cases où je peux finir après un tir depuis `from` avec `mpLeft` PM : parcours de la zone déjà atteignable. */
function finalCells(zone: Zone, from: Cell, mpLeft: number): ZoneCell[] {
	const found: ZoneCell[] = [{ cell: from, cost: 0 }]
	const seen = new Set<number>([from.x * 4096 + from.y])
	for (let head = 0; head < found.length; head++) {
		const current = found[head]!
		if (current.cost >= mpLeft) continue
		for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
			const key = (current.cell.x + dx) * 4096 + current.cell.y + dy
			const index = zone.byKey.get(key)
			if (index === undefined || seen.has(key)) continue
			seen.add(key)
			found.push({ cell: zone.cells[index]!.cell, cost: current.cost + 1 })
		}
	}
	return found
}

/**
 * Étapes candidates du tour simulé `k` depuis `state`, ajoutées à `sink` au fur et à mesure : une coupure du budget laisse
 * `sink` rempli d'étapes COMPLÈTES (jamais une moitié d'étape).
 */
export function expandTurn(env: BeamEnv, state: SimState, k: number, sink: TurnStep[]): void {
	const { catalog, budget } = env
	const book = catalog.book
	if (!state.enemies.some((enemy) => enemy.life > 0)) return
	const zone = env.zone(state, k)
	const mask = book.maskOf((item) => state.cooldowns[catalog.chipIndex.get(item.ref as Chip)!] === 0)
	const stats = { strength: catalog.base.strength, magic: catalog.base.magic }
	const variants = boostVariants(env, state)
	const startNearest = nearestAlive(state.enemies, state.cell)!
	const buffed = (variant: Variant): { boosts: Boost[]; critical: number } => {
		let agility = catalog.base.agility
		const boosts: Boost[] = []
		for (const buff of [...state.buffs, ...variant.buffs]) {
			if (buff.stat === "strength") boosts.push({ stat: "strength", value: buff.value, turns: Math.max(1, buff.turns) })
			else if (buff.stat === "agility") agility += buff.value
		}
		return { boosts, critical: 1 + (CRITICAL_FACTOR - 1) * Math.min(1, Math.max(0, agility) / 1000) }
	}
	const prepared = variants.map((variant) => ({ variant, ...buffed(variant) }))
	const phaseA: Plan[] = []
	for (const entry of zone.cells) {
		budget.tick(1)
		const cell = entry.cell
		const nearest = nearestAlive(state.enemies, cell)!
		for (const enemy of state.enemies) {
			if (enemy.life <= 0) continue
			budget.tick(variants.length)
			const dx = cell.x - enemy.cell.x
			const dy = cell.y - enemy.cell.y
			const distance = Math.abs(dx) + Math.abs(dy)
			const shape = shapeOf(dx, dy)
			let los = false
			if (distance <= book.maxDistance && book.usableAt(distance, true, shape) !== book.usableAt(distance, false, shape)) {
				los = env.lineOfSight(cell, enemy.cell)
			}
			const shield: Shield = { relative: enemy.enemy.relativeShield || 0, absolute: enemy.enemy.absoluteShield || 0 }
			for (const { variant, boosts, critical } of prepared) {
				let combo = EMPTY_COMBO
				let net = 0
				if (distance <= book.maxDistance && variant.tp > 0) {
					const read = book.readBoosted(stats, boosts, { distance, los, shape, tp: variant.tp, mask, held: state.held }, 0, shield)
					combo = read.combo
					net = read.net
				}
				// Sans tir : un seul candidat par case et variante, contre l'ennemi le plus proche.
				if (combo.items.length === 0 && enemy !== nearest.enemy) continue
				const plan: Plan = {
					state, k, target: combo.items.length > 0 ? enemy : null, shotCell: cell, finalCell: cell, beforeMp: entry.cost,
					afterMp: 0, combo, net, variant, supports: [], critical, startDistance: startNearest.distance
				}
				sink.push(stepOf(env, plan))
			}
		}
	}
	budget.tick(sink.length) // tri des candidats
	// Enrichissement des meilleurs : soin/bouclier (meilleur sous-ensemble), puis case finale de repli.
	const top = selectTop(sink.slice(), REFINE_KEEP, betterStep)
	for (const step of top) {
		budget.tick(4)
		const variant = prepared.find((candidate) => candidate.variant.boosts === step.boosts)!
		const base: Plan = {
			state, k, target: step.target, shotCell: step.shotCell, finalCell: step.finalCell, beforeMp: step.beforeMp, afterMp: 0,
			combo: step.combo, net: step.net, variant: variant.variant, supports: [], critical: variant.critical,
			startDistance: startNearest.distance
		}
		let withSupport: Plan = base
		let bestSupport: TurnStep | null = null
		for (const subset of supportSubsets(env, state, variant.variant.tp)) {
			budget.tick(2)
			const spent = subset.reduce((sum, support) => sum + support.cost, 0)
			let combo = step.combo
			let net = step.net
			if (step.target !== null && step.combo.tp > variant.variant.tp - spent) {
				const enemy = step.target
				const dx = step.shotCell.x - enemy.cell.x
				const dy = step.shotCell.y - enemy.cell.y
				const distance = Math.abs(dx) + Math.abs(dy)
				const shape = shapeOf(dx, dy)
				const shield: Shield = { relative: enemy.enemy.relativeShield || 0, absolute: enemy.enemy.absoluteShield || 0 }
				const read = book.readBoosted(stats, variant.boosts, {
					distance, los: env.lineOfSight(step.shotCell, enemy.cell), shape, tp: variant.variant.tp - spent, mask, held: state.held
				}, 0, shield)
				combo = read.combo
				net = read.net
			}
			const candidate = stepOf(env, { ...base, combo, net, supports: subset, target: combo.items.length > 0 ? step.target : null })
			if (bestSupport === null || betterStep(candidate, bestSupport) < 0) { bestSupport = candidate; withSupport = { ...base, combo, net, supports: subset, target: combo.items.length > 0 ? step.target : null } }
		}
		if (bestSupport !== null) sink.push(bestSupport)
		if (env.allowRetreat) {
			const mpLeft = env.mp - step.beforeMp
			if (mpLeft > 0) {
				let bestFinal: TurnStep | null = null
				for (const target of withSupport === base ? [base] : [withSupport, base]) {
					for (const final of finalCells(zone, step.shotCell, mpLeft)) {
						budget.tick(1)
						if (final.cell === step.shotCell) continue
						const candidate = stepOf(env, { ...target, finalCell: final.cell, afterMp: final.cost })
						if (bestFinal === null || betterStep(candidate, bestFinal) < 0) bestFinal = candidate
					}
					if (bestFinal !== null) sink.push(bestFinal)
					bestFinal = null
				}
			}
		}
	}
}

function nextState(env: BeamEnv, state: SimState, step: TurnStep): SimState {
	const { catalog } = env
	const used = new Set<Chip>()
	for (const index of step.combo.items) { const ref = catalog.book.items[index]!.ref; if (!catalog.book.items[index]!.isWeapon) used.add(ref as Chip) }
	for (const boost of step.boosts) used.add(boost.chip)
	for (const support of step.supports) used.add(support.chip)
	const cooldowns = catalog.chips.map((chip, i) => used.has(chip) ? Math.max(0, chip.cooldown - 1) : Math.max(0, state.cooldowns[i]! - 1))
	const buffs = [...state.buffs, ...step.boosts.map((boost) => ({ stat: boost.stat, value: boost.gain, turns: boost.turns }))]
		.map((buff) => ({ ...buff, turns: buff.turns - 1 })).filter((buff) => buff.turns > 0)
	const enemies = state.enemies.map((enemy) => {
		const life = enemy === step.target ? Math.max(0, enemy.life - step.outcome.damage) : enemy.life
		return life > 0
			? { enemy: enemy.enemy, life, cell: env.mover({ cell: enemy.cell, mp: enemy.enemy.mp }, step.finalCell) }
			: { enemy: enemy.enemy, life, cell: enemy.cell }
	})
	let held = state.held
	for (const index of step.combo.items) if (catalog.book.items[index]!.isWeapon) held = index
	return {
		cell: step.finalCell, life: Math.min(env.me.maxLife, Math.max(1, state.life + step.outcome.heal - step.outcome.exposed * DAMAGE_TAKEN_FRACTION)),
		tp: catalog.base.tp + buffs.filter((buff) => buff.stat === "tp").reduce((sum, buff) => sum + buff.value, 0),
		cooldowns, buffs, enemies, held
	}
}

/** Lance le faisceau : `depth` tours au plus, et le niveau en cours est abandonné si le budget est coupé. */
export function runBeam(env: BeamEnv, root: SimState, width = BEAM_WIDTH, depth = BEAM_DEPTH): BeamResult {
	let beam: BeamNode[] = [{ state: root, score: 0, steps: [], key: "", group: "" }]
	let reached = 0
	let cut: string | null = null
	for (let k = 0; k < depth; k++) {
		if (k >= 2 && !env.budget.deepenOk()) break
		const next: BeamNode[] = []
		let sink: TurnStep[] = []
		try {
			for (const node of beam) {
				if (!node.state.enemies.some((enemy) => enemy.life > 0)) { next.push(node); continue }
				sink = []
				expandTurn(env, node.state, k, sink)
				for (const step of selectTop(sink, width, betterStep)) {
					next.push({
						state: nextState(env, node.state, step), score: node.score + (TURN_WEIGHTS[k] ?? 0) * step.score,
						steps: [...node.steps, step], key: `${node.key}/${step.key}`, group: `${node.group}/${step.group}`
					})
				}
			}
		} catch (error) {
			if (!(error instanceof BookCut)) throw error
			cut = error.message
			// Tour 1 coupé : les étapes déjà produites sont complètes, on garde les meilleures ; plus loin, niveau abandonné.
			if (k === 0) for (const step of selectTop(sink, width, betterStep)) {
				next.push({ state: nextState(env, root, step), score: (TURN_WEIGHTS[0] ?? 1) * step.score, steps: [step], key: step.key, group: step.group })
			}
			if (next.length > 0 && k === 0) { beam = selectNodes(next, width); reached = 1 }
			break
		}
		if (next.length === 0) break
		beam = selectNodes(next, width)
		reached = k + 1
	}
	return { best: reached > 0 ? beam[0] ?? null : null, beam: reached > 0 ? beam : [], depth: reached, cut }
}

function selectNodes(nodes: BeamNode[], width: number): BeamNode[] {
	return selectTop(nodes, width, (a, b) => b.score - a.score || (a.steps[0]?.danger ?? 0) - (b.steps[0]?.danger ?? 0))
}
