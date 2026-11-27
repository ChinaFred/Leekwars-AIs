// @version:5.8
// file version: 3
import { OPS_BUDGET } from "../../Toolbox/Budgets.js"
import { ReachableCells, MOVE_NEIGHBOR_OFFSETS } from "../Context/ReachableCells.js"
import { isCellInLaunchPattern } from "../Context/LaunchPattern.js"
import { ShotCandidate, isStrengthBoostType, isTpBoostType, toCandidate } from "../Context/ShotPlan.js"
import { Budget, Unavailable, key, validCost } from "./TacticalTypes.js"
import { netDamage } from "./TacticalScore.js"

/**
 * Parcours exploratoire facultatif, sans tir promis : l'unique arme choisie (la première valide de `weapons`, que
 * l'appelant ordonne selon la posture du rôle) peut être inabordable ce tour. Les distances retournées suivent
 * seulement des cases actuellement traversables, y compris au-delà des PM de ce tour.
 */
export function futureWeaponRoute(
	me: Me, target: Entity, weapons: readonly Weapon[], reachable: ReachableCells, budget: Budget
): Map<number, number> | null {
	if (me.mp <= 0 || typeof Field === "undefined" || typeof Field.cellFromXY !== "function") return null
	const weapon = weapons.find((item) => validCost(item.cost) &&
		Number.isFinite(item.minRange) && Number.isFinite(item.maxRange) &&
		item.minRange >= 0 && item.maxRange >= item.minRange && toCandidate(item, false, me.strength) !== null)
	if (!weapon || (weapon.needsLos && typeof Field.lineOfSight !== "function")) return null
	const maximumCells = 160, maximumDistance = 8, maximumSightCalls = 8
	const startOps = typeof System === "undefined" ? 0 : System.operations
	const room = (): boolean => {
		budget.check()
		return typeof System === "undefined" || !Number.isFinite(System.maxOperations) ||
			System.maxOperations <= 0 || System.operations - startOps < System.maxOperations * 0.02
	}
	const queue = [...reachable.entries()].map(({ cell, cost }) => ({ cell, cost }))
	const cells = new Map<number, Cell>(queue.map(({ cell }) => [key(cell), cell]))
	const seen = new Set<number>(cells.keys())
	let goal: Cell | null = null
	let sightCalls = 0
	for (let head = 0; head < queue.length; head++) {
		if (!room()) return null
		budget.tick()
		const { cell, cost } = queue[head]!
		const dx = target.cell.x - cell.x, dy = target.cell.y - cell.y
		const range = Math.abs(dx) + Math.abs(dy)
		if (cost <= maximumDistance && range >= weapon.minRange && range <= weapon.maxRange &&
			isCellInLaunchPattern(weapon.launchType, dx, dy)) {
			if (!weapon.needsLos) { goal = cell; break }
			if (sightCalls >= maximumSightCalls) return null
			sightCalls++
			const visible = Field.lineOfSight(cell, target.cell)
			if (!room()) return null
			if (visible) { goal = cell; break }
		}
		if (cost >= maximumDistance || queue.length >= maximumCells) continue
		// Les contrôles de budget encadrent chaque appel natif (avant : fin du précédent ou en-tête de case ;
		// après : ci-dessous) : aucun contrôle supplémentaire n'est utile entre deux voisins déjà écartés.
		for (const [offsetX, offsetY] of MOVE_NEIGHBOR_OFFSETS) {
			const x = cell.x + offsetX, y = cell.y + offsetY
			const id = x * 4096 + y
			if (seen.has(id)) continue
			seen.add(id)
			const next = Field.cellFromXY(x, y)
			if (!room()) return null
			if (!next || next.obstacle || (next.entity !== null && next.entity.id !== me.id)) continue
			cells.set(id, next)
			queue.push({ cell: next, cost: cost + 1 })
			if (queue.length >= maximumCells) break
		}
	}
	if (!goal) return null
	// Les distances sont calculées dans le sous-graphe exploré, pas à vol d'oiseau.
	const distances = new Map<number, number>([[key(goal), 0]])
	const reverse = [goal]
	for (let head = 0; head < reverse.length; head++) {
		if (!room()) return null
		budget.tick()
		const cell = reverse[head]!
		const nextDistance = distances.get(key(cell))! + 1
		for (const [dx, dy] of MOVE_NEIGHBOR_OFFSETS) {
			const id = (cell.x + dx) * 4096 + cell.y + dy
			const next = cells.get(id)
			if (next && !distances.has(id)) { distances.set(id, nextDistance); reverse.push(next) }
		}
	}
	for (const { cell } of reachable.entries()) if (!distances.has(key(cell))) return null
	return distances
}

