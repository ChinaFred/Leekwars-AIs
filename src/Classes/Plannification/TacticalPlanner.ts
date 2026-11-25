// @version:5.8
// file version: 8
import { ReachableCells, computeReachableCells, MOVE_NEIGHBOR_OFFSETS } from "../Context/ReachableCells.js"
import { aliveEnemies } from "../Context/Targets.js"
import { ThreatMap } from "../Context/ThreatMap.js"
import { ShotCandidate, maxUsesOf, toCandidate } from "../Context/ShotPlan.js"
import { LeekProfile } from "../LeekProfile.js"
import { log, LOG_CONTEXT } from "../../Toolbox/Logger.js"
import { ExecutionBudget, EXECUTION_BUDGET_POLICY, hasExecutionRoom } from "./ExecutionBudget.js"

export interface TacticalContext {
	readonly reachable: ReachableCells | null
	readonly threat: ThreatMap | null
}

/** Éphémère, sans dépense : réutilisable par le secours uniquement au même état. */
export interface TacticalPreparation {
	readonly entityId: number
	readonly origin: Cell
	readonly reachable: ReachableCells | null
	readonly turn: number
	readonly mp: number
	readonly tp: number
	readonly enemies: Array<{ enemy: Entity; cell: Cell }>
	dangers: ReadonlyMap<number, number> | null
	readonly weaponCells: Map<Entity, Map<Weapon, Cell[]>>
	readonly currentWeapons: Map<Entity, Map<Weapon, boolean>>
}

export interface TacticalPlan {
	readonly target: Entity
	readonly shotCell: Cell
	readonly destination: Cell
	readonly beforeMp: number
	readonly afterMp: number
	readonly weapon: Weapon | null
	readonly weaponShots: number
	readonly chips: readonly Chip[]
	readonly protection: readonly Chip[]
	readonly tpUsed: number
	readonly usefulDamage: number
	/** Danger brut conservé, même si les dégâts moyens dépassent les PV de la cible. */
	readonly danger: number
	readonly score: number
	readonly progress?: number
	readonly searchStatus?: string
	readonly state?: { readonly turn: number; readonly enemies: ReadonlyArray<{ enemy: Entity; cell: Cell }> }
}

class Unavailable extends Error {}

/** Bornes de recherche, pas des mesures d'opérations moteur. Aucun plan partiel n'est exécuté. */
export const TACTICAL_LIMITS = {
	cells: 85, enemies: 4, weapons: 4, attackChips: 8, protectionChips: 3, tp: 30, work: 100000
} as const

class Budget {
	private work = 0
	private readonly start = typeof System === "undefined" ? 0 : System.operations
	incumbent: TacticalPlan | null = null

	tick(): void {
		if (++this.work > TACTICAL_LIMITS.work) {
			throw new Unavailable("search bound")
		}
		if (this.work % 64 === 1) this.check()
	}

	check(): void {
		if (typeof System !== "undefined" &&
			Number.isFinite(System.maxOperations) && System.maxOperations > 0 &&
			(System.operations >= System.maxOperations * 0.70 ||
				System.operations - this.start >= System.maxOperations * 0.15)) {
			throw new Unavailable("operations reserve")
		}
	}
}

function key(cell: Cell): number { return cell.x * 4096 + cell.y }
function same(a: Cell, b: Cell): boolean { return key(a) === key(b) }
function validCost(cost: number): boolean { return Number.isInteger(cost) && cost > 0 }

function featureValue(chip: Chip, type: number): number {
	let value = 0
	for (const feature of chip.features) {
		if (feature.type === type) value += (feature.minValue + feature.maxValue) / 2
	}
	return Math.max(0, value)
}

/** Estimation par impact ; arrondis, critiques, érosion et effets secondaires non simulés. */
function netDamage(candidate: ShotCandidate, target: Entity): number {
	const relative = Math.max(0, Math.min(100, target.relativeShield || 0))
	return Math.max(0, candidate.damage * (1 - relative / 100) - Math.max(0, target.absoluteShield || 0))
}

interface Attack {
	damage: number
	weaponShots: number
	chips: readonly Chip[]
}

interface AttackChoice { attack: Attack; cost: number }

