// @version:5.8
// file version: 15
import { MIN_LIFE_RATIO_FOR_BOOST } from "../../Brain/StrengthBoost.js"
import { logSearchCut } from "../../Toolbox/Logger.js"
import { BookBudget, BookCut } from "./BookBudget.js"
import { BoostItem, Buff, Catalog, SupportItem } from "./BookCatalog.js"
import { EnemyMover } from "./BookEnemyModel.js"
import { BookObjective, TurnOutcome } from "./BookObjective.js"
import { STANDOFF_NEVER_EXPOSED } from "./BookStandoff.js"
import { Boost, CombatTable, Combo, EMPTY_COMBO, SHAPE, Shield, shapeOf } from "./CombatBook.js"
import { KILL_MARGIN, LETHAL_PENALTY } from "./TacticalScore.js"

/**
 * Faisceau multi-tours sur la table de combos. Un nœud = un état simulé minimal (ma case, mes PV, mes PT, cooldowns,
 * boosts actifs, ennemis : case et PV) et le chemin qui y mène. Chaque tour : tous les couples (case atteignable, cible,
 * variante de boost) sont lus dans la table ; les `REFINE_KEEP` meilleurs GROUPES d'actions (classés sur leur potentiel,
 * danger mis à part) reçoivent une case finale de repli et un soin/bouclier ; puis les `BEAM_WIDTH` meilleurs
 * enchaînements sont gardés, dédupliqués par clé. Seul le tour 1 du meilleur est exécuté.
 */
export const BEAM_WIDTH = 5
/** Tours simulés : le 2e seulement si le duel est actif ou si un autre plan non létal promet plus ; un 3e si le budget le permet. */
export const BEAM_DEPTH = 3
/** Poids du tour t dans le score d'un enchaînement : décroissant, le tour 2 vaut moins que le tour 1. Non calibré. */
export const TURN_WEIGHTS: readonly number[] = [1, 0.6, 0.4]
/** Groupes d'actions d'un tour qui reçoivent repli et soin/bouclier. */
export const REFINE_KEEP = 12
/** Part des dégâts modélisés (danger de la case finale) retranchée de mes PV au tour simulé suivant. Heuristique. */
export const DAMAGE_TAKEN_FRACTION = 0.5
/**
 * Marge sur le coût mesuré d'un nœud pour décider d'ouvrir un niveau de plus. Le coût est mesuré sur le niveau 1 (une seule
 * racine, qui calcule aussi ses cases atteignables) ; combat 55027536 (e7ef19c) : les nœuds du niveau 2 coûtent environ la
 * moitié (≤ 87k contre 120-155k estimés). À 2, 3 nœuds sur 5 étaient ouverts aux tours 5 et 6 alors que le tour finissait à
 * 44 % / 41 % des ops. Combat 55029308 tour 1 : racine 293 708 ops, nœuds du niveau 2 ≈ 175 k (0,6 ×), du niveau 3 ≈ 95 k (0,55 ×) ;
 * à 1,2 le faisceau était réduit à 4 puis 2 nœuds sur 5 et le tour finissait à 64,5 % des ops (plafond 70 %). À 0,7 : 5 nœuds au
 * niveau 2, 3 au niveau 3. Risque : un niveau coupé en cours est abandonné (travail perdu, le niveau précédent reste). Jamais
 * au-delà du plafond global : `SEARCH_GLOBAL_FRACTION` (0,80) et `BOOK_SEARCH_FRACTION` (0,70) bornent toujours la recherche.
 */
export const NODE_COST_MARGIN = 0.7
/**
 * Crédit d'un boost de force posé SANS tir (voir `idleBoostCredit`) : part des dégâts supplémentaires du boost sur les tours
 * où il sert, à 0,75 comme les autres crédits de tours futurs (`FUTURE_TURN_WEIGHT`). Durées relevées dans fight.json : protein 2
 * tours, motivation 3 (le tour du lancer compte pour 1 ; l'effet est retiré au début de mon tour suivant la durée).
 */
export const IDLE_BOOST_SHOT_WEIGHT = 0.75
/**
 * Tempo perdu d'une fuite sans tir au tour 1 : une étape qui n'inflige rien, recule (progrès < 0) et ne soigne ni ne protège
 * perd ce poids × les dégâts de la meilleure étape NON létale du même tour qui tire (`penalizeFleeNoShot`). Combat 55028419,
 * tour 8 : recul de 5 cases + protein (0 dégât) retenu à 158,4 contre un tir non létal de 93,9 dégâts écarté à 77,2 (danger
 * exposé 0,5 × 185,76). Valeur non calibrée.
 */
export const FLEE_NO_SHOT_WEIGHT = 1.0
/** Multiplicateur d'un coup critique (CRITICAL_FACTOR officiel = 1,3), chance = agilité / 1000. */
const CRITICAL_FACTOR = 1.3

