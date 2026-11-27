// @version:5.8
// file version: 9
import { ReachableCells, computeReachableCells } from "../Classes/Context/ReachableCells.js"
import {
	agilityBoostOf,
	agilityBoostTurns,
	baseMeanDamage,
	isAgilityBoostType,
	isMpBoostType,
	isStrengthBoostType,
	isTpBoostType,
	maxUsesOf,
	mpBoostOf,
	mpBoostTurns,
	planShots,
	strengthBoostOf,
	strengthBoostTurns,
	ShotCandidate,
	toCandidate,
	tpBoostOf,
	tpBoostTurns
} from "../Classes/Context/ShotPlan.js"
import { CRITICAL_FACTOR } from "../Classes/Context/EnemyMemory.js"
import { WEAPON_SWAP_TP } from "../Classes/Context/ThreatMap.js"
import { SEARCH_GLOBAL_FRACTION } from "../Classes/Plannification/ExecutionBudget.js"
import { TacticalPreparation } from "../Classes/Plannification/TacticalTypes.js"
import { log, LOG_CONTEXT } from "../Toolbox/Logger.js"

/** Part créditée des tours futurs couverts par le boost (le contact avec l'ennemi n'est pas garanti). */
export const FUTURE_TURN_WEIGHT = 0.75

/** En dessous de ce ratio de PV, les PT d'un combat en cours vont à la protection, pas au boost. */
export const MIN_LIFE_RATIO_FOR_BOOST = 0.5

export interface BoostOption {
	readonly chip: Chip
	/** Force ajoutée (science comprise). */
	readonly gain: number
	/** Durée de l'effet en tours (le tour du lancer compte pour 1). */
	readonly turns: number
}

/** Un boost de force est-il déjà actif sur moi (effet de force non expiré) ? Évite de gaspiller PT et délai. */
export function hasActiveStrengthBoost(me: Me): boolean {
	return (me.effects ?? []).some((effect) => isStrengthBoostType(effect.type) && effect.turns > 0)
}

/** Boosts de force prêts, abordables avec `tp` PT, hors boost déjà actif (liste vide s'il y en a un). */
export function readyBoosts(me: Me, tp: number): BoostOption[] {
	const found: BoostOption[] = []
	if (hasActiveStrengthBoost(me)) {
		return found
	}
	for (const chip of me.chips ?? []) {
		const gain = strengthBoostOf(chip, me.science ?? 0)
		if (!(gain > 0) || !Number.isInteger(chip.cost) || chip.cost <= 0 || chip.cost > tp ||
			chip.currentCooldown !== 0) {
			continue
		}
		found.push({ chip, gain, turns: strengthBoostTurns(chip) })
	}
	return found
}

/** Le boost au plus grand gain de force parmi les prêts ; null sinon. */
export function pickBoost(me: Me, tp: number): BoostOption | null {
	let best: BoostOption | null = null
	for (const option of readyBoosts(me, tp)) {
		if (best === null || option.gain > best.gain) {
			best = option
		}
	}
	return best
}

/** Un boost de PT est-il déjà actif sur moi (effet de PT non expiré) ? */
export function hasActiveTpBoost(me: Me): boolean {
	return (me.effects ?? []).some((effect) => isTpBoostType(effect.type) && effect.turns > 0)
}

/** Boosts de PT prêts : `gain` = PT ajoutés par tour d'effet ; abordables avec `tp` PT ; vide si un est actif. */
export function readyTpBoosts(me: Me, tp: number): BoostOption[] {
	const found: BoostOption[] = []
	if (hasActiveTpBoost(me)) {
		return found
	}
	for (const chip of me.chips ?? []) {
		const gain = tpBoostOf(chip, me.science ?? 0)
		if (!(gain > 0) || !Number.isInteger(chip.cost) || chip.cost <= 0 || chip.cost > tp ||
			chip.currentCooldown !== 0) {
			continue
		}
		found.push({ chip, gain, turns: tpBoostTurns(chip) })
	}
	return found
}

/** Le boost de PT au plus grand gain parmi les prêts ; null sinon. */
export function pickTpBoost(me: Me, tp: number): BoostOption | null {
	let best: BoostOption | null = null
	for (const option of readyTpBoosts(me, tp)) {
		if (best === null || option.gain > best.gain) {
			best = option
		}
	}
	return best
}

