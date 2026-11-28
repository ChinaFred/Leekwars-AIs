// @version:5.8
// file version: 15
import { ChestView, chestDangerOf } from "./ChestDanger.js"
import { assessStance, describeEnemyTurn, EnemyStanceReport } from "./EnemyBehavior.js"
import { EnemyHit, EnemyProfile } from "./EnemyProfile.js"
import { EntityProfile } from "./EntityProfile.js"
import { computeReachableCells, ReachableCells } from "./ReachableCells.js"
import { hasDamage, strengthBoostOf, tpBoostOf } from "./ShotPlan.js"
import { buildTargetZone, buildThreatMap, GeometricShotCells, ThreatEnemy, ThreatMap } from "./ThreatMap.js"

/** Multiplicateur de coup critique : constante officielle CRITICAL_FACTOR = 1.3. */
export const CRITICAL_FACTOR = 1.3

/** Marge (en PV) sur les bornes de dégâts pour l'arrondi du moteur. */
export const DAMAGE_TOLERANCE = 1

/**
 * Valeur de `aliveEnemies` pour `EnemyMemory.update` quand une perte de PV ne doit JAMAIS être imputée à l'entité
 * observée (un coffre) : elle reste journalisée « ambiguous », comme avec plusieurs ennemis vivants.
 */
export const NEVER_ATTRIBUTE_DAMAGE = Number.POSITIVE_INFINITY

type Item = Weapon | Chip

export interface EnemyUpdate {
	/** Noms des armes/puces vues pour la première fois pendant cet appel. */
	newItems: string[]
	/** Dernier coup journalisé pendant cet appel (null si aucun). */
	hit: EnemyHit | null
}

export type EntitySide = "me" | "ally" | "enemy"

/** Résumé d'un calcul de cases atteignables (pour le journal). */
export interface ReachableUpdate {
	entityId: number
	name: string
	side: EntitySide
	/** PM utilisés pour le calcul. */
	mp: number
	/** Nombre de cases atteignables (case de départ incluse). */
	size: number
	truncated: boolean
	/** false si le résultat du même tour (même case, mêmes PM) a été réutilisé. */
	recomputed: boolean
}

/** Résumé du calcul de la carte de danger (pour le journal). */
export interface ThreatUpdate {
	/** Cases évaluées. */
	size: number
	/** Cases que je pouvais atteindre. */
	candidateCells: number
	maxDanger: number
	minDanger: number
	/** Case la plus sûre (la moins coûteuse en PM parmi les plus sûres) ; null si la carte est vide. */
	safestCell: Cell | null
	/** Ennemis avec au moins un item offensif exploitable. */
	enemies: number
	truncated: boolean
	pairsEvaluated: number
	lineOfSightCalls: number
}

/**
 * Mémoire de l'adversaire : collecte de données uniquement, aucune décision tactique.
 * Les dégâts instantanés (arme, caillou, foudre) n'apparaissent pas dans les effets : l'attribution
 * des coups est une heuristique (voir docs/strategies.md, « Mémoire de l'adversaire »).
 */
export class EnemyMemory {
	private readonly profiles = new Map<number, EnemyProfile>()
	/** Profils de moi et de mes alliés vivants (une entrée par entité, retirée à la mort). */
	private readonly friendlyProfiles = new Map<number, EntityProfile>()
	private lastLife: number | null = null
	private lastLifeTurn = 0
	/** Carte de danger de mon poireau pour le tour courant (remplacée à chaque tour). */
	private threatMap: ThreatMap | null = null
	/** Entrées ennemies de `threatMap` (même tour), gardées pour `computeTargetZone` ; null sans carte. */
	private threatInputs: readonly ThreatEnemy[] | null = null
	/** Lignes de vue (case de tir, case visée) déjà demandées : les obstacles sont fixes pendant le combat. */
	private readonly sightCache = new Map<number, boolean>()

	has(enemyId: number): boolean {
		return this.profiles.has(enemyId)
	}

	/** Premier contact : instantané de l'ennemi (sans effet si déjà connu). */
	identify(entity: Entity, turn: number): EnemyProfile {
		const existing = this.profiles.get(entity.id)
		if (existing !== undefined) {
			return existing
		}
		const profile = new EnemyProfile(entity, turn)
		this.profiles.set(entity.id, profile)
		return profile
	}