/** Meilleur coût exact ≤ budget ; dégâts utiles plafonnés puis PT minimaux. */
function attackChoices(
	states: Array<Attack | undefined>, target: Entity, weaponRequired: boolean, budget: Budget
): Array<AttackChoice | undefined> {
	const choices: Array<AttackChoice | undefined> = []
	let best: AttackChoice | undefined
	for (let cost = 0; cost < states.length; cost++) {
		budget.tick()
		const attack = states[cost]
		if (attack && (!weaponRequired || attack.weaponShots > 0) &&
			(!best || Math.min(target.life, attack.damage) > Math.min(target.life, best.attack.damage))) {
			best = { attack, cost }
		}
		choices.push(best)
	}
	return choices
}

/**
 * Sac à dos borné : chaque puce au plus une fois, tous les nombres de tirs permis.
 * Une entrée par coût EXACT ; aucune comparaison gloutonne dégâts/PT.
 */
function attacks(
	tp: number, weapon: ShotCandidate | null, chips: readonly ShotCandidate[], target: Entity, budget: Budget
): Array<Attack | undefined> {
	let states: Array<Attack | undefined> = new Array(tp + 1)
	states[0] = { damage: 0, weaponShots: 0, chips: [] }
	if (weapon !== null) {
		const limit = Math.min(weapon.uses, Math.floor(tp / weapon.cost))
		for (let shots = 1; shots <= limit; shots++) {
			budget.tick()
			states[shots * weapon.cost] = {
				damage: shots * netDamage(weapon, target), weaponShots: shots, chips: []
			}
		}
	}
	for (const chip of chips) {
		const next = states.slice()
		const impact = netDamage(chip, target)
		for (let cost = 0; cost + chip.cost <= tp; cost++) {
			budget.tick()
			const state = states[cost]
			if (state === undefined) continue
			const damage = state.damage + impact
			if (damage > (next[cost + chip.cost]?.damage ?? -1)) {
				next[cost + chip.cost] = {
					damage, weaponShots: state.weaponShots, chips: [...state.chips, chip.item as Chip]
				}
			}
		}
		states = next
	}
	return states
}

interface Protection {
	chips: readonly Chip[]
	cost: number
	heal: number
	absolute: number
	relative: number
}

function protections(me: Me, profile: LeekProfile, budget: Budget): Protection[] {
	const usable = (chip: Chip): boolean => {
		budget.check()
		const result = me.canUseChip(chip, me)
		budget.check()
		return result
	}
	const candidates = [...new Set(me.chips)].filter((chip) =>
		validCost(chip.cost) && chip.cost <= me.tp && chip.currentCooldown === 0 && maxUsesOf(chip) > 0 &&
		chip.features.length > 0 && chip.features.every((feature) =>
			(feature.type === Effect.HEAL && profile.allowHealing) ||
			((feature.type === Effect.ABSOLUTE_SHIELD || feature.type === Effect.RELATIVE_SHIELD) && profile.allowShielding)
		) && usable(chip)
	)
	if (candidates.length > TACTICAL_LIMITS.protectionChips) throw new Unavailable("protection bound")
	const result: Protection[] = [{ chips: [], cost: 0, heal: 0, absolute: 0, relative: 0 }]
	for (const chip of candidates) {
		for (const previous of result.slice()) {
			if (previous.cost + chip.cost > me.tp) continue
			result.push({
				chips: [...previous.chips, chip], cost: previous.cost + chip.cost,
				heal: Math.min(me.maxLife - me.life,
					previous.heal + featureValue(chip, Effect.HEAL) * (1 + me.wisdom / 100)),
				// Crédit prudent en valeur de base, sans prétendre simuler la résistance du lanceur.
				absolute: previous.absolute + featureValue(chip, Effect.ABSOLUTE_SHIELD),
				relative: Math.min(100, previous.relative + featureValue(chip, Effect.RELATIVE_SHIELD))
			})
		}
	}
	return result
}

/** Ne crédite qu'un impact d'armure absolue, jamais tous les tirs potentiels. Heuristique, pas PV garantis. */
function shieldCredit(protection: Protection, danger: number): number {
	return Math.min(danger, protection.absolute + danger * protection.relative / 100)
}

/**
 * Marge sur les dégâts moyens pour compter un meurtre : les dégâts varient (min–max), aucune garantie.
 * Seul le dernier ennemi vivant, tué, annule le danger du plan.
 */
export const KILL_MARGIN = 1.1

/** Pénalité d'un plan dont le danger prévu atteint mes PV (soin compris) : la survie passe avant les dégâts. */
export const LETHAL_PENALTY = 1000

/**
 * Coût de risque d'un plan, en points de score : `weight` × danger après protection, plus `LETHAL_PENALTY` et
 * le dépassement si ce danger atteint mes PV (vie + soin prévu). Nul si le plan tue le dernier ennemi.
 * Estimation du modèle, pas une garantie de survie (critiques, buffs recastés et armes inconnues non prévus).
 */
