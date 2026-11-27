// @version:5.8
// file version: 2
import { MOVE_NEIGHBOR_OFFSETS } from "../Context/ReachableCells.js"
import { toCandidate } from "../Context/ShotPlan.js"
import { log, LOG_CONTEXT } from "../../Toolbox/Logger.js"
import { STAGNATION_TURNS } from "../Context/StagnationTracker.js"
import { Budget, Skipped, TacticalPlan, TacticalPreparation, Unavailable, key, validCost } from "./TacticalTypes.js"
import { PASSIVE_DANGER_LIFE_FRACTION } from "./TacticalScore.js"

/**
 * Sortie de stagnation : au plus 613 cases explorées (toute la carte) et un arrêt facultatif à 2 % de
 * `System.maxOperations` depuis son entrée, comme le trajet futur existant. Aucune mesure d'opérations réelle.
 */
const STAGNATION_ROUTE_CELLS = 613
const STAGNATION_ROUTE_FRACTION = 0.02

interface StagnationInput {
	me: Me
	target: Entity
	turns: number
	weapons: readonly Weapon[]
	attackChips: readonly Chip[]
	chipZones: ReadonlyMap<Chip, Cell[]>
	entries: ReadonlyArray<{ cell: Cell; cost: number }>
	dangers: ReadonlyMap<number, number>
	preparation: TacticalPreparation
	skipped: Skipped
	budget: Budget
	visited: (cell: Cell) => boolean
	/** Poids du risque annulé par la passivité : seul un danger qui atteint `PASSIVE_DANGER_LIFE_FRACTION` × mes PV écarte une case. */
	riskFree: boolean
}

/**
 * Sortie de stagnation (combat 54940819) : après `STAGNATION_TURNS` tours sans tir ni progrès, aller vers la case
 * atteignable ce tour qui rapproche le plus, en distance de MARCHE (BFS, obstacles et occupants), d'une zone de
 * tir native d'une arme ou puce offensive, même si la distance Manhattan augmente (minimum local derrière un mur).
 * La sécurité reste prioritaire : seules les cases de danger ≤ celui de la case actuelle sont candidates (0 ici si
 * je suis sûr) et la marche doit diminuer strictement. Sinon : maintien, motivé dans le journal et dans la raison.
 * Exception `riskFree` (poids du risque annulé par la passivité, comme dans le plan normal) : toute case dont le danger
 * reste sous `PASSIVE_DANGER_LIFE_FRACTION` × mes PV est candidate.
 * La route peut demander plusieurs tours : un déplacement de sortie qui ne bat pas le record de proximité ne remet
 * pas le compteur à zéro (voir `StagnationTracker`) et la cible est recalculée chaque tour.
 */