/** Un boost de PM est-il déjà actif sur moi (effet de PM non expiré) ? */
export function hasActiveMpBoost(me: Me): boolean {
	return (me.effects ?? []).some((effect) => isMpBoostType(effect.type) && effect.turns > 0)
}

/**
 * Le boost de PM prêt au plus grand gain, abordable avec `tp` PT ; null sinon, ou si un boost de PM est actif.
 * `gain` = PM entiers (partie entière du gain moyen ; le moteur arrondit au plus proche : sous-estimation prudente).
 */
export function pickMpBoost(me: Me, tp: number): BoostOption | null {
	let best: BoostOption | null = null
	if (hasActiveMpBoost(me)) {
		return best
	}
	for (const chip of me.chips ?? []) {
		const gain = Math.floor(mpBoostOf(chip, me.science ?? 0))
		if (!(gain >= 1) || !Number.isInteger(chip.cost) || chip.cost <= 0 || chip.cost > tp ||
			chip.currentCooldown !== 0) {
			continue
		}
		if (best === null || gain > best.gain) {
			best = { chip, gain, turns: mpBoostTurns(chip) }
		}
	}
	return best
}

/** Un boost d'agilité est-il déjà actif sur moi (effet d'agilité non expiré) ? */
export function hasActiveAgilityBoost(me: Me): boolean {
	return (me.effects ?? []).some((effect) => isAgilityBoostType(effect.type) && effect.turns > 0)
}

/**
 * Le boost d'agilité prêt au plus grand gain, abordable avec `tp` PT ; null sinon, ou si un boost d'agilité est actif.
 * `gain` = agilité entière (partie entière du gain moyen). Valeur attendue faible : + gain / 1000 de chance de critique,
 * soit + gain × 0,03 % de dégâts moyens (critique × 1,3) : le plan la mesure (`agilityCritGain`) et la compare aux tirs.
 */
export function pickAgilityBoost(me: Me, tp: number): BoostOption | null {
	let best: BoostOption | null = null
	if (hasActiveAgilityBoost(me)) {
		return best
	}
	for (const chip of me.chips ?? []) {
		const gain = Math.floor(agilityBoostOf(chip, me.science ?? 0))
		if (!(gain >= 1) || !Number.isInteger(chip.cost) || chip.cost <= 0 || chip.cost > tp ||
			chip.currentCooldown !== 0) {
			continue
		}
		if (best === null || gain > best.gain) {
			best = { chip, gain, turns: agilityBoostTurns(chip) }
		}
	}
	return best
}

/**
 * Gain relatif de dégâts moyens d'un boost d'agilité : (critique − 1) × chance de critique ajoutée, soit
 * 0,3 × gain / 1000 (gain plafonné pour que la chance totale reste ≤ 100 %). Estimation : le moteur arrondit.
 */
export function agilityCritGain(me: Me, option: BoostOption): number {
	const room = Number.isFinite(me.agility) ? Math.max(0, 1000 - me.agility) : 1000
	return (CRITICAL_FACTOR - 1) * Math.min(option.gain, room) / 1000
}

/**
 * Part des tours SUIVANTS d'un boost d'agilité pour `weapon` : `FUTURE_TURN_WEIGHT` × (durée − 1) tours de tirs
 * entiers de l'arme seule à `fullTp` PT, chacun majoré de `agilityCritGain`. Non plafonnée (l'appelant plafonne).
 */
export function agilityBoostFutureDamage(me: Me, weapon: Weapon, option: BoostOption, fullTp: number): number {
	const base = baseMeanDamage(weapon)
	if (!(base > 0) || !(weapon.cost > 0)) {
		return 0
	}
	const shots = Math.max(0, Math.min(Math.floor(fullTp / weapon.cost), maxUsesOf(weapon)))
	const strength = Number.isFinite(me.strength) ? me.strength : 0
	return Math.max(0, option.turns - 1) * shots * base * (1 + strength / 100) * agilityCritGain(me, option) * FUTURE_TURN_WEIGHT
}

/** Décision du boost de PM d'avant plan : `option` null = ne pas lancer ; `reason` vide = aucune puce de PM prête. */
export interface MpBoostDecision {
	readonly option: BoostOption | null
	readonly reason: string
	/** Zone atteignable à PM + gain (seulement avec `option`), déjà calculée par la décision. */
	readonly zone?: ReachableCells
}

/** Listes natives déjà obtenues ce tour (voir `TacticalPreparation`) : un appel natif n'est jamais refait. */
type NativeCells = Pick<TacticalPreparation, "weaponCells" | "chipCells">