function riskCost(me: Me, weight: number, protection: Protection, danger: number, kills: boolean): number {
	if (kills) return 0
	const exposed = danger - shieldCredit(protection, danger)
	const life = me.life + protection.heal
	return weight * exposed + (exposed >= life ? LETHAL_PENALTY + exposed - life : 0)
}

function killsLastEnemy(damage: number, target: Entity, enemyCount: number): boolean {
	return enemyCount === 1 && damage >= target.life * KILL_MARGIN
}

function better(candidate: TacticalPlan, best: TacticalPlan | null): boolean {
	return best === null || candidate.score > best.score ||
		(candidate.score === best.score && (candidate.danger < best.danger ||
			(candidate.danger === best.danger && (candidate.tpUsed < best.tpUsed ||
				(candidate.tpUsed === best.tpUsed &&
					candidate.beforeMp + candidate.afterMp < best.beforeMp + best.afterMp)))))
}

/**
 * Phase pure côté combat : aucun PT/PM dépensé. Une carte complète reste une estimation incomplète
 * des menaces (voir strategies.md), jamais une preuve de sécurité ou de meurtre.
 */
export function evaluateTacticalPlans(
	me: Me, profile: LeekProfile, context?: TacticalContext
): { plan: TacticalPlan | null; reason: string; preparation: TacticalPreparation } {
	const budget = new Budget()
	const preparation: TacticalPreparation = {
		entityId: me.id, origin: me.cell, reachable: context?.reachable ?? null,
		turn: Fight.turn, mp: me.mp, tp: me.tp, enemies: [],
		dangers: null, weaponCells: new Map(), currentWeapons: new Map()
	}
	const currentState = (): boolean => preparation.turn === Fight.turn &&
		same(me.cell, preparation.origin) && me.mp === preparation.mp && me.tp === preparation.tp &&
		preparation.enemies.every(({ enemy, cell }) => same(enemy.cell, cell))
	const stamp = (plan: TacticalPlan | null): TacticalPlan | null => plan && {
		...plan, state: { turn: preparation.turn, enemies: preparation.enemies }
	}
	try {
		const skipped = { unverified: 0, refused: 0 }
		const plan = evaluate(me, profile, context, skipped, budget, preparation)
		if (!currentState()) throw new Unavailable("state changed during search")
		const reason = skipped.unverified > 0 ? "offensive chip legality unverified" :
			skipped.refused > 0 ? "offensive chip refused at current cell" : "no actionable plan"
		return { plan: stamp(plan), reason: plan ? "complete search" : reason, preparation }
	} catch (error) {
		if (error instanceof Unavailable) {
			const globalAvailable = hasExecutionRoom()
			// Si le PREMIER fournisseur revient après la limite, ne pas préférer
			// aveuglément une simple progression à son option de tir non encore classée.
			// Le secours continue avec ce résultat et les dangers, sans les recalculer.
			const firingContinuation = budget.incumbent?.usefulDamage === 0 && preparation.weaponCells.size > 0
			return {
				plan: currentState() && globalAvailable && budget.incumbent && !firingContinuation ? stamp({
					...budget.incumbent, searchStatus: `bounded search: ${error.message}; complete incumbent`
				}) : null,
				reason: error.message, preparation
			}
		}
		// Évaluation sans dépense : l'historique reste possible, mais l'exception n'est pas silencieuse.
		log(() => JSON.stringify({
			level: "ERROR",
			file: "src/Classes/Plannification/TacticalPlanner.ts",
			function: "evaluateTacticalPlans",
			error: error instanceof Error
				? { name: error.name, message: error.message, stack: error.stack ?? null }
				: { name: typeof error, message: String(error), stack: null }
		}), LOG_CONTEXT.ERROR, { sink: "debug" })
		return { plan: null, reason: "evaluation API unavailable", preparation }
	}
}