export interface SimEnemy { readonly enemy: Entity; readonly cell: Cell; readonly life: number }

export interface SimState {
	readonly cell: Cell
	readonly life: number
	/** PT disponibles au début du tour simulé (boosts de PT actifs compris). */
	readonly tp: number
	/** PM disponibles au début du tour simulé (boosts de PM actifs compris). */
	readonly mp: number
	/** Tours avant que la puce `catalog.chips[i]` soit relançable : 0 = prête. */
	readonly cooldowns: readonly number[]
	readonly buffs: readonly Buff[]
	readonly enemies: readonly SimEnemy[]
	/** Indice (dans `book.items`) de l'arme en main, -1 si aucune. */
	readonly held: number
}

export interface ZoneCell { readonly cell: Cell; readonly cost: number }
export interface Zone { readonly cells: readonly ZoneCell[]; readonly byKey: ReadonlyMap<number, number> }

/** Duel constaté (`BookStandoff.ts`), AGGRESSIVE seulement : limite létale élargie et poids du danger réduit. */
export interface DuelState {
	/** Limite létale en multiple de mes PV (≥ 1). */
	readonly accept: number
	/** Facteur du poids du danger exposé (1 = plein). */
	readonly riskScale: number
	readonly beyond: number
}

/** Ce que le faisceau a considéré au tour 1, pour le journal de diagnostic. */
export interface BeamTrace {
	/** Un repli après tir a-t-il été cherché (`allowHiding` et des PM) ? */
	retreat: boolean
	candidates: TurnStep[]
	groups: Map<string, { stay: TurnStep; retreat: TurnStep | null; reachedMp: number }>
}

export interface BeamEnv {
	readonly me: Me
	readonly catalog: Catalog
	readonly objective: BookObjective
	readonly budget: BookBudget
	/** PM que la zone du tour 0 couvre en plus de mes PM (boost de PM prêt, zone et danger obtenus) ; 0 : pas de boost de PM au tour 0. */
	readonly rootMpGain: number
	readonly mover: EnemyMover
	/** Cases atteignables avec `mp` PM au tour simulé `k` (0 = tour courant) depuis la case de l'état ; `cost` = PM du trajet. */
	zone(state: SimState, k: number, mp: number): Zone
	/** Danger de la case au tour simulé `k` : carte du jeu au tour 0, hypothèse de `BookEnemyModel` ensuite. */
	dangerAt(cell: Cell, k: number): number
	lineOfSight(from: Cell, to: Cell): boolean
	/** Soin et bouclier permis par le profil à cet état ; l'agressivité les départage par le score (`objectiveFor`). */
	supportAllowed(state: SimState): { heal: boolean; shield: boolean }
	/** Retraite après tir permise (`allowHiding`). */
	readonly allowRetreat: boolean
	/** Duel constaté ; null sinon (comportement inchangé). */
	readonly duel: DuelState | null
	/** Impose (true) ou interdit (false) le niveau 2 ; indéfini : règle de `worthDeepening`. */
	readonly deepen?: boolean
	readonly trace?: BeamTrace
}

export interface Plan {
	readonly state: SimState
	readonly k: number
	readonly target: SimEnemy | null
	readonly enemyIdx: number
	readonly variantIdx: number
	readonly shotCell: Cell
	readonly finalCell: Cell
	readonly beforeMp: number
	readonly afterMp: number
	readonly combo: Combo
	readonly net: number
	readonly variant: Variant
	readonly supports: readonly SupportItem[]
	readonly critical: number
	/** Plus petite distance d'ennemi depuis ma case de départ (pour le progrès). */
	readonly startDistance: number
	/** Crédit d'un boost de force sans tir de cette variante (0 sinon) ; compté seulement si aucun tour suivant n'est simulé. */
	readonly idleCredit: number
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
	/** Limite létale appliquée (PV + soin, × acceptation du duel) : pour le journal. */
	readonly limit: number
	readonly score: number
	/** Pénalité de fuite sans tir déjà retranchée de `score` (tour 1, `penalizeFleeNoShot`) ; 0 sinon. */
	readonly fleePenalty: number
	/** Crédit d'un boost de force posé sans tir : ajouté au score du faisceau seulement s'il reste à un tour (voir `runBeam`). */
	readonly idleCredit: number
	/** Clé de distinction : actions et cases. */
	readonly key: string
	/** Clé des seules actions (items, boosts, soins, cible) : sert à la diversité du faisceau et au regroupement. */
	readonly group: string
	readonly plan: Plan
}

export interface BeamNode { readonly state: SimState; readonly score: number; readonly steps: readonly TurnStep[]; readonly key: string; readonly group: string }