/**
 * Terme `N` du score : part créditée des dégâts moyens que la case finale d'un plan permet au tour SUIVANT. Même
 * esprit que `FUTURE_TURN_WEIGHT` (le contact n'est pas garanti : la cible est supposée immobile). Non calibré.
 */
export const NEXT_TURN_WEIGHT = 0.75

/**
 * Allocation du calcul de `N`, en part de `System.maxOperations` depuis son entrée : au-delà, `N` = 0 pour TOUTES
 * les cases (jamais un `N` partiel). Politique, pas un coût mesuré ; aucun appel natif de liste de cases n'y est fait.
 */
export const NEXT_TURN_FRACTION = OPS_BUDGET.NEXT_TURN

/** Valeur des boosts actifs qui ne couvriront plus mon prochain tour (`turns` = 1 : hypothèse non vérifiée en combat). */
function expiringBoost(me: Me, isType: (type: number) => boolean): number {
	let value = 0
	for (const effect of me.effects ?? []) {
		if (isType(effect.type) && effect.turns === 1 && effect.value > 0) value += effect.value
	}
	return value
}

/**
 * Meilleurs dégâts moyens possibles au tour suivant depuis chaque case atteignable (ordre de `entries`), cible
 * supposée IMMOBILE ; null si aucune case n'en permet. `zones` : items dont la liste native de cases de tir a DÉJÀ
 * été obtenue ce tour (aucun appel natif ici). Un item est utilisable depuis `c` si une case de sa liste est à au
 * plus mes PM de MARCHE de `c` (cases libres ; hors de ma zone : `Field.cellFromXY`). Une seule propagation en
 * largeur pour tous les items (masques de bits), bornée au losange de rayon 2 × PM autour de ma case. Dégâts : maximum
 * exact par ensemble d'items (sac à dos des puces, une table par ensemble de puces, puis tirs d'une arme au plus,
 * 1 PT si ce n'est pas l'arme équipée en fin de plan), avec les PT et la force du début de ce tour moins les boosts
 * qui expirent, boucliers actuels de la cible.
 * Du plan, seule compte l'arme équipée à la fin : `equipped[0]` est l'arme actuelle, puis chaque autre arme de
 * `zones` ; `damages[e]` est le tableau pour `equipped[e]`. Ni ses tirs ni ses boosts (gain futur : terme `F`).
 * Approximation : les items d'un ensemble peuvent demander des cases de tir différentes.
 */
export interface NextTurn { equipped: Array<Weapon | null>; damages: number[][] }

