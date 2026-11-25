// @version:5.8
// file version: 7
import { computeReachableCells, MOVE_NEIGHBOR_OFFSETS, ReachableCells } from "../Context/ReachableCells.js"
import { aliveEnemies } from "../Context/Targets.js"
import { maxUsesOf, toCandidate } from "../Context/ShotPlan.js"
import { LeekProfile } from "../LeekProfile.js"
import { Plannification } from "./Plannification.js"
import { TacticalContext, TacticalPreparation } from "./TacticalPlanner.js"
import { log, LOG_CONTEXT, LogText, getLogConfig } from "../../Toolbox/Logger.js"
import { ExecutionBudget, EXECUTION_BUDGET_POLICY, hasExecutionRoom } from "./ExecutionBudget.js"

const key = (cell: Cell): number => cell.x * 4096 + cell.y
const same = (a: Cell, b: Cell): boolean => key(a) === key(b)
const emitMessage = (text: LogText): void => log(() =>
	`[Reserve] ${typeof text === "function" ? text() : text}`, LOG_CONTEXT.PLANNING)

function phase(me: Me, name: string, details: () => unknown): void {
	emitMessage(() => `phase before action ${JSON.stringify({
		phase: name, from: { x: me.cell.x, y: me.cell.y }, tp: me.tp, mp: me.mp, details: details()
	})}`)
}

/** Bornes de travail, PAS des mesures d'ops. Pas de produit départ/tir/destination. */
export const RESERVE_LIMITS = { enemies: 4, weapons: 4, chips: 8, cells: 500, nativeCells: 613, lateCells: 8 } as const
// Recherche seulement : l'exécution utilise la réserve globale, pas ce chronomètre.
const SEARCH_FRACTION = 0.03

interface Shot {
	target: Entity
	weapon: Weapon | null
	chip: Chip | null
	cell: Cell
	cost: number
	damage: number
}

interface ProgressOption { cell: Cell; cost: number; score: number }

interface RetreatDecision {
	mode: "modeled" | "geometric" | "hold"
	from: Cell
	cell: Cell | null
	cost: number
	mpLimit: number
	awayFrom: Entity | null
	reason: string
	complete: boolean
}

/**
 * Un seul parcours local depuis la case de tir prévue. Tout trajet
 * départ → tir → fin de coût total ≤ PM initiaux reste dans la zone initiale.
 * Aucun Field, fournisseur natif ou nouveau dangerAt ; même ordre BFS que le déplacement.
 */
function cachedRetreat(
	me: Me, from: Cell, mp: number, reachable: ReachableCells,
	dangers: ReadonlyMap<number, number>, budget: () => boolean
): RetreatDecision {
	const result: RetreatDecision = { mode: "hold", from, cell: from, cost: 0, mpLimit: mp,
		awayFrom: null, reason: "no lower modeled danger reachable", complete: false }
	let lowest = dangers.get(key(from))
	if (lowest === undefined) { result.reason = "current danger unknown"; return result }
	const cells = new Map<number, Cell>()
	for (const { cell } of reachable.entries()) {
		if (!budget()) { result.reason = "completion margin; hold"; return result }
		cells.set(key(cell), cell)
	}
	const queue = [{ cell: from, cost: 0 }]
	const seen = new Set<number>([key(from)])
	for (let head = 0; head < queue.length; head++) {
		if (!budget()) { result.reason = "completion margin; best evaluated ending only"; return result }
		const { cell, cost } = queue[head]!
		const value = dangers.get(key(cell))
		if (value !== undefined && value < lowest) {
			lowest = value
			result.mode = "modeled"; result.cell = cell; result.cost = cost
			result.reason = "strictly lower modeled danger; not safety"
		}
		if (cost >= mp) continue
		for (const [dx, dy] of MOVE_NEIGHBOR_OFFSETS) {
			const id = (cell.x + dx) * 4096 + cell.y + dy
			const next = cells.get(id)
			if (!next || next.obstacle || seen.has(id) ||
				(next.entity !== null && next.entity.id !== me.id)) continue
			seen.add(id)
			queue.push({ cell: next, cost: cost + 1 })
		}
	}
	result.complete = true
	return result
}