	/**
	 * À appeler au début de MON tour, avant de planifier. `aliveEnemies` > 1 (ou `NEVER_ATTRIBUTE_DAMAGE`) empêche
	 * d'attribuer une perte de PV à un ennemi précis (elle est alors journalisée « ambiguous »).
	 */
	update(entity: Entity, me: Me, turn: number, aliveEnemies = 1): EnemyUpdate | null {
		const profile = this.profiles.get(entity.id)
		if (profile === undefined) {
			return null
		}
		const result: EnemyUpdate = { newItems: [], hit: null }

		profile.advanceTo(turn)
		profile.maxTpSeen = Math.max(profile.maxTpSeen, entity.tp ?? 0)

		const weapon = entity.weapon ?? null
		if (weapon !== null) {
			const changed = profile.equippedWeapon?.id !== weapon.id
			if (profile.observeWeapon(weapon, turn, changed)) {
				result.newItems.push(weapon.name)
			}
		}
		profile.equippedWeapon = weapon

		// Usages détectés d'abord (sans toucher aux cooldowns), pour que les candidats de l'inférence
		// de dégâts soient jugés sur les cooldowns d'avant cet appel.
		const uses = this.collectUses(profile, entity, me, turn)
		result.hit = this.attributeDamage(profile, entity, me, turn, aliveEnemies)

		this.recordEnemyTurn(profile, entity, uses, result.hit, turn, aliveEnemies)

		for (const item of uses) {
			if (isChipItem(item)) {
				if (profile.observeChip(item, turn)) {
					result.newItems.push(item.name)
				}
				profile.startCooldown(item)
			} else if (profile.observeWeapon(item, turn, true)) {
				result.newItems.push(item.name)
			}
		}
		return result
	}

	/**
	 * À appeler à la fin de MON tour : référence de PV pour mesurer ce que l'ennemi m'inflige ensuite, et photographie
	 * (case, PV) des ennemis vivants donnés pour mesurer ce qu'ils font à leur tour (`recordEnemyTurn`).
	 */
	endMyTurn(me: Me, turn: number, enemies: readonly Entity[] = []): void {
		this.lastLife = me.life
		this.lastLifeTurn = turn
		for (const enemy of enemies) {
			const profile = this.profiles.get(enemy.id)
			if (profile !== undefined) {
				profile.afterMyTurn = {
					turn,
					cell: { x: enemy.cell.x, y: enemy.cell.y },
					life: enemy.life,
					myCell: { x: me.cell.x, y: me.cell.y }
				}
			}
		}
	}

	/** Posture de l'ennemi sur ses derniers tours (null si inconnu) : voir `assessStance`. */
	stanceOf(enemyId: number): EnemyStanceReport | null {
		const profile = this.profiles.get(enemyId)
		return profile === undefined ? null : assessStance(profile.turnLog)
	}

	/** PV perdus depuis la fin de mon tour précédent (`endMyTurn`), nets des soins reçus ; 0 au premier tour. */
	lifeLostSinceMyTurn(me: Me): number {
		return this.lastLife === null ? 0 : Math.max(0, this.lastLife - me.life)
	}

	getProfile(enemyId: number): EnemyProfile | null {
		return this.profiles.get(enemyId) ?? null
	}

	/** Profil d'une entité connue : ennemi, moi ou allié vivant (null sinon). */
	getEntityProfile(entityId: number): EntityProfile | null {
		return this.profiles.get(entityId) ?? this.friendlyProfiles.get(entityId) ?? null
	}

	/** Cases atteignables calculées à mon dernier tour (null : entité inconnue, morte ou jamais calculée). */
	getReachable(entityId: number): ReachableCells | null {
		return this.getEntityProfile(entityId)?.reachable ?? null
	}

