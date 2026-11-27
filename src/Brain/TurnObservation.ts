// @version:5.8
// file version: 3
import { EnemyMemory, NEVER_ATTRIBUTE_DAMAGE } from "../Classes/Context/EnemyMemory.js"
import { actionHistory, StagnationTracker } from "../Classes/Context/StagnationTracker.js"
import { aliveChests, aliveEnemies } from "../Classes/Context/Targets.js"
import { reportError } from "../Toolbox/Debug.js"
import { isLogEnabled, log, LOG_CONTEXT } from "../Toolbox/Logger.js"
import { AccessibleZoneSource, showAccessibleZones, showDangerZone } from "../Toolbox/Marker.js"

/** Mémoire et cartes du tour ; seules les cartes sont transmises à planAct. */
export const enemyMemory = new EnemyMemory()

/** Coffres : listés et observés à part, jamais ciblés ni comptés comme ennemis. */
export const chestMemory = new EnemyMemory()

/** Tours consécutifs sans tir ni progrès, mémorisés entre les tours (sortie de minimum local). */
export const stagnation = new StagnationTracker()

/** Exécute une collecte ou un affichage : une erreur est journalisée (`ERROR`) sans interrompre le tour. */
function guarded(name: string, action: () => void): void {
	try {
		action()
	} catch (error) {
		reportError("src/Brain/TurnObservation.ts", name, error)
	}
}

/**
 * Ennemis vivants du tour : demandés au jeu au premier besoin, puis la même liste sert à toutes les étapes.
 * Une erreur de l'API n'est pas mémorisée : chaque étape (protégée) la rencontre et la journalise à son tour.
 */
type EnemyList = () => readonly Entity[]

function enemyList(): EnemyList {
	let list: Entity[] | null = null
	return () => {
		if (list === null) {
			list = aliveEnemies()
		}
		return list
	}
}

/**
 * Met à jour le compteur de stagnation au début du tour (PV ennemis vivants, distance au plus proche, dégâts de mes
 * actions au tour précédent : voir `StagnationTracker`). Sans ennemi vivant, la distance vaut +∞ : `observe` ne fait
 * que la comparer (jamais de record, tour compté sans progrès). Une erreur est journalisée sans interrompre le tour.
 */
function observeStagnation(me: Me, living: EnemyList): void {
	guarded("observeStagnation", () => {
		const enemies = living()
		const enemyLife = enemies.reduce((total, enemy) => total + enemy.life, 0)
		const enemyDistance = enemies.reduce((best, enemy) =>
			Math.min(best, Math.abs(me.cell.x - enemy.cell.x) + Math.abs(me.cell.y - enemy.cell.y)), Number.POSITIVE_INFINITY)
		stagnation.noteEnemyPositions(enemies.map((enemy) => `${enemy.cell.x},${enemy.cell.y}`).sort().join(";"))
		stagnation.observe(Fight.turn, enemyLife, enemyDistance, actionHistory.lastDealt, enemies.length)
	})
}

/**
 * Ouvre le tour dans l'historique des actions, après `observeStagnation` (qui lit les dégâts du tour précédent).
 * Étape protégée à part : une erreur dans le calcul de stagnation n'empêche pas d'enregistrer les actions du tour.
 */
function openHistory(me: Me): void {
	guarded("openHistory", () => {
		actionHistory.begin(Fight.turn, me, enemyMemory.lifeLostSinceMyTurn(me), stagnation.passiveTurns)
	})
}

/**
 * Liste les coffres vivants et enregistre leurs actions (armes/puces vues). Les coups attribués par la mémoire
 * sont ignorés : l'attribution des dégâts n'a de sens que pour un adversaire.
 */
function observeChests(me: Me): void {
	guarded("observeChests", () => {
		const chests = aliveChests()
		const turnNumber = Fight.turn
		for (const chest of chests) {
			if (!chestMemory.has(chest.id)) {
				chestMemory.identify(chest, turnNumber)
				log(
					() => `[Chest] Listed ${chest.name} (#${chest.id}) ${chest.life}/${chest.maxLife} HP ` +
						`at (${chest.cell.x},${chest.cell.y}); not an enemy`,
					LOG_CONTEXT.MEMORY
				)
			}
			const update = chestMemory.update(chest, me, turnNumber, NEVER_ATTRIBUTE_DAMAGE)
			if (update !== null && update.newItems.length > 0) {
				log(() => `[Chest] ${chest.name} (#${chest.id}) observed: ${update.newItems.join(", ")}`, LOG_CONTEXT.MEMORY)
			}
		}
		if (chests.length > 0) {
			log(
				() => `[Chest] ${chests.map((chest) => `#${chest.id} ${chest.life}/${chest.maxLife} HP`).join(", ")}`,
				LOG_CONTEXT.MEMORY
			)
		}
	})
}

/**
 * Identifie les ennemis vivants nouveaux et met à jour les connus. Une erreur est journalisée
 * mais n'interrompt pas le tour : la collecte de données ne doit jamais empêcher de jouer.
 */
function observeEnemies(me: Me, living: EnemyList): void {
	guarded("observeEnemies", () => {
		const turnNumber = Fight.turn
		const enemies = living()
		for (const enemy of enemies) {
			if (!enemyMemory.has(enemy.id)) {
				const profile = enemyMemory.identify(enemy, turnNumber)
				log(
					() => `[EnemyMemory] Identified ${profile.name} (#${profile.id}) lvl ${profile.level}, ` +
						`${profile.maxLife} HP, ${profile.knownWeapons.length} weapons, ${profile.knownChips.length} chips`,
					LOG_CONTEXT.MEMORY
				)
			}
			const update = enemyMemory.update(enemy, me, turnNumber, enemies.length)
			if (update === null) {
				continue
			}
			if (update.newItems.length > 0) {
				log(() => `[EnemyMemory] ${enemy.name} observed: ${update.newItems.join(", ")}`, LOG_CONTEXT.MEMORY)
			}
			if (update.hit !== null && update.hit.item !== null) {
				const hit = update.hit
				log(
					() => `[EnemyMemory] ${enemy.name} hit ${hit.amount} with ${hit.item?.name} (${hit.source})`,
					LOG_CONTEXT.MEMORY
				)
			}
		}
	})
}

