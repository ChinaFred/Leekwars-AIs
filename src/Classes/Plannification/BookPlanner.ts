// @version:5.8
// file version: 3
import { log, LOG_CONTEXT } from "../../Toolbox/Logger.js"
import { computeReachableCells } from "../Context/ReachableCells.js"
import { aliveEnemies } from "../Context/Targets.js"
import { LeekProfile, createStrategy } from "../LeekProfile.js"
import { BEAM_DEPTH, BEAM_WIDTH, BeamEnv, BeamNode, BeamResult, SimState, TurnStep, Zone, runBeam } from "./BookBeam.js"
import { BookBudget } from "./BookBudget.js"
import { catalogFor } from "./BookCatalog.js"
import { EnemyMover, advanceTowardMe, futureDangerOf } from "./BookEnemyModel.js"
import { BookObjective, DEFAULT_OBJECTIVE } from "./BookObjective.js"
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

export interface BeamRun { readonly result: BeamResult; readonly catalog: Catalog; readonly work: number }

/** Faisceau du tour, ou null (données absentes ou périmées, budget épuisé d'entrée, aucun ennemi). */
export function planBeam(me: Me, context: TacticalContext, profile: LeekProfile, options: BookOptions = {}): BeamRun | null {
	const { reachable, threat } = context
	const enemies = aliveEnemies().filter((enemy) => enemy.life > 0)
	if (enemies.length === 0 || enemies.length > TACTICAL_LIMITS.enemies || !reachable || !threat || reachable.truncated ||
		threat.truncated || threat.inputsTruncated || !reachable.isUpToDate(me.id, me.cell, me.mp, Fight.turn) ||
		threat.entityId !== me.id || threat.turn !== Fight.turn || threat.candidateCells !== reachable.size ||
		!hasExecutionRoom()) return null

	const objective = options.objective ?? DEFAULT_OBJECTIVE
	const budget = new BookBudget(options.workLimit)
	const catalog = catalogFor(me)
	const rootCells = [...reachable.entries()]
	const known = new Map<number, { cell: Cell; danger: number }>()
	for (const entry of rootCells) {
		const danger = threat.dangerAt(entry.cell)
		if (danger === null || !Number.isFinite(danger) || danger < 0) return null
		known.set(entry.cell.x * 4096 + entry.cell.y, { cell: entry.cell, danger })
	}
	const toZone = (cells: ReadonlyArray<{ cell: Cell; cost: number }>): Zone =>
		({ cells, byKey: new Map(cells.map((entry, i) => [entry.cell.x * 4096 + entry.cell.y, i])) })
	const rootZone = toZone(rootCells)
	const zones = new Map<string, Zone>()
	const sight = new Map<string, boolean>()
	const futureDanger = futureDangerOf(known)
	const strategy = createStrategy(profile)
	const env: BeamEnv = {
		me, catalog, objective, budget, mp: me.mp, mover: options.mover ?? advanceTowardMe, allowRetreat: profile.allowHiding,
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
		dangerAt: (cell) => futureDanger(cell),
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
					(strategy.shouldHeal(ratio, 1 - ratio) || strategy.shouldHealWithThreat(ratio, 1 - ratio, distance)),
				shield: profile.allowShielding && closest !== null &&
					strategy.shouldShield(ratio, distance, closest.enemy.mp + (closest.enemy.weapon?.maxRange ?? 1))
			}
		}
	}
	const root: SimState = {
		cell: me.cell, life: me.life, tp: me.tp, cooldowns: catalog.chips.map((chip) => chip.currentCooldown),
		buffs: catalog.buffs, enemies: enemies.map((enemy) => ({ enemy, cell: enemy.cell, life: enemy.life })),
		held: me.weapon === null ? -1 : catalog.book.items.findIndex((item) => item.ref === me.weapon)
	}
	const result = runBeam(env, root, options.width ?? BEAM_WIDTH, options.depth ?? BEAM_DEPTH)
	log(() => `[Book] profile ${objective.name}: depth ${result.depth}, ${result.beam.length} plans, ${budget.work} work units, ` +
		`${catalog.book.tablesBuilt} tables${result.cut ? `, cut: ${result.cut}` : ""}`, LOG_CONTEXT.PLANNING)
	for (const node of result.beam) log(() => `[Book] beam ${node.score.toFixed(1)}: ${describe(node, catalog.book.items)}`, LOG_CONTEXT.PLANNING)
	return { result, catalog, work: budget.work }
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
	log(() => `[Book] chosen: ${describe({ ...best, steps: [first] }, catalog.book.items)}`, LOG_CONTEXT.PLANNING)
	return toPlan(me, catalog, first, enemies, result.depth, result.cut, best.score)
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