	/**
	 * À appeler au début de MON tour, après `identify`/`update` des ennemis : calcule les cases atteignables
	 * de moi, de mes alliés vivants et des ennemis vivants, et les range dans leurs profils (remplacées à chaque tour).
	 * PM utilisés : `me.mp` pour moi ; pour les autres, le plus grand `entity.mp` vu pendant mon tour
	 * (hypothèse : leurs PM du prochain tour, `entity.mp` pouvant valoir les PM restants de leur dernier tour).
	 * Entités mortes : profil allié retiré, `reachable` d'un ennemi effacé (son profil est conservé).
	 * Les cases ne sont pas recalculées si le tour, la case de départ et les PM sont identiques.
	 */
	updateReachable(
		me: Me,
		allies: readonly Entity[],
		enemies: readonly Entity[],
		turn: number
	): ReachableUpdate[] {
		const updates: ReachableUpdate[] = []
		const liveFriendly = new Set<number>([me.id])
		const liveEnemies = new Set<number>()

		const myProfile = this.friendlyProfileOf(me, turn)
		myProfile.observeMp(me.mp)
		updates.push(this.refreshReachable(myProfile, me, "me", me.mp, turn))

		for (const ally of allies) {
			if (liveFriendly.has(ally.id) || !(ally.life > 0)) {
				continue
			}
			liveFriendly.add(ally.id)
			const profile = this.friendlyProfileOf(ally, turn)
			profile.observeMp(ally.mp)
			updates.push(this.refreshReachable(profile, ally, "ally", profile.maxMpSeen, turn))
		}

		for (const enemy of enemies) {
			if (liveEnemies.has(enemy.id) || !(enemy.life > 0)) {
				continue
			}
			liveEnemies.add(enemy.id)
			const profile = this.identify(enemy, turn)
			profile.observeMp(enemy.mp)
			updates.push(this.refreshReachable(profile, enemy, "enemy", profile.maxMpSeen, turn))
		}

		for (const id of [...this.friendlyProfiles.keys()]) {
			if (!liveFriendly.has(id)) {
				this.friendlyProfiles.delete(id)
			}
		}
		for (const [id, profile] of this.profiles) {
			if (!liveEnemies.has(id)) {
				profile.clearReachable()
			}
		}
		return updates
	}

	/** Carte de danger calculée à mon dernier tour (null : jamais calculée ou calcul impossible). */
	getThreatMap(): ThreatMap | null {
		return this.threatMap
	}

	/**
	 * À appeler au début de MON tour, après `updateReachable` : calcule la carte de danger de `me` (voir
	 * `ThreatMap.ts`) et remplace la précédente. Le planificateur conjoint lit cette carte. Retourne null (et
	 * efface la carte) si mes cases atteignables du tour sont absentes ou périmées.
	 *
	 * Par ennemi vivant : force = `entity.strength` actuelle (hypothèse non vérifiée : elle inclut déjà les
	 * buffs en cours) ; PT = max(`maxTpSeen`, `entity.tp`) (hypothèse : `entity.tp` pendant mon tour peut être
	 * ses PT restants, le maximum observé estime ses PT au prochain tour) ; armes = l'ÉQUIPÉE (sans coût) et
	 * les autres armes connues à dégâts (1 PT de changement, une seule arme par plan) ;
	 * puces = connues, offensives et prêtes (`isChipReady`) ; cases de tir = cases atteignables avec ses PM
	 * (`maxMpSeen`) EN IGNORANT mon entité, recalculées ici (un parcours en largeur de plus par ennemi
	 * offensif, ≤ ~4 × 500 appels à `Field.cellFromXY`, non stocké). Un ennemi sans item offensif
	 * n'est pas parcouru du tout. `chests` : coffres vivants, JAMAIS des ennemis : seul un danger forfaitaire est ajouté aux
	 * cases à leur portée (`ChestDanger.ts`).
	 */
	updateThreatMap(me: Me, enemies: readonly Entity[], turn: number, chests: readonly ChestView[] = []): ThreatUpdate | null {
		// Une exception plus bas ne doit pas laisser la carte du tour précédent passer pour celle du tour courant.
		this.threatMap = null
		this.threatInputs = null
		const mine = this.getReachable(me.id)
		if (mine === null || mine.turn !== turn) {
			return null
		}
		const inputs: ThreatEnemy[] = []
		const seen = new Set<number>()
		for (const enemy of enemies) {
			if (seen.has(enemy.id) || !(enemy.life > 0)) {
				continue
			}
			seen.add(enemy.id)
			const profile = this.identify(enemy, turn)
			const weapon = enemy.weapon ?? null
			const otherWeapons = profile.knownWeapons.filter((known) =>
				hasDamage(known) && known.id !== weapon?.id)
			const chips = profile.knownChips.filter((chip) => hasDamage(chip) && profile.isChipReady(chip))
			const science = enemy.science ?? 0
			const boosts = profile.knownChips.filter((chip) =>
				(strengthBoostOf(chip, science) > 0 || tpBoostOf(chip, science) > 0) && profile.isChipReady(chip))
			if ((weapon === null || !hasDamage(weapon)) && otherWeapons.length === 0 && chips.length === 0) {
				continue
			}
			inputs.push({
				id: enemy.id,
				name: enemy.name,
				strength: enemy.strength ?? 0,
				tp: Math.max(profile.maxTpSeen, enemy.tp ?? 0),
				weapon,
				otherWeapons,
				chips,
				boosts,
				science,
				reachable: computeReachableCells(enemy, profile.maxMpSeen, turn, { ignoreEntityId: me.id })
			})
		}
		const map = buildThreatMap(me, mine, inputs, turn, {
			provider: new GeometricShotCells(this.sightCache),
			extraDanger: chests.length > 0 ? chestDangerOf(chests, me.maxLife) : undefined
		})
		this.threatMap = map
		this.threatInputs = inputs
		return {
			size: map.size,
			candidateCells: map.candidateCells,
			maxDanger: map.maxDanger,
			minDanger: map.minDanger,
			safestCell: map.safestCells()[0] ?? null,
			enemies: inputs.length,
			truncated: map.truncated,
			pairsEvaluated: map.pairsEvaluated,
			lineOfSightCalls: map.lineOfSightCalls
		}
	}

