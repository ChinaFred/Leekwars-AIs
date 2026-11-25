// @version:5.8
// file version: 2
import { ReachableCells, computeReachableCells } from "../Context/ReachableCells.js"
import { ThreatMap } from "../Context/ThreatMap.js"
import { ShotCandidate, maxUsesOf, toCandidate } from "../Context/ShotPlan.js"
import { LeekProfile } from "../LeekProfile.js"
import { log, LOG_CONTEXT } from "../../Toolbox/Logger.js"

export interface TacticalContext {
	readonly reachable: ReachableCells | null
	readonly threat: ThreatMap | null
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
}

class Unavailable extends Error {}

/** Bornes de recherche, pas des mesures d'opérations moteur. Aucun plan partiel n'est exécuté. */
export const TACTICAL_LIMITS = {
	cells: 85, enemies: 4, weapons: 4, attackChips: 8, protectionChips: 3, tp: 30, work: 100000
} as const

class Budget {
	private work = 0
	private readonly start = typeof System === "undefined" ? 0 : System.operations

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

function protections(me: Me, profile: LeekProfile): Protection[] {
	const candidates = [...new Set(me.chips)].filter((chip) =>
		validCost(chip.cost) && chip.cost <= me.tp && chip.currentCooldown === 0 && maxUsesOf(chip) > 0 &&
		chip.features.length > 0 && chip.features.every((feature) =>
			(feature.type === Effect.HEAL && profile.allowHealing) ||
			((feature.type === Effect.ABSOLUTE_SHIELD || feature.type === Effect.RELATIVE_SHIELD) && profile.allowShielding)
		) && me.canUseChip(chip, me)
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
): { plan: TacticalPlan | null; reason: string } {
	try {
		const skipped = { unverified: 0, refused: 0 }
		const plan = evaluate(me, profile, context, skipped)
		const reason = skipped.unverified > 0 ? "offensive chip legality unverified" :
			skipped.refused > 0 ? "offensive chip refused at current cell" : "no actionable plan"
		return { plan, reason }
	} catch (error) {
		if (error instanceof Unavailable) {
			return { plan: null, reason: error.message }
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
		return { plan: null, reason: "evaluation API unavailable" }
	}
}

function evaluate(
	me: Me, profile: LeekProfile, context: TacticalContext | undefined,
	skipped: { unverified: number; refused: number }
): TacticalPlan | null {
	const reachable = context?.reachable
	const threat = context?.threat
	if (!reachable || !threat) throw new Unavailable("missing threat/reachable data")
	if (reachable.truncated || threat.truncated || threat.inputsTruncated) throw new Unavailable("truncated data")
	if (!reachable.isUpToDate(me.id, me.cell, me.mp, Fight.turn) ||
		threat.entityId !== me.id || threat.turn !== Fight.turn ||
		threat.candidateCells !== reachable.size) throw new Unavailable("stale/inconsistent data")
	for (const entry of reachable.entries()) {
		const danger = threat.dangerAt(entry.cell)
		if (danger === null || !Number.isFinite(danger) || danger < 0) throw new Unavailable("missing/invalid danger cell")
	}
	if (reachable.size > TACTICAL_LIMITS.cells || !Number.isInteger(me.tp) ||
		me.tp < 0 || me.tp > TACTICAL_LIMITS.tp) throw new Unavailable("cells/PT bound")

	const budget = new Budget()
	budget.tick()
	const enemies = Fight.getAliveEnemies().filter((enemy) => enemy.life > 0)
	const weapons = [...new Set(me.weapon === null ? me.weapons : [me.weapon, ...me.weapons])]
	const attackChips = [...new Set(me.chips)].filter((chip) =>
		chip.currentCooldown === 0 && chip.cost <= me.tp && validCost(chip.cost) &&
		toCandidate(chip, true, me.strength) !== null
	)
	if (enemies.length > TACTICAL_LIMITS.enemies || weapons.length > TACTICAL_LIMITS.weapons ||
		attackChips.length > TACTICAL_LIMITS.attackChips) throw new Unavailable("items/targets bound")
	const support = protections(me, profile)
	const weight = (profile.strategyName === "DEFENSIVE" ? 1.25 :
		profile.strategyName === "AGGRESSIVE" ? 0.75 : 1) * (1.5 - profile.aggression / 100)

	// Fournisseurs natifs existants : cellules de lancement par (cible,item), pas par couple de cases.
	const nativeCells = (getCells: () => Cell[]): Set<number> => {
		budget.check()
		const cells = new Set(getCells().map(key))
		budget.check()
		return cells
	}
	const prepared = enemies.map((target) => ({
		target,
		weapons: weapons.map((weapon) => ({
			weapon, candidate: validCost(weapon.cost) ? toCandidate(weapon, false, me.strength) : null,
			cells: nativeCells(() => Fight.weaponCells(target, weapon))
		})),
		// Un refus depuis l'origine ne prouve pas une interdiction depuis une autre case :
		// la raison peut être la portée/LOS, mais aussi une restriction que nous ne savons pas isoler.
		// Sans preuve indépendante, ne pas créditer cette puce sur les cases hypothétiques.
		chips: attackChips.map((chip) => {
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
	let best: TacticalPlan | null = null
	let actionable = false
	for (const shot of reachable.entries()) {
		budget.tick()
		// Depuis la case de tir, pas depuis l'origine : interdit de réutiliser deux fois les mêmes PM.
		budget.check()
		const after = computeReachableCells({ id: me.id, cell: shot.cell }, me.mp - shot.cost, Fight.turn)
		budget.check()
		if (after.truncated) throw new Unavailable("post-shot reachability truncated")
		const endings = [...after.entries()].filter((entry) =>
			reachable.canReach(entry.cell) && (profile.allowHiding || same(entry.cell, shot.cell)))
		// Les supports n'améliorent pas les dégâts : une seule table par cible/case/arme suffit
		// pour TOUS leurs budgets résiduels (les états sont indexés par coût exact).
		const offense: Array<{
			target: Entity; weapon: Weapon | null; equipCost: number; states: Array<Attack | undefined>
		}> = []
		for (const enemy of prepared) {
			const usableChips = enemy.chips.filter((chip) => chip.cells.has(key(shot.cell))).map((chip) => chip.candidate)
			for (const option of [null, ...enemy.weapons]) {
				budget.tick()
				if (option !== null && (option.candidate === null || !option.cells.has(key(shot.cell)))) continue
				const equipCost = option !== null && option.weapon !== me.weapon ? 1 : 0
				if (equipCost > me.tp) continue
				offense.push({
					target: enemy.target, weapon: option?.weapon ?? null, equipCost,
					states: attacks(me.tp - equipCost, option?.candidate ?? null, usableChips, enemy.target, budget)
				})
			}
		}
		for (const protection of support) {
			let ending: typeof endings[number] | null = null
			let finalDanger = 0
			let penalizedDanger = Infinity
			for (const entry of endings) {
				budget.tick()
				const danger = threat.dangerAt(entry.cell)
				if (danger === null || !Number.isFinite(danger)) throw new Unavailable("missing final danger")
				const penalty = danger - shieldCredit(protection, danger)
				if (penalty < penalizedDanger ||
					(penalty === penalizedDanger && (danger < finalDanger ||
						(danger === finalDanger && entry.cost < (ending?.cost ?? Infinity))))) {
					ending = entry
					finalDanger = danger
					penalizedDanger = penalty
				}
			}
			if (ending === null) continue
			for (const option of offense) {
				const available = me.tp - protection.cost - option.equipCost
				for (let cost = 0; cost <= available; cost++) {
					budget.tick()
					const attack = option.states[cost]
					if (attack === undefined || (option.weapon !== null && attack.weaponShots === 0)) continue
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
						score: usefulDamage - weight * penalizedDanger + weight * protection.heal
					}
					if (better(candidate, best)) best = candidate
				}
			}
		}
	}
	return actionable ? best : null
}

function interrupted(reason: string): void {
	log(() => `[Tactical] execution: ${reason}`, LOG_CONTEXT.PLANNING)
}

/** Contrôles natifs répétés : un échec ne déclenche jamais une seconde séquence historique après dépense. */
export function executeTacticalPlan(me: Me, plan: TacticalPlan): void {
	log(() => `[Tactical] target #${plan.target.id}, useful ${plan.usefulDamage.toFixed(1)}, ` +
		`potential danger ${plan.danger.toFixed(1)}, PT ${plan.tpUsed}, PM ${plan.beforeMp}+${plan.afterMp}`,
	LOG_CONTEXT.PLANNING)
	if (me.life <= 0) return
	if (!same(me.cell, plan.shotCell)) {
		const current = computeReachableCells(me, me.mp, Fight.turn)
		const cost = current.costTo(plan.shotCell)
		if (cost === null || cost > plan.beforeMp) { interrupted("shot cell blocked"); return }
		me.moveToward(plan.shotCell, cost)
		if (!same(me.cell, plan.shotCell)) { interrupted("shot cell not reached"); return }
	}
	const used = new Set<Chip>()
	const cast = (chip: Chip, target: Entity): void => {
		if (me.life > 0 && target.life > 0 && !used.has(chip) && me.chips.includes(chip) &&
			chip.currentCooldown === 0 && maxUsesOf(chip) > 0 && me.tp >= chip.cost &&
			me.canUseChip(chip, target)) {
			used.add(chip)
			me.useChip(chip, target)
		} else interrupted(`chip unavailable: ${chip.name}`)
	}
	for (const chip of plan.protection) cast(chip, me)
	if (plan.weapon !== null && me.weapon !== plan.weapon && me.tp >= 1 && me.life > 0) {
		me.setWeapon(plan.weapon)
	}
	for (const chip of plan.chips) cast(chip, plan.target)
	for (let shot = 0; shot < plan.weaponShots; shot++) {
		if (me.life <= 0 || plan.target.life <= 0 || plan.weapon === null || me.weapon !== plan.weapon ||
			shot >= maxUsesOf(plan.weapon) || me.tp < plan.weapon.cost || !me.canUseWeapon(plan.target)) {
			interrupted("weapon/target unavailable")
			break
		}
		me.useWeapon(plan.target)
	}
	if (me.life <= 0 || same(me.cell, plan.destination)) return
	const current = computeReachableCells(me, Math.min(me.mp, plan.afterMp), Fight.turn)
	const cost = current.costTo(plan.destination)
	if (cost === null) { interrupted("final cell blocked"); return }
	me.moveToward(plan.destination, cost)
	if (!same(me.cell, plan.destination)) interrupted("final cell not reached")
}
