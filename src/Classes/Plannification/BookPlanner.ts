// @version:5.8
// file version: 9
import { log, LOG_CONTEXT } from "../../Toolbox/Logger.js"
import { chestDangerOf } from "../Context/ChestDanger.js"
import { computeReachableCells } from "../Context/ReachableCells.js"
import { aliveChests, aliveEnemies } from "../Context/Targets.js"
import { LeekProfile } from "../LeekProfile.js"
import {
	BEAM_DEPTH, BEAM_WIDTH, BeamEnv, BeamNode, BeamResult, BeamTrace, DuelState, REFINE_KEEP, SimState, TurnStep, Zone, runBeam
} from "./BookBeam.js"
import { BOOK_DUEL_SEARCH_FRACTION, BookBudget } from "./BookBudget.js"
import { catalogFor } from "./BookCatalog.js"
import { EnemyMover, advanceTowardMe, futureDangerOf } from "./BookEnemyModel.js"
import { BookObjective, DEFAULT_OBJECTIVE } from "./BookObjective.js"
import { StandoffTracker } from "./BookStandoff.js"
import { hasExecutionRoom } from "./ExecutionBudget.js"
import { TACTICAL_LIMITS, TacticalContext, TacticalPlan } from "./TacticalTypes.js"

/**
 * Plan du tour par faisceau sur la table de combos (`BookBeam.ts`), parallèle à `TacticalPlanner.ts` (qu'il ne modifie
 * ni n'appelle). Le tour 1 du meilleur enchaînement devient un `TacticalPlan` exécuté par `executeTacticalPlan`
 * (ordre : boost, protection, équipement, puces, tirs, déplacement) ; on replanifie à chaque tour (horizon glissant).
 */
export interface BookOptions {
	readonly objective?: BookObjective
	readonly width?: number
	readonly depth?: number
	/** Hypothèse de déplacement de l'ennemi aux tours simulés (`BookEnemyModel.ts`). */
	readonly mover?: EnemyMover
	/** Plafond d'unités de travail (tests) ; sans lui, seul le plafond d'opérations du jeu coupe. */
	readonly workLimit?: number
	/** Compteur de duel (`BookStandoff.ts`) : lu seulement en posture AGGRESSIVE. */
	readonly standoff?: StandoffTracker
	/** Impose ou interdit le niveau 2 (tests) ; sinon `worthDeepening`. */
	readonly deepen?: boolean
	/** Budget fourni (tests : opérations simulées) ; sinon créé ici avec la part de `BOOK_SEARCH_FRACTION` ou du duel. */
	readonly budget?: BookBudget
}

function describe(node: BeamNode, items: Catalog["book"]["items"]): string {
	return node.steps.map((step) => {
		const names = step.combo.items.map((i) => (items[i]!.ref as { name?: string } | undefined)?.name ?? `#${i}`)
		return `[${step.shotCell.id}>${step.finalCell.id} ${names.join("+") || "-"}` +
			`${step.boosts.length ? ` boost:${step.boosts.map((b) => b.chip.name).join("+")}` : ""}` +
			`${step.supports.length ? ` support:${step.supports.map((s) => s.chip.name).join("+")}` : ""} ` +
			`dmg ${step.outcome.damage.toFixed(1)} heal ${step.outcome.heal.toFixed(1)} danger ${step.danger} s ${step.score.toFixed(1)}]`
	}).join(" ")
}
type Catalog = ReturnType<typeof catalogFor>

export interface BeamRun {
	readonly result: BeamResult
	readonly catalog: Catalog
	readonly work: number
	readonly trace: BeamTrace
	readonly ops: { readonly prepare: number; readonly beam: number }
	/** Part du total d'opérations accordée au faisceau (0,25, ou 0,30 en duel AGGRESSIVE). */
	readonly budgetFraction: number
}