	/**
	 * Carte de danger d'une AUTRE zone atteignable de `me` (zone d'un boost de PM), à partir des entrées ennemies de la
	 * carte du tour (leurs zones ne dépendent pas de mes PM) : lecture seule, rien n'est stocké ni remplacé. Null sans
	 * carte du tour. Coût : une évaluation par case de la zone, ligne de vue partagée avec la carte du tour.
	 */
	threatMapFor(me: Me, reachable: ReachableCells, turn: number): ThreatMap | null {
		if (this.threatMap === null || this.threatInputs === null) {
			return null
		}
		return buildThreatMap(me, reachable, this.threatInputs, turn, { provider: new GeometricShotCells(this.sightCache) })
	}

	/**
	 * Zone visée du tour (voir `buildTargetZone`) : toutes les cases que les ennemis de la carte de danger courante
	 * peuvent toucher, atteignables par moi ou non. Calculée À LA DEMANDE (affichage), jamais stockée ni lue par le
	 * planificateur ; reprend les cases de la carte de danger (telles quelles, case de tir comprise) et partage son
	 * cache de ligne de vue. Null sans carte de danger du tour.
	 */
	computeTargetZone(me: Pick<Entity, "id" | "cell">): ThreatMap | null {
		const known = this.threatMap
		if (known === null || this.threatInputs === null) {
			return null
		}
		return buildTargetZone(me, this.threatInputs, known.turn, { provider: new GeometricShotCells(this.sightCache), known })
	}

	private friendlyProfileOf(entity: Entity, turn: number): EntityProfile {
		let profile = this.friendlyProfiles.get(entity.id)
		if (profile === undefined) {
			profile = new EntityProfile(entity, turn)
			this.friendlyProfiles.set(entity.id, profile)
		}
		return profile
	}

	private refreshReachable(
		profile: EntityProfile,
		entity: Entity,
		side: EntitySide,
		mp: number,
		turn: number
	): ReachableUpdate {
		const current = profile.reachable
		const recomputed = current === null || !current.isUpToDate(entity.id, entity.cell, mp, turn)
		const reachable = recomputed ? computeReachableCells(entity, mp, turn) : current
		if (recomputed) {
			profile.setReachable(reachable)
		}
		return {
			entityId: entity.id,
			name: entity.name,
			side,
			mp: reachable.mp,
			size: reachable.size,
			truncated: reachable.truncated,
			recomputed
		}
	}

	/** Armes connues (liste initiale + observées). */
	knownWeapons(enemyId: number): readonly Weapon[] {
		return this.profiles.get(enemyId)?.knownWeapons ?? []
	}