/** Distance de trajet vers une case de tir future ; parcours inverse multi-source borné. */
function progressDistances(me: Me, goals: readonly Cell[], budget: () => boolean): Map<number, number> {
	const distances = new Map<number, number>()
	const queue: Cell[] = []
	for (const cell of goals) {
		if (queue.length >= RESERVE_LIMITS.cells) break
		if (cell.obstacle || distances.has(key(cell))) continue
		// Une cible occupée est autorisée comme graine uniquement (progrès sans arme abordable).
		distances.set(key(cell), 0)
		queue.push(cell)
	}
	for (let head = 0; head < queue.length; head++) {
		if (head % 64 === 0 && !budget()) break
		const cell = queue[head]!
		for (const [dx, dy] of MOVE_NEIGHBOR_OFFSETS) {
			const next = Field.cellFromXY(cell.x + dx, cell.y + dy)
			if (!next || next.obstacle || distances.has(key(next)) ||
				(next.entity !== null && next.entity.id !== me.id)) continue
			if (queue.length >= RESERVE_LIMITS.cells) return distances
			distances.set(key(next), distances.get(key(cell))! + 1)
			queue.push(next)
		}
	}
	return distances
}

/**
 * Plan B séquentiel : une approche minimale, attaques contrôlées sur place, un repli.
 * false uniquement si l'API nécessaire est absente, AVANT toute dépense (anciens hôtes).
 */
