// @version:5.8
// file version: 17
import { Action } from "./Action.js"
import { LeekProfile, createStrategy } from "../LeekProfile.js"
import { LeekStrategy } from "../Strategy/LeekStrategy.js"
import { MovementBehavior, MOVEMENT_BEHAVIOR } from "../Strategy/MovementBehavior.js"
import { globalCombatLogger } from "../../Toolbox/CombatLogger.js"
import { log, LOG_CONTEXT, LogContext, LogText } from "../../Toolbox/Logger.js"
import { ExecutionBudget, EXECUTION_BUDGET_POLICY } from "./ExecutionBudget.js"
import { track } from "../Context/StagnationTracker.js"

export class Plannification {
	readonly actions: Action[] = []
	readonly strategy: LeekStrategy
	private tpLeft: number
	private mpLeft: number
	private chosenWeapon: Weapon | null = null
	private plannedAttacks = 0
	private weaponEquipPlanned = false
	private movementBehavior: MovementBehavior

	constructor(
		private readonly leek: Me,
		private readonly target: Entity,
		private readonly profile: LeekProfile
	) {
		this.tpLeft = leek.tp
		this.mpLeft = leek.mp
		this.strategy = createStrategy(profile)
		this.movementBehavior = new MovementBehavior(leek, target, leek.weapon, target.weapon)
	}

	/**
	 * Log de plannification sous le contexte donné (préfixe `[Plannification] ` conservé). Passer une
	 * fonction pour ne payer le gabarit de chaîne que si le contexte est actif.
	 */
	private debug(message: LogText, context: LogContext): void {
		log(() => `[Plannification] ${typeof message === "function" ? message() : message}`, context)
	}

	private predictContactNextTurn(): { iCanShoot: boolean; enemyCanShoot: boolean } {
		const currentDistance = this.leek.distance(this.target)
		const myMaxRange = this.chosenWeapon?.maxRange ?? 1
		const enemyMaxRange = this.target.weapon?.maxRange ?? 1
		const myMaxReach = Math.max(currentDistance - this.mpLeft, 0)
		const enemyMaxReach = Math.max(currentDistance - this.target.mp, 0)

		const result = {
			iCanShoot: myMaxReach <= myMaxRange,
			enemyCanShoot: enemyMaxReach <= enemyMaxRange
		}

		this.debug(
			() => `PredictContactNextTurn: distance=${currentDistance}, ` +
				`myMaxReach=${myMaxReach}, myMaxRange=${myMaxRange}, iCanShoot=${result.iCanShoot}, ` +
				`enemyMaxReach=${enemyMaxReach}, enemyMaxRange=${enemyMaxRange}, enemyCanShoot=${result.enemyCanShoot}`,
			LOG_CONTEXT.STRATEGY
		)

		return result
	}

	private shouldPrioritizeDefense(): boolean {
		const contact = this.predictContactNextTurn()
		const lifeRatio = this.leek.life / this.leek.maxLife
		
		// Defense priority if:
		// 1) Enemy can shoot but I cannot (asymmetry) → classic defensive posture
		// 2) BOTH can shoot AND I'm moderately wounded → mutual contact danger
		const asymmetryDefense = contact.enemyCanShoot && !contact.iCanShoot
		const mutualContactDanger = contact.enemyCanShoot && contact.iCanShoot && lifeRatio <= 0.60
		
		return asymmetryDefense || mutualContactDanger
	}

	private shouldBoostAttack(): boolean {
		const contact = this.predictContactNextTurn()
		return contact.iCanShoot && !contact.enemyCanShoot
	}