	observedWeapons(enemyId: number): Weapon[] {
		const profile = this.profiles.get(enemyId)
		return profile === undefined ? [] : [...profile.observedWeapons.values()].map((seen) => seen.item)
	}

	observedChips(enemyId: number): Chip[] {
		const profile = this.profiles.get(enemyId)
		return profile === undefined ? [] : [...profile.observedChips.values()].map((seen) => seen.item)
	}

	/** Portée max parmi les armes connues (0 si ennemi ou armes inconnus). */
	maxKnownWeaponRange(enemyId: number): number {
		let range = 0
		for (const weapon of this.knownWeapons(enemyId)) {
			range = Math.max(range, weapon.maxRange)
		}
		return range
	}

	/** Cooldown restant estimé d'une puce de l'ennemi (0 si inconnu ou prête). */
	getCooldown(enemyId: number, chip: Chip): number {
		return this.profiles.get(enemyId)?.getCooldown(chip) ?? 0
	}

	isChipReady(enemyId: number, chip: Chip): boolean {
		return this.getCooldown(enemyId, chip) === 0
	}

	/**
	 * Historise ce que l'ennemi a fait depuis la fin de mon tour précédent (photographie de `endMyTurn`, consommée).
	 * Les dégâts ne comptent que s'ils sont attribuables : lus sur un effet ou inférés, ou sans autre ennemi vivant ;
	 * ceux d'un effet sur la durée en cours (`source` « effect ») ne sont pas un nouveau coup.
	 */
	private recordEnemyTurn(
		profile: EnemyProfile,
		entity: Entity,
		uses: readonly Item[],
		hit: EnemyHit | null,
		turn: number,
		aliveEnemies: number
	): void {
		const before = profile.afterMyTurn
		if (before === null || before.turn >= turn) {
			return
		}
		profile.afterMyTurn = null
		const attributable = hit !== null && (hit.source === "inferred" || (hit.source === "ambiguous" && aliveEnemies <= 1))
		profile.addTurnRecord(describeEnemyTurn(
			turn, before, { cell: entity.cell, life: entity.life }, uses, attributable ? hit.amount : 0
		))
	}

	private collectUses(profile: EnemyProfile, entity: Entity, me: Me, turn: number): Item[] {
		// Effets regroupés par « item:cible » pour cet appel, en gardant la plus grande durée restante :
		// un item posant plusieurs effets de durées différentes n'est ainsi évalué qu'une fois.
		const grouped = new Map<string, { item: Item, itemKey: string, turns: number }>()
		const consider = (effect: Effect): void => {
			const item = resolveItem(profile, effect.item)
			if (item === null) {
				return
			}
			const itemKey = `${isChipItem(item) ? "chip" : "weapon"}:${item.id}`
			const key = `${itemKey}:${idOf(effect.target) ?? -1}`
			const current = grouped.get(key)
			if (current === undefined) {
				grouped.set(key, { item, itemKey, turns: effect.turns })
			} else {
				// Math.max : une durée finie l'emporte sur une durée permanente (< 0)
				current.turns = Math.max(current.turns, effect.turns)
			}
		}
		for (const effect of entity.launchedEffects ?? []) {
			consider(effect)
		}
		for (const effect of me.effects ?? []) {
			if (idOf(effect.caster) === entity.id) {
				consider(effect)
			}
		}

		const found = new Map<string, Item>()
		for (const [key, group] of grouped) {
			if (isNewEffect(profile, key, turn, group.turns)) {
				found.set(group.itemKey, group.item)
			}
		}
		return [...found.values()]
	}