export function executeReservePlan(
	me: Me, profile: LeekProfile, context?: TacticalContext, preparation?: TacticalPreparation
): boolean {
	if (typeof Field === "undefined" || typeof Field.cellFromXY !== "function" ||
		typeof Fight.weaponCells !== "function" || typeof me.canUseChip !== "function") return false

	const startOps = typeof System === "undefined" ? 0 : System.operations
	let loggingOps = 0
	const planningLogs = getLogConfig().isEnabled(LOG_CONTEXT.PLANNING)
	const message = (text: LogText): void => {
		if (!planningLogs) return
		const before = typeof System === "undefined" ? 0 : System.operations
		emitMessage(text)
		if (typeof System !== "undefined") loggingOps += Math.max(0, System.operations - before)
	}
	const globalBudget = (): boolean => typeof System === "undefined" ||
		!Number.isFinite(System.maxOperations) || System.maxOperations <= 0 ||
		System.operations < System.maxOperations * 0.70
	let executionBudget: ExecutionBudget | null = null
	const budget = (): boolean => executionBudget ? executionBudget.available() : hasExecutionRoom()
	const searchBudget = (): boolean => globalBudget() && (typeof System === "undefined" ||
		!Number.isFinite(System.maxOperations) || System.maxOperations <= 0 ||
		System.operations - startOps - loggingOps < System.maxOperations * SEARCH_FRACTION)
	const origin = me.cell
	const initialMp = me.mp
	const turn = Fight.turn
	let moved = false
	let spentMp = 0
	try {
		const allEnemies = aliveEnemies().filter((enemy) => enemy.life > 0)
		if (allEnemies.length === 0 || me.life <= 0) return true
		const enemies = allEnemies.slice(0, RESERVE_LIMITS.enemies)
		const positions = allEnemies.map((enemy) => ({ enemy, cell: enemy.cell }))
		const unchanged = (): boolean => Fight.turn === turn &&
			positions.every(({ enemy, cell }) => same(enemy.cell, cell))
		const supplied = context?.reachable
		let reachable: ReachableCells | null = supplied && !supplied.truncated &&
			supplied.size <= RESERVE_LIMITS.cells && supplied.isUpToDate(me.id, origin, initialMp, turn)
			? supplied : null
		if (!reachable && searchBudget()) reachable = computeReachableCells(me, initialMp, turn)
		const reusable = preparation && preparation.entityId === me.id && preparation.turn === turn &&
			same(preparation.origin, origin) && preparation.mp === initialMp && preparation.tp === me.tp &&
			preparation.reachable === reachable && preparation.enemies.length === allEnemies.length &&
			preparation.enemies.every(({ enemy, cell }) => allEnemies.includes(enemy) && same(enemy.cell, cell))
			? preparation : null
		const objective = enemies[0]!
		const distanceToObjective = (cell: Cell): number =>
			Math.abs(cell.x - objective.cell.x) + Math.abs(cell.y - objective.cell.y)
		const weight = (profile.strategyName === "DEFENSIVE" ? 1.25 :
			profile.strategyName === "AGGRESSIVE" ? 0.75 : 1) * (1.5 - profile.aggression / 100)
		// Sélection partielle AVANT les validations/fournisseurs coûteux, uniquement avec
		// les coûts de trajet déjà calculés. Aucun danger n'est crédité à ce stade.
		let geometricEmergency: ProgressOption | null = null
		if (reachable && !reachable.truncated) {
			for (const entry of reachable.entries()) {
				if (!searchBudget()) break
				const progress = distanceToObjective(origin) - distanceToObjective(entry.cell)
				if (entry.cost > 0 && progress > 0 &&
					(geometricEmergency === null || progress > geometricEmergency.score)) {
					geometricEmergency = { cell: entry.cell, cost: entry.cost, score: progress }
				}
			}
		}
		const threat = context?.threat
		let known = !!(reachable && threat && !reachable.truncated && !threat.truncated &&
			!threat.inputsTruncated && threat.turn === turn && threat.entityId === me.id &&
			threat.candidateCells === reachable.size && supplied === reachable &&
			threat.enemyCount === allEnemies.length &&
			(!preparation || preparation.enemies.every(({ enemy, cell }) => same(enemy.cell, cell))))
		const cachedDangers = known ? reusable?.dangers : null
		const dangers = new Map<number, number>(cachedDangers ?? [])
		let modeledEmergency: ProgressOption | null = null
		let shortEmergency: ProgressOption | null = null
		let validationInterrupted = false
		if (known && reachable && threat) {
			for (const { cell } of reachable.entries()) {
				if (!searchBudget()) {
					if (!cachedDangers) { known = false; validationInterrupted = true }
					break
				}
				const value = cachedDangers ? cachedDangers.get(key(cell)) ?? null : threat.dangerAt(cell)
				const withinSearch = searchBudget()
				if (!budget()) { known = false; validationInterrupted = true; break }
				if (value === null || !Number.isFinite(value) || value < 0) { known = false; break }
				// Un résultat déjà obtenu reste évaluable dans la marge d'action. Le jeter
				// parce que cet appel franchit 3 % perdait précisément le candidat de secours.
				dangers.set(key(cell), value)
				const originDanger = dangers.get(key(origin))
				const progress = distanceToObjective(origin) - distanceToObjective(cell)
				const cost = reachable.costTo(cell)
				const score = progress - weight * value
				if (originDanger !== undefined && cost !== null && cost > 0 &&
					(profile.allowHiding || progress > 0) &&
					score > -weight * originDanger) {
					if (modeledEmergency === null || score > modeledEmergency.score) modeledEmergency = { cell, cost, score }
					if (cost === 1 && (shortEmergency === null || score > shortEmergency.score)) shortEmergency = { cell, cost, score }
				}
				if (!withinSearch) { known = false; validationInterrupted = true; break }
			}
		}
		// Un scan interrompu n'autorise NI une carte complète NI un repli géométrique
		// ignorant les dangers déjà lus. Seul un couple départ/destination évalué sert.
		const emergency = known || validationInterrupted ? modeledEmergency : geometricEmergency
		const danger = (cell: Cell): number | null => known && unchanged() ? dangers.get(key(cell)) ?? null : null
		const progressDanger = (cell: Cell): number | null =>
			(known || validationInterrupted) && unchanged() ? dangers.get(key(cell)) ?? null : null
		if (validationInterrupted) {
			message(() => `danger validation: ${budget() ? "search margin reached" : "hard operations reserve reached"}; ` +
				"partial scan; only evaluated origin/destination eligible")
		}
		if (reusable) message("reuse current evaluation: validated danger/native weapon cells; no second full search")
		message(() => `start; danger ${known ? "modeled (all enemies)" :
			validationInterrupted ? "partial; evaluated cells only, map incomplete" : "unknown; geometric fallback"}; ` +
			`PM ${initialMp}; targets ${enemies.length}/${allEnemies.length}; ` +
			`after validation ops delta ${typeof System === "undefined" ? "unknown" : System.operations - startOps}`)
		const weapons = [...new Set(me.weapon ? [me.weapon, ...me.weapons] : me.weapons)]
			.slice(0, RESERVE_LIMITS.weapons)
		const chips = me.chips.slice(0, RESERVE_LIMITS.chips)
		if (allEnemies.length > enemies.length || me.weapons.length > weapons.length || me.chips.length > chips.length) {
			message("candidate cap; partial heuristic, not optimum")
		}
		// Borne prudente : hors portée maximale + PM, aucun fournisseur de tir n'est utile.
		// Le cas inverse ne prouve ni tir, ni LOS ; la sélection peut rester incomplète.
		let attackMayBeReachable = false
		const mayReach = (target: Entity, range: number): boolean => !Number.isFinite(range) ||
			Math.abs(origin.x - target.cell.x) + Math.abs(origin.y - target.cell.y) <= range + initialMp
		let goals: Cell[] | null = null
		let best: Shot | null = null
		const consider = (shot: Shot): void => {
			if (best === null || shot.cost < best.cost) { best = shot; return }
			if (shot.cost !== best.cost) return
			const candidateDanger = danger(shot.cell)
			const bestDanger = danger(best.cell)
			// Sans deux valeurs connues, comparer seulement les dégâts, jamais un danger fictif.
			const wins = candidateDanger === null || bestDanger === null
				? shot.damage > best.damage
				: shot.damage - weight * candidateDanger > best.damage - weight * bestDanger
			if (wins) best = shot
		}
		// Nombre borné d'items/cibles ; pas de BFS depuis chaque case de tir.
		for (const target of enemies) {
			for (const weapon of weapons) {
				const candidate = toCandidate(weapon, false, me.strength)
				const equip = me.weapon === weapon ? 0 : 1
				if (!candidate || !Number.isInteger(candidate.cost) || candidate.cost + equip > me.tp) continue
				const potentiallyReachable = mayReach(target, weapon.maxRange)
				if (potentiallyReachable) attackMayBeReachable = true
				const damage = Math.min(target.life, candidate.damage *
					Math.min(candidate.uses, Math.floor((me.tp - equip) / candidate.cost)))
				const cachedCells = reusable?.weaponCells.get(target)?.get(weapon)
				const currentPermission = reusable?.currentWeapons.get(target)?.get(weapon)
				if (currentPermission === true ||
					(!cachedCells && currentPermission === undefined && searchBudget() && me.canUseWeapon(target, weapon))) {
					consider({ target, weapon, chip: null, cell: me.cell, cost: 0, damage })
				}
				// À 0 PM, le contrôle natif courant suffit ; aucun fournisseur hypothétique nécessaire.
				if (!reachable || me.mp <= 0 || !potentiallyReachable || (!cachedCells && !searchBudget())) continue
				const cells = cachedCells ?? Fight.weaponCells(target, weapon)
				if (!budget() || cells.length > RESERVE_LIMITS.nativeCells) continue
				if (!searchBudget()) {
					// Le fournisseur a déjà renvoyé ses résultats : vérification bornée, pas de
					// nouvel appel/recherche. Garder une vraie option de tir si elle est dans ce préfixe.
					for (let i = 0; i < Math.min(cells.length, RESERVE_LIMITS.lateCells) && budget(); i++) {
						const cell = cells[i]!
						const cost = reachable.costTo(cell)
						if (cost !== null) consider({ target, weapon, chip: null, cell, cost, damage })
					}
					continue
				}
				if (target === enemies[0] && goals === null) {
					goals = cells.filter((cell) => !cell.obstacle &&
						(cell.entity === null || cell.entity.id === me.id))
				}
				let scanned = 0
				for (const cell of cells) {
					if (++scanned % 64 === 0 && !searchBudget()) break
					const cost = reachable.costTo(cell)
					if (cost !== null) consider({ target, weapon, chip: null, cell, cost, damage })
				}
			}
			for (const chip of chips) {
				const candidate = toCandidate(chip, true, me.strength)
				if (!candidate || !Number.isInteger(candidate.cost) || chip.currentCooldown !== 0 || chip.cost > me.tp) continue
				if (mayReach(target, chip.maxRange)) attackMayBeReachable = true
				if (!searchBudget() || !me.canUseChip(chip, target)) continue
				// Restrictions hypothétiques non vérifiées : puces uniquement depuis la case actuelle.
				consider({ target, weapon: null, chip, cell: me.cell, cost: 0,
					damage: Math.min(target.life, candidate.damage) })
			}
		}
		// TS ne suit pas les affectations faites par consider().
		const shot = best as Shot | null
		// Choisir AVANT l'aperçu et avant dépense. Un BFS inverse interrompu ne jette
		// plus les entrées déjà évaluées ; près du tir garder une option courte (1 PM).
		let progressDecision: { cell: Cell; cost: number; phase: string } | null = null
		if (!shot) {
			if (emergency && !attackMayBeReachable) {
				progressDecision = { ...emergency, phase: "cached progress" }
			} else if (reachable && searchBudget()) {
				const distances = progressDistances(me, goals?.length ? goals : [objective.cell], searchBudget)
				const originDistance = distances.get(key(origin))
				const originDanger = danger(origin)
				let score = originDanger === null ? 0 : -weight * originDanger
				for (const entry of reachable.entries()) {
					if (!searchBudget()) break
					const distance = distances.get(key(entry.cell))
					const progress = originDistance !== undefined && distance !== undefined ? originDistance - distance : 0
					if (!profile.allowHiding && progress <= 0) continue
					const cellDanger = danger(entry.cell)
					if (originDanger !== null && cellDanger === null) continue
					const value = progress - (originDanger === null ? 0 : weight * cellDanger!)
					if (value > score) {
						score = value
						progressDecision = { cell: entry.cell, cost: entry.cost, phase: "progress" }
					}
				}
			}
			if (!progressDecision && shortEmergency && budget()) {
				progressDecision = { ...shortEmergency, phase: "short evaluated progress/cover" }
			}
		}
		// Candidat fixé : finalisation locale bornée, sans relancer la recherche offensive.
		// Sa marge globale couvre aussi aperçu/phases/contrôles, jamais l'ancien chrono relatif.
		executionBudget = new ExecutionBudget()
		const equipTp = shot?.weapon && me.weapon !== shot.weapon ? 1 : 0
		const shotsAtMost = shot?.weapon
			? Math.min(maxUsesOf(shot.weapon), Math.floor((me.tp - equipTp) / shot.weapon.cost), 30) : 0
		const attackTp = shot?.weapon ? shotsAtMost * shot.weapon.cost : shot?.chip?.cost ?? 0
		const actionCell = shot?.cell ?? progressDecision?.cell ?? origin
		const approachMp = shot?.cost ?? progressDecision?.cost ?? 0
		const remainingMp = Math.max(0, initialMp - approachMp)
		const strategy = new Plannification(me, objective, profile).strategy
		const supportEligible = (chip: Chip, from: Cell, target: Entity): boolean => {
			const heal = chip.features.some((f) => f.type === Effect.HEAL)
			const shield = chip.features.some((f) => f.type === Effect.ABSOLUTE_SHIELD || f.type === Effect.RELATIVE_SHIELD)
			const life = me.life / me.maxLife
			const distance = Math.abs(from.x - target.cell.x) + Math.abs(from.y - target.cell.y)
			return (heal || shield) && chip.features.every((f) =>
				f.type === Effect.HEAL || f.type === Effect.ABSOLUTE_SHIELD || f.type === Effect.RELATIVE_SHIELD) &&
				(!heal || (profile.allowHealing &&
				(strategy.shouldHeal(life, 1 - life) || strategy.shouldHealWithThreat(life, 1 - life, distance)))) &&
				(!shield || (profile.allowShielding && strategy.shouldShield(life, distance,
					target.mp + (target.weapon?.maxRange ?? 1))))
		}
		const supportSteps: Array<{ chip: Chip; selected: boolean; tpBefore: number; tpAfter: number;
			thresholdMet: boolean }> = []
		const supportOmissions: Array<{ chip: Chip; reason: string }> = []
		let supportComplete = true
		let projectedTp = Math.max(0, me.tp - equipTp - attackTp)
		for (const chip of chips) {
			if (!budget()) { supportComplete = false; break }
			const heal = chip.features.some((f) => f.type === Effect.HEAL)
			const shield = chip.features.some((f) => f.type === Effect.ABSOLUTE_SHIELD || f.type === Effect.RELATIVE_SHIELD)
			let reason = ""
			if ((!heal && !shield) || chip.features.some((f) =>
				f.type !== Effect.HEAL && f.type !== Effect.ABSOLUTE_SHIELD && f.type !== Effect.RELATIVE_SHIELD)) {
				reason = "not pure support"
			} else if ((heal && !profile.allowHealing) || (shield && !profile.allowShielding)) reason = "profile forbids support"
			else if (chip.currentCooldown !== 0 || maxUsesOf(chip) <= 0) reason = "cooldown/uses unavailable"
			else if (!Number.isInteger(chip.cost) || chip.cost <= 0 || chip.cost > me.tp) reason = "invalid/unaffordable cost"
			if (reason) { supportOmissions.push({ chip, reason }); continue }
			const thresholdMet = supportEligible(chip, actionCell, objective)
			const selected = thresholdMet && chip.cost <= projectedTp
			const tpBefore = projectedTp
			if (selected) projectedTp -= chip.cost
			// Alternatives explicites si tirs interrompus/support précédent refusé ou seuil changé.
			// Pas de test natif depuis une position hypothétique : contrôle sur soi à l'exécution.
			supportSteps.push({ chip, selected, tpBefore, tpAfter: projectedTp, thresholdMet })
		}
		const nearestFrom = (from: Cell): Entity | null => {
			let nearest: Entity | null = null, distance = Infinity
			for (const enemy of allEnemies) {
				if (enemy.life <= 0) continue
				const value = Math.abs(from.x - enemy.cell.x) + Math.abs(from.y - enemy.cell.y)
				if (value < distance) { nearest = enemy; distance = value }
			}
			return nearest
		}
		let retreatPlan: RetreatDecision = { mode: "hold", from: actionCell, cell: actionCell, cost: 0,
			mpLimit: remainingMp, awayFrom: null, complete: true,
			reason: !shot ? "no attack selected; progress/hold already decided" :
				!profile.allowHiding ? "profile forbids retreat" : "no remaining MP" }
		if (shot && profile.allowHiding && remainingMp > 0) {
			if (known && unchanged() && reachable) {
				retreatPlan = cachedRetreat(me, actionCell, remainingMp, reachable, dangers, budget)
			} else {
				retreatPlan = { mode: "geometric", from: actionCell, cell: null, cost: 0,
					mpLimit: remainingMp, awayFrom: nearestFrom(actionCell), complete: true,
					reason: "danger unknown; geometric only, no safety claim" }
			}
		}
		message(() => {
			return `plan before execution ${JSON.stringify({
				mode: "bounded sequence with explicit conditional branches; native checks may cancel",
				order: shot ? ["approach", "equipment if needed", "conditional attack", "planned support", "planned retreat"]
					: ["planned progress/hold", "planned support"],
				target: { id: (shot?.target ?? enemies[0]!).id,
					position: { x: (shot?.target ?? enemies[0]!).cell.x, y: (shot?.target ?? enemies[0]!).cell.y } },
				origin: { x: me.cell.x, y: me.cell.y }, tpAvailable: me.tp, mpAvailable: me.mp,
				ops: typeof System === "undefined" ? null : {
					current: System.operations, relative: System.operations - startOps,
					searchConsumed: System.operations - startOps - loggingOps, loggingConsumed: loggingOps,
					searchFraction: SEARCH_FRACTION, researchGlobalFraction: 0.70,
					executionMargin: EXECUTION_BUDGET_POLICY
				},
				approach: shot ? { to: { x: shot.cell.x, y: shot.cell.y }, mpCost: shot.cost,
					mpRemainingIfReached: me.mp - shot.cost } : null,
				progressSelection: progressDecision ? {
					to: { x: progressDecision.cell.x, y: progressDecision.cell.y }, mpCost: progressDecision.cost,
					danger: progressDanger(progressDecision.cell), status: "selected; native path/state checks may cancel"
				} : null,
				attack: shot ? { weapon: shot.weapon?.name ?? null, equipTp, weaponShotsAtMost: shotsAtMost,
					weaponTpAtMost: shot.weapon ? shotsAtMost * shot.weapon.cost : 0,
					chip: shot.chip ? { name: shot.chip.name, cost: shot.chip.cost } : null,
					condition: "recheck real position, target, equipment, PT and native permission after approach" } : null,
				protection: supportSteps.filter((step) => step.selected).map((step) => ({
					chip: step.chip.name, target: me.id, tpCost: step.chip.cost,
					tpBefore: step.tpBefore, tpAfter: step.tpAfter
				})),
				support: {
					alternatives: supportSteps.filter((step) => !step.selected).map((step) => ({
						chip: step.chip.name, tpCost: step.chip.cost,
						when: !step.thresholdMet ? "strategy threshold becomes satisfied" : "earlier actions spend less PT"
					})),
					omitted: supportOmissions.map(({ chip, reason }) => ({ chip: chip.name, reason })),
					complete: supportComplete,
					condition: "listed chips only, in inventory order; actual PT/life/threshold/cooldown/native self permission; living enemy required",
					absenceReason: supportSteps.some((step) => step.selected) ? null :
						!supportComplete ? "completion margin; unexamined chips not scheduled" : "no eligible support fits projected PT"
				},
				destination: retreatPlan.cell ? { x: retreatPlan.cell.x, y: retreatPlan.cell.y } : null,
				resources: { tpInitial: me.tp, equipment: equipTp, attack: attackTp,
					support: me.tp - equipTp - attackTp - projectedTp, tpRemainingIfExecuted: projectedTp,
					mpInitial: initialMp, approachOrProgress: approachMp,
					retreat: retreatPlan.mode === "geometric" ? null : retreatPlan.cost,
					mpRemainingIfExecuted: retreatPlan.mode === "geometric" ? null : remainingMp - retreatPlan.cost },
				emergencyProgress: emergency && !attackMayBeReachable ? {
					to: { x: emergency.cell.x, y: emergency.cell.y }, mpCost: emergency.cost,
					condition: "objective beyond modeled attack bound; execution margin available and unchanged state",
					originDanger: progressDanger(origin), danger: progressDanger(emergency.cell),
					scope: validationInterrupted ? "evaluated origin/destination only; map incomplete" : known ? "complete validated map" : "unknown",
					status: "partial geometric progress/cover, not safety"
				} : null,
				retreat: { allowed: profile.allowHiding, mode: retreatPlan.mode, status: retreatPlan.reason,
					from: { x: actionCell.x, y: actionCell.y },
					mpCost: retreatPlan.mode === "geometric" ? null : retreatPlan.cost, mpLimit: remainingMp,
					awayFrom: retreatPlan.awayFrom?.id ?? null, complete: retreatPlan.complete,
					danger: retreatPlan.cell ? danger(retreatPlan.cell) : null,
					alternatives: {
						failedApproach: "stop entire sequence",
						refusedAttackOrDeadTarget: "stop attacks; listed support with real PT, then planned retreat",
						blockedDestination: "hold; do not start a second sequence",
						displacedOrReducedMP: "one bounded local path check; lowest cached known danger, else hold",
						staleDanger: "if allowed and MP remain, geometric away from nearest living enemy; no safety claim",
						apiFailure: "stop; report ERROR; no second sequence",
						insufficientExecutionMargin: "stop"
					} },
				dangerAtShot: shot ? danger(shot.cell) : null,
				dangerStatus: known && unchanged() ? "modeled, not safety" :
					validationInterrupted ? "partial; only evaluated origin/destination, not a complete map or safety" : "unknown",
				score: null, scoreStatus: "bounded heuristic; no global optimization score"
			})}`
		})
		const move = (cell: Cell, cost: number, phase: string, cachedEmergency = false): boolean => {
			if (cost === 0) {
				if (!same(me.cell, cell)) { message(() => `${phase}: position changed; stop`); return false }
				return true
			}
			if (!budget() || me.life <= 0 || cost > Math.min(me.mp, initialMp - spentMp)) {
				message(() => `${phase}: budget stop`); return false
			}
			let actual: number | null = cost
			if (cachedEmergency) {
				if (!same(me.cell, origin) || !unchanged() || objective.life <= 0 || cell.obstacle ||
					(cell.entity !== null && cell.entity.id !== me.id)) {
					message("emergency progress: state changed/blocked; stop"); return false
				}
				// Pas de nouvelle recherche après la marge interne. Le moteur valide le trajet,
				// avec limite PM stricte ; une arrivée partielle reste possible et arrête la séquence.
			} else {
				const fresh = computeReachableCells(me, Math.min(me.mp, cost), Fight.turn)
				actual = fresh.costTo(cell)
			}
			if (!budget() || actual === null || actual > cost) { message(() => `${phase}: blocked/budget`); return false }
			const before = me.mp
			message(() => `phase before action ${JSON.stringify({
				phase, from: { x: me.cell.x, y: me.cell.y }, to: { x: cell.x, y: cell.y },
				mpCost: actual, tp: me.tp, mp: me.mp,
				destinationDanger: cachedEmergency ? progressDanger(cell) : danger(cell),
				originDanger: cachedEmergency ? progressDanger(origin) : danger(me.cell),
				dangerScope: validationInterrupted ? "evaluated origin/destination only; map incomplete" : known ? "complete validated map" : "unknown"
			})}`)
			if (!budget()) { message(() => `${phase}: hard operations reserve; stop before action`); return false }
			me.moveToward(cell, actual)
			moved = true
			spentMp += Math.max(0, before - me.mp)
			const reached = same(me.cell, cell) && before - me.mp <= cost
			message(() => `${phase}: PM ${before - me.mp}; ${reached ? "reached" : "not reached; stop"}`)
			return reached && budget()
		}
		if (!budget()) { message("hard operations reserve; no action"); return true }
		if (shot && unchanged() && shot.target.life > 0) {
			if (!move(shot.cell, shot.cost, "approach")) return true
			if (shot.weapon && me.weapon !== shot.weapon && me.tp >= 1 && me.life > 0) {
				phase(me, "equipment", () => ({ weapon: shot.weapon!.name, tpCost: 1 }))
				if (!budget()) { message("equipment: hard operations reserve; stop"); return true }
				me.setWeapon(shot.weapon)
				if (me.weapon !== shot.weapon) message("equipment not applied; weapon attacks remain conditional")
			}
			if (!budget()) { message("attack: hard operations reserve; stop"); return true }
			const weapon = shot.weapon
			let attacks = 0
			if (shot.chip && me.life > 0 && shot.target.life > 0 &&
				shot.chip.currentCooldown === 0 && me.tp >= shot.chip.cost &&
				me.canUseChip(shot.chip, shot.target)) {
				phase(me, "offensive chip", () => ({ chip: shot.chip!.name, target: shot.target.id, tpCost: shot.chip!.cost }))
				if (!budget()) { message("offensive chip: hard operations reserve; stop"); return true }
				const result = me.useChip(shot.chip, shot.target)
				if (result > 0) attacks++
				else message(() => `attack chip refused: ${shot.chip!.name}; result ${result}`)
			}
			if (weapon && weapon === me.weapon) {
				const count = Math.min(shotsAtMost, maxUsesOf(weapon), Math.floor(me.tp / weapon.cost))
				for (let i = 0; i < count; i++) {
					if (!budget()) { message("weapon shot: hard operations reserve; stop"); return true }
					if (me.life <= 0 || shot.target.life <= 0 || me.weapon !== weapon ||
						me.tp < weapon.cost || !me.canUseWeapon(shot.target)) break
					phase(me, "weapon shot", () => ({
						weapon: weapon.name, target: shot.target.id, shot: i + 1, atMost: count, tpCost: weapon.cost
					}))
					if (!budget()) { message("weapon shot: hard operations reserve; stop"); return true }
					const result = me.useWeapon(shot.target)
					if (!(result > 0)) { message(() => `weapon refused: result ${result}`); break }
					attacks++
				}
			}
			message(() => `attack: ${attacks}${attacks === 0 ? "; native refusal/weapon unavailable" : ""}; ` +
				`PT ${me.tp}, PM ${me.mp}`)
		} else if (progressDecision) {
			message(() => `cached partial progress/cover; ${progressDecision!.phase}; ` +
				"selection stopped; execution uses global reserve; danger is not safety")
			if (!move(progressDecision.cell, progressDecision.cost, progressDecision.phase, true)) return true
		} else if (!shot) {
			message(() => `no attack selected; movement unavailable: ${!searchBudget()
				? "search stopped; no evaluated improving candidate" : "no improving candidate"}`)
		}
		if (me.life <= 0) return true
		// Exécuter uniquement les supports/alternatives énumérés AVANT la première action.
		// Les PT réels activent les branches prévues, sans nouvelle sélection d'items.
		const target = enemies.find((enemy) => enemy.life > 0)
		if (target) {
			for (const { chip } of supportSteps) {
				if (!budget()) { message("support: hard operations reserve; stop"); return true }
				if (!me.chips.includes(chip) || !supportEligible(chip, me.cell, target) ||
					chip.currentCooldown !== 0 || maxUsesOf(chip) <= 0 ||
					!Number.isInteger(chip.cost) || chip.cost <= 0 ||
					chip.cost > me.tp || me.life <= 0 || !me.canUseChip(chip, me)) continue
				phase(me, "support", () => ({ chip: chip.name, target: me.id, tpCost: chip.cost }))
				if (!budget()) { message("support: hard operations reserve; stop"); return true }
				const result = me.useChip(chip, me)
				if (result > 0) message(() => `support: ${chip.name}; PT ${me.tp}`)
				else message(() => `support refused: ${chip.name}; result ${result}; PT ${me.tp}`)
			}
		}
		if (!profile.allowHiding || me.mp <= 0 || !shot) return true
		if (!budget()) { message("retreat: operations reserve; stop"); return true }
		if (retreatPlan.mode === "geometric" || !known || !unchanged()) {
			const nearest = nearestFrom(me.cell)
			message("retreat: danger unknown; geometric only, no safety claim")
			if (nearest) {
				phase(me, "geometric retreat", () => ({
					awayFrom: nearest.id, mpLimit: Math.max(0, Math.min(me.mp, initialMp - spentMp)),
					destination: null, danger: null, status: "unknown; no safety claim"
				}))
				if (!budget()) { message("retreat: hard operations reserve; stop"); return true }
				me.moveAwayFrom(nearest, Math.max(0, Math.min(me.mp, initialMp - spentMp)))
			}
			return true
		}
		const actualMp = Math.max(0, Math.min(me.mp, initialMp - spentMp))
		if (!same(me.cell, retreatPlan.from) || actualMp < retreatPlan.mpLimit) {
			// Branche annoncée : déplacement subi / PM consommés par un effet.
			// Pas de nouveau fournisseur ni d'autre approche/attaque/support.
			const remaining = computeReachableCells(me, actualMp, turn)
			if (!budget()) { message("retreat: operations reserve; stop"); return true }
			if (remaining.truncated) { message("retreat: changed position; path data truncated; hold"); return true }
			retreatPlan = cachedRetreat(me, me.cell, actualMp, remaining, dangers, budget)
			message(() => `retreat branch: changed position/MP; ${retreatPlan.reason}`)
		}
		if (retreatPlan.mode === "modeled" && retreatPlan.cell && !same(retreatPlan.cell, me.cell)) {
			move(retreatPlan.cell, retreatPlan.cost, "retreat")
		} else message(() => `retreat: ${retreatPlan.reason}`)
		return true
	} catch (error) {
		// Même en cas d'erreur native après dépense : jamais une seconde séquence complète.
		log(() => JSON.stringify({ level: "ERROR", file: "ReservePlan.ts", function: "executeReservePlan",
			error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
		}), LOG_CONTEXT.ERROR, { sink: "debug" })
		message(() => `API failure; stop (movement attempted=${moved}); no second sequence`)
		return true
	}
}