export interface BeamResult {
	/** Meilleur enchaînement du dernier niveau COMPLET ; null si aucun tour n'a pu être évalué. */
	readonly best: BeamNode | null
	readonly beam: readonly BeamNode[]
	readonly depth: number
	readonly cut: string | null
	/** Pourquoi un niveau n'a pas été ouvert (règle de profondeur, budget) ; null sinon. */
	readonly skipped: string | null
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

export interface Variant {
	readonly boosts: readonly BoostItem[]; readonly cost: number; readonly tpGain: number; readonly buffs: readonly Buff[]; readonly tp: number
	/** PM gagnés dès le lancer (boost de PM) : la zone du tour s'élargit d'autant. */
	readonly mpGain: number
}

/**
 * Le meilleur boost PRÊT d'une statistique (puce prête, abordable, aucun effet de la même statistique actif), ou undefined ;
 * toujours undefined sous le seuil de PV `MIN_LIFE_RATIO_FOR_BOOST`.
 */
export function bestReadyBoost(env: Pick<BeamEnv, "me" | "catalog">, state: SimState, stat: Buff["stat"]): BoostItem | undefined {
	if (state.life / env.me.maxLife < MIN_LIFE_RATIO_FOR_BOOST) return undefined
	if (state.buffs.some((buff) => buff.stat === stat && buff.turns > 0)) return undefined
	let best: BoostItem | undefined
	for (const boost of env.catalog.boosts) {
		if (boost.stat !== stat || state.cooldowns[env.catalog.chipIndex.get(boost.chip)!] !== 0 || boost.cost > state.tp) continue
		if (best === undefined || boost.gain > best.gain || (boost.gain === best.gain && boost.cost < best.cost)) best = boost
	}
	return best
}

/**
 * Variantes de boost du tour : aucune, ou un sous-ensemble du meilleur boost PRÊT par statistique (PT, force, agilité, PM),
 * sans empiler un effet déjà actif. Sous le seuil de PV `MIN_LIFE_RATIO_FOR_BOOST` : aucune. Le boost de PT est lancé
 * d'abord (ses PT servent aux autres), celui de PM avant tout déplacement. Au tour 0 le boost de PM exige la zone et le danger
 * à PM + gain (`env.rootMpGain`) ; aux tours simulés la zone est calculée à PM + gain.
 */
export function boostVariants(env: BeamEnv, state: SimState, k: number): Variant[] {
	const none: Variant = { boosts: [], cost: 0, tpGain: 0, buffs: [], tp: state.tp, mpGain: 0 }
	const ready = (["tp", "strength", "agility", "mp"] as const).map((stat) => bestReadyBoost(env, state, stat))
		.filter((boost): boost is BoostItem => boost !== undefined && !(boost.stat === "mp" && k === 0 && boost.gain > env.rootMpGain))
	const variants: Variant[] = [none]
	for (let bits = 1; bits < 1 << ready.length; bits++) {
		const boosts = ready.filter((_, i) => (bits & (1 << i)) !== 0)
		if (new Set(boosts.map((boost) => boost.chip)).size !== boosts.length) continue
		const tpBoost = boosts.find((boost) => boost.stat === "tp")
		const tpGain = tpBoost?.gain ?? 0
		const cost = boosts.reduce((sum, boost) => sum + boost.cost, 0)
		if ((tpBoost?.cost ?? 0) > state.tp || cost > state.tp + tpGain) continue
		variants.push({
			boosts, cost, tpGain, tp: state.tp - cost + tpGain, mpGain: boosts.find((boost) => boost.stat === "mp")?.gain ?? 0,
			buffs: boosts.map((boost) => ({ stat: boost.stat, value: boost.gain, turns: boost.turns }))
		})
	}
	return variants
}

/** Sous-ensembles non vides de puces de soin/bouclier prêtes, permis par le profil (soin seulement si des PV manquent), abordables avec `tp` PT. */
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

/** Signature numérique d'un combo (nombre de lancers par item, base 16) : mémoïsée, sans chaîne ni tri. */
const signatures = new WeakMap<Combo, number>()
function signatureOf(combo: Combo): number {
	let signature = signatures.get(combo)
	if (signature === undefined) {
		signature = 0
		for (const index of combo.items) signature += 16 ** index
		signatures.set(combo, signature)
	}
	return signature
}

function stepOf(env: BeamEnv, p: Plan): TurnStep {
	const { state, variant } = p
	const danger = env.dangerAt(p.finalCell, p.k)
	let heal = 0
	let absolute = 0
	let relative = 0
	let supportCost = 0
	let supportMask = 0
	for (const support of p.supports) {
		heal += support.heal
		absolute += support.absolute
		relative += support.relative
		supportCost += support.cost
		supportMask |= 1 << env.catalog.chipIndex.get(support.chip)!
	}
	heal = Math.min(Math.max(0, env.me.maxLife - state.life), heal)
	relative = Math.min(100, relative)
	const dealt = p.net * p.critical
	const damage = p.target === null ? 0 : Math.min(p.target.life, dealt)
	let aliveCount = 0
	for (const enemy of state.enemies) if (enemy.life > 0) aliveCount++
	const won = p.target !== null && aliveCount === 1 && dealt >= p.target.life * KILL_MARGIN
	const credit = Math.min(danger, absolute + danger * relative / 100)
	const exposed = won ? 0 : danger - credit
	const nearest = nearestAlive(state.enemies, p.finalCell)
	const tpUsed = p.combo.tp + variant.cost + supportCost
	// Duel (AGGRESSIVE) : limite létale élargie, jamais sous le seuil de PV des boosts ni à 2 x mes PV ou plus.
	const duel = env.duel !== null && state.life / env.me.maxLife >= MIN_LIFE_RATIO_FOR_BOOST ? env.duel : null
	const limit = (state.life + heal) * (duel === null ? 1 : duel.accept)
	const lethal = !won && (exposed >= limit || (duel !== null && duel.accept > 1 && exposed >= STANDOFF_NEVER_EXPOSED * state.life))
	const outcome: TurnOutcome = {
		damage, heal, shield: won ? 0 : credit, exposed, kills: p.target !== null && damage >= p.target.life, won,
		progress: nearest === null ? 0 : p.startDistance - nearest.distance, tpSpent: tpUsed, boostsCast: variant.boosts.length
	}
	const judged = duel !== null && duel.riskScale !== 1 ? { ...outcome, exposed: exposed * duel.riskScale } : outcome
	const score = env.objective.score(judged) - (lethal ? LETHAL_PENALTY + exposed - limit : 0)
	const group = `${p.target?.enemy.id ?? "-"}:${signatureOf(p.combo)}:${p.variantIdx}:${supportMask}`
	return {
		target: p.target, shotCell: p.shotCell, finalCell: p.finalCell, beforeMp: p.beforeMp, afterMp: p.afterMp, combo: p.combo, net: p.net,
		boosts: variant.boosts, supports: p.supports, tpGain: variant.tpGain, tpUsed, danger, outcome, lethal, limit, score, fleePenalty: 0,
		idleCredit: p.combo.items.length === 0 ? p.idleCredit : 0, key: `${p.finalCell.id}:${p.shotCell.id}:${group}`, group, plan: p
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

/** Score d'une étape si son danger final était nul : le plafond de ce que ses actions peuvent valoir (hors repli, soin, bouclier). */
function ceilingOf(env: BeamEnv, step: TurnStep): number {
	return env.objective.score({ ...step.outcome, exposed: 0, shield: 0 })
}

const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]]

/**
 * Meilleure case finale d'un groupe d'actions, sur TOUTES les cases de tir du groupe : parcours à sources multiples dans
 * la zone (départ = case de tir au coût d'approche, un PM par pas, au plus `mp` en tout, boost de PM du groupe compris). La case de moindre danger
 * (puis de moindre coût) est retenue : à actions égales le score ne croît qu'avec la baisse du danger exposé.
 * Rend l'étape (case de tir d'origine, case finale), ou null si aucune case de moindre danger que le tir lui-même.
 */
function bestRetreat(env: BeamEnv, zone: Zone, steps: readonly TurnStep[], k: number, mp: number, trace?: { reachedMp: number }): TurnStep | null {
	const count = zone.cells.length
	const distance: number[] = new Array(count).fill(Infinity)
	const origin: Array<TurnStep | undefined> = new Array(count)
	const buckets: number[][] = []
	for (let cost = 0; cost <= mp; cost++) buckets.push([])
	for (const step of steps) {
		const index = zone.byKey.get(step.shotCell.x * 4096 + step.shotCell.y)
		if (index === undefined || step.beforeMp > mp || step.beforeMp >= distance[index]!) continue
		distance[index] = step.beforeMp
		origin[index] = step
		buckets[step.beforeMp]!.push(index)
	}
	let visited = 0
	for (let cost = 0; cost <= mp; cost++) {
		for (const index of buckets[cost]!) {
			if (distance[index] !== cost || cost >= mp) continue
			visited++
			const cell = zone.cells[index]!.cell
			for (const [dx, dy] of NEIGHBORS) {
				const next = zone.byKey.get((cell.x + dx) * 4096 + cell.y + dy)
				if (next === undefined || distance[next]! <= cost + 1) continue
				distance[next] = cost + 1
				origin[next] = origin[index]
				buckets[cost + 1]!.push(next)
			}
		}
	}
	env.budget.tick(visited + count)
	let best = -1
	let bestDanger = Infinity
	for (let index = 0; index < count; index++) {
		if (distance[index] === Infinity) continue
		const danger = env.dangerAt(zone.cells[index]!.cell, k)
		if (danger < bestDanger || (danger === bestDanger && best >= 0 && distance[index]! < distance[best]!)) { best = index; bestDanger = danger }
		if (trace !== undefined) trace.reachedMp = Math.max(trace.reachedMp, distance[index]!)
	}
	if (best < 0) return null
	const source = origin[best]!
	const finalCell = zone.cells[best]!.cell
	if (distance[best] === source.beforeMp) return null // la case de tir elle-même : déjà candidate
	return stepOf(env, { ...source.plan, finalCell, afterMp: distance[best]! - source.beforeMp })
}

/** Meilleur sous-ensemble de soin/bouclier ajouté à `base` (les PT servent d'abord au combo : il est relu à PT réduits). */
function bestSupport(
	env: BeamEnv, state: SimState, k: number, base: TurnStep,
	read: (plan: Plan, tp: number) => { combo: Combo; net: number }
): TurnStep | null {
	let best: TurnStep | null = null
	const plan = base.plan
	for (const subset of supportSubsets(env, state, plan.variant.tp)) {
		env.budget.tick(2)
		const spent = subset.reduce((sum, support) => sum + support.cost, 0)
		let combo = plan.combo
		let net = plan.net
		if (plan.target !== null && combo.tp > plan.variant.tp - spent) ({ combo, net } = read(plan, plan.variant.tp - spent))
		const candidate = stepOf(env, { ...plan, combo, net, supports: subset, target: combo.items.length > 0 ? plan.target : null })
		if (best === null || betterStep(candidate, best) < 0) best = candidate
	}
	return best
}

/**
 * Étapes candidates du tour simulé `k` depuis `state`, ajoutées à `sink` au fur et à mesure : une coupure du budget laisse
 * `sink` rempli d'étapes COMPLÈTES (jamais une moitié d'étape).
 */
export function expandTurn(env: BeamEnv, state: SimState, k: number, sink: TurnStep[]): void {
	const { catalog, budget } = env
	const book = catalog.book
	if (!state.enemies.some((enemy) => enemy.life > 0)) return
	const variants = boostVariants(env, state, k)
	// Une seule zone, à PM + meilleur gain : une variante sans boost de PM en ignore les cases au-delà de ses PM (le coût est celui du trajet).
	const zone = env.zone(state, k, state.mp + Math.max(...variants.map((variant) => variant.mpGain)))
	const mask = book.maskOf((item) => state.cooldowns[catalog.chipIndex.get(item.ref as Chip)!] === 0)
	const stats = { strength: catalog.base.strength, magic: catalog.base.magic }
	const alive = state.enemies.filter((enemy) => enemy.life > 0)
	const startNearest = nearestAlive(state.enemies, state.cell)!
	const shieldOf = (enemy: SimEnemy): Shield => ({ relative: enemy.enemy.relativeShield || 0, absolute: enemy.enemy.absoluteShield || 0 })
	// Une résolution par (variante de boost, cible), pas par case : table à lire et facteurs (`CombatBook.resolveBoost`).
	const preparedBase = variants.map((variant, variantIdx) => {
		let agility = catalog.base.agility
		const boosts: Boost[] = []
		for (const buff of [...state.buffs, ...variant.buffs]) {
			if (buff.stat === "strength") boosts.push({ stat: "strength", value: buff.value, turns: Math.max(1, buff.turns) })
			else if (buff.stat === "agility") agility += buff.value
		}
		return {
			variant, variantIdx, boosts, critical: 1 + (CRITICAL_FACTOR - 1) * Math.min(1, Math.max(0, agility) / 1000),
			resolved: alive.map((enemy) => book.resolveBoost(stats, boosts, 0, shieldOf(enemy)))
		}
	})
	const prepared = preparedBase.map((entry) => ({ ...entry, idle: 0 }))
	const query = { distance: 0, los: false, shape: 0, tp: 0, mask, held: state.held }
	// Crédit d'un boost de force sans tir, au tour 1 seulement (les tours simulés valent les boosts pour de vrai).
	const nearestNow = nearestAlive(state.enemies, state.cell)!
	const nearestIdx = alive.indexOf(nearestNow.enemy)
	const idleOf = (index: number): number => {
		const pv = prepared[index]!
		const boost = pv.variant.boosts.find((candidate) => candidate.stat === "strength")
		if (k !== 0 || boost === undefined) return 0
		return idleBoostCredit(env, state.mp, nearestNow.distance, nearestNow.enemy, boost.turns, prepared[0]!, pv, nearestIdx, mask, state.held)
	}
	prepared.forEach((entry, index) => { entry.idle = idleOf(index) })
	const readAt = (plan: Plan, tp: number): { combo: Combo; net: number } => {
		const enemy = plan.target!
		const dx = plan.shotCell.x - enemy.cell.x
		const dy = plan.shotCell.y - enemy.cell.y
		const resolved = prepared[plan.variantIdx]!.resolved[plan.enemyIdx]!
		const combo = resolved.table.read({
			distance: Math.abs(dx) + Math.abs(dy), los: env.lineOfSight(plan.shotCell, enemy.cell), shape: shapeOf(dx, dy), tp, mask, held: state.held
		})
		return { combo, net: combo.total * resolved.netFactor }
	}
	const first = sink.length
	for (const entry of zone.cells) {
		budget.tick(1)
		const cell = entry.cell
		const nearest = nearestAlive(state.enemies, cell)!
		for (let enemyIdx = 0; enemyIdx < alive.length; enemyIdx++) {
			const enemy = alive[enemyIdx]!
			budget.tick(variants.length)
			const dx = cell.x - enemy.cell.x
			const dy = cell.y - enemy.cell.y
			const distance = Math.abs(dx) + Math.abs(dy)
			const shape = shapeOf(dx, dy)
			let los = false
			if (distance <= book.maxDistance && book.usableAt(distance, true, shape) !== book.usableAt(distance, false, shape)) {
				los = env.lineOfSight(cell, enemy.cell)
			}
			for (const pv of prepared) {
				if (entry.cost > state.mp + pv.variant.mpGain) continue
				let combo = EMPTY_COMBO
				let net = 0
				if (distance <= book.maxDistance && pv.variant.tp > 0) {
					query.distance = distance; query.los = los; query.shape = shape; query.tp = pv.variant.tp
					const resolved = pv.resolved[enemyIdx]!
					combo = resolved.table.read(query)
					net = combo.total * resolved.netFactor
				}
				// Sans tir : un seul candidat par case et variante, contre l'ennemi le plus proche.
				if (combo.items.length === 0 && enemy !== nearest.enemy) continue
				sink.push(stepOf(env, {
					state, k, target: combo.items.length > 0 ? enemy : null, enemyIdx, variantIdx: pv.variantIdx, shotCell: cell, finalCell: cell,
					beforeMp: entry.cost, afterMp: 0, combo, net, variant: pv.variant, supports: [], critical: pv.critical,
					startDistance: startNearest.distance, idleCredit: pv.idle
				}))
			}
		}
	}
	budget.tick(sink.length - first) // regroupement et tri des candidats
	if (env.trace !== undefined && k === 0) env.trace.candidates = sink
	// Raffinement par GROUPE d'actions, classé sur le potentiel (danger final nul) et non sur le score « sur place » : une
	// attaque dont la case de tir est létale vaut tout autant si on la quitte après le tir (combat 55005067, tour 5).
	const groups = new Map<string, TurnStep[]>()
	for (let i = first; i < sink.length; i++) {
		const step = sink[i]!
		const members = groups.get(step.group)
		if (members === undefined) groups.set(step.group, [step]); else members.push(step)
	}
	const ranked = [...groups.values()].map((members) => {
		let stay = members[0]!
		for (const member of members) if (betterStep(member, stay) < 0) stay = member
		return { members, stay, ceiling: stay.target === null ? stay.score : ceilingOf(env, stay) }
	}).sort((a, b) => b.ceiling - a.ceiling || a.stay.tpUsed - b.stay.tpUsed).slice(0, REFINE_KEEP)
	for (const group of ranked) {
		budget.tick(4)
		let best = group.stay
		let retreat: TurnStep | null = null
		const reached = { reachedMp: 0 }
		const mp = state.mp + group.stay.plan.variant.mpGain
		if (env.allowRetreat && group.stay.target !== null && mp > 0) {
			retreat = bestRetreat(env, zone, group.members, k, mp, reached)
			if (retreat !== null) { sink.push(retreat); if (betterStep(retreat, best) < 0) best = retreat }
		}
		if (env.trace !== undefined && k === 0) env.trace.groups.set(group.stay.group, { stay: group.stay, retreat, reachedMp: reached.reachedMp })
		const support = bestSupport(env, state, k, best, readAt)
		if (support !== null) sink.push(support)
	}
}

/**
 * Crédit d'un boost de force posé sans tir. Un boost compte pour de vrai quand le tour suivant est simulé ; sinon (niveau 2
 * non ouvert) un plan « boost seul » vaudrait le plan vide. Contact estimé : l'ennemi avance de ses PM et moi des miens, le
 * premier tir est possible au tour `s` = max(1, ⌈(distance − mes PM − portée max) / (mes PM + ses PM)⌉) ; le boost de durée `d`
 * (le tour du lancer compte pour 1) couvre `d − s` tours de tir. Crédit = `IDLE_BOOST_SHOT_WEIGHT` × `d − s` × gain de dégâts
 * du meilleur tour de tir avec ce boost (au meilleur éloignement, tous mes PT, plafonné aux PV de la cible). 0 si `d − s` ≤ 0.
 */
function idleBoostCredit(
	env: BeamEnv, mp: number, distance: number, target: SimEnemy, duration: number,
	plain: { resolved: ReadonlyArray<{ table: CombatTable; netFactor: number }>; critical: number },
	boosted: { resolved: ReadonlyArray<{ table: CombatTable; netFactor: number }>; critical: number },
	enemyIdx: number, mask: number, held: number
): number {
	const book = env.catalog.book
	const contact = Math.max(1, Math.ceil((distance - mp - book.maxDistance) / (mp + target.enemy.mp)))
	const covered = duration - contact
	if (covered <= 0) return 0
	let gain = 0
	for (let d = 1; d <= book.maxDistance; d++) {
		const query = { distance: d, los: true, shape: SHAPE.LINE, tp: env.catalog.base.tp, mask, held }
		const a = plain.resolved[enemyIdx]!
		const b = boosted.resolved[enemyIdx]!
		env.budget.tick(1)
		gain = Math.max(gain, b.table.read(query).total * b.netFactor * boosted.critical - a.table.read(query).total * a.netFactor * plain.critical)
	}
	return IDLE_BOOST_SHOT_WEIGHT * covered * Math.min(gain, target.life)
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
			? { enemy: enemy.enemy, life, cell: env.mover({ cell: enemy.cell, mp: enemy.enemy.mp, id: enemy.enemy.id }, step.finalCell) }
			: { enemy: enemy.enemy, life, cell: enemy.cell }
	})
	let held = state.held
	for (const index of step.combo.items) if (catalog.book.items[index]!.isWeapon) held = index
	return {
		cell: step.finalCell, life: Math.min(env.me.maxLife, Math.max(1, state.life + step.outcome.heal - step.outcome.exposed * DAMAGE_TAKEN_FRACTION)),
		tp: catalog.base.tp + buffs.filter((buff) => buff.stat === "tp").reduce((sum, buff) => sum + buff.value, 0),
		mp: catalog.base.mp + buffs.filter((buff) => buff.stat === "mp").reduce((sum, buff) => sum + buff.value, 0),
		cooldowns, buffs, enemies, held
	}
}