	private attributeDamage(
		profile: EnemyProfile,
		entity: Entity,
		me: Me,
		turn: number,
		aliveEnemies: number
	): EnemyHit | null {
		if (this.lastLife === null) {
			return null
		}
		const elapsed = Math.max(1, turn - this.lastLifeTurn)
		let loss = this.lastLife - me.life
		let reported: EnemyHit | null = null

		// Dégâts sur la durée lancés par cet ennemi : lus sur l'effet (supposés appliqués une fois par tour).
		for (const effect of me.effects ?? []) {
			if (idOf(effect.caster) !== entity.id || (effect.type !== Effect.DAMAGE && effect.type !== Effect.POISON)) {
				continue
			}
			reported = { turn, amount: effect.value, item: resolveItem(profile, effect.item), source: "effect" }
			profile.addHit(reported)
			loss -= effect.value
		}
		if (loss <= 0) {
			return reported
		}

		let item: Item | null = null
		if (aliveEnemies <= 1) {
			const strength = entity.strength ?? 0
			const compatible: Item[] = []
			if (entity.weapon !== null && entity.weapon !== undefined &&
				isCompatible(entity.weapon, loss, strength, profile.maxTpSeen, elapsed)) {
				compatible.push(entity.weapon)
			}
			for (const chip of profile.knownChips) {
				if (profile.isChipReady(chip) && isCompatible(chip, loss, strength, profile.maxTpSeen, elapsed)) {
					compatible.push(chip)
				}
			}
			item = compatible.length === 1 ? (compatible[0] ?? null) : null
		}
		reported = { turn, amount: loss, item, source: item === null ? "ambiguous" : "inferred" }
		profile.addHit(reported)
		return reported
	}
}

function isChipItem(item: Item): item is Chip {
	return "cooldown" in item || "currentCooldown" in item
}

/** Id d'une entité/item donné soit par un objet soit par un id numérique (forme non précisée par la doc). */
function idOf(value: Entity | Item | number | null | undefined): number | null {
	if (value === null || value === undefined) {
		return null
	}
	return typeof value === "number" ? value : value.id
}

/**
 * Objet fourni : utilisé tel quel. Id numérique : retrouvé parmi les armes/puces connues de l'ennemi,
 * seulement si un unique item correspond (les espaces d'ids armes/puces peuvent se recouvrir).
 */
function resolveItem(profile: EnemyProfile, raw: Item | number | null | undefined): Item | null {
	if (raw === null || raw === undefined) {
		return null
	}
	if (typeof raw === "object") {
		return raw
	}
	const chips = profile.knownChips.filter((chip) => chip.id === raw)
	const weapons = profile.knownWeapons.filter((weapon) => weapon.id === raw)
	return chips.length + weapons.length === 1 ? (chips[0] ?? weapons[0] ?? null) : null
}

/**
 * Un effet déjà vu et toujours actif n'est pas un nouvel usage. Nouvel usage si : jamais vu,
 * ou expiré depuis, ou durée restante supérieure à celle attendue (relancé). Effet permanent (turns < 0) : une seule fois.
 * `turns` est la plus grande durée restante des effets de l'item sur cette cible dans l'appel courant.
 */
function isNewEffect(profile: EnemyProfile, key: string, turn: number, turns: number): boolean {
	const previous = profile.effectSeen.get(key)
	profile.effectSeen.set(key, { turn, turns })
	if (previous === undefined) {
		return true
	}
	if (turns < 0 || previous.turns < 0) {
		return false
	}
	const expected = previous.turns - (turn - previous.turn)
	return expected <= 0 || turns > expected
}

function baseDamage(item: Item): { min: number, max: number } {
	let min = 0
	let max = 0
	for (const feature of item.features) {
		if (feature.type === Effect.DAMAGE) {
			min += feature.minValue
			max += feature.maxValue
		}
	}
	return { min, max }
}

/**
 * Plage de dégâts plausible : min = valeur min × (1 + force/100) pour 1 utilisation sans critique ;
 * max = valeur max × (1 + force/100) × CRITICAL_FACTOR × utilisations × tours écoulés.
 * Utilisations par tour : floor(PT max vus / coût) pour une arme ; 1 pour une puce à cooldown.
 * Les boucliers réduisent les dégâts reçus et peuvent faire sortir la perte observée de la plage.
 */
function isCompatible(item: Item, amount: number, strength: number, tpBudget: number, elapsedTurns: number): boolean {
	const base = baseDamage(item)
	if (base.max <= 0) {
		return false
	}
	const scale = 1 + strength / 100
	const limitedByCooldown = isChipItem(item) && (item.cooldown ?? 0) !== 0
	const usesPerTurn = limitedByCooldown ? 1 : Math.max(1, Math.floor(tpBudget / Math.max(1, item.cost)))
	const min = base.min * scale
	const max = base.max * scale * CRITICAL_FACTOR * usesPerTurn * elapsedTurns
	return amount + DAMAGE_TOLERANCE >= min && amount - DAMAGE_TOLERANCE <= max
}
