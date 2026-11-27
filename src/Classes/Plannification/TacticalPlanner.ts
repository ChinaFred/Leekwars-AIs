// @version:5.8
// file version: 41
import { MOVE_NEIGHBOR_OFFSETS } from "../Context/ReachableCells.js"
import { aliveEnemies } from "../Context/Targets.js"
import { ShotCandidate, toCandidate } from "../Context/ShotPlan.js"
import { LeekProfile, createStrategy } from "../LeekProfile.js"
import {
	BoostOption, FUTURE_TURN_WEIGHT, MIN_LIFE_RATIO_FOR_BOOST, agilityCritGain, boostReach
} from "../../Brain/StrengthBoost.js"
import { log, LOG_CONTEXT } from "../../Toolbox/Logger.js"
import { hasExecutionRoom } from "./ExecutionBudget.js"
import {
	Budget, MpBoostCandidate, Skipped, TACTICAL_LIMITS, TacticalContext, TacticalPlan, TacticalPreparation, Unavailable,
	key, same, validCost
} from "./TacticalTypes.js"
import {
	AttackChoice, BoostVariant, PASSIVE_DANGER_LIFE_FRACTION, Protection, attackChoices, attacks, beats, better, boostFuture,
	boostVariants, killsLastEnemy, lethal, netDamage, posture, protections, riskCost, riskWeight, shieldCredit, woundedRiskFactor
} from "./TacticalScore.js"
import {
	NEXT_TURN_FRACTION, NEXT_TURN_WEIGHT, NextTurn, futureWeaponRoute, nextTurnDamages
} from "./TacticalNextTurn.js"
import { stagnationEscape } from "./TacticalStagnation.js"

/**
 * Zone d'effet d'une puce offensive : distance de Manhattan à la cible jusqu'à laquelle le lanceur peut se trouver
 * dans la zone (le plan ne simule pas les zones). Clés : types `area` du moteur officiel (leek-wars-generator,
 * `Area.java`) : cercles 1-3 (3, 4, 5), plus 2-3 (6, 7), X 1-3 (8, 9, 10), carrés 1-2 (11, 12). Case seule, laser,
 * premier en ligne, `area` absent ou inconnu : 0. Renvoie 0 si chaque effet exclut le lanceur (`targets` sans le
 * bit 4, `TARGET_CASTER` du moteur ; Éclair : 27). HYPOTHÈSE non vérifiée en combat : `chip.area` et
 * `feature.targets` de l'API ont ces valeurs ; `targets` illisible = lanceur supposé touché.
 */