/**
 * Le meilleur plan du tour n'inflige rien (aucun tir possible : ses PT seraient perdus) et un plan non létal du faisceau lance un
 * boost ? Alors un boost ne coûte aucun tir et ne se juge que sur les tours suivants (PM : zone et cases de tir plus proches ; PT et
 * force : tirs ou dégâts en plus) : sans niveau de plus il ne serait jamais comparé à ne pas le lancer. Sinon un boost qui accompagne
 * un tir paie déjà dans le score du niveau 1 : la règle du plan qui inflige plus suffit.
 */
function investsInBoost(beam: readonly BeamNode[]): boolean {
	const best = beam[0]?.steps[0]
	return best !== undefined && best.outcome.damage === 0 &&
		beam.some((node) => node.steps.some((step) => !step.lethal && step.boosts.length > 0))
}

/**
 * Le niveau suivant est toujours ouvert : un plan qui se juge sur un seul tour peut se payer au tour d'après (combat 55029810,
 * tour 2 : danger 249 sur 450 PV accepté à profondeur 1, tour 3 létal partout). Seuls `env.deepen === false` (tests, réglage), le
 * budget (`affordable`, plafonds du faisceau) et `deepenOk` au 3e tour le limitent encore.
 */
export function worthDeepening(env: BeamEnv, _beam: readonly BeamNode[]): boolean {
	return env.deepen !== false
}