function cachedCells<T extends Weapon | Chip>(
	store: Map<Entity, Map<T, Cell[]>> | undefined, target: Entity, item: T, fetch: () => Cell[]
): Cell[] {
	let byItem = store?.get(target)
	const known = byItem?.get(item)
	if (known) {
		return known
	}
	const cells = fetch()
	if (store) {
		if (!byItem) {
			store.set(target, byItem = new Map())
		}
		byItem.set(item, cells)
	}
	return cells
}

/** Zone atteignable à PM + gain, ou le motif du refus (carte tronquée, plus de `cellLimit` cases). */
function boostedZone(me: Me, option: BoostOption, cellLimit: number): ReachableCells | string {
	const boostedMp = me.mp + option.gain
	const zone = computeReachableCells(me, boostedMp, Fight.turn)
	return zone.truncated || zone.size > cellLimit
		? `${zone.size}${zone.truncated ? "+" : ""} cells with ${boostedMp} MP > ${cellLimit}` : zone
}

/** Même garde que les recherches (plan conjoint, plan B, carte de danger) : rien ne démarre passé 80 % des opérations. */
function hasSearchRoom(): boolean {
	return typeof System === "undefined" || !Number.isFinite(System.maxOperations) || System.maxOperations <= 0 ||
		System.operations < System.maxOperations * SEARCH_GLOBAL_FRACTION
}

/** Une case de `zone` est-elle à portée de Manhattan [min, max] de `target` ? Sinon la liste native est inutile. */
function mayReach(zone: ReachableCells, target: Entity, item: Weapon | Chip): boolean {
	if (!Number.isFinite(item.maxRange)) {
		return true
	}
	const minRange = Number.isFinite(item.minRange) ? item.minRange : 0
	for (const { cell } of zone.entries()) {
		const range = Math.abs(cell.x - target.cell.x) + Math.abs(cell.y - target.cell.y)
		if (range >= minRange && range <= item.maxRange) {
			return true
		}
	}
	return false
}

/**
 * Faut-il lancer un boost de PM AVANT le plan du tour ? Oui seulement si toutes ces conditions sont vraies :
 * une puce de PM est prête (`pickMpBoost`) et utilisable sur moi ; PV ≥ `MIN_LIFE_RATIO_FOR_BOOST` ; mes cases
 * atteignables (`reachable`) sont celles du tour, non tronquées ; aucune n'est une case de tir (listes natives
 * `Fight.weaponCells` / `me.chipCells`) d'une arme ou d'une puce offensive prête que je peux payer, contre un
 * ennemi de `enemies` ; avec PM + gain la zone n'est pas tronquée, compte au plus `cellLimit` cases (au-delà le
 * plan conjoint se replierait sur le plan B) et contient une case de tir d'une ARME encore payable après le boost
 * (+ `WEAPON_SWAP_TP` si elle n'est pas équipée). Les puces offensives ne comptent pas dans ce second test : les
 * plans ne créditent une puce que si elle est utilisable depuis la case actuelle, donc pas depuis une case débloquée.
 *
 * Ne lance RIEN : c'est une décision d'observation (lecture seule). Le plan boosté est cherché ensuite sur `zone` et
 * comparé au plan sans boost par le même score (`TacticalPlanner.ts`), danger des cases débloquées compris.
 * Coût : un parcours en largeur de plus, puis une liste native par couple (ennemi, item) dont la portée de Manhattan
 * touche la zone ; aucune liste si l'arme équipée tire déjà d'ici ou si rien n'est à portée de la zone boostée.
 * `cells` : listes natives déjà obtenues par la recherche, réutilisées et complétées. Non mesuré sur le moteur.
 * Garde : rien ne démarre passé `SEARCH_GLOBAL_FRACTION` des opérations.
 */