const AREA_SELF_RADIUS: Readonly<Record<number, number>> = { 3: 1, 4: 2, 5: 3, 6: 2, 7: 3, 8: 2, 9: 4, 10: 6, 11: 2, 12: 4 }
const TARGET_CASTER = 4
export function selfHitRadius(chip: Chip): number {
	const radius = AREA_SELF_RADIUS[chip.area ?? 1] ?? 0
	if (radius === 0 || chip.features.every((feature) =>
		Number.isInteger(feature.targets) && (feature.targets & TARGET_CASTER) === 0)) return 0
	return radius
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
		dangers: null, weaponCells: new Map(), chipCells: new Map(), currentWeapons: new Map()
	}
	const currentState = (): boolean => preparation.turn === Fight.turn &&
		same(me.cell, preparation.origin) && me.mp === preparation.mp && me.tp === preparation.tp &&
		preparation.enemies.every(({ enemy, cell }) => same(enemy.cell, cell))
	/**
	 * Boost de PM : candidat de l'observation (`context.mpBoost`), puis SECONDE recherche sur la zone à PM + gain, avec la
	 * carte de danger de cette zone et `PT − coût` PT. Le plan boosté (boost lancé en première action) remplace le plan sans
	 * boost seulement s'il le bat STRICTEMENT au même score (tour condamné : tuer d'abord). Sans candidat, ou à la moindre
	 * erreur ou limite de la seconde recherche : le plan sans boost est gardé. Rien n'est dépensé ici.
	 */
	const withMpBoost = (base: TacticalPlan | null, baseSkipped: Skipped, baseBudget: Budget): TacticalPlan | null => {
		const source = context?.mpBoost
		if (!source) return base
		try {
			let candidate: MpBoostCandidate | null = source("unlock", preparation)
			// Fuite : sans tir débloqué, la zone élargie ne sert que si le meilleur plan sans boost est létal (danger >= mes PV).
			if (candidate === null && base !== null && base.danger >= me.life) candidate = source("flee", preparation)
			if (candidate === null) return base
			const { option } = candidate
			const frame = { mp: me.mp + option.gain, tp: me.tp - option.chip.cost, boost: option }
			const boostedPreparation: TacticalPreparation = {
				...preparation, reachable: candidate.reachable, mp: frame.mp, tp: frame.tp, enemies: [], dangers: null, currentWeapons: new Map()
			}
			const boostedSkipped: Skipped = { refused: 0, noProgress: null, doomed: false, leaderScore: null }
			const boostedBudget = new Budget()
			const startOps = typeof System === "undefined" ? 0 : System.operations
			const found = evaluate(me, profile, { ...context, reachable: candidate.reachable, threat: candidate.threat },
				boostedSkipped, boostedBudget, boostedPreparation, frame)
			const cost = `second search ${boostedBudget.used} ticks` +
				(typeof System === "undefined" ? "" : `, ${System.operations - startOps} operations`) +
				` (first search ${baseBudget.used} ticks)`
			if (!currentState()) throw new Unavailable("state changed during the boosted search")
			if (found === null) {
				log(() => `[Boost] MP: no plan on the boosted zone (${cost}); plan without boost kept`, LOG_CONTEXT.PLANNING)
				return base
			}
			const boosted: TacticalPlan = { ...found, mpBoost: { chip: option.chip, gain: option.gain }, tpUsed: found.tpUsed + option.chip.cost }
			if (me.life / me.maxLife < MIN_LIFE_RATIO_FOR_BOOST && (boosted.weaponShots > 0 || boosted.chips.length > 0)) {
				log(() => `[Boost] MP: boosted plan with a shot refused below 50 % life (${cost})`, LOG_CONTEXT.PLANNING)
				return base
			}
			const kills = (plan: TacticalPlan): boolean => plan.usefulDamage >= plan.target.life
			// Référence : le plan sans boost ; à défaut (rester sur place), le score du meilleur plan classé sans action.
			const reference = base?.score ?? baseSkipped.leaderScore
			const better = reference === null && base === null ||
				(baseSkipped.doomed && base !== null && kills(boosted) !== kills(base) ? kills(boosted) : boosted.score > reference!)
			log(() => `[Boost] MP: ${option.chip.name} (+${option.gain} MP) plan score ${boosted.score}, danger ${boosted.danger}, ` +
				`${boosted.weaponShots > 0 || boosted.chips.length > 0 ? "with a shot" : "no shot"} vs without boost ` +
				(base === null ? `no action (best score ${reference})` : `score ${base.score}, danger ${base.danger}`) + `: ${better ? "boosted plan kept" : "plan without boost kept"} ` +
				`(${candidate!.reason}; ${cost})`, LOG_CONTEXT.PLANNING)
			return better ? boosted : base
		} catch (error) {
			const cause = error instanceof Error ? error.message : String(error)
			log(() => `[Boost] MP: boosted search unavailable (${cause}); plan without boost kept`, LOG_CONTEXT.PLANNING)
			return base
		}
	}
	const stamp = (plan: TacticalPlan | null): TacticalPlan | null => plan && {
		...plan, state: { turn: preparation.turn, enemies: preparation.enemies }
	}
	try {
		const skipped: Skipped = { refused: 0, noProgress: null, doomed: false, leaderScore: null }
		const base = evaluate(me, profile, context, skipped, budget, preparation, { mp: me.mp, tp: me.tp, boost: null })
		if (!currentState()) throw new Unavailable("state changed during search")
		const plan = withMpBoost(base, skipped, budget)
		const reason = skipped.noProgress ??
			(skipped.refused > 0 ? "offensive chip refused at current cell" : "no actionable plan")
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
		// Évaluation sans dépense : le plan B reste possible, mais l'exception n'est pas silencieuse.
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

/**
 * `frame` : PM et PT du plan. Ceux du tour, ou, pour un plan boosté (`boost` non nul : seconde recherche du boost de PM),
 * PM + gain et PT − coût, sur la zone et la carte de danger boostées. La seconde recherche n'a aucun effet de bord sur la
 * stagnation (ni sortie ni compteur) : elle ne compare que le plan normal.
 */
interface Frame { readonly mp: number; readonly tp: number; readonly boost: BoostOption | null }

function evaluate(
	me: Me, profile: LeekProfile, context: TacticalContext | undefined,
	skipped: Skipped, budget: Budget, preparation: TacticalPreparation, frame: Frame
): TacticalPlan | null {
	const { mp, tp } = frame
	const reachable = context?.reachable
	const threat = context?.threat
	if (!reachable || !threat) throw new Unavailable("missing threat/reachable data")
	budget.check()
	if (reachable.truncated || threat.truncated || threat.inputsTruncated) throw new Unavailable("truncated data")
	if (!reachable.isUpToDate(me.id, me.cell, mp, Fight.turn) ||
		threat.entityId !== me.id || threat.turn !== Fight.turn ||
		threat.candidateCells !== reachable.size) throw new Unavailable("stale/inconsistent data")
	if (reachable.size > TACTICAL_LIMITS.cells || !Number.isInteger(tp) ||
		tp < 0 || tp > TACTICAL_LIMITS.tp) throw new Unavailable("cells/PT bound")

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
		chip.currentCooldown === 0 && chip.cost <= tp && validCost(chip.cost) &&
		toCandidate(chip, true, me.strength) !== null
	)
	if (enemies.length > TACTICAL_LIMITS.enemies || weapons.length > TACTICAL_LIMITS.weapons ||
		attackChips.length > TACTICAL_LIMITS.attackChips) throw new Unavailable("items/targets bound")
	// Le comportement configuré décide du soin, du bouclier et du poids du risque (seuils du rôle, comme le plan B).
	const strategy = createStrategy(profile)
	const lifeRatio = me.life / me.maxLife
	let closest: Entity | null = null
	let closestDistance = Infinity
	for (const enemy of enemies) {
		const range = Math.abs(me.cell.x - enemy.cell.x) + Math.abs(me.cell.y - enemy.cell.y)
		if (range < closestDistance) { closest = enemy; closestDistance = range }
	}
	const support = protections(me,
		profile.allowHealing && (strategy.shouldHeal(lifeRatio, 1 - lifeRatio) ||
			strategy.shouldHealWithThreat(lifeRatio, 1 - lifeRatio, closestDistance)),
		profile.allowShielding && closest !== null && strategy.shouldShield(lifeRatio, closestDistance,
			closest.mp + (closest.weapon?.maxRange ?? 1)),
		budget, tp)
	const weight = riskWeight(profile, strategy, lifeRatio, closestDistance)
	// Passivité (voir `StagnationTracker.riskFactor`) : le danger pèse de moins en moins tant qu'aucun dégât n'est
	// infligé, jusqu'à 0. `LETHAL_PENALTY` et le crédit de soin (`weight`) ne sont pas réduits ; dès que le poids est
	// réduit, le seuil de `LETHAL_PENALTY` descend à `PASSIVE_DANGER_LIFE_FRACTION` × mes PV (marge sous le modèle).
	// Posture du rôle (`posture`, `TacticalScore.ts`) : plancher de `p` (un rôle défensif ne devient jamais téméraire),
	// poids d'approche `a` de `G` et `N`, règle du recul sans tir et arme du trajet futur.
	const stance = posture(profile, 1 / NEXT_TURN_WEIGHT)
	const approach = stance.approach
	const wounded = woundedRiskFactor(enemies[0])
	const riskFactor = Math.min(context?.stagnation?.riskFactor ?? 1, wounded)
	const passivity = Math.max(riskFactor, stance.passivityFloor)
	const risk = weight * passivity
	const lifeFraction = riskFactor < 1 ? PASSIVE_DANGER_LIFE_FRACTION : 1
	if (riskFactor < 1) {
		log(() => `[Tactical] ${wounded < 1 ? `wounded enemy (${enemies[0]!.life}/${enemies[0]!.maxLife} HP)` :
			`passivity: ${context!.stagnation!.passiveTurns} turns without damage dealt`}; ` +
			`risk weight ${weight} x ${passivity}, danger accepted under ${PASSIVE_DANGER_LIFE_FRACTION} x life`, LOG_CONTEXT.PLANNING)
	}
	// Danger minimal de la zone (sert aussi à la sortie anticipée de `endingsFor`).
	let minDanger = Infinity
	for (const value of dangers.values()) minDanger = Math.min(minDanger, value)
	// Tour condamné : même test que `LETHAL_PENALTY` (`lethal`), vrai sur la case la moins dangereuse pour CHAQUE
	// protection candidate, donc pour tout plan (le danger exposé croît avec le danger). Alors : cible tuée d'abord
	// (`beats`), et aucun crédit des tours suivants d'un boost (`F` = 0, avec ou sans tir : un boost ne vaut que par les
	// dégâts de CE tour). Combat 54969530, tour 10 : protein sans tir (F = 51,3) + cure, 0 dégât.
	const doomed = support.every((protection) => lethal(me, protection, minDanger, lifeFraction))
	skipped.doomed = doomed
	if (doomed) {
		log(() => `[Tactical] doomed turn: least danger ${minDanger} is lethal with every protection ` +
			`(life ${me.life}, fraction ${lifeFraction}); kill first, no future boost credit`, LOG_CONTEXT.PLANNING)
	}
	// Recul sans dégâts : plan qui n'inflige rien, dont `G` < 0 ET la distance Manhattan augmente (il s'éloigne de
	// `enemies[0]` ; un détour du trajet futur qui rapproche en Manhattan n'en est pas un), vers une case MOINS
	// dangereuse que la mienne, sans soin ni bouclier utile (combats 54969622, 54976625, 54974628 : replis à PV pleins
	// vers une case de danger nul, zone réduite tour après tour, aucun dégât infligé). Un pas en arrière à danger égal ou
	// supérieur n'est pas un repli (il ne vaut que par `N`). La recherche le classe comme avant (`leaderRetreat` : il
	// est en tête), donc une recherche interrompue rend le même candidat qu'avant. En fin de recherche COMPLÈTE il est
	// remplacé par le meilleur plan qui INFLIGE DES DÉGÂTS (`substitute`) avec un danger sous
	// `PASSIVE_DANGER_LIFE_FRACTION` × mes PV (marge des critiques, comme à poids réduit ; sans objet s'il tue le dernier
	// ennemi), même si un plan sans dégâts est mieux classé que lui : le but est de tirer au lieu de reculer, pas de
	// s'exposer sans tirer (avance, pas de côté, protection ou boost seuls ne remplacent pas le recul). Sans un tel
	// plan, le recul est rendu comme avant : le refus ne rend jamais un plan nul, vide ou létal.
	// Jamais filtré (`freeRetreat`) : posture `free` (DEFENSIVE : se mettre à couvert sans tirer est son jeu), seuil de
	// repli du rôle (`shouldHide`), tour condamné, plusieurs ennemis (`G` ne mesure que `enemies[0]`). Un ennemi plus lent
	// ne l'autorise pas (54976625 : 5 PM contre 4, acculé au tour 6).
	// Le recul APRÈS des dégâts et la sortie de stagnation ne sont pas concernés.
	// Posture `advance` (AGGRESSIVE), en plus : sans plan à dégâts pour le remplacer, le recul en tête cède au meilleur
	// plan sans attaque qui AVANCE (`G` > 0) ou agit sur place (`G` = 0 avec soin, bouclier utile ou boost crédité), sous
	// la même marge de danger (`advance`, suivi dans la boucle du plan de progression). Ni pas de côté ni autre recul ne
	// le remplacent ; sans un tel plan, ou s'il vise une case déjà visitée par une sortie de stagnation (refusée ensuite :
	// plan nul), le recul est gardé. Vaut aussi quand aucune attaque n'est possible ce tour (phase d'approche).
	const freeRetreat = stance.retreat === "free" || doomed || enemies.length !== 1 ||
		(profile.allowHiding && strategy.shouldHide(lifeRatio, closestDistance))
	const originDanger = dangers.get(key(me.cell))!
	let leaderRetreat = false
	let substitute: TacticalPlan | null = null
	let advance: TacticalPlan | null = null
	// Boost : composante du plan. `boosts[0]` est toujours « aucun ». Un plan avec tir n'en lance pas sous
	// `MIN_LIFE_RATIO_FOR_BOOST` de PV ; un plan sans tir seulement si l'ennemi peut être à portée au tour suivant.
	const boosts = boostVariants(me, tp)
	// Sous ce seuil : ni PT ni force, mais l'agilité reste candidate (ses PT ne servent à rien d'autre ; le score tranche).
	const attackBoosts = lifeRatio >= MIN_LIFE_RATIO_FOR_BOOST ? boosts : boosts.filter((variant) => variant.tp === null && variant.strength === null)
	// Tour 1 sans arme équipée : 1 PT reste pour `equipOpeningWeapon` (après le plan) si le plan n'équipe pas d'arme.
	const openingReserve = Fight.turn === 1 && me.weapon === null && me.weapons.length > 0 ? 1 : 0
	const strengthGain = attackBoosts.find((variant) => variant.strength !== null)?.strength?.gain ?? 0
	let maxTp = tp
	for (const variant of attackBoosts) maxTp = Math.max(maxTp, tp - variant.cost + variant.tpGain)
	// Arme de référence du crédit futur quand le plan ne tire pas à l'arme.
	const referenceWeapon = me.weapon ?? weapons[0] ?? null
	// Sans tir, le crédit ne dépend pas de la case : la meilleure variante est choisie une fois par protection. Seul ce
	// crédit compte les puces offensives (`idle`) : sans tir, les PT du boost seraient perdus ; avec tir, non.
	const idleTarget = !doomed && boosts.length > 1 && closest !== null && closestDistance <= boostReach(me, closest) ? closest : null
	const idleCredits = boosts.map((variant) => idleTarget === null || variant.cost === 0 ? 0 :
		Math.min(idleTarget.life * FUTURE_TURN_WEIGHT, boostFuture(me, variant, referenceWeapon, idleTarget.life, true)))
	const idleBoosts = support.map((protection) => {
		let best = { variant: boosts[0]!, credit: 0 }
		if (idleTarget === null) return best
		for (let v = 0; v < boosts.length; v++) {
			const variant = boosts[v]!
			if (variant.cost === 0 ||
				tp - variant.cost + variant.tpGain < protection.cost + (variant.agility ? openingReserve : 0)) continue
			const credit = idleCredits[v]!
			if (credit > best.credit || (credit === best.credit && credit > 0 && variant.cost < best.variant.cost)) {
				best = { variant, credit }
			}
		}
		return best
	})
	const boostOf = (variant: BoostVariant): TacticalPlan["boost"] =>
		variant.cost > 0 ? { chips: variant.chips, tpGain: variant.tpGain } : undefined
	const hasAffordableWeapon = weapons.some((weapon) => validCost(weapon.cost) &&
		weapon.cost + (weapon === me.weapon ? 0 : 1) <= tp && toCandidate(weapon, false, me.strength))
	// Zone atteignable en tableaux denses (ordre BFS) : danger et voisins lus par indice dans les boucles chaudes,
	// au lieu d'une clé et d'une table par lecture. Tout préfixe d'un trajet total ≤ PM appartient à cette zone.
	const entries = [...reachable.entries()]
	const entryIndex = new Map<number, number>()
	for (let i = 0; i < entries.length; i++) entryIndex.set(key(entries[i]!.cell), i)
	const entryDanger = entries.map(({ cell }) => dangers.get(key(cell))!)
	if (enemies.length && (hasAffordableWeapon || attackChips.length === 0)) {
		const target = enemies[0]!
		const distance = (cell: Cell): number => Math.abs(cell.x - target.cell.x) + Math.abs(cell.y - target.cell.y)
		const stay = -riskCost(me, risk, support[0]!, dangers.get(key(me.cell))!, false, lifeFraction)
		// Seules les cases à 0 ou 1 PM sont des candidates précoces : filtrées une fois, pas une fois par protection.
		const near = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.cost <= 1)
		const originDistance = distance(me.cell)
		for (const protection of support) for (const { entry, index } of near) {
			budget.tick()
			const progress = originDistance - distance(entry.cell)
			if (!profile.allowHiding && entry.cost > 0 && progress <= 0) continue
			const danger = entryDanger[index]!
			const score = approach * progress - riskCost(me, risk, protection, danger, false, lifeFraction) + weight * protection.heal
			if (score <= stay || (entry.cost === 0 && protection.chips.length === 0)) continue
			if (!beats(budget.incumbent, doomed, 0, score, danger, protection.cost, target, undefined, undefined, entry.cost)) continue
			budget.incumbent = {
				target, shotCell: me.cell, destination: entry.cell, beforeMp: 0, afterMp: entry.cost,
				weapon: null, weaponShots: 0, chips: [], protection: protection.chips,
				tpUsed: protection.cost, usefulDamage: 0, danger, progress, score
			}
		}
	}

	const adjacency: number[][] = []
	for (const { cell } of entries) {
		budget.tick()
		const adjacent: number[] = []
		for (const [dx, dy] of MOVE_NEIGHBOR_OFFSETS) {
			const neighbor = entryIndex.get((cell.x + dx) * 4096 + cell.y + dy)
			if (neighbor !== undefined) adjacent.push(neighbor)
		}
		adjacency.push(adjacent)
	}
	// Distance de tir courante par case (Infinity : inconnue), remplie par l'anticipation ci-dessous.
	const firing: number[] = entries.map(() => Infinity)
	// Plus petite distance de tir parmi les cases de danger minimal : quand la fin trouvée atteint déjà les deux,
	// aucune case plus lointaine du parcours ne peut la remplacer (égalité stricte exigée).
	let minFiring = Infinity
	// `N` par arme équipée en fin de plan (indice de `nextEquipped`) et par case atteignable, avant le contrôle de
	// létalité : null tant qu'il n'est pas calculé, ou nul partout. `maxNext[e]` : son maximum sur ma zone.
	let nextValues: number[][] | null = null
	let nextEquipped: Array<Weapon | null> = []
	let maxNext: number[] = []
	const nextState = (weapon: Weapon | null): number => nextValues === null ? 0 : Math.max(0, nextEquipped.indexOf(weapon))
	interface Ending { index: number; cell: Cell; cost: number; danger: number }
	const endingCache = new Map<number, Ending[]>()
	const seenStamp: number[] = entries.map(() => 0)
	let stamp = 0
	/**
	 * Fins candidates après un tir depuis `shot`, par danger croissant : pour chaque valeur de `N`, la case de moindre
	 * danger (puis de moindre distance de tir, puis la moins chère en PM), sauf si une case de danger ≤ a un `N`
	 * supérieur. Le coût de risque croît avec le danger pour toute protection : la meilleure fin en fait partie.
	 * Sans `N` (ou `N` égal partout) : une seule fin, la case de moindre danger, et la même sortie anticipée.
	 */
	const endingsFor = (shot: { cell: Cell; cost: number }, state: number): Ending[] => {
		const start = entryIndex.get(key(shot.cell))!
		const cached = endingCache.get(start * 8 + state)
		if (cached) return cached
		const values = nextValues ? nextValues[state]! : null
		const top = values ? maxNext[state]! : 0
		const queue = [start]
		const costs = [0]
		seenStamp[start] = ++stamp
		const groups = new Map<number, { index: number; cost: number; danger: number }>()
		const limit = profile.allowHiding ? mp - shot.cost : 0
		for (let head = 0; head < queue.length; head++) {
			budget.tick()
			const index = queue[head]!
			const value = entryDanger[index]!
			const worth = values ? values[index]! : 0
			const group = groups.get(worth)
			if (!group || value < group.danger || (value === group.danger && firing[index]! < firing[group.index]!)) {
				groups.set(worth, { index, cost: costs[head]!, danger: value })
			}
			const best = groups.get(top)
			if (best && best.danger === minDanger && firing[best.index]! <= minFiring) break
			if (costs[head]! >= limit) continue
			for (const neighbor of adjacency[index]!) {
				if (seenStamp[neighbor] === stamp) continue
				seenStamp[neighbor] = stamp
				queue.push(neighbor)
				costs.push(costs[head]! + 1)
			}
		}
		const found = [...groups.entries()]
		const endings = found.filter(([worth, group]) => !found.some(([otherWorth, other]) =>
			otherWorth > worth && other.danger <= group.danger))
			.map(([, group]) => ({ index: group.index, cell: entries[group.index]!.cell, cost: group.cost, danger: group.danger }))
			.sort((a, b) => a.danger - b.danger)
		endingCache.set(start * 8 + state, endings)
		return endings
	}
	/** `N` d'un plan qui finit sur la case `index`, arme `state` en main ; nul si la case est létale avec cette protection. */
	const nextValue = (index: number, protection: Protection, state: number): number =>
		nextValues === null || lethal(me, protection, entryDanger[index]!, lifeFraction) ? 0 : nextValues[state]![index]!
	/** Fin qui maximise `N` − coût de risque pour cette protection ; à égalité, la moins dangereuse. */
	const endingFor = (shot: { cell: Cell; cost: number }, protection: Protection, state: number): Ending => {
		const endings = endingsFor(shot, state)
		let best = endings[0]!
		if (endings.length === 1) return best
		let bestScore = -Infinity
		for (const ending of endings) {
			budget.tick()
			const score = nextValue(ending.index, protection, state) -
				riskCost(me, risk, protection, ending.danger, false, lifeFraction)
			if (score > bestScore) { best = ending; bestScore = score }
		}
		return best
	}
	const retainWeapon = (target: Entity, weapon: Weapon, item: ShotCandidate, shot: { cell: Cell; cost: number }): void => {
		const equip = weapon === me.weapon ? 0 : 1
		// Appelé avant le calcul de `N` : une seule fin, la case de moindre danger ; `N` est ajouté ensuite à l'option gardée.
		const ending = endingsFor(shot, 0)[0]!
		const danger = ending.danger
		const states = attacks(tp - equip, item, [], target, budget)
		const choices = attackChoices(states, target, true, budget)
		for (const protection of support) {
			budget.tick()
			const choice = choices[tp - equip - protection.cost]
			if (!choice) continue
			const { attack, cost } = choice
			const usefulDamage = Math.min(target.life, attack.damage)
			const tpUsed = cost + equip + protection.cost
			const score = usefulDamage -
				riskCost(me, risk, protection, danger, killsLastEnemy(attack.damage, target, enemies.length), lifeFraction) +
				weight * protection.heal
			if (!beats(budget.incumbent, doomed, usefulDamage, score, danger, tpUsed, target, undefined, undefined, shot.cost + ending.cost)) continue
			budget.incumbent = {
				target, shotCell: shot.cell, destination: ending.cell, beforeMp: shot.cost, afterMp: ending.cost,
				weapon, weaponShots: attack.weaponShots, chips: [], protection: protection.chips,
				tpUsed, usefulDamage, danger, score
			}
		}
	}
	// Option complète avant les fournisseurs ; améliorée dès que chaque arme est
	// préparée, AVANT de lancer les fournisseurs suivants (notamment les puces).
	const readyWeapon = me.weapon ?? weapons[0] ?? null
	const readyCandidate = readyWeapon && validCost(readyWeapon.cost) ? toCandidate(readyWeapon, false, me.strength) : null
	if (readyWeapon && readyCandidate) for (const target of enemies) {
		const equip = readyWeapon === me.weapon ? 0 : 1
		if (readyCandidate.cost + equip > tp) continue
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
	// Un fournisseur natif (`getCellsToUseWeapon`/`getCellsToUseChip`, 25 834 ops l'appel d'après la documentation
	// officielle LeekScript ; non vérifié pour l'API TypeScript) n'est utile que si une case de MA zone atteignable
	// est à portée de Manhattan [min, max] de la cible : la liste native est un sous-ensemble de ces cases. Test sur la
	// zone elle-même, plus serré que « distance de départ ≤ portée + PM » (obstacles et occupants exclus de la zone).
	const mayReach = (target: Entity, item: Weapon | Chip): boolean => {
		if (!Number.isFinite(item.maxRange)) return true
		const minRange = Number.isFinite(item.minRange) ? item.minRange : 0
		for (const { cell } of entries) {
			const range = Math.abs(cell.x - target.cell.x) + Math.abs(cell.y - target.cell.y)
			if (range >= minRange && range <= item.maxRange) return true
		}
		return false
	}
	const chipZones = new Map<Chip, Cell[]>()
	const prepared = enemies.map((target) => ({
		target,
		weapons: weapons.map((weapon) => {
			const candidate = validCost(weapon.cost) ? toCandidate(weapon, false, me.strength) : null
			if (!candidate || candidate.cost + (weapon === me.weapon ? 0 : 1) > tp ||
				!mayReach(target, weapon)) return { weapon, candidate: null, cells: new Set<number>() }
			const cells = nativeCells(() => {
				// Liste déjà obtenue (recherche sans boost) : un appel natif n'est jamais refait ; la liste ne dépend pas de mes PM.
				let byWeapon = preparation.weaponCells.get(target)
				const known = byWeapon?.get(weapon)
				if (known) return known
				const cells = Fight.weaponCells(target, weapon)
				if (!byWeapon) preparation.weaponCells.set(target, byWeapon = new Map())
				byWeapon.set(weapon, cells) // Même si le contrôle suivant interrompt la recherche.
				return cells
			})
			let nearest: typeof entries[number] | null = null
			let nearestDanger = Infinity
			for (let i = 0; i < entries.length; i++) {
				budget.tick()
				const entry = entries[i]!
				if (cells.has(key(entry.cell)) && (nearest === null || entry.cost < nearest.cost ||
					(entry.cost === nearest.cost && entryDanger[i]! < nearestDanger))) {
					nearest = entry; nearestDanger = entryDanger[i]!
				}
			}
			if (nearest) retainWeapon(target, weapon, candidate, nearest)
			return { weapon, candidate, cells }
		}),
		// Refus depuis ma case alors qu'elle N'EST PAS dans la liste native : la géométrie (portée, alignement, ligne
		// de vue) l'explique, la puce est créditée sur les cases natives atteignables (déplacement puis tir, revérifié
		// par `canUseChip` à l'arrivée). Refus alors que ma case EST dans la liste : restriction inconnue, puce écartée.
		chips: attackChips.map((chip) => {
			if (!mayReach(target, chip)) return null
			const cells = nativeCells(() => {
				let byChip = preparation.chipCells.get(target)
				const raw = byChip?.get(chip) ?? me.chipCells(chip, target)
				if (!byChip) preparation.chipCells.set(target, byChip = new Map())
				byChip.set(chip, raw)
				chipZones.set(chip, raw) // Réutilisé par la sortie de stagnation, sans second appel natif.
				return raw
			})
			budget.check()
			const usable = me.canUseChip(chip, target)
			budget.check()
			if (!usable && cells.has(key(me.cell))) { skipped.refused++; return null }
			// Zone d'effet non simulée : pas de tir depuis une case où je serais dans la zone centrée sur la cible.
			const radius = selfHitRadius(chip)
			if (radius > 0) {
				const outside = (cell: Cell): boolean =>
					Math.abs(cell.x - target.cell.x) + Math.abs(cell.y - target.cell.y) > radius
				for (const { cell } of entries) {
					budget.tick()
					if (!outside(cell)) cells.delete(key(cell))
				}
				chipZones.set(chip, chipZones.get(chip)!.filter(outside)) // même garde pour la sortie de stagnation
			}
			return { candidate: toCandidate(chip, true, me.strength) as ShotCandidate, cells }
		}).filter((chip) => chip !== null)
	}))
	// Anticipation limitée : distances dans le graphe courant vers les cases de tir
	// natives déjà obtenues pour l'unique cible. Aucun nouveau fournisseur ni LOS.
	// La position ennemie et les obstacles au prochain tour restent inconnus.
	if (prepared.length === 1) {
		const queue: number[] = []
		for (const weapon of prepared[0]!.weapons) for (const id of weapon.cells) {
			budget.tick()
			const index = entryIndex.get(id)
			if (index !== undefined && firing[index] === Infinity) { firing[index] = 0; queue.push(index) }
		}
		for (let head = 0; head < queue.length; head++) {
			budget.tick()
			const index = queue[head]!
			const nextDistance = firing[index]! + 1
			for (const neighbor of adjacency[index]!) {
				if (firing[neighbor] === Infinity) { firing[neighbor] = nextDistance; queue.push(neighbor) }
			}
		}
		for (let i = 0; i < entries.length; i++) {
			if (entryDanger[i] === minDanger) minFiring = Math.min(minFiring, firing[i]!)
		}
	}
	// Terme `N` (un seul ennemi) : dégâts du tour suivant calculés pour TOUTES les cases dans leur propre allocation,
	// sinon `N` nul pour toutes. Puces : exactement celles que la recherche de ce tour crédite (même règle : écartée
	// seulement si `canUseChip` la refuse depuis une case de sa liste native ; cases sous zone d'effet déjà retirées), de
	// cooldown de base 0 ou 1 (prêtes au tour suivant même si le plan les lance). Aucun appel natif de plus.
	let nextDamages: NextTurn | null = null
	if (enemies.length === 1) {
		try {
			const zones: Array<{ item: Weapon | Chip; isChip: boolean; cells: readonly Cell[] }> = []
			for (const [weapon, cells] of preparation.weaponCells.get(enemies[0]!) ?? []) zones.push({ item: weapon, isChip: false, cells })
			for (const { candidate } of prepared[0]!.chips) {
				const chip = candidate.item as Chip
				const cells = chipZones.get(chip)
				if (cells && (chip.cooldown === 0 || chip.cooldown === 1)) zones.push({ item: chip, isChip: true, cells })
			}
			nextDamages = nextTurnDamages(me, enemies[0]!, entries, entryIndex, zones, new Budget(NEXT_TURN_FRACTION),
				// Prochain tour : mes PM, plus ceux du boost de PM s'il dure encore (durée >= 2 : hypothèse non vérifiée).
				frame.boost !== null && frame.boost.turns >= 2 ? mp : me.mp)
		} catch (error) {
			const cause = error instanceof Error ? error.message : String(error)
			log(() => `[Tactical] next-turn value unavailable (${cause}): N = 0 for every cell`, LOG_CONTEXT.PLANNING)
		}
		budget.check()
	}
	const firingDistance = (target: Entity, cell: Cell): number | undefined => {
		if (target !== prepared[0]?.target) return undefined
		const distance = firing[entryIndex.get(key(cell))!]
		return distance === Infinity ? undefined : distance
	}
	const weaponOffense = prepared.some((enemy) =>
		enemy.weapons.some((w) => w.candidate && netDamage(w.candidate, enemy.target) > 0 && w.cells.size > 0))
	const hasOffense = weaponOffense || prepared.some((enemy) =>
		enemy.chips.some((c) => netDamage(c.candidate, enemy.target) > 0 && c.cells.size > 0))
	// Le trajet futur est celui d'une ARME : une puce atteignable ce tour ne le coupe pas (son tir peut être décliné
	// comme trop dangereux ; l'avance sûre vers une case de tir d'arme doit alors rester un plan candidat).
	// Arme visée selon la posture : ordre de l'inventaire (arme en main d'abord), ou d'abord l'arme aux meilleurs dégâts
	// moyens sur un tour (tirs permis par mes PT et `maxUses`, 1 PT d'équipement hors main), ou à la plus longue portée.
	const routeWeapons = (target: Entity): readonly Weapon[] => {
		if (stance.routeWeapon === "first") return weapons
		let first: Weapon | null = null
		let firstValue = 0
		for (const weapon of weapons) {
			let value = 0
			if (stance.routeWeapon === "range") value = Number.isFinite(weapon.maxRange) ? weapon.maxRange : 0
			else {
				const candidate = validCost(weapon.cost) ? toCandidate(weapon, false, me.strength) : null
				if (candidate) value = netDamage(candidate, target) *
					Math.min(candidate.uses, Math.floor((tp - (weapon === me.weapon ? 0 : 1)) / candidate.cost))
			}
			if (value > firstValue) { first = weapon; firstValue = value }
		}
		return first === null ? weapons : [first, ...weapons.filter((weapon) => weapon !== first)]
	}
	const futureRoute = !weaponOffense && enemies.length === 1
		? futureWeaponRoute(me, enemies[0]!, routeWeapons(enemies[0]!), reachable, budget, mp) : null
	// Si la case hypothétique est déjà accessible ce tour, conserver le progrès
	// Manhattan existant ; la distance sert seulement à départager les égalités.
	const futureProgress = futureRoute && futureRoute.get(key(me.cell))! > mp ? futureRoute : null
	// Une table exacte par cible/arme/masque de puces utilisables, pas par case : `tables[0]` à ma force actuelle,
	// `tables[1]` à la force boostée (seulement si une variante de force existe) ; `future` : crédit par variante.
	interface Offense { tables: Array<Array<AttackChoice | undefined>>; future: number[] }
	interface OffenseOption { target: Entity; weapon: Weapon | null; equipCost: number; tables: Offense }
	const attackCache = new Map<string, Offense>()
	const offenses: Array<OffenseOption[] | undefined> = []
	/** Options d'attaque depuis la case de tir `entries[s]` (mémoïsées : préparées une fois, lues par le classement). */
	const offenseAt = (s: number): OffenseOption[] => {
		const known = offenses[s]
		if (known) return known
		const shot = entries[s]!
		// Depuis la case de tir, pas depuis l'origine : interdit de réutiliser deux fois les mêmes PM.
		// Les supports n'améliorent pas les dégâts : une seule table par cible/case/arme suffit
		// pour TOUS leurs budgets résiduels (les états sont indexés par coût exact).
		const offense: OffenseOption[] = []
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
				if (equipCost > tp) continue
				const cacheKey = `${enemyIndex}:${optionIndex}:${mask}`
				let tables = attackCache.get(cacheKey)
				if (!tables) {
					const table = (weapon: ShotCandidate | null, chips: readonly ShotCandidate[]) => attackChoices(
						attacks(maxTp - equipCost, weapon, chips, enemy.target, budget), enemy.target, option !== null, budget)
					tables = {
						tables: [table(option?.candidate ?? null, usableChips)],
						future: attackBoosts.map((variant) => variant.cost === 0 ? 0 :
							boostFuture(me, variant, option?.weapon ?? referenceWeapon, enemy.target.life))
					}
					if (strengthGain > 0) {
						const boosted = (item: Weapon | Chip, isChip: boolean): ShotCandidate | null =>
							toCandidate(item, isChip, me.strength + strengthGain)
						tables.tables.push(table(option ? boosted(option.weapon, false) : null,
							usableChips.map((chip) => boosted(chip.item, true)).filter((chip) => chip !== null)))
					}
					attackCache.set(cacheKey, tables)
				}
				offense.push({ target: enemy.target, weapon: option?.weapon ?? null, equipCost, tables })
			}
		}
		offenses[s] = offense
		return offense
	}
	// `N` = `a` × `NEXT_TURN_WEIGHT` × min(PV de la cible − `U_max`, dégâts du tour suivant depuis la case), où `U_max` est le
	// plus grand dégât utile qu'un plan quelconque peut infliger CE tour (toutes cases de tir, armes et boosts, sans
	// protection ni danger). `N` ne dépend donc que de la case finale : renoncer à un tir coûte ses dégâts pleins, et si
	// un coup fatal est possible ce tour `N` est nul partout (classement identique à celui sans `N`).
	if (nextDamages !== null) {
		const target = enemies[0]!
		let maxUseful = 0
		if (hasOffense) for (let s = 0; s < entries.length && maxUseful < target.life; s++) {
			for (const option of offenseAt(s)) for (const variant of attackBoosts) {
				budget.tick()
				const choice = option.tables.tables[variant.strength ? 1 : 0]![tp - variant.cost + variant.tpGain - option.equipCost]
				if (choice) maxUseful = Math.max(maxUseful, Math.min(target.life, choice.attack.damage))
			}
		}
		const remaining = target.life - maxUseful
		if (remaining > 0) {
			// Poids d'approche compris (≤ 1 au total, voir `posture`) : toute la suite lit `N` déjà pondéré.
			const nextWeight = approach * NEXT_TURN_WEIGHT
			nextEquipped = nextDamages.equipped
			nextValues = nextDamages.damages.map((row) => row.map((damage) => nextWeight * Math.min(remaining, damage)))
			maxNext = nextValues.map((row) => Math.max(...row))
			// Les options complètes gardées avant ce point (sans `N`) reçoivent le leur : la suite compare des scores avec `N`.
			if (budget.incumbent) {
				const kept = budget.incumbent
				const nextTurn = nextValue(entryIndex.get(key(kept.destination))!,
					support.find((protection) => protection.chips === kept.protection) ?? support[0]!,
					nextState(kept.weapon ?? me.weapon))
				if (nextTurn > 0) budget.incumbent = { ...kept, score: kept.score + nextTurn, nextTurn }
			}
		}
	}
	endingCache.clear()
	// `G` par case, vers `enemies[0]` (cible des plans sans attaque) : Manhattan, ou trajet futur. Une fois par case,
	// pas une fois par (protection, case) ; sert aussi au filtre du recul sans tir du classement offensif.
	const progressTarget = enemies[0]
	const geometric = progressTarget ? entries.map(({ cell }) =>
		Math.abs(me.cell.x - progressTarget.cell.x) + Math.abs(me.cell.y - progressTarget.cell.y) -
		Math.abs(cell.x - progressTarget.cell.x) - Math.abs(cell.y - progressTarget.cell.y)) : []
	const originFuture = futureProgress ? futureProgress.get(key(me.cell))! : 0
	const progressOf = futureProgress
		? entries.map(({ cell }) => originFuture - futureProgress.get(key(cell))!) : geometric
	// Sans case plus lointaine (Manhattan) et plus sûre que la mienne, aucun recul ne peut être en tête : rien à suivre.
	const retreatPossible = !freeRetreat && geometric.some((gain, i) => gain < 0 && entryDanger[i]! < originDanger)
	const advancePossible = retreatPossible && stance.retreat === "advance"
	// Sans attaque connue, progression/couvert/support sont AUSSI un plan complet.
	// Une puce refusée depuis une case de sa liste native n'autorise pas une approche de tir fictive.
	let progressPlan: TacticalPlan | null = null
	if (enemies.length && (hasAffordableWeapon || futureRoute || !skipped.refused)) {
		const target = enemies[0]!
		const futureDistance = futureRoute ? entries.map(({ cell }) => futureRoute.get(key(cell))) : null
		const firingOf = entries.map(({ cell }) => firingDistance(target, cell))
		for (let p = 0; p < support.length; p++) for (let i = 0; i < entries.length; i++) {
			const protection = support[p]!
			const idle = idleBoosts[p]!
			const ending = entries[i]!
			budget.tick()
			if (!profile.allowHiding && geometric[i]! <= 0 && !same(ending.cell, me.cell)) continue
			const progress = progressOf[i]!
			const danger = entryDanger[i]!
			const nextTurn = nextValue(i, protection, 0)
			// `plan.progress` reste la distance brute ; seul le score porte le poids d'approche.
			const score = approach * progress - riskCost(me, risk, protection, danger, false, lifeFraction) +
				weight * protection.heal + idle.credit + nextTurn
			const futureRouteDistance = futureDistance?.[i]
			const tpUsed = protection.cost + idle.variant.cost
			const useful = protection.heal > 0 || shieldCredit(protection, danger) > 0
			const retreat = !freeRetreat && progress < 0 && geometric[i]! < 0 && danger < originDanger && !useful
			const leads = beats(progressPlan, doomed, 0, score, danger, tpUsed, target, firingOf[i], futureRouteDistance, ending.cost)
			// Remplaçant du recul en posture `advance`, suivi à part tant qu'il n'est pas lui-même en tête (voir `freeRetreat`).
			const standIn = advancePossible && (leads || advance !== progressPlan) &&
				(progress > 0 || (progress === 0 && (useful || idle.credit > 0))) &&
				!lethal(me, protection, danger, PASSIVE_DANGER_LIFE_FRACTION)
			if (!leads && !(standIn && beats(advance, doomed, 0, score, danger, tpUsed, target, firingOf[i],
				futureRouteDistance, ending.cost))) continue
			const candidate: TacticalPlan = {
				target, shotCell: me.cell, destination: ending.cell, beforeMp: 0, afterMp: ending.cost,
				weapon: null, weaponShots: 0, chips: [], protection: protection.chips, boost: boostOf(idle.variant),
				tpUsed, usefulDamage: 0, danger, progress,
				progressModel: futureProgress ? "future firing route" : undefined,
				firingDistance: firingOf[i],
				futureRouteDistance,
				score, nextTurn
			}
			if (standIn) advance = candidate
			if (!leads) continue
			leaderRetreat = retreat
			progressPlan = candidate
			if ((ending.cost > 0 || useful || idle.credit > 0) && better(candidate, budget.incumbent, doomed)) budget.incumbent = candidate
		}
	}
	// Règle de stagnation (voir `stagnationEscape` et `StagnationTracker`) appliquée au plan NORMAL, toujours calculé
	// d'abord. Garantie : tant que le plan normal tire ou progresse, il est exécuté tel quel, donc la règle ne peut
	// jamais retarder un tir par rapport à la règle désactivée (tant que la sortie n'a pas été engagée, la trajectoire
	// est celle de la règle désactivée). Elle n'agit que si ce plan est bloqué (aucun tir, aucun déplacement) ou si une
	// sortie est déjà engagée (sinon le progrès Manhattan ramènerait Kassbi dans son minimum local : 187 → 133 → 187).
	const stagnation = context?.stagnation
	const withStagnation = (planned: TacticalPlan | null): TacticalPlan | null => {
		if (frame.boost !== null) return planned // seconde recherche (boost de PM) : aucun effet de bord sur la stagnation
		if (planned && (planned.weaponShots > 0 || planned.chips.length > 0)) {
			stagnation?.noteOffense() // un tir RÉEL est prévu : le planificateur normal garde la main
			return planned
		}
		// Anti-oscillation sur TOUT l'épisode : le plan normal ne retourne pas vers une case visitée par une sortie
		// (départ, arrivée, case de stagnation d'origine), sauf record de proximité (jamais le cas d'une case déjà visitée
		// avec des ennemis immobiles). Sont toujours acceptés : un tir prévu, un déplacement vers une case non visitée,
		// un déplacement dont le danger final est STRICTEMENT inférieur à celui de la case courante (retraite de sécurité),
		// et tout plan avec protection (déplacement + protection compris). Seul un déplacement de progression sans gain
		// de sécurité vers une case visitée est refusé.
		let normal = planned
		const currentDanger = dangers.get(key(me.cell))!
		if (stagnation && planned && planned.afterMp > 0 && planned.protection.length === 0 &&
			planned.danger >= currentDanger && stagnation.visited(planned.destination)) {
			const toEnemy = Math.min(...enemies.map((enemy) =>
				Math.abs(planned.destination.x - enemy.cell.x) + Math.abs(planned.destination.y - enemy.cell.y)))
			if (!stagnation.beatsRecord(toEnemy)) {
				log(() => `[Tactical] stagnation: move back to visited cell (${planned.destination.x},` +
					`${planned.destination.y}) refused`, LOG_CONTEXT.PLANNING)
				normal = null
			}
		}
		if (!stagnation?.active || !enemies.length) return normal
		// Une retraite de sécurité (danger final strictement inférieur à celui de la case courante) n'est jamais remplacée
		// par la sortie, dont le plafond de danger est celui de la case courante : elle serait plus exposée que la retraite.
		if (normal && normal.afterMp > 0 && normal.danger < currentDanger) return normal
		const blocked = normal === null || (normal.afterMp === 0 && normal.protection.length === 0)
		if (!blocked && !stagnation.escaping) return normal
		const escape = stagnationEscape({
			me, target: enemies[0]!, turns: stagnation.turns, weapons, attackChips, chipZones,
			entries, dangers, preparation, skipped, budget, visited: (cell) => stagnation.visited(cell),
			riskFree: risk === 0
		})
		if (escape) {
			stagnation.commit(me.cell, escape.destination)
			// La sortie remplace un plan bloqué : elle garde le boost sans tir de ce plan (PT inutilisés).
			const idle = idleBoosts[0]!.variant
			return idle.cost > 0 ? { ...escape, boost: boostOf(idle), tpUsed: idle.cost } : escape
		}
		if (!stagnation.escaping) return normal
		// Sortie engagée sans case sûre plus proche par la marche (ennemi qui a fui, frontière de danger) : on LÈVE
		// l'engagement et le plan normal s'exécute (un maintien éternel retardait le premier tir d'un ennemi qui fuit),
		// sauf retour vers une case visitée (refusé ci-dessus, ce tour et les suivants) ; la sortie ne se ré-engage
		// jamais vers une case visitée.
		stagnation.release()
		log(() => `[Tactical] stagnation: escape released (no safe cell closer by walking); the normal plan resumes`,
			LOG_CONTEXT.PLANNING)
		return normal
	}
	// Fin de recherche complète, posture `advance` : le recul sans dégâts en tête, qu'aucun plan à dégâts ne remplace,
	// cède à `advance` s'il existe (toujours un plan qui agit, sous la marge de danger).
	const advanceInstead = (leader: TacticalPlan | null): TacticalPlan | null => {
		if (!leaderRetreat || leader === null || advance === null ||
			(advance.afterMp > 0 && stagnation?.visited(advance.destination))) return leader
		const kept = advance
		log(() => `[Tactical] aggressive posture: retreat without damage refused: (${leader.destination.x},${leader.destination.y}) ` +
			`progress ${leader.progress ?? "none"}, danger ${leader.danger}, score ${leader.score}; no damaging plan, ` +
			`(${kept.destination.x},${kept.destination.y}) progress ${kept.progress}, danger ${kept.danger} under ` +
			`${PASSIVE_DANGER_LIFE_FRACTION} x life kept instead (score ${kept.score})`, LOG_CONTEXT.PLANNING)
		return kept
	}
	if (!hasOffense) {
		const leader = advanceInstead(progressPlan)
		skipped.leaderScore = leader?.score ?? null
		const normal = leader && (leader.afterMp > 0 || leader.protection.length > 0 || leader.boost) ? leader : null
		const result = withStagnation(normal)
		// Plan nul : la case actuelle est le meilleur progrès (souvent un minimum local de distance Manhattan).
		if (result === null && progressPlan && skipped.noProgress === null) skipped.noProgress = "no improving progress"
		return result
	}
	let best: TacticalPlan | null = progressPlan
	let actionable = false
	for (let s = 0; s < entries.length; s++) {
		const shot = entries[s]!
		budget.tick()
		const offense = offenseAt(s)
		if (!same(shot.cell, me.cell) &&
			!offense.some((o) => (o.tables.tables[0]![maxTp - o.equipCost]?.attack.damage ?? 0) > 0)) continue
		for (let p = 0; p < support.length; p++) {
			const protection = support[p]!
			// La fin dépend de la case de tir, de la protection et de l'arme en main à la fin, pas du boost. Sans `N`,
			// D − crédit(D) étant monotone, c'est la même case de moindre danger pour tous les supports.
			const picked: Array<Ending | undefined> = []
			for (const option of offense) for (let v = 0; v < attackBoosts.length; v++) {
				let variant = attackBoosts[v]!
				// Le boost est payé d'abord ; le reste (PT gagnés compris) finance protection, équipement et attaque.
				const available = tp - variant.cost + variant.tpGain - protection.cost - option.equipCost
				budget.tick()
				const choice = option.tables.tables[variant.strength ? 1 : 0]![available]
				if (!choice) continue
				const { attack, cost } = choice
				// Sans dégâts ce tour, seul le boost « sans tir » de cette protection est permis (`idleBoosts`).
				let future = 0
				if (!(attack.damage > 0)) {
					if (variant.cost > 0) continue
					if (cost === 0) { variant = idleBoosts[p]!.variant; future = idleBoosts[p]!.credit }
				}
				// Agilité sans arme (puces seules) : le PT de l'équipement du tour 1 n'est pas pris au plan.
				if (attackBoosts[v]!.agility && option.weapon === null && openingReserve > 0 && available - cost < openingReserve) continue
				// Sans repli autorisé, un déplacement avant tir doit permettre des dégâts utiles.
				if (!profile.allowHiding && !(attack.damage > 0) && !same(shot.cell, me.cell)) continue
				const state = attack.weaponShots > 0 ? nextState(option.weapon) : 0
				let ending = picked[state]
				if (!ending) picked[state] = ending = endingFor(shot, protection, state)
				const finalDanger = ending.danger
				const nextTurn = nextValue(ending.index, protection, state)
				if (attack.damage > 0 || protection.heal > 0 || shieldCredit(protection, finalDanger) > 0) actionable = true
				const usefulDamage = Math.min(option.target.life, attack.damage)
				const tpUsed = cost + protection.cost + option.equipCost + variant.cost
				const kills = killsLastEnemy(attack.damage, option.target, enemies.length)
				// Sans dégâts (aucun tir, ou tir entièrement absorbé), ce plan n'est qu'un déplacement : même filtre que le
				// plan sans attaque (voir `freeRetreat`).
				const retreat = !freeRetreat && !(attack.damage > 0) && progressOf[ending.index]! < 0 &&
					geometric[ending.index]! < 0 && finalDanger < originDanger && !(protection.heal > 0 || shieldCredit(protection, finalDanger) > 0)
				// Tours suivants du boost, plafonnés par les PV qui restent à la cible après ce tour, eux aussi pondérés :
				// des dégâts remis à plus tard ne valent jamais ceux de ce tour (un boost ne bat pas le coup fatal à égalité).
				if (attack.damage > 0 && !doomed) {
					future = Math.min((option.target.life - usefulDamage) * FUTURE_TURN_WEIGHT, option.tables.future[v]!)
				}
				// Critiques de ce tour (agilité) : sans objet si le tir tue la cible.
				const critNow = variant.agility && attack.damage > 0 && attack.damage < option.target.life
					? usefulDamage * agilityCritGain(me, variant.agility) : 0
				const score = usefulDamage + critNow - riskCost(me, risk, protection, finalDanger, kills, lifeFraction) +
					weight * protection.heal + future + nextTurn
				const firingDistanceAtEnd = firingDistance(option.target, ending.cell)
				// Même départage que le plan de progression (trajet futur, seulement sans tir d'arme à portée).
				const futureRouteAtEnd = futureRoute?.get(key(ending.cell))
				const leads = beats(best, doomed, usefulDamage, score, finalDanger, tpUsed, option.target, firingDistanceAtEnd,
					futureRouteAtEnd, shot.cost + ending.cost)
				// Meilleur plan à dégâts sous la marge de danger, suivi à part tant qu'il n'est pas lui-même en tête (alors
				// aucun candidat battu par la tête ne peut le battre) : c'est lui qui remplacera un recul sans dégâts.
				const damaging = retreatPossible && (leads || substitute !== best) && attack.damage > 0 &&
					(kills || !lethal(me, protection, finalDanger, PASSIVE_DANGER_LIFE_FRACTION))
				if (!leads && !(damaging && beats(substitute, doomed, usefulDamage, score, finalDanger, tpUsed, option.target,
					firingDistanceAtEnd, futureRouteAtEnd, shot.cost + ending.cost))) continue
				const candidate: TacticalPlan = {
					target: option.target, shotCell: shot.cell, destination: ending.cell,
					beforeMp: shot.cost, afterMp: ending.cost,
					weapon: attack.weaponShots > 0 ? option.weapon : null,
					weaponShots: attack.weaponShots, chips: attack.chips, protection: protection.chips,
					boost: boostOf(variant), tpUsed, usefulDamage, danger: finalDanger,
					firingDistance: firingDistanceAtEnd, futureRouteDistance: futureRouteAtEnd,
					score, nextTurn
				}
				if (damaging) substitute = candidate
				if (!leads) continue
				leaderRetreat = retreat
				best = candidate
				if (actionable && better(candidate, budget.incumbent, doomed)) budget.incumbent = candidate
			}
		}
	}
	// Fin de recherche complète : le recul sans dégâts en tête cède au meilleur plan à dégâts sous la marge, s'il existe.
	if (actionable && leaderRetreat && best !== null && substitute !== null) {
		const refused = best, kept = substitute
		log(() => `[Tactical] retreat without damage refused: (${refused.destination.x},${refused.destination.y}) progress ` +
			`${refused.progress ?? "none"}, danger ${refused.danger}, score ${refused.score}; life above the retreat threshold, ` +
			`a plan dealing ${kept.usefulDamage} under ${PASSIVE_DANGER_LIFE_FRACTION} x life exists (score ${kept.score})`,
		LOG_CONTEXT.PLANNING)
		best = kept
	} else if (actionable) best = advanceInstead(best)
	skipped.leaderScore = best?.score ?? null
	return withStagnation(actionable ? best : null)
}