/** Faisceau du tour, ou null (données absentes ou périmées, budget épuisé d'entrée, aucun ennemi). */
export function planBeam(me: Me, context: TacticalContext, profile: LeekProfile, options: BookOptions = {}): BeamRun | null {
	const { reachable, threat } = context
	const enemies = aliveEnemies().filter((enemy) => enemy.life > 0)
	if (enemies.length === 0 || enemies.length > TACTICAL_LIMITS.enemies || !reachable || !threat || reachable.truncated ||
		threat.truncated || threat.inputsTruncated || !reachable.isUpToDate(me.id, me.cell, me.mp, Fight.turn) ||
		threat.entityId !== me.id || threat.turn !== Fight.turn || threat.candidateCells !== reachable.size ||
		!hasExecutionRoom()) return null

	const objective = options.objective ?? DEFAULT_OBJECTIVE
	// Duel : actif dès que le compteur de duel (`BookStandoff.ts`) le constate.
	const duel: DuelState | null = options.standoff?.active
		? { accept: options.standoff.accept, riskScale: options.standoff.riskScale, beyond: options.standoff.beyond } : null
	const budget = options.budget ?? new BookBudget(options.workLimit, duel === null ? undefined : BOOK_DUEL_SEARCH_FRACTION)
	const opsStart = budget.ops()
	const catalog = catalogFor(me)
	budget.link(catalog.book)
	const rootCells = [...reachable.entries()]
	// Les coffres sont déjà dans la carte de danger du jeu (`ChestDanger.ts` via `EnemyMemory.updateThreatMap`) : `known` garde le
	// danger SANS coffre, le terme de coffre est rajouté à toute case (zone du tour 1 ou case simulée) par `dangerAt`.
	const chestDanger = chestDangerOf(aliveChests(), me.maxLife)
	const known = new Map<number, { cell: Cell; danger: number }>()
	for (const entry of rootCells) {
		const danger = threat.dangerAt(entry.cell)
		if (danger === null || !Number.isFinite(danger) || danger < 0) return null
		known.set(entry.cell.x * 4096 + entry.cell.y, { cell: entry.cell, danger: Math.max(0, danger - chestDanger(entry.cell)) })
	}
	const toZone = (cells: ReadonlyArray<{ cell: Cell; cost: number }>): Zone =>
		({ cells, byKey: new Map(cells.map((entry, i) => [entry.cell.x * 4096 + entry.cell.y, i])) })
	const rootZone = toZone(rootCells)
	const zones = new Map<string, Zone>()
	const sight = new Map<string, boolean>()
	const futureDanger = futureDangerOf(known)
	const behavior = profile.behavior
	const trace: BeamTrace = { retreat: profile.allowHiding && me.mp > 0, candidates: [], groups: new Map() }
	const env: BeamEnv = {
		me, catalog, objective, budget, mp: me.mp, mover: options.mover ?? advanceTowardMe, allowRetreat: profile.allowHiding, duel, deepen: options.deepen, trace,
		zone(state, k) {
			if (k === 0) return rootZone
			const id = `${k}:${state.cell.id}`
			let zone = zones.get(id)
			if (zone === undefined) {
				const computed = computeReachableCells({ id: me.id, cell: state.cell }, me.mp, Fight.turn + k)
				budget.tick(computed.size * 4)
				zones.set(id, zone = toZone([...computed.entries()]))
			}
			return zone
		},
		dangerAt: (cell) => futureDanger(cell) + chestDanger(cell),
		lineOfSight(from, to) {
			const id = `${from.id}:${to.id}`
			let seen = sight.get(id)
			if (seen === undefined) { budget.tick(1); sight.set(id, seen = Field.lineOfSight(from, to)) }
			return seen
		},
		supportAllowed(state) {
			const ratio = state.life / me.maxLife
			let closest: SimState["enemies"][number] | null = null
			let distance = Infinity
			for (const enemy of state.enemies) {
				const d = Math.abs(enemy.cell.x - state.cell.x) + Math.abs(enemy.cell.y - state.cell.y)
				if (enemy.life > 0 && d < distance) { closest = enemy; distance = d }
			}
			return {
				heal: profile.allowHealing && closest !== null &&
					(behavior.shouldHeal(ratio) || behavior.shouldHealWithThreat(ratio, distance)),
				shield: profile.allowShielding && closest !== null &&
					behavior.shouldShield(ratio, distance, closest.enemy.mp + (closest.enemy.weapon?.maxRange ?? 1))
			}
		}
	}
	const root: SimState = {
		cell: me.cell, life: me.life, tp: me.tp, cooldowns: catalog.chips.map((chip) => chip.currentCooldown),
		buffs: catalog.buffs, enemies: enemies.map((enemy) => ({ enemy, cell: enemy.cell, life: enemy.life })),
		held: me.weapon === null ? -1 : catalog.book.items.findIndex((item) => item.ref === me.weapon)
	}
	const opsPrepared = budget.ops()
	const result = runBeam(env, root, options.width ?? BEAM_WIDTH, options.depth ?? BEAM_DEPTH)
	log(() => `[Book] profile ${objective.name}: depth ${result.depth}, ${result.beam.length} plans, ${budget.work} work units, ` +
		`${catalog.book.tablesBuilt} tables${result.cut ? `, cut: ${result.cut}` : ""}${result.skipped ? `, skipped ${result.skipped}` : ""}` +
		`${duel ? `, duel +${duel.beyond} (accept ${duel.accept}, risk x${duel.riskScale})` : ""}`, LOG_CONTEXT.PLANNING)
	log(() => `[Book] ops: prepare ${opsPrepared - opsStart}, beam ${budget.ops() - opsPrepared} (units are not ops)`, LOG_CONTEXT.PLANNING)
	for (const node of result.beam) log(() => `[Book] beam ${node.score.toFixed(1)}: ${describe(node, catalog.book.items)}`, LOG_CONTEXT.PLANNING)
	return { result, catalog, work: budget.work, trace, ops: { prepare: opsPrepared - opsStart, beam: budget.ops() - opsPrepared }, budgetFraction: budget.fraction }
}