export function decideMpBoost(
	me: Me, reachable: ReachableCells | null, enemies: readonly Entity[], cellLimit: number, cells?: NativeCells
): MpBoostDecision {
	const no = (reason: string): MpBoostDecision => ({ option: null, reason })
	const option = pickMpBoost(me, me.tp)
	if (option === null) {
		return no("")
	}
	if (!(me.maxLife > 0) || me.life / me.maxLife < MIN_LIFE_RATIO_FOR_BOOST) {
		return no("life below 50 %")
	}
	if (typeof Field === "undefined" || typeof Field.cellFromXY !== "function" ||
		typeof Fight.weaponCells !== "function" || typeof me.chipCells !== "function" ||
		typeof me.canUseChip !== "function" || typeof me.canUseWeapon !== "function") {
		return no("native firing cells unavailable")
	}
	if (reachable === null || reachable.truncated || !reachable.isUpToDate(me.id, me.cell, me.mp, Fight.turn)) {
		return no("reachable cells unavailable")
	}
	const targets = enemies.filter((enemy) => enemy.life > 0)
	if (targets.length === 0) {
		return no("no enemy")
	}
	const tpAfter = me.tp - option.chip.cost
	const weapons = [...new Set(me.weapon ? [me.weapon, ...(me.weapons ?? [])] : me.weapons ?? [])]
		.filter((weapon) => toCandidate(weapon, false, me.strength) !== null)
		.map((weapon) => ({ weapon, cost: weapon.cost + (weapon === me.weapon ? 0 : WEAPON_SWAP_TP) }))
		.filter(({ cost }) => cost <= me.tp)
	if (!weapons.some(({ cost }) => cost <= tpAfter)) {
		return no("no weapon shot affordable after the boost")
	}
	if (!hasSearchRoom()) {
		return no("operations budget")
	}
	if (!me.canUseChip(option.chip, me)) {
		return no("chip not usable on me")
	}
	const equipped = me.weapon
	if (equipped && weapons.some(({ weapon }) => weapon === equipped) &&
		targets.some((target) => me.canUseWeapon(target))) {
		return no(`shot already possible: ${equipped.name}`)
	}
	const boostedMp = me.mp + option.gain
	const boosted = boostedZone(me, option, cellLimit)
	if (typeof boosted === "string") {
		return no(boosted)
	}
	const chips = [...new Set(me.chips ?? [])].filter((chip) => chip.currentCooldown === 0 &&
		Number.isInteger(chip.cost) && chip.cost > 0 && chip.cost <= me.tp && toCandidate(chip, true, me.strength) !== null)
	const reaches = (zone: ReachableCells, cells: readonly Cell[]): boolean => cells.some((cell) => zone.canReach(cell))
	let unlocked: string | null = null
	for (const target of targets) {
		for (const chip of chips) {
			if (!mayReach(reachable, target, chip)) {
				continue
			}
			if (!hasSearchRoom()) {
				return no("operations budget")
			}
			if (reaches(reachable, cachedCells(cells?.chipCells, target, chip, () => me.chipCells(chip, target)))) {
				return no(`shot already possible: ${chip.name}`)
			}
		}
		for (const { weapon, cost } of weapons) {
			// La zone boostée contient la zone du tour : hors de portée de l'une, hors de portée des deux.
			if (!mayReach(boosted, target, weapon)) {
				continue
			}
			if (!hasSearchRoom()) {
				return no("operations budget")
			}
			const zone = cachedCells(cells?.weaponCells, target, weapon, () => Fight.weaponCells(target, weapon))
			if (reaches(reachable, zone)) {
				return no(`shot already possible: ${weapon.name}`)
			}
			if (unlocked === null && cost <= tpAfter && reaches(boosted, zone)) {
				unlocked = `${weapon.name} on ${target.name}`
			}
		}
	}
	if (unlocked === null) {
		return no(`no firing cell within ${boostedMp} MP`)
	}
	if (!hasSearchRoom()) {
		return no("operations budget")
	}
	return {
		option,
		reason: `no firing cell in ${reachable.size} cells with ${me.mp} MP; ${boosted.size} cells with ${boostedMp} MP reach ${unlocked}`,
		zone: boosted
	}
}

/**
 * Boost de PM pour FUIR : même lecture seule, sans condition de tir ni de PV (le plan boosté avec tir reste refusé sous
 * `MIN_LIFE_RATIO_FOR_BOOST` par le planificateur). Appelé seulement quand le meilleur plan sans boost est létal ; le
 * score décide si la zone élargie offre mieux. Mêmes gardes : puce prête et utilisable, cartes fraîches, au plus
 * `cellLimit` cases, opérations < `SEARCH_GLOBAL_FRACTION`.
 */