/**
 * Tour 1 : retranche `FLEE_NO_SHOT_WEIGHT` × (dégâts de la meilleure étape non létale qui tire) du score de chaque étape sans
 * dégâts, en recul, sans soin ni bouclier. Sans étape non létale qui tire, la fuite est justifiée : rien n'est changé.
 * Modifie `sink` en place (les diagnostics, qui lisent le même tableau, voient le score pénalisé).
 */
export function penalizeFleeNoShot(sink: TurnStep[]): void {
	let lost = 0
	for (const step of sink) if (!step.lethal && step.outcome.damage > lost) lost = step.outcome.damage
	const penalty = FLEE_NO_SHOT_WEIGHT * lost
	if (penalty <= 0) return
	for (let i = 0; i < sink.length; i++) {
		const { outcome } = sink[i]!
		if (outcome.damage === 0 && outcome.progress < 0 && outcome.heal === 0 && outcome.shield === 0) {
			sink[i] = { ...sink[i]!, score: sink[i]!.score - penalty, fleePenalty: penalty }
		}
	}
}

/**
 * Lance le faisceau : `depth` tours au plus. Le tour 1 est complet avant tout autre niveau ; un niveau de plus n'est ouvert
 * que s'il en vaut la peine (`worthDeepening`) et que le budget couvre le coût MESURÉ d'un nœud (`NODE_COST_MARGIN`), en
 * n'ouvrant que les meilleurs nœuds si besoin. Un niveau coupé en cours est abandonné : le niveau précédent complet reste.
 */