function evaluate(
	me: Me, profile: LeekProfile, context: TacticalContext | undefined,
	skipped: { unverified: number; refused: number }, budget: Budget, preparation: TacticalPreparation
): TacticalPlan | null {
	const reachable = context?.reachable
	const threat = context?.threat
	if (!reachable || !threat) throw new Unavailable("missing threat/reachable data")
	budget.check()
	if (reachable.truncated || threat.truncated || threat.inputsTruncated) throw new Unavailable("truncated data")
	if (!reachable.isUpToDate(me.id, me.cell, me.mp, Fight.turn) ||
		threat.entityId !== me.id || threat.turn !== Fight.turn ||
		threat.candidateCells !== reachable.size) throw new Unavailable("stale/inconsistent data")
	if (reachable.size > TACTICAL_LIMITS.cells || !Number.isInteger(me.tp) ||
		me.tp < 0 || me.tp > TACTICAL_LIMITS.tp) throw new Unavailable("cells/PT bound")

	const enemies = aliveEnemies().filter((enemy) => enemy.life > 0)
	preparation.enemies.push(...enemies.map((enemy) => ({ enemy, cell: enemy.cell })))
	if (threat.enemyCount !== enemies.length) throw new Unavailable("stale/inconsistent enemy count")
	// La validation fait partie du budget, pas seulement la recherche qui la suit.
	// Un seul appel fournisseur par case ; les scores relisent cet instantané validé.
	const dangers = new Map<number, number>()
	for (const entry of reachable.entries()) {
		budget.check()
		const danger = threat.dangerAt(entry.cell)
		budget.check()
		if (danger === null || !Number.isFinite(danger) || danger < 0) throw new Unavailable("missing/invalid danger cell")
		dangers.set(key(entry.cell), danger)
	}
	preparation.dangers = dangers
	budget.tick()
	const weapons = [...new Set(me.weapon === null ? me.weapons : [me.weapon, ...me.weapons])]
	const attackChips = [...new Set(me.chips)].filter((chip) =>
		chip.currentCooldown === 0 && chip.cost <= me.tp && validCost(chip.cost) &&
		toCandidate(chip, true, me.strength) !== null
	)
	if (enemies.length > TACTICAL_LIMITS.enemies || weapons.length > TACTICAL_LIMITS.weapons ||
		attackChips.length > TACTICAL_LIMITS.attackChips) throw new Unavailable("items/targets bound")
	const support = protections(me, profile, budget)
	const weight = (profile.strategyName === "DEFENSIVE" ? 1.25 :
		profile.strategyName === "AGGRESSIVE" ? 0.75 : 1) * (1.5 - profile.aggression / 100)
	const hasAffordableWeapon = weapons.some((weapon) => validCost(weapon.cost) &&
		weapon.cost + (weapon === me.weapon ? 0 : 1) <= me.tp && toCandidate(weapon, false, me.strength))
	if (enemies.length && (hasAffordableWeapon || attackChips.length === 0)) {
		const target = enemies[0]!
		const distance = (cell: Cell): number => Math.abs(cell.x - target.cell.x) + Math.abs(cell.y - target.cell.y)
		const stay = -riskCost(me, weight, support[0]!, dangers.get(key(me.cell))!, false)
		for (const protection of support) for (const entry of reachable.entries()) {
			budget.tick()
			if (entry.cost > 1) continue
			const progress = distance(me.cell) - distance(entry.cell)
			if (!profile.allowHiding && entry.cost > 0 && progress <= 0) continue
			const danger = dangers.get(key(entry.cell))!
			const score = progress - riskCost(me, weight, protection, danger, false) + weight * protection.heal
			if (score <= stay || (entry.cost === 0 && protection.chips.length === 0)) continue
			const candidate: TacticalPlan = {
				target, shotCell: me.cell, destination: entry.cell, beforeMp: 0, afterMp: entry.cost,
				weapon: null, weaponShots: 0, chips: [], protection: protection.chips,
				tpUsed: protection.cost, usefulDamage: 0, danger, progress, score
			}
			if (better(candidate, budget.incumbent)) budget.incumbent = candidate
		}
	}

	const entries = [...reachable.entries()]
	// Tout préfixe d'un trajet total ≤ PM appartient à cette zone initiale.
	const byKey = new Map(entries.map((entry) => [key(entry.cell), entry.cell]))
	const neighbors = new Map<number, Cell[]>()
	for (const { cell } of entries) {
		budget.tick()
		const adjacent: Cell[] = []
		for (const [dx, dy] of MOVE_NEIGHBOR_OFFSETS) {
			const neighbor = byKey.get((cell.x + dx) * 4096 + cell.y + dy)
			if (neighbor) adjacent.push(neighbor)
		}
		neighbors.set(key(cell), adjacent)
	}
	const endingCache = new Map<number, { cell: Cell; cost: number }>()
	const endingFor = (shot: { cell: Cell; cost: number }): { cell: Cell; cost: number } => {
		const cached = endingCache.get(key(shot.cell))
		if (cached) return cached
		const queue = [{ cell: shot.cell, cost: 0 }]
		const visited = new Set([key(shot.cell)])
		let best = queue[0]!
		let danger = dangers.get(key(best.cell))!
		for (let head = 0; head < queue.length; head++) {
			budget.tick()
			const entry = queue[head]!
			const value = dangers.get(key(entry.cell))!
			if (value < danger) { best = entry; danger = value }
			if (!profile.allowHiding || entry.cost >= me.mp - shot.cost) continue
			for (const cell of neighbors.get(key(entry.cell))!) {
				if (visited.has(key(cell))) continue
				visited.add(key(cell))
				queue.push({ cell, cost: entry.cost + 1 })
			}
		}
		endingCache.set(key(shot.cell), best)
		return best
	}
	const retainWeapon = (target: Entity, weapon: Weapon, item: ShotCandidate, shot: { cell: Cell; cost: number }): void => {
		const equip = weapon === me.weapon ? 0 : 1
		const ending = endingFor(shot)
		const danger = dangers.get(key(ending.cell))!
		const states = attacks(me.tp - equip, item, [], target, budget)
		const choices = attackChoices(states, target, true, budget)
		for (const protection of support) {
			budget.tick()
			const choice = choices[me.tp - equip - protection.cost]
			if (!choice) continue
			const { attack, cost } = choice
			const usefulDamage = Math.min(target.life, attack.damage)
			const candidate: TacticalPlan = {
				target, shotCell: shot.cell, destination: ending.cell, beforeMp: shot.cost, afterMp: ending.cost,
				weapon, weaponShots: attack.weaponShots, chips: [], protection: protection.chips,
				tpUsed: cost + equip + protection.cost, usefulDamage, danger,
				score: usefulDamage - riskCost(me, weight, protection, danger, killsLastEnemy(attack.damage, target, enemies.length)) +
					weight * protection.heal
			}
			if (better(candidate, budget.incumbent)) budget.incumbent = candidate
		}
	}
	// Option complète avant les fournisseurs ; améliorée dès que chaque arme est
	// préparée, AVANT de lancer les fournisseurs suivants (notamment les puces).
	const readyWeapon = me.weapon ?? weapons[0] ?? null
	const readyCandidate = readyWeapon && validCost(readyWeapon.cost) ? toCandidate(readyWeapon, false, me.strength) : null
	if (readyWeapon && readyCandidate) for (const target of enemies) {
		const equip = readyWeapon === me.weapon ? 0 : 1
		if (readyCandidate.cost + equip > me.tp) continue
		const distance = Math.abs(me.cell.x - target.cell.x) + Math.abs(me.cell.y - target.cell.y)
		if (Number.isFinite(readyWeapon.maxRange) && distance > readyWeapon.maxRange) continue
		budget.check()
		const usable = me.canUseWeapon(target, readyWeapon)
		preparation.currentWeapons.set(target, new Map([[readyWeapon, usable]]))
		budget.check()
		if (usable) retainWeapon(target, readyWeapon, readyCandidate, { cell: me.cell, cost: 0 })
	}

	// Fournisseurs natifs existants : cellules de lancement par (cible,item), pas par couple de cases.
	const nativeCells = (getCells: () => Cell[]): Set<number> => {
		budget.check()
		const raw = getCells()
		budget.check()
		if (raw.length > 613) throw new Unavailable("native cells bound")
		const cells = new Set<number>()
		for (const cell of raw) {
			budget.tick()
			if (reachable.canReach(cell)) cells.add(key(cell))
		}
		return cells
	}
	const mayReach = (target: Entity, range: number): boolean => !Number.isFinite(range) ||
		Math.abs(me.cell.x - target.cell.x) + Math.abs(me.cell.y - target.cell.y) <= range + me.mp
	const prepared = enemies.map((target) => ({
		target,
		weapons: weapons.map((weapon) => {
			const candidate = validCost(weapon.cost) ? toCandidate(weapon, false, me.strength) : null
			if (!candidate || candidate.cost + (weapon === me.weapon ? 0 : 1) > me.tp ||
				!mayReach(target, weapon.maxRange)) return { weapon, candidate: null, cells: new Set<number>() }
			const cells = nativeCells(() => {
				const cells = Fight.weaponCells(target, weapon)
				let byWeapon = preparation.weaponCells.get(target)
				if (!byWeapon) preparation.weaponCells.set(target, byWeapon = new Map())
				byWeapon.set(weapon, cells) // Même si le contrôle suivant interrompt la recherche.
				return cells
			})
			let nearest: typeof entries[number] | null = null
			for (const entry of entries) {
				budget.tick()
				if (cells.has(key(entry.cell)) && (nearest === null || entry.cost < nearest.cost ||
					(entry.cost === nearest.cost && dangers.get(key(entry.cell))! < dangers.get(key(nearest.cell))!))) nearest = entry
			}
			if (nearest) retainWeapon(target, weapon, candidate, nearest)
			return { weapon, candidate, cells }
		}),
		// Un refus depuis l'origine ne prouve pas une interdiction depuis une autre case :
		// la raison peut être la portée/LOS, mais aussi une restriction que nous ne savons pas isoler.
		// Sans preuve indépendante, ne pas créditer cette puce sur les cases hypothétiques.
		chips: attackChips.map((chip) => {
			if (!mayReach(target, chip.maxRange)) { skipped.unverified++; return null }
			const cells = nativeCells(() => me.chipCells(chip, target))
			budget.check()
			const usable = me.canUseChip(chip, target)
			budget.check()
			if (!usable) {
				if (cells.has(key(me.cell))) skipped.refused++
				else skipped.unverified++
				return null
			}
			return { candidate: toCandidate(chip, true, me.strength) as ShotCandidate, cells }
		}).filter((chip) => chip !== null)
	}))
	const hasOffense = prepared.some((enemy) =>
		enemy.weapons.some((w) => w.candidate && netDamage(w.candidate, enemy.target) > 0 && w.cells.size > 0) ||
		enemy.chips.some((c) => netDamage(c.candidate, enemy.target) > 0 && c.cells.size > 0))
	// Sans attaque connue, progression/couvert/support sont AUSSI un plan complet.
	// Une légalité de puce refusée/non vérifiée n'autorise pas une approche de tir fictive.
	let progressPlan: TacticalPlan | null = null
	if (enemies.length && (hasAffordableWeapon || (!skipped.unverified && !skipped.refused))) {
		const target = enemies[0]!
		const distance = (cell: Cell): number => Math.abs(cell.x - target.cell.x) + Math.abs(cell.y - target.cell.y)
		for (const protection of support) for (const ending of entries) {
			budget.tick()
			const progress = distance(me.cell) - distance(ending.cell)
			if (!profile.allowHiding && progress <= 0 && !same(ending.cell, me.cell)) continue
			const danger = dangers.get(key(ending.cell))!
			const candidate: TacticalPlan = {
				target, shotCell: me.cell, destination: ending.cell, beforeMp: 0, afterMp: ending.cost,
				weapon: null, weaponShots: 0, chips: [], protection: protection.chips,
				tpUsed: protection.cost, usefulDamage: 0, danger, progress,
				score: progress - riskCost(me, weight, protection, danger, false) + weight * protection.heal
			}
			if (better(candidate, progressPlan)) {
				progressPlan = candidate
				if ((ending.cost > 0 || protection.heal > 0 || shieldCredit(protection, danger) > 0) &&
					better(candidate, budget.incumbent)) budget.incumbent = candidate
			}
		}
	}
	if (!hasOffense) return progressPlan && (progressPlan.afterMp > 0 || progressPlan.protection.length > 0) ? progressPlan : null
	// Une table exacte par cible/arme/masque de puces utilisables, pas par case.
	const attackCache = new Map<string, Array<AttackChoice | undefined>>()
	let best: TacticalPlan | null = progressPlan
	let actionable = false
	for (const shot of entries) {
		budget.tick()
		// Depuis la case de tir, pas depuis l'origine : interdit de réutiliser deux fois les mêmes PM.
		// Les supports n'améliorent pas les dégâts : une seule table par cible/case/arme suffit
		// pour TOUS leurs budgets résiduels (les états sont indexés par coût exact).
		const offense: Array<{
			target: Entity; weapon: Weapon | null; equipCost: number; choices: Array<AttackChoice | undefined>
		}> = []
		for (let enemyIndex = 0; enemyIndex < prepared.length; enemyIndex++) {
			const enemy = prepared[enemyIndex]!
			const usableChips = enemy.chips.filter((chip) => chip.cells.has(key(shot.cell))).map((chip) => chip.candidate)
			const mask = enemy.chips.reduce((bits, chip, i) => chip.cells.has(key(shot.cell)) ? bits | (1 << i) : bits, 0)
			const options = [null, ...enemy.weapons]
			for (let optionIndex = 0; optionIndex < options.length; optionIndex++) {
				const option = options[optionIndex]!
				budget.tick()
				if (option !== null && (option.candidate === null || !option.cells.has(key(shot.cell)))) continue
				const equipCost = option !== null && option.weapon !== me.weapon ? 1 : 0
				if (equipCost > me.tp) continue
				const cacheKey = `${enemyIndex}:${optionIndex}:${mask}`
				let choices = attackCache.get(cacheKey)
				if (!choices) {
					const states = attacks(me.tp - equipCost, option?.candidate ?? null, usableChips, enemy.target, budget)
					choices = attackChoices(states, enemy.target, option !== null, budget)
					attackCache.set(cacheKey, choices)
				}
				offense.push({
					target: enemy.target, weapon: option?.weapon ?? null, equipCost,
					choices
				})
			}
		}
		if (!same(shot.cell, me.cell) && !offense.some((o) => (o.choices[o.choices.length - 1]?.attack.damage ?? 0) > 0)) continue
		// D − crédit(D) est monotone : même destination minimale pour tous les supports.
		const ending = endingFor(shot)
		const finalDanger = dangers.get(key(ending.cell))!
		for (const protection of support) {
			for (const option of offense) {
				const available = me.tp - protection.cost - option.equipCost
				budget.tick()
				const choice = option.choices[available]
				if (!choice) continue
				const { attack, cost } = choice
				// Sans repli autorisé, un déplacement avant tir doit permettre des dégâts utiles.
				if (!profile.allowHiding && !(attack.damage > 0) && !same(shot.cell, me.cell)) continue
				if (attack.damage > 0 || protection.heal > 0 || shieldCredit(protection, finalDanger) > 0) actionable = true
				const usefulDamage = Math.min(option.target.life, attack.damage)
				const candidate: TacticalPlan = {
					target: option.target, shotCell: shot.cell, destination: ending.cell,
					beforeMp: shot.cost, afterMp: ending.cost,
					weapon: attack.weaponShots > 0 ? option.weapon : null,
					weaponShots: attack.weaponShots, chips: attack.chips, protection: protection.chips,
					tpUsed: cost + protection.cost + option.equipCost, usefulDamage, danger: finalDanger,
					score: usefulDamage - riskCost(me, weight, protection, finalDanger,
						killsLastEnemy(attack.damage, option.target, enemies.length)) + weight * protection.heal
				}
				if (better(candidate, best)) {
					best = candidate
					if (actionable && better(candidate, budget.incumbent)) budget.incumbent = candidate
				}
			}
		}
	}
	return actionable ? best : null
}