export function decideFleeMpBoost(
	me: Me, reachable: ReachableCells | null, enemies: readonly Entity[], cellLimit: number
): MpBoostDecision {
	const no = (reason: string): MpBoostDecision => ({ option: null, reason })
	const option = pickMpBoost(me, me.tp)
	if (option === null) {
		return no("")
	}
	if (typeof me.canUseChip !== "function") {
		return no("native chip check unavailable")
	}
	if (reachable === null || reachable.truncated || !reachable.isUpToDate(me.id, me.cell, me.mp, Fight.turn)) {
		return no("reachable cells unavailable")
	}
	if (!enemies.some((enemy) => enemy.life > 0)) {
		return no("no enemy")
	}
	if (!hasSearchRoom()) {
		return no("operations budget")
	}
	if (!me.canUseChip(option.chip, me)) {
		return no("chip not usable on me")
	}
	const zone = boostedZone(me, option, cellLimit)
	if (typeof zone === "string") {
		return no(zone)
	}
	return { option, reason: `lethal plan in ${reachable.size} cells with ${me.mp} MP; ${zone.size} cells with ${me.mp + option.gain} MP`, zone }
}

/**
 * Part des tours SUIVANTS d'un boost de PT pour `weapon` : `FUTURE_TURN_WEIGHT` × (durée − 1) tours à
 * `fullTp` + gain contre `fullTp`, chaque tour plafonné par les PV de l'ennemi.
 * Par défaut (plans qui tirent, plan B avec tir) : tirs entiers de l'arme seule.
 * `idle` (plan SANS tir : les PT du boost seraient perdus) : maximum de trois scénarios de portée, en maximum exact
 * (`planShots`) : arme seule, puces seules (arme hors de portée, combat 54991104), arme + puces. Puces : offensives,
 * prêtes, de cooldown de base 0 (relançables, `chipUsesOf`) ou 1 (une fois par tour), donc disponibles à chaque tour
 * couvert. Crédit OPTIMISTE assumé : il suppose le scénario de portée le plus favorable au boost.
 * Coût en mode `idle` : six sacs à dos par appel (à calculer une fois par variante, pas par case).
 */
export function tpBoostFutureDamage(
	me: Me, weapon: Weapon, option: BoostOption, fullTp: number, enemyLife = Number.POSITIVE_INFINITY, idle = false
): number {
	const base = baseMeanDamage(weapon)
	if (!(base > 0) || !(weapon.cost > 0)) {
		return 0
	}
	const limit = maxUsesOf(weapon)
	const strength = Number.isFinite(me.strength) ? me.strength : 0
	const life = Number.isFinite(enemyLife) && enemyLife > 0 ? enemyLife : Number.POSITIVE_INFINITY
	const damage = (budget: number): number =>
		Math.min(life, Math.max(0, Math.min(Math.floor(budget / weapon.cost), limit)) * base * (1 + strength / 100))
	let best = damage(fullTp + option.gain) - damage(fullTp)
	if (idle) {
		const chips: ShotCandidate[] = []
		for (const chip of new Set(me.chips ?? [])) {
			const shot = chip.currentCooldown === 0 && (chip.cooldown === 0 || chip.cooldown === 1)
				? toCandidate(chip, true, strength) : null
			if (shot !== null) {
				chips.push(shot)
			}
		}
		if (chips.length > 0) {
			const candidate = toCandidate(weapon, false, strength)
			const gain = (arm: ShotCandidate | null): number =>
				Math.min(life, planShots(fullTp + option.gain, arm, chips).damage) - Math.min(life, planShots(fullTp, arm, chips).damage)
			best = Math.max(best, gain(null), gain(candidate))
		}
	}
	return Math.max(0, option.turns - 1) * best * FUTURE_TURN_WEIGHT
}

/**
 * Part des tours SUIVANTS d'un boost de force pour `weapon`, non plafonnée : `FUTURE_TURN_WEIGHT` × (durée − 1)
 * tours pleins à `fullTp` PT, chaque tir gagnant `gain` % des dégâts de base. L'appelant plafonne par les PV
 * qui restent à la cible après ce tour.
 */
export function strengthBoostFutureDamage(weapon: Weapon, option: BoostOption, fullTp: number): number {
	const base = baseMeanDamage(weapon)
	if (!(base > 0) || !(weapon.cost > 0)) {
		return 0
	}
	const shots = Math.max(0, Math.min(Math.floor(fullTp / weapon.cost), maxUsesOf(weapon)))
	return Math.max(0, option.turns - 1) * shots * base * (option.gain / 100) * FUTURE_TURN_WEIGHT
}