export function runBeam(env: BeamEnv, root: SimState, width = BEAM_WIDTH, depth = BEAM_DEPTH): BeamResult {
	let beam: BeamNode[] = [{ state: root, score: 0, steps: [], key: "", group: "" }]
	let reached = 0
	let cut: string | null = null
	let skipped: string | null = null
	let nodeOps = 0
	const opsDetail = (): string => `ops=${env.budget.ops()}/${typeof System === "undefined" ? "?" : System.maxOperations}`
	for (let k = 0; k < depth; k++) {
		let nodes = beam
		if (k >= 1) {
			if (!worthDeepening(env, beam)) { skipped = `level ${k + 1}: deepen disabled`; break }
			// Le 3e tour reste facultatif (`deepenOk`) sauf pour un tel boost, dont l'effet dure 2 à 3 tours : les plafonds du faisceau
			// (`BOOK_SEARCH_FRACTION`, 0,80 global) et le coût mesuré d'un nœud (`affordable`) s'appliquent toujours.
			if (k >= 2 && !investsInBoost(beam) && !env.budget.deepenOk()) {
				skipped = `level ${k + 1}: budget`
				logSearchCut("livre", "deepen fraction", `${opsDetail()} profondeur=${k + 1} niveau_atteint=${reached}`)
				break
			}
			const affordable = Math.floor(env.budget.remainingOps() / Math.max(1, nodeOps * NODE_COST_MARGIN))
			if (affordable < 1) {
				skipped = `level ${k + 1}: remaining ops ${Math.round(env.budget.remainingOps())} < ${Math.round(nodeOps * NODE_COST_MARGIN)}`
				logSearchCut("livre", "remaining ops < node cost", `${opsDetail()} profondeur=${k + 1} niveau_atteint=${reached}`)
				break
			}
			if (affordable < beam.length) {
				logSearchCut("livre", `beam nodes bound (${beam.length} > ${affordable})`, `${opsDetail()} profondeur=${k + 1} niveau_atteint=${reached}`)
			}
			nodes = beam.slice(0, affordable)
		}
		const next: BeamNode[] = []
		let sink: TurnStep[] = []
		const startOps = env.budget.ops()
		try {
			for (const node of nodes) {
				if (!node.state.enemies.some((enemy) => enemy.life > 0)) { next.push(node); continue }
				sink = []
				expandTurn(env, node.state, k, sink)
				if (k === 0) penalizeFleeNoShot(sink)
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
			logSearchCut("livre", cut, `${opsDetail()} profondeur=${k + 1} niveau_atteint=${reached}`)
			// Tour 1 coupé : les étapes déjà produites sont complètes, on garde les meilleures ; plus loin, niveau abandonné.
			if (k === 0) penalizeFleeNoShot(sink)
			if (k === 0) for (const step of selectTop(sink, width, betterStep)) {
				next.push({ state: nextState(env, root, step), score: (TURN_WEIGHTS[0] ?? 1) * step.score, steps: [step], key: step.key, group: step.group })
			}
			if (next.length > 0 && k === 0) { beam = selectNodes(next, width); reached = 1 }
			break
		}
		if (next.length === 0) break
		beam = selectNodes(next, width)
		reached = k + 1
		nodeOps = (env.budget.ops() - startOps) / nodes.length
	}
	// Un seul tour simulé : le boost posé sans tir n'a pas de tour suivant où payer, son crédit estimé le remplace. Seulement
	// s'il n'y a aucun tir non létal ce tour-ci : un boost seul ne doit jamais l'emporter sur un tir (combat 55005891, tour 2).
	const shootable = beam.some((node) => node.steps[0] !== undefined && node.steps[0].outcome.damage > 0 && !node.steps[0].lethal)
	if (reached === 1 && !shootable) beam = selectNodes(beam.map((node) => ({ ...node, score: node.score + (TURN_WEIGHTS[0] ?? 1) * (node.steps[0]?.idleCredit ?? 0) })), width)
	return { best: reached > 0 ? beam[0] ?? null : null, beam: reached > 0 ? beam : [], depth: reached, cut, skipped }
}

function selectNodes(nodes: BeamNode[], width: number): BeamNode[] {
	return selectTop(nodes, width, (a, b) => b.score - a.score || (a.steps[0]?.danger ?? 0) - (b.steps[0]?.danger ?? 0))
}