/**
 * Calcule les cases atteignables utilisées par le planificateur et les visualisations.
 * Une erreur est journalisée sans interrompre le tour. Un seul log court par tour.
 */
function observeReachableCells(me: Me, living: EnemyList): void {
	guarded("observeReachableCells", () => {
		const allies = Fight.getAllies().filter((ally) => ally.id !== me.id)
		const updates = enemyMemory.updateReachable(me, allies, living(), Fight.turn)
		log(() => {
			const summary = updates
				.map((update) => {
					const who = update.side === "me" ? "me" : `${update.side}#${update.entityId}`
					return `${who}:${update.size}${update.truncated ? "+" : ""} (${update.mp} MP)`
				})
				.join(", ")
			return `[Reachable] ${summary}`
		}, LOG_CONTEXT.REACHABLE)
	})
}

/**
 * Calcule la carte de danger utilisée par planAct à partir des cases atteignables.
 * Une erreur est journalisée sans interrompre le tour. Un seul log court par tour ; son coût
 * est inclus dans la ligne d'opérations de `logTurnOperations`.
 */
function observeThreatMap(me: Me, living: EnemyList): void {
	guarded("observeThreatMap", () => {
		const update = enemyMemory.updateThreatMap(me, living(), Fight.turn)
		if (update === null) {
			log("[Threat] unavailable", LOG_CONTEXT.THREAT)
			return
		}
		log(() => {
			const safest = update.safestCell === null ? "none" : `(${update.safestCell.x},${update.safestCell.y})`
			return `[Threat] ${update.size}/${update.candidateCells} cells, danger max ${update.maxDanger.toFixed(1)} ` +
				`min ${update.minDanger.toFixed(1)}, safest ${safest}, ${update.enemies} armed enemies, ` +
				`${update.pairsEvaluated} pairs, ${update.lineOfSightCalls} LoS${update.truncated ? ", TRUNCATED" : ""}`
		}, LOG_CONTEXT.THREAT)
	})
}

/**
 * Affichage visuel (contexte ACCESSIBLE_ZONE) de la zone accessible de chaque poireau vivant, dans l'ordre moi,
 * alliés, ennemis, à partir des cases déjà calculées par `observeReachableCells` (aucun appel API de plus pour
 * les cases). Sans effet (et sans calcul) si le contexte est inactif. Aucun effet sur planAct ; une erreur est
 * journalisée sans interrompre le tour.
 */
function displayAccessibleZones(me: Me, living: EnemyList): void {
	guarded("displayAccessibleZones", () => {
		if (!isLogEnabled(LOG_CONTEXT.ACCESSIBLE_ZONE)) {
			return
		}
		const seen = new Set<number>([me.id])
		const sources: AccessibleZoneSource[] = [
			{ name: me.name, side: "me", reachable: enemyMemory.getReachable(me.id) }
		]
		for (const ally of Fight.getAllies()) {
			if (seen.has(ally.id) || !(ally.life > 0)) {
				continue
			}
			seen.add(ally.id)
			sources.push({ name: ally.name, side: "ally", reachable: enemyMemory.getReachable(ally.id) })
		}
		for (const enemy of living()) {
			if (seen.has(enemy.id)) {
				continue
			}
			seen.add(enemy.id)
			sources.push({ name: enemy.name, side: "enemy", reachable: enemyMemory.getReachable(enemy.id) })
		}
		showAccessibleZones(sources)
	})
}

/**
 * Affichage visuel (contexte DANGER_ZONE) de la carte de danger calculée par `observeThreatMap`. Sans effet si
 * le contexte est inactif ou si la carte est absente. Aucun effet sur planAct.
 */
function displayDangerZone(): void {
	guarded("displayDangerZone", () => {
		if (!isLogEnabled(LOG_CONTEXT.DANGER_ZONE)) {
			return
		}
		showDangerZone(enemyMemory.getThreatMap())
	})
}

/**
 * Observation complète du début de tour, dans l'ordre : ennemis, coffres, cases atteignables (et leur affichage),
 * carte de danger (et son affichage), stagnation, puis ouverture de l'historique des actions. Chaque étape est
 * protégée séparément ; la liste des ennemis vivants n'est demandée au jeu qu'une fois.
 */
export function observeTurn(me: Me): void {
	const living = enemyList()
	observeEnemies(me, living)
	observeChests(me)
	observeReachableCells(me, living)
	displayAccessibleZones(me, living)
	observeThreatMap(me, living)
	displayDangerZone()
	observeStagnation(me, living)
	openHistory(me)
}

/** Recalcule cases atteignables puis carte de danger avec les PM et PT réels (après le boost de PM). */
export function refreshMaps(me: Me): void {
	const living = enemyList()
	observeReachableCells(me, living)
	observeThreatMap(me, living)
}

/** Mémorise mes PV de fin de tour (attribution des dégâts subis au tour suivant). */
export function recordMyTurnEnd(me: Me): void {
	guarded("recordMyTurnEnd", () => {
		enemyMemory.endMyTurn(me, Fight.turn)
	})
}