/**
 * Portée (en cases) sous laquelle un boost lancé sans tirer ce tour peut encore servir au tour suivant :
 * portée max de mes armes + deux tours de mes PM + les PM de l'ennemi.
 */
export function boostReach(me: Me, enemy: Entity): number {
	let range = me.weapon?.maxRange ?? 0
	for (const weapon of me.weapons ?? []) {
		range = Math.max(range, weapon.maxRange)
	}
	return range + 2 * me.mp + (enemy.mp ?? 0)
}

/**
 * Dégâts nets d'un boost de PT (`option.gain` PT immédiatement, puis à chaque tour couvert) pour `weapon` :
 * ce tour (si je tire : `inContactNow`), PT − coût + gain contre PT en tirs entiers de l'arme seule (ce que le
 * plan B exécute) ; puis les tours suivants (`tpBoostFutureDamage`, arme seule). Dégâts plafonnés par les PV de
 * l'ennemi. Un gain de PT inférieur au coût de l'arme peut ne rien valoir. Estimation à une arme, pas une simulation.
 */
export function tpBoostNetDamage(
	me: Me, weapon: Weapon, option: BoostOption, tp: number, fullTp: number, inContactNow: boolean,
	enemyLife = Number.POSITIVE_INFINITY
): number {
	const base = baseMeanDamage(weapon)
	if (!(base > 0) || !(weapon.cost > 0)) {
		return 0
	}
	const limit = maxUsesOf(weapon)
	const strength = Number.isFinite(me.strength) ? me.strength : 0
	const life = Number.isFinite(enemyLife) && enemyLife > 0 ? enemyLife : Number.POSITIVE_INFINITY
	const damage = (budget: number): number =>
		Math.min(life, Math.max(0, Math.min(Math.floor(budget / weapon.cost), limit)) * base * (1 + strength / 100))
	const now = inContactNow ? damage(tp - option.chip.cost + option.gain) - damage(tp) : 0
	return now + tpBoostFutureDamage(me, weapon, option, fullTp, enemyLife)
}

/**
 * Dégâts supplémentaires (nets du PT dépensé) d'un boost lancé maintenant avec `tp` PT, pour `weapon` : tirs de
 * ce tour avec et sans boost, plus `FUTURE_TURN_WEIGHT` × les tirs d'un tour plein pour chaque tour futur
 * couvert (durée − 1). Les dégâts sont plafonnés par les PV de l'ennemi (`enemyLife`) : un boost qui ferait
 * perdre un meurtre ce tour a un gain négatif. Estimation à une arme et sans puce offensive, pas une
 * simulation du plan.
 */
export function boostNetDamage(
	me: Me, weapon: Weapon, option: BoostOption, tp: number, enemyLife = Number.POSITIVE_INFINITY
): number {
	const base = baseMeanDamage(weapon)
	if (!(base > 0) || !(weapon.cost > 0)) {
		return 0
	}
	const limit = maxUsesOf(weapon)
	const shots = (budget: number): number => Math.max(0, Math.min(Math.floor(budget / weapon.cost), limit))
	const strength = Number.isFinite(me.strength) ? me.strength : 0
	const life = Number.isFinite(enemyLife) && enemyLife > 0 ? enemyLife : Number.POSITIVE_INFINITY
	const without = Math.min(life, shots(tp) * base * (1 + strength / 100))
	const boosted = Math.min(life, shots(tp - option.chip.cost) * base * (1 + (strength + option.gain) / 100))
	const future = Math.min(Math.max(0, life - boosted), strengthBoostFutureDamage(weapon, option, tp))
	return boosted - without + future
}

/**
 * Inventaire des puces (une ligne, tour 1) : identifiant, coût, délai et features, pour vérifier les boosts.
 * Ce module n'importe pas `Debug.ts` (les planificateurs l'importent) : l'appelant protège l'appel.
 */
export function logChipInventory(me: Me): void {
	const chips = me.chips ?? []
	if (chips.length === 0) {
		return
	}
	log(() => `[Chips] ${chips.map((chip) =>
		`${chip.name}#${chip.id}(${chip.cost}TP,cd${chip.cooldown},${(chip.features ?? []).map((feature) =>
			`${feature.type}:${feature.minValue}-${feature.maxValue}x${feature.turns}`).join("/")})`).join("; ")} | STR ${me.strength}, SCI ${me.science}`,
		LOG_CONTEXT.CHIP)
}