	chooseWeapon(): void {
		const candidates = [...this.leek.weapons]
		if (this.leek.weapon !== null && !candidates.includes(this.leek.weapon)) {
			candidates.push(this.leek.weapon)
		}

		let bestDamage = Number.NEGATIVE_INFINITY
		for (const weapon of candidates) {
			const meanDamage = getMeanFeatureValue(weapon.features, Effect.DAMAGE) *
				(1 + this.leek.strength / 100)
			const turnDamage = weapon.cost > 0
				? meanDamage * Math.floor(this.tpLeft / weapon.cost)
				: 0
			this.debug(
				() => `Weapon ${weapon.name}: damage=${meanDamage.toFixed(1)}, turnDamage=${turnDamage.toFixed(1)}, ` +
					`range=${weapon.minRange}-${weapon.maxRange}`,
				LOG_CONTEXT.WEAPON
			)
			if (turnDamage > bestDamage) {
				this.chosenWeapon = weapon
				bestDamage = turnDamage
			}
		}

		this.debug(() => `ChosenWeapon: ${this.chosenWeapon?.name} (turnDamage: ${bestDamage.toFixed(1)})`, LOG_CONTEXT.WEAPON)
		this.movementBehavior = new MovementBehavior(this.leek, this.target, this.chosenWeapon, this.target.weapon)
	}

	planEquipWeapon(): void {
		if (this.chosenWeapon === null) {
			this.chooseWeapon()
		}
		const weapon = this.chosenWeapon
		if (weapon === null || this.leek.weapon === weapon || this.tpLeft < 1) {
			this.debug(
				() => `SkipEquipWeapon: weapon=${weapon?.name}, current=${this.leek.weapon?.name}, tpLeft=${this.tpLeft}`,
				LOG_CONTEXT.WEAPON
			)
			return
		}
		this.debug(() => `EquipWeapon: ${weapon.name} (cost 1 TP, ${this.tpLeft} → ${this.tpLeft - 1})`, LOG_CONTEXT.WEAPON)
		this.actions.push(new Action("equip weapon", () => this.leek.setWeapon(weapon), weapon.name))
		this.tpLeft -= 1
		this.weaponEquipPlanned = true
	}

	planMove(): void {
		if (this.chosenWeapon === null) {
			this.chooseWeapon()
		}
		if (this.chosenWeapon === null) {
			this.debug(`SkipMove: no weapon chosen`, LOG_CONTEXT.MOVEMENT)
			return
		}

		if (this.mpLeft > 0 && !this.leek.canUseWeapon(this.target)) {
			const contact = this.predictContactNextTurn()
			const distance = this.leek.distance(this.target)
			const behavior = this.movementBehavior.getOptimalBehavior({
				iCanShoot: contact.iCanShoot,
				enemyCanShoot: contact.enemyCanShoot,
				distance
			})

			this.debug(
				() => `Move: distance=${distance}, behavior=${behavior}, ` +
					`mpLeft=${this.mpLeft} → 0`,
				LOG_CONTEXT.MOVEMENT
			)

			this.actions.push(
				new Action(
					`move [${behavior}]`,
					() => this.movementBehavior.executeBehavior(behavior),
					`Move: ${behavior}`
				)
			)
			this.mpLeft = 0
		} else {
			this.debug(
				() => `SkipMove: canUseWeapon=${this.leek.canUseWeapon(this.target)}, mpLeft=${this.mpLeft}`,
				LOG_CONTEXT.MOVEMENT
			)
		}
	}