function interrupted(reason: string): void {
	log(() => `[Tactical] execution: ${reason}`, LOG_CONTEXT.PLANNING)
}

function phase(me: Me, name: string, details: () => unknown): void {
	log(() => `[Tactical] phase before action ${JSON.stringify({
		phase: name, from: { x: me.cell.x, y: me.cell.y }, tp: me.tp, mp: me.mp, details: details()
	})}`, LOG_CONTEXT.PLANNING)
}

/** Contrôles natifs répétés : un échec ne déclenche jamais une seconde séquence historique après dépense. */
export function executeTacticalPlan(me: Me, plan: TacticalPlan): void {
	try { execute(me, plan) }
	catch (error) {
		log(() => JSON.stringify({
			level: "ERROR", file: "TacticalPlanner.ts", function: "executeTacticalPlan",
			error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
		}), LOG_CONTEXT.ERROR, { sink: "debug" })
		interrupted("API failure; no second sequence")
	}
}

function execute(me: Me, plan: TacticalPlan): void {
	const executionBudget = new ExecutionBudget()
	const currentState = (): boolean => !plan.state || (plan.state.turn === Fight.turn &&
		plan.state.enemies.every(({ enemy, cell }) => same(enemy.cell, cell)))
	const available = (): boolean => {
		if (executionBudget.available()) return true
		interrupted("global operations reserve; stop")
		return false
	}
	log(() => `[Tactical] plan before execution ${JSON.stringify({
		mode: "complete intent; native checks may cancel actions",
		order: ["approach", "protection", "equipment if needed", "offensive chips", "weapon shots", "final move"],
		target: { id: plan.target.id, position: { x: plan.target.cell.x, y: plan.target.cell.y } },
		origin: { x: me.cell.x, y: me.cell.y },
		shotCell: { x: plan.shotCell.x, y: plan.shotCell.y },
		destination: { x: plan.destination.x, y: plan.destination.y },
		tp: { available: me.tp, planned: plan.tpUsed, remainingIfExecuted: me.tp - plan.tpUsed },
		mp: { available: me.mp, before: plan.beforeMp, after: plan.afterMp },
		weapon: plan.weapon === null ? null : { name: plan.weapon.name, cost: plan.weapon.cost,
			equipTp: me.weapon === plan.weapon ? 0 : 1, shots: plan.weaponShots },
		chips: plan.chips.map((chip) => ({ name: chip.name, cost: chip.cost })),
		protection: plan.protection.map((chip) => ({ name: chip.name, cost: chip.cost })),
		attackLegality: plan.weaponShots > 0 || plan.chips.length > 0
			? "native cells/current permission; range/LOS checked in selection, native permission rechecked at execution"
			: "no attack selected",
		usefulDamage: plan.usefulDamage, danger: currentState() ? plan.danger : null,
		score: currentState() ? plan.score : null, stateCurrent: currentState(),
		progress: plan.progress ?? 0, searchStatus: plan.searchStatus ?? "complete search",
		executionBudget: EXECUTION_BUDGET_POLICY,
		estimates: "damage/score/danger modeled, not guaranteed outcome"
	})}`, LOG_CONTEXT.PLANNING)
	if (me.life <= 0 || !available()) return
	if (!currentState()) { interrupted("enemy positions/turn changed; plan unavailable"); return }
	if (!same(me.cell, plan.shotCell)) {
		const current = computeReachableCells(me, me.mp, Fight.turn)
		const cost = current.costTo(plan.shotCell)
		if (!available()) return
		if (cost === null || cost > plan.beforeMp) { interrupted("shot cell blocked"); return }
		phase(me, "approach", () => ({ to: { x: plan.shotCell.x, y: plan.shotCell.y }, mpCost: cost }))
		if (!available()) return
		me.moveToward(plan.shotCell, cost)
		if (!same(me.cell, plan.shotCell)) { interrupted("shot cell not reached"); return }
	}
	if (!currentState()) { interrupted("enemy positions/turn changed after approach; stop"); return }
	const used = new Set<Chip>()
	const cast = (chip: Chip, target: Entity, name: string): void => {
		if (!available()) return
		if (me.life > 0 && target.life > 0 && !used.has(chip) && me.chips.includes(chip) &&
			chip.currentCooldown === 0 && maxUsesOf(chip) > 0 && me.tp >= chip.cost &&
			me.canUseChip(chip, target)) {
			used.add(chip)
			phase(me, name, () => ({ chip: chip.name, target: target.id, tpCost: chip.cost }))
			if (!available()) return
			const result = me.useChip(chip, target)
			if (!(result > 0)) interrupted(`chip refused: ${chip.name}, result ${result}`)
		} else interrupted(`chip unavailable: ${chip.name}`)
	}
	for (const chip of plan.protection) cast(chip, me, "protection")
	if (!available()) return
	if (plan.weapon !== null && me.weapon !== plan.weapon && me.tp >= 1 && me.life > 0) {
		phase(me, "equipment", () => ({ weapon: plan.weapon!.name, tpCost: 1 }))
		if (!available()) return
		me.setWeapon(plan.weapon)
	}
	for (const chip of plan.chips) {
		if (!available()) return
		cast(chip, plan.target, "offensive chip")
	}
	for (let shot = 0; shot < plan.weaponShots; shot++) {
		if (!available()) return
		if (me.life <= 0 || plan.target.life <= 0 || plan.weapon === null || me.weapon !== plan.weapon ||
			shot >= maxUsesOf(plan.weapon) || me.tp < plan.weapon.cost || !me.canUseWeapon(plan.target)) {
			interrupted("weapon/target unavailable")
			break
		}
		phase(me, "weapon shot", () => ({
			weapon: plan.weapon!.name, target: plan.target.id, shot: shot + 1,
			atMost: plan.weaponShots, tpCost: plan.weapon!.cost
		}))
		if (!available()) return
		const result = me.useWeapon(plan.target)
		if (!(result > 0)) { interrupted(`weapon refused: result ${result}`); break }
	}
	if (me.life <= 0 || same(me.cell, plan.destination) || !available()) return
	if (!currentState()) { interrupted("danger stale after actions; final move cancelled"); return }
	const current = computeReachableCells(me, Math.min(me.mp, plan.afterMp), Fight.turn)
	const cost = current.costTo(plan.destination)
	if (!available()) return
	if (cost === null) { interrupted("final cell blocked"); return }
	phase(me, "final move", () => ({ to: { x: plan.destination.x, y: plan.destination.y }, mpCost: cost }))
	if (!available()) return
	me.moveToward(plan.destination, cost)
	if (!same(me.cell, plan.destination)) interrupted("final cell not reached")
}