export function stagnationEscape(input: StagnationInput): TacticalPlan | null {
	const { me, target, turns, weapons, attackChips, chipZones, entries, dangers, preparation, skipped, budget, visited, riskFree } = input
	const hold = (reason: string): null => {
		skipped.noProgress = `stagnation: ${reason}`
		log(() => `[Tactical] stagnation: ${turns} turns without shot or progress (threshold ${STAGNATION_TURNS}); ` +
			`${reason}; holding, safety first`, LOG_CONTEXT.PLANNING)
		return null
	}
	if (typeof Field === "undefined" || typeof Field.cellFromXY !== "function") return hold("walking route unavailable")
	// Zone de tir : cases natives de toutes mes armes/puces offensives (listes déjà obtenues, sinon un appel).
	const goals = new Map<number, Cell>()
	const addZone = (raw: readonly Cell[]): void => {
		if (raw.length > 613) throw new Unavailable("native cells bound")
		for (const cell of raw) {
			budget.tick()
			if (!cell.obstacle && (cell.entity === null || cell.entity.id === me.id)) goals.set(key(cell), cell)
		}
	}
	for (const weapon of weapons) {
		if (!validCost(weapon.cost) || toCandidate(weapon, false, me.strength) === null) continue
		let raw = preparation.weaponCells.get(target)?.get(weapon)
		if (!raw) { budget.check(); raw = Fight.weaponCells(target, weapon); budget.check() }
		addZone(raw)
	}
	for (const chip of attackChips) {
		let raw = chipZones.get(chip)
		if (!raw) { budget.check(); raw = me.chipCells(chip, target); budget.check() }
		addZone(raw)
	}
	if (goals.size === 0) return hold("no firing zone known")
	// BFS inverse depuis la zone de tir jusqu'à avoir étiqueté toutes mes cases atteignables.
	const wanted = new Set(entries.map(({ cell }) => key(cell)))
	const walk = new Map<number, number>()
	const queue: Cell[] = []
	const seen = new Set<number>(goals.keys())
	let missing = wanted.size
	for (const [id, cell] of goals) { walk.set(id, 0); queue.push(cell); if (wanted.has(id)) missing-- }
	const startOps = typeof System === "undefined" ? 0 : System.operations
	for (let head = 0; head < queue.length && missing > 0 && queue.length < STAGNATION_ROUTE_CELLS; head++) {
		budget.tick()
		if (typeof System !== "undefined" && Number.isFinite(System.maxOperations) && System.maxOperations > 0 &&
			System.operations - startOps >= System.maxOperations * STAGNATION_ROUTE_FRACTION) {
			return hold("walking route search stopped by its operations allowance")
		}
		const cell = queue[head]!
		const next = walk.get(key(cell))! + 1
		for (const [dx, dy] of MOVE_NEIGHBOR_OFFSETS) {
			const x = cell.x + dx, y = cell.y + dy, id = x * 4096 + y
			if (seen.has(id)) continue
			seen.add(id)
			const neighbor = Field.cellFromXY(x, y)
			if (!neighbor || neighbor.obstacle || (neighbor.entity !== null && neighbor.entity.id !== me.id)) continue
			walk.set(id, next)
			queue.push(neighbor)
			if (wanted.has(id)) missing--
		}
	}
	const origin = walk.get(key(me.cell))
	if (origin === undefined) return hold("no walking route to a firing zone")
	const ceiling = dangers.get(key(me.cell))!
	const lifeLimit = me.life * PASSIVE_DANGER_LIFE_FRACTION
	let best: { cell: Cell; cost: number; walk: number; danger: number } | null = null
	for (const entry of entries) {
		budget.tick()
		const distance = walk.get(key(entry.cell))
		const danger = dangers.get(key(entry.cell))!
		if (distance === undefined || distance >= origin || visited(entry.cell) ||
			(riskFree ? danger >= lifeLimit : danger > ceiling)) continue
		if (best === null || distance < best.walk ||
			(distance === best.walk && (danger < best.danger || (danger === best.danger && entry.cost < best.cost)))) {
			best = { cell: entry.cell, cost: entry.cost, walk: distance, danger }
		}
	}
	if (best === null) {
		return hold(`no cell with danger ${riskFree ? `< ${lifeLimit} (${PASSIVE_DANGER_LIFE_FRACTION} x my life)` : `<= ${ceiling}`} closer by walking ` +
			`(walking distance ${origin})`)
	}
	const chosen = best
	log(() => `[Tactical] stagnation: ${turns} turns without shot or progress (threshold ${STAGNATION_TURNS}); ` +
		`escaping to (${chosen.cell.x},${chosen.cell.y}), walking distance ${origin} -> ${chosen.walk}, ` +
		`danger ${chosen.danger} (origin ${ceiling}), ${chosen.cost} MP`, LOG_CONTEXT.PLANNING)
	return {
		target, shotCell: me.cell, destination: chosen.cell, beforeMp: 0, afterMp: chosen.cost, weapon: null,
		weaponShots: 0, chips: [], protection: [], tpUsed: 0, usefulDamage: 0, danger: chosen.danger,
		score: origin - chosen.walk, progress: origin - chosen.walk, progressModel: "stagnation walk route",
		stagnation: { turns, walkBefore: origin, walkAfter: chosen.walk }
	}
}
