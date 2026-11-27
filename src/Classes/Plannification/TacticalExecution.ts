// @version:5.8
// file version: 1
import { computeReachableCells } from "../Context/ReachableCells.js"
import { chipUsesOf, maxUsesOf } from "../Context/ShotPlan.js"
import { log, LOG_CONTEXT } from "../../Toolbox/Logger.js"
import { ExecutionBudget, EXECUTION_BUDGET_POLICY } from "./ExecutionBudget.js"
import { track } from "../Context/StagnationTracker.js"
import { TacticalPlan, same } from "./TacticalTypes.js"

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
		order: ["approach", "boost", "protection", "equipment if needed", "offensive chips", "weapon shots", "final move"],
		target: { id: plan.target.id, position: { x: plan.target.cell.x, y: plan.target.cell.y } },
		origin: { x: me.cell.x, y: me.cell.y },
		shotCell: { x: plan.shotCell.x, y: plan.shotCell.y },
		destination: { x: plan.destination.x, y: plan.destination.y },
		tp: { available: me.tp, planned: plan.tpUsed, gainedFromBoost: plan.boost?.tpGain ?? 0,
			remainingIfExecuted: me.tp - plan.tpUsed + (plan.boost?.tpGain ?? 0) },
		mp: { available: me.mp, before: plan.beforeMp, after: plan.afterMp },
		weapon: plan.weapon === null ? null : { name: plan.weapon.name, cost: plan.weapon.cost,
			equipTp: me.weapon === plan.weapon ? 0 : 1, shots: plan.weaponShots },
		chips: plan.chips.map((chip) => ({ name: chip.name, cost: chip.cost })),
		boost: (plan.boost?.chips ?? []).map((chip) => ({ name: chip.name, cost: chip.cost })),
		protection: plan.protection.map((chip) => ({ name: chip.name, cost: chip.cost })),
		attackLegality: plan.weaponShots > 0 || plan.chips.length > 0
			? "native cells; range/LOS checked in selection, native permission rechecked at execution"
			: "no attack selected",
		usefulDamage: plan.usefulDamage, danger: currentState() ? plan.danger : null,
		score: currentState() ? plan.score : null, nextTurn: currentState() ? plan.nextTurn ?? 0 : null,
		stateCurrent: currentState(),
		progress: plan.progress ?? 0, progressModel: plan.progressModel ?? "Manhattan",
		stagnation: plan.stagnation ?? null,
		searchStatus: plan.searchStatus ?? "complete search",
		executionBudget: EXECUTION_BUDGET_POLICY,
		estimates: "damage/score/danger modeled, not guaranteed outcome"
	})}`, LOG_CONTEXT.PLANNING)
	if (me.life <= 0 || !available()) return
	if (!currentState()) { interrupted("enemy positions/turn changed; plan unavailable"); return }
	if (!same(me.cell, plan.shotCell)) {
		// Seules les cases à au plus `beforeMp` pas comptent (au-delà : « shot cell blocked », comme avec `me.mp`).
		const current = computeReachableCells(me, Math.min(me.mp, plan.beforeMp), Fight.turn)
		const cost = current.costTo(plan.shotCell)
		if (!available()) return
		if (cost === null || cost > plan.beforeMp) { interrupted("shot cell blocked"); return }
		phase(me, "approach", () => ({ to: { x: plan.shotCell.x, y: plan.shotCell.y }, mpCost: cost }))
		if (!available()) return
		track(me, "move", null, () => me.moveToward(plan.shotCell, cost))
		if (!same(me.cell, plan.shotCell)) { interrupted("shot cell not reached"); return }
	}
	if (!currentState()) { interrupted("enemy positions/turn changed after approach; stop"); return }
	// Lancers déjà tentés par puce : une puce sans cooldown de base peut être relancée (`chipUsesOf`), les autres non.
	const casts = new Map<Chip, number>()
	const cast = (chip: Chip, target: Entity, name: string): void => {
		if (!available()) return
		if (me.life > 0 && target.life > 0 && (casts.get(chip) ?? 0) < chipUsesOf(chip) && me.chips.includes(chip) &&
			chip.currentCooldown === 0 && me.tp >= chip.cost &&
			me.canUseChip(chip, target)) {
			casts.set(chip, (casts.get(chip) ?? 0) + 1)
			phase(me, name, () => ({ chip: chip.name, target: target.id, tpCost: chip.cost }))
			if (!available()) return
			const result = track(me, chip, target, () => me.useChip(chip, target))
			if (!(result > 0)) {
				casts.set(chip, Infinity) // refus natif : aucun autre lancer de cette puce n'est tenté
				interrupted(`chip refused: ${chip.name}, result ${result}`)
			}
		} else interrupted(`chip unavailable: ${chip.name}`)
	}
	// Boost avant tout le reste : les PT, la force et l'agilité (critiques) qu'il donne servent aux actions suivantes du même plan.
	for (const chip of plan.boost?.chips ?? []) cast(chip, me, "boost")
	for (const chip of plan.protection) cast(chip, me, "protection")
	if (!available()) return
	if (plan.weapon !== null && me.weapon !== plan.weapon && me.tp >= 1 && me.life > 0) {
		phase(me, "equipment", () => ({ weapon: plan.weapon!.name, tpCost: 1 }))
		if (!available()) return
		track(me, "equip", null, () => me.setWeapon(plan.weapon!))
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
		const result = track(me, plan.weapon, plan.target, () => me.useWeapon(plan.target))
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
	track(me, "move", null, () => me.moveToward(plan.destination, cost))
	if (!same(me.cell, plan.destination)) interrupted("final cell not reached")
}