/** Plan du tour, ou null (rien d'utile à faire ou faisceau indisponible : l'appelant a un repli). */
export function planWithBook(me: Me, context: TacticalContext, profile: LeekProfile, options: BookOptions = {}): TacticalPlan | null {
	const run = planBeam(me, context, profile, options)
	if (run === null || run.result.best === null) return null
	const { catalog } = run
	const best = run.result.best
	const result = run.result
	const enemies = aliveEnemies().filter((enemy) => enemy.life > 0)
	const first = best.steps[0]!
	if (first.combo.items.length === 0 && first.boosts.length === 0 && first.supports.length === 0 &&
		first.finalCell === me.cell) {
		log(() => "[Book] best sequence does nothing this turn: fallback", LOG_CONTEXT.PLANNING)
		return null
	}
	log(() => unchosen(first, run.trace, catalog.book.items, me.mp), LOG_CONTEXT.PLANNING)
	log(() => `[Book] chosen: ${describe({ ...best, steps: [first] }, catalog.book.items)}`, LOG_CONTEXT.PLANNING)
	return toPlan(me, catalog, first, enemies, result.depth, result.cut, best.score)
}

/**
 * Diagnostic : le meilleur plan du tour 1 NON retenu qui inflige plus que le plan choisi, son danger final et pourquoi il
 * n'a pas été retenu (létal avec la limite appliquée, pas de case de repli moins dangereuse à portée de PM, groupe hors des
 * `REFINE_KEEP` meilleurs donc sans repli essayé, ou score inférieur).
 */
export function unchosen(chosen: TurnStep, trace: BeamTrace, items: Catalog["book"]["items"], mp: number): string {
	let alt: TurnStep | null = null
	for (const step of trace.candidates) {
		if (step.key === chosen.key || !(step.outcome.damage > chosen.outcome.damage + 1e-9)) continue
		if (alt === null || step.outcome.damage > alt.outcome.damage || (step.outcome.damage === alt.outcome.damage && step.score > alt.score)) alt = step
	}
	if (alt === null) return "[Book] unchosen with more damage: none"
	const record = trace.groups.get(alt.group)
	const reason = alt.lethal
		? `lethal (danger ${alt.danger.toFixed(1)} >= limit ${alt.limit.toFixed(1)})` + (record === undefined
			? `; group outside the ${REFINE_KEEP} best: no retreat tried`
			: !trace.retreat ? "; retreat disabled (no MP or hiding not allowed)"
			: record.retreat === null ? `; no cell with a lower danger within ${mp} MP (farthest reached: ${record.reachedMp} MP)` : "")
		: `lower score (${alt.score.toFixed(1)} < ${chosen.score.toFixed(1)})`
	return `[Book] unchosen with more damage: ${describe({ state: chosen.plan.state, score: alt.score, steps: [alt], key: "", group: "" }, items)} reason: ${reason}`
}

function toPlan(me: Me, catalog: Catalog, step: TurnStep, enemies: Entity[], depth: number, cut: string | null, score: number): TacticalPlan {
	const items = catalog.book.items
	const weaponIndex = step.combo.items.find((i) => items[i]!.isWeapon)
	const nearest = [...enemies].sort((a, b) => me.distance(a) - me.distance(b))[0]!
	const boostChips = step.boosts.map((boost) => boost.chip)
	return {
		target: step.target?.enemy ?? nearest, shotCell: step.shotCell, destination: step.finalCell,
		beforeMp: step.beforeMp, afterMp: step.afterMp,
		weapon: weaponIndex === undefined ? null : items[weaponIndex]!.ref as Weapon, weaponShots: step.combo.weaponShots,
		chips: step.combo.items.filter((i) => !items[i]!.isWeapon).map((i) => items[i]!.ref as Chip),
		protection: step.supports.map((support) => support.chip),
		boost: boostChips.length > 0 ? { chips: boostChips, tpGain: step.tpGain } : undefined,
		tpUsed: step.tpUsed, usefulDamage: step.outcome.damage, danger: step.danger, score,
		searchStatus: `book beam depth ${depth}${cut ? `; cut: ${cut}` : ""}`,
		state: { turn: Fight.turn, enemies: enemies.map((enemy) => ({ enemy, cell: enemy.cell })) }
	}
}