	planShootOrChip(): void {
		// Indépendant de l'ordre de planification : ne dépend plus d'un drapeau posé par planMove.
		if (this.chosenWeapon === null) {
			this.chooseWeapon()
		}
		if (this.chosenWeapon === null || this.leek.maxLife <= 0) {
			this.debug(
				() => `SkipShootOrChip: weapon=${this.chosenWeapon?.name}, alive=${this.leek.maxLife > 0}`,
				LOG_CONTEXT.PLANNING
			)
			return
		}
		const lifeRatio = this.leek.life / this.leek.maxLife
		const chosenWeapon = this.chosenWeapon
		if (this.strategy.shouldUseAttackChip(lifeRatio)) {
			const attackChip = this.leek.chips.find((chip) =>
				chip.currentCooldown === 0 &&
				chip.cost <= this.tpLeft &&
				getMeanFeatureValue(chip.features, Effect.DAMAGE) > 0 &&
				this.leek.chipCells(chip, this.target).includes(this.leek.cell)
			)
			if (attackChip !== undefined) {
				this.debug(
					() => `AttackChip: ${attackChip.name} (cost ${attackChip.cost} TP, ${this.tpLeft} → ${this.tpLeft - attackChip.cost})`,
					LOG_CONTEXT.CHIP
				)
				this.actions.push(
					new Action("attack chip", () => this.leek.useChip(attackChip, this.target), attackChip.name)
				)
				this.tpLeft -= attackChip.cost
				this.plannedAttacks++
			}
		}

		if (
			this.chosenWeapon.cost <= 0 ||
			(!this.weaponEquipPlanned && this.leek.weapon !== this.chosenWeapon)
		) {
			this.debug(() => `SkipShoot: weapon=${chosenWeapon.name}, cost=${chosenWeapon.cost}`, LOG_CONTEXT.WEAPON)
			return
		}

		let shootCount = 0
		while (this.tpLeft >= this.chosenWeapon.cost) {
			shootCount++
			this.actions.push(new Action("shoot", () => {
				return this.leek.canUseWeapon(this.target) ? this.leek.useWeapon(this.target) : undefined
			}, this.chosenWeapon.name))
			this.tpLeft -= this.chosenWeapon.cost
		}
		this.plannedAttacks += shootCount

		if (shootCount > 0) {
			this.debug(
				() => `Shoot: ${chosenWeapon.name} ×${shootCount} (cost ${shootCount * chosenWeapon.cost} TP)`,
				LOG_CONTEXT.WEAPON
			)
		}
	}

	planChipsActionsAfterShoot(): void {
		if (this.leek.maxLife <= 0) {
			this.debug(`SkipChipsAfterShoot: dead`, LOG_CONTEXT.STRATEGY)
			return
		}
		const lifeLost = this.leek.maxLife - this.leek.life
		const lifeRatio = this.leek.life / this.leek.maxLife
		const lostLifeRatio = lifeLost / this.leek.maxLife

		const shouldDefense = this.shouldPrioritizeDefense()
		const shouldOffense = this.shouldBoostAttack()

		this.debug(
			() => `ChipsAfterShoot: life=${lifeRatio.toFixed(2)}, lifeLost=${lostLifeRatio.toFixed(2)}, ` +
				`shouldDefense=${shouldDefense}, shouldOffense=${shouldOffense}`,
			LOG_CONTEXT.STRATEGY
		)

		if (this.profile.allowShielding && shouldDefense && this.strategy.shouldShield(
			lifeRatio,
			this.leek.distance(this.target),
			this.target.mp + (this.target.weapon?.maxRange ?? this.chosenWeapon?.maxRange ?? 0)
		)) {
			const shield = this.leek.chips.find((chip) =>
				chip.currentCooldown === 0 &&
				chip.cost <= this.tpLeft &&
				chip.features.some((feature) =>
					feature.type === Effect.ABSOLUTE_SHIELD ||
					feature.type === Effect.RELATIVE_SHIELD
				) &&
				this.leek.chipCells(chip, this.leek).includes(this.leek.cell)
			)
			if (shield !== undefined) {
				this.debug(() => `Shield (defense priority): ${shield.name}`, LOG_CONTEXT.ARMOR)
				this.actions.push(
					new Action("shield", () => this.leek.useChip(shield, this.leek), shield.name)
				)
				this.tpLeft -= shield.cost
				return
			}
		}

		if (this.profile.allowHealing && 
			(this.strategy.shouldHeal(lifeRatio, lostLifeRatio) || 
			 (this.strategy as any).shouldHealWithThreat?.(lifeRatio, lostLifeRatio, this.leek.distance(this.target)))) {
			const chip = Chip.bandage
			const meanHealing = getMeanFeatureValue(chip.features, Effect.HEAL) *
				(1 + this.leek.wisdom / 100)
			if (
				this.leek.chips.includes(chip) &&
				chip.currentCooldown === 0 &&
				chip.cost <= this.tpLeft &&
				meanHealing > 0 &&
				meanHealing <= lifeLost &&
				this.leek.chipCells(chip, this.leek).includes(this.leek.cell)
			) {
				const meanDamagePerTp = this.chosenWeapon !== null && this.chosenWeapon.cost > 0
					? getMeanFeatureValue(this.chosenWeapon.features, Effect.DAMAGE) *
						(1 + this.leek.strength / 100) / this.chosenWeapon.cost
					: 0

				if (!this.strategy.shouldSkipHealForDamage(chip.cost, meanHealing, this.tpLeft, meanDamagePerTp)) {
					this.debug(
						() => `Heal: ${chip.name} (healing=${meanHealing.toFixed(0)}, ` +
							`meanDamagePerTp=${meanDamagePerTp.toFixed(2)}, skip=${this.strategy.shouldSkipHealForDamage(chip.cost, meanHealing, this.tpLeft, meanDamagePerTp)}, ` +
							`distance=${this.leek.distance(this.target)}, threat-aware=true)`,
						LOG_CONTEXT.CHIP
					)
					this.actions.push(new Action("heal", () => this.leek.useChip(chip, this.leek), chip.name))
					this.tpLeft -= chip.cost
				} else {
					this.debug(`SkipHeal: more damage per TP available`, LOG_CONTEXT.CHIP)
				}
			}
		}

		if (this.profile.allowShielding && !shouldDefense && this.strategy.shouldShield(
			lifeRatio,
			this.leek.distance(this.target),
			this.target.mp + (this.target.weapon?.maxRange ?? this.chosenWeapon?.maxRange ?? 0)
		)) {
			const shield = this.leek.chips.find((chip) =>
				chip.currentCooldown === 0 &&
				chip.cost <= this.tpLeft &&
				chip.features.some((feature) =>
					feature.type === Effect.ABSOLUTE_SHIELD ||
					feature.type === Effect.RELATIVE_SHIELD
				) &&
				this.leek.chipCells(chip, this.leek).includes(this.leek.cell)
			)
			if (shield !== undefined) {
				this.debug(() => `Shield (after healing): ${shield.name}`, LOG_CONTEXT.ARMOR)
				this.actions.push(
					new Action("shield", () => this.leek.useChip(shield, this.leek), shield.name)
				)
				this.tpLeft -= shield.cost
			}
		}
	}