export function nextTurnDamages(
	me: Me, target: Entity, entries: ReadonlyArray<{ cell: Cell; cost: number }>, entryIndex: ReadonlyMap<number, number>,
	zones: ReadonlyArray<{ item: Weapon | Chip; isChip: boolean; cells: readonly Cell[] }>, budget: Budget
): NextTurn | null {
	const tp = me.tp - Math.floor(expiringBoost(me, isTpBoostType))
	const strength = me.strength - expiringBoost(me, isStrengthBoostType)
	const mp = Math.max(0, me.mp)
	const items: Array<{ candidate: ShotCandidate; isChip: boolean; cells: readonly Cell[] }> = []
	for (const { item, isChip, cells } of zones) {
		const candidate = item.cost <= tp ? toCandidate(item, isChip, strength) : null
		if (candidate) items.push({ candidate, isChip, cells })
	}
	if (items.length === 0) return null
	if (typeof Field === "undefined" || typeof Field.cellFromXY !== "function") throw new Unavailable("no cell lookup")
	const ox = me.cell.x, oy = me.cell.y
	const free = (cell: Cell): boolean => !cell.obstacle && (cell.entity === null || cell.entity.id === me.id)
	const reach = new Map<number, number>()
	let frontier = new Map<number, { x: number; y: number; bits: number }>()
	for (let bit = 0; bit < items.length; bit++) {
		for (const cell of items[bit]!.cells) {
			budget.tick()
			const id = key(cell)
			if (Math.abs(cell.x - ox) + Math.abs(cell.y - oy) > 2 * mp || (!entryIndex.has(id) && !free(cell))) continue
			reach.set(id, (reach.get(id) ?? 0) | (1 << bit))
			const seed = frontier.get(id)
			if (seed) seed.bits |= 1 << bit
			else frontier.set(id, { x: cell.x, y: cell.y, bits: 1 << bit })
		}
	}
	// Chaque tour de boucle porte d'un pas les bits acquis au tour précédent (instantané : jamais deux pas par tour).
	// Une case à `step` pas d'une case de tir ne sert que si elle est à ≤ PM − `step` d'une case de ma zone.
	const open = new Map<number, boolean>()
	for (let step = 1; step <= mp && frontier.size > 0; step++) {
		const gained = new Map<number, { x: number; y: number; bits: number }>()
		for (const { x, y, bits } of frontier.values()) {
			budget.tick()
			for (const [dx, dy] of MOVE_NEIGHBOR_OFFSETS) {
				const nx = x + dx, ny = y + dy
				if (Math.abs(nx - ox) + Math.abs(ny - oy) > 2 * mp - step) continue
				const id = nx * 4096 + ny
				const old = reach.get(id) ?? 0
				const fresh = bits & ~old
				if (fresh === 0) continue
				if (old === 0 && !entryIndex.has(id)) {
					let walkable = open.get(id)
					if (walkable === undefined) {
						const cell = Field.cellFromXY(nx, ny)
						walkable = !!cell && free(cell)
						open.set(id, walkable)
					}
					if (!walkable) continue
				}
				reach.set(id, old | fresh)
				const entry = gained.get(id)
				if (entry) entry.bits |= fresh
				else gained.set(id, { x: nx, y: ny, bits: fresh })
			}
		}
		frontier = gained
	}
	const masks = entries.map(({ cell }) => reach.get(key(cell)) ?? 0)
	const equipped: Array<Weapon | null> = [me.weapon]
	for (const { candidate, isChip } of items) {
		if (!isChip && candidate.item !== me.weapon) equipped.push(candidate.item as Weapon)
	}
	// Puces : meilleurs dégâts pour un budget ≤ b, une table par ensemble de puces (partagée par les armes et les mains).
	const chipTables = new Map<number, number[]>()
	const chipTable = (mask: number): number[] => {
		let table = chipTables.get(mask)
		if (table) return table
		table = new Array<number>(tp + 1).fill(0)
		for (let bit = 0; bit < items.length; bit++) {
			const { candidate, isChip } = items[bit]!
			if (!isChip || (mask & (1 << bit)) === 0) continue
			const impact = netDamage(candidate, target)
			const cost = candidate.cost
			if (candidate.uses >= Math.floor(tp / cost)) {
				// Lancers non limités par `maxUses` dans ces PT : une passe croissante (la puce peut se cumuler).
				for (let spent = cost; spent <= tp; spent++) {
					budget.tick()
					table[spent] = Math.max(table[spent]!, table[spent - cost]! + impact)
				}
			} else for (let cast = 0; cast < candidate.uses; cast++) {
				for (let spent = tp; spent >= cost; spent--) {
					budget.tick()
					table[spent] = Math.max(table[spent]!, table[spent - cost]! + impact)
				}
			}
		}
		chipTables.set(mask, table)
		return table
	}
	let chipBits = 0
	for (let bit = 0; bit < items.length; bit++) if (items[bit]!.isChip) chipBits |= 1 << bit
	let any = false
	const damages = equipped.map((held) => {
		const byMask = new Map<number, number>([[0, 0]])
		return masks.map((mask) => {
			let best = byMask.get(mask)
			if (best !== undefined) return best
			const chips = chipTable(mask & chipBits)
			best = chips[tp]!
			for (let bit = 0; bit < items.length; bit++) {
				const { candidate, isChip } = items[bit]!
				if (isChip || (mask & (1 << bit)) === 0) continue
				const impact = netDamage(candidate, target)
				const left = tp - (candidate.item !== held ? 1 : 0)
				for (let shots = 1; shots <= candidate.uses && shots * candidate.cost <= left; shots++) {
					budget.tick()
					best = Math.max(best, shots * impact + chips[left - shots * candidate.cost]!)
				}
			}
			byMask.set(mask, best)
			any = any || best > 0
			return best
		})
	})
	budget.check()
	return any ? { equipped, damages } : null
}