	planHide(): void {
		if (
			!this.profile.allowHiding ||
			this.mpLeft <= 0 ||
			this.leek.maxLife <= 0 ||
			this.target.life <= 0
		) {
			this.debug(
				() => `SkipHide: allowHiding=${this.profile.allowHiding}, mpLeft=${this.mpLeft}, alive=${this.leek.maxLife > 0}, targetAlive=${this.target.life > 0}`,
				LOG_CONTEXT.STRATEGY
			)
			return
		}

		const distance = this.leek.distance(this.target)
		const lifeRatio = this.leek.life / this.leek.maxLife
		const shouldHide = this.strategy.shouldHide(lifeRatio, distance)

		this.debug(
			() => `HideCheck: distance=${distance}, lifeRatio=${lifeRatio.toFixed(2)}, shouldHide=${shouldHide}`,
			LOG_CONTEXT.STRATEGY
		)

		if (shouldHide) {
			this.debug(`Hide: retreat to corner`, LOG_CONTEXT.MOVEMENT)
			this.actions.push(
				new Action("hide", () => this.movementBehavior.executeBehavior(MOVEMENT_BEHAVIOR.RETREAT_TO_CORNER), "Smart Retreat")
			)
			this.mpLeft = 0
		}
	}

	/**
	 * Recul de zone_control, planifié APRÈS les tirs (et après planHide, qui garde la priorité) :
	 * déplacer ne coûte pas de PT, donc on tire d'abord puis on sort de la portée de l'ennemi si c'est possible.
	 * Conditions : au moins une attaque planifiée, des PM restants, repli autorisé, ennemi vivant,
	 * l'ennemi peut m'atteindre depuis ma position et un recul de `mpLeft` cases m'en sort.
	 * Met mpLeft à 0 pour qu'aucun autre déplacement ne s'ajoute.
	 */
	planRetreatAfterShoot(): void {
		if (
			!this.profile.allowHiding ||
			this.plannedAttacks <= 0 ||
			this.mpLeft <= 0 ||
			this.leek.maxLife <= 0 ||
			this.target.life <= 0
		) {
			this.debug(
				() => `SkipRetreatAfterShoot: allowHiding=${this.profile.allowHiding}, attacks=${this.plannedAttacks}, mpLeft=${this.mpLeft}`,
				LOG_CONTEXT.STRATEGY
			)
			return
		}

		const distance = this.leek.distance(this.target)
		const inReach = this.movementBehavior.isInEnemyReach(distance)
		const canLeave = this.movementBehavior.canLeaveEnemyReach(distance, this.mpLeft)
		this.debug(
			() => `RetreatCheck: distance=${distance}, enemyMp=${this.target.mp}, inEnemyReach=${inReach}, canLeaveReach=${canLeave}`,
			LOG_CONTEXT.STRATEGY
		)
		if (!inReach || !canLeave) {
			return
		}

		this.debug(() => `RetreatAfterShoot: mpLeft=${this.mpLeft} → 0`, LOG_CONTEXT.MOVEMENT)
		this.actions.push(
			new Action(
				"retreat after shoot",
				() => this.movementBehavior.executeZoneRetreat(),
				"Zone control retreat"
			)
		)
		this.mpLeft = 0
	}

	execute(): void {
		const executionBudget = new ExecutionBudget()
		this.debug(
			() => `Execute: plan before execution ${JSON.stringify({
				mode: "historical queue; intent, not confirmed success",
				target: { id: `#${this.target.id}`, position: { x: this.target.cell.x, y: this.target.cell.y } },
				origin: { x: this.leek.cell.x, y: this.leek.cell.y },
				tp: { available: this.leek.tp, remainingPlanned: this.tpLeft },
				mp: { available: this.leek.mp, remainingPlanned: this.mpLeft },
				weapon: this.chosenWeapon?.name ?? null,
				actions: this.actions.map((action, index) => ({
					order: index + 1, name: action.name, description: action.desc
				})),
				destination: null, danger: null, score: null, executionBudget: EXECUTION_BUDGET_POLICY,
				limits: "movement destinations resolved at execution; queue budgets are not observed spending"
			})}`,
			LOG_CONTEXT.PLANNING
		)
		const available = (): boolean => executionBudget.available()
		while (this.actions.length > 0) {
			if (!available()) {
				this.debug("Execute: global operations reserve; remaining queue cancelled", LOG_CONTEXT.PLANNING)
				return
			}
			const action = this.actions.shift()
			this.debug(() => `  → ${action?.name}; before action; ${action?.desc}; ` +
				`from (${this.leek.cell.x},${this.leek.cell.y}), TP ${this.leek.tp}, MP ${this.leek.mp}`,
			LOG_CONTEXT.PLANNING)
			if (!available()) {
				this.debug("Execute: global operations reserve after phase log; action cancelled", LOG_CONTEXT.PLANNING)
				return
			}
			if (!action) continue
			// Historique : la file ne connaît que le nom de phase ; arme/puce = `desc`, tout déplacement = `move`.
			const offensive = action.name === "shoot" || action.name === "attack chip"
			track(this.leek, () => action.name === "equip weapon" ? "equip" :
				offensive || action.name === "shield" || action.name === "heal" ? action.desc : "move",
			offensive ? this.target : null, () => action.action())
		}
		this.debug(() => `Done: observed TP ${this.leek.tp}, MP ${this.leek.mp}; ` +
			`planned remaining TP ${this.tpLeft}, MP ${this.mpLeft}; queue completed, success not inferred`,
		LOG_CONTEXT.PLANNING)
	}
}

function getMeanFeatureValue(features: Feature[], featureType: number): number {
	let total = 0
	for (const feature of features) {
		if (feature.type === featureType) {
			total += (feature.minValue + feature.maxValue) / 2
		}
	}
	return total
}
