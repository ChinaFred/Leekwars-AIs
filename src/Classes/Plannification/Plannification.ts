// @version:5.8
// file version: 5
import { Action } from "./Action.js"
import { LeekProfile } from "../LeekProfile.js"
import {
	AggressiveStrategy
} from "../Strategy/AggressiveStrategy.js"
import { BalancedStrategy } from "../Strategy/BalancedStrategy.js"
import { DefensiveStrategy } from "../Strategy/DefensiveStrategy.js"
import { LeekStrategy } from "../Strategy/LeekStrategy.js"
import { MovementBehavior, MOVEMENT_BEHAVIOR } from "../Strategy/MovementBehavior.js"
import { globalCombatLogger } from "../../Toolbox/CombatLogger.js"

export class Plannification {
	readonly actions: Action[] = []
	readonly strategy: LeekStrategy
	private tpLeft: number
	private mpLeft: number
	private chosenWeapon: Weapon | null = null
	private willShoot = false
	private weaponEquipPlanned = false
	private movementBehavior: MovementBehavior
	private debugEnabled = true

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

	private debug(message: string): void {
		if (this.debugEnabled) {
			console.log(`[Plannification] ${message}`)
		}
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
			`PredictContactNextTurn: distance=${currentDistance}, ` +
			`myMaxReach=${myMaxReach}, myMaxRange=${myMaxRange}, iCanShoot=${result.iCanShoot}, ` +
			`enemyMaxReach=${enemyMaxReach}, enemyMaxRange=${enemyMaxRange}, enemyCanShoot=${result.enemyCanShoot}`
		)

		return result
	}

	private shouldPrioritizeDefense(): boolean {
		const contact = this.predictContactNextTurn()
		return contact.enemyCanShoot && !contact.iCanShoot
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

		const preferredMid = (this.profile.preferredMinRange + this.profile.preferredMaxRange) / 2
		let bestScore = Number.NEGATIVE_INFINITY
		for (const weapon of candidates) {
			const weaponMid = (weapon.minRange + weapon.maxRange) / 2
			const meanDamage = getMeanFeatureValue(weapon.features, Effect.DAMAGE) *
				(1 + this.leek.strength / 100)
			const turnDamage = weapon.cost > 0
				? meanDamage * Math.floor(this.tpLeft / weapon.cost)
				: 0
			const score = this.strategy.scoreWeapon(turnDamage, preferredMid, weaponMid)
			this.debug(
				`Weapon ${weapon.name}: damage=${meanDamage.toFixed(1)}, turnDamage=${turnDamage.toFixed(1)}, ` +
				`range=${weapon.minRange}-${weapon.maxRange}, score=${score.toFixed(2)}`
			)
			if (score > bestScore) {
				this.chosenWeapon = weapon
				bestScore = score
			}
		}

		this.debug(`ChosenWeapon: ${this.chosenWeapon?.name} (score: ${bestScore.toFixed(2)})`)
		this.movementBehavior = new MovementBehavior(this.leek, this.target, this.chosenWeapon, this.target.weapon)
	}

	planEquipWeapon(): void {
		if (this.chosenWeapon === null) {
			this.chooseWeapon()
		}
		const weapon = this.chosenWeapon
		if (weapon === null || this.leek.weapon === weapon || this.tpLeft < 1) {
			this.debug(`SkipEquipWeapon: weapon=${weapon?.name}, current=${this.leek.weapon?.name}, tpLeft=${this.tpLeft}`)
			return
		}
		this.debug(`EquipWeapon: ${weapon.name} (cost 1 TP, ${this.tpLeft} → ${this.tpLeft - 1})`)
		this.actions.push(new Action("equip weapon", () => this.leek.setWeapon(weapon), weapon.name))
		this.tpLeft -= 1
		this.weaponEquipPlanned = true
	}

	planMove(): void {
		if (this.chosenWeapon === null) {
			this.chooseWeapon()
		}
		if (this.chosenWeapon === null) {
			this.debug(`SkipMove: no weapon chosen`)
			return
		}

		this.willShoot = true
		if (this.mpLeft > 0 && !this.leek.canUseWeapon(this.target)) {
			const contact = this.predictContactNextTurn()
			const distance = this.leek.distance(this.target)
			const behavior = this.movementBehavior.getOptimalBehavior({
				iCanShoot: contact.iCanShoot,
				enemyCanShoot: contact.enemyCanShoot,
				distance
			})

			this.debug(
				`Move: distance=${distance}, behavior=${behavior}, ` +
				`mpLeft=${this.mpLeft} → 0`
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
			this.debug(`SkipMove: canUseWeapon=${this.leek.canUseWeapon(this.target)}, mpLeft=${this.mpLeft}`)
		}
	}

	planShootOrChip(): void {
		if (!this.willShoot || this.leek.maxLife <= 0) {
			this.debug(`SkipShootOrChip: willShoot=${this.willShoot}, alive=${this.leek.maxLife > 0}`)
			return
		}
		const lifeRatio = this.leek.life / this.leek.maxLife
		if (this.strategy.shouldUseAttackChip(lifeRatio)) {
			const attackChip = this.leek.chips.find((chip) =>
				chip.currentCooldown === 0 &&
				chip.cost <= this.tpLeft &&
				getMeanFeatureValue(chip.features, Effect.DAMAGE) > 0 &&
				this.leek.chipCells(chip, this.target).includes(this.leek.cell)
			)
			if (attackChip !== undefined) {
				this.debug(`AttackChip: ${attackChip.name} (cost ${attackChip.cost} TP, ${this.tpLeft} → ${this.tpLeft - attackChip.cost})`)
				this.actions.push(
					new Action("attack chip", () => this.leek.useChip(attackChip, this.target), attackChip.name)
				)
				this.tpLeft -= attackChip.cost
			}
		}

		if (
			this.chosenWeapon === null ||
			this.chosenWeapon.cost <= 0 ||
			(!this.weaponEquipPlanned && this.leek.weapon !== this.chosenWeapon)
		) {
			this.debug(`SkipShoot: weapon=${this.chosenWeapon?.name}, cost=${this.chosenWeapon?.cost}`)
			return
		}

		let shootCount = 0
		while (this.tpLeft >= this.chosenWeapon.cost) {
			shootCount++
			this.actions.push(new Action("shoot", () => {
				if (this.leek.canUseWeapon(this.target)) {
					this.leek.useWeapon(this.target)
				}
			}, this.chosenWeapon.name))
			this.tpLeft -= this.chosenWeapon.cost
		}

		if (shootCount > 0) {
			this.debug(`Shoot: ${this.chosenWeapon.name} ×${shootCount} (cost ${shootCount * this.chosenWeapon.cost} TP)`)
		}
	}

	planChipsActionsAfterShoot(): void {
		if (this.leek.maxLife <= 0) {
			this.debug(`SkipChipsAfterShoot: dead`)
			return
		}
		const lifeLost = this.leek.maxLife - this.leek.life
		const lifeRatio = this.leek.life / this.leek.maxLife
		const lostLifeRatio = lifeLost / this.leek.maxLife

		const shouldDefense = this.shouldPrioritizeDefense()
		const shouldOffense = this.shouldBoostAttack()

		this.debug(
			`ChipsAfterShoot: life=${lifeRatio.toFixed(2)}, lifeLost=${lostLifeRatio.toFixed(2)}, ` +
			`shouldDefense=${shouldDefense}, shouldOffense=${shouldOffense}`
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
				this.debug(`Shield (defense priority): ${shield.name}`)
				this.actions.push(
					new Action("shield", () => this.leek.useChip(shield, this.leek), shield.name)
				)
				this.tpLeft -= shield.cost
				return
			}
		}

		if (this.profile.allowHealing && this.strategy.shouldHeal(lifeRatio, lostLifeRatio)) {
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
						`Heal: ${chip.name} (healing=${meanHealing.toFixed(0)}, ` +
						`meanDamagePerTp=${meanDamagePerTp.toFixed(2)}, skip=${this.strategy.shouldSkipHealForDamage(chip.cost, meanHealing, this.tpLeft, meanDamagePerTp)})`
					)
					this.actions.push(new Action("heal", () => this.leek.useChip(chip, this.leek), chip.name))
					this.tpLeft -= chip.cost
				} else {
					this.debug(`SkipHeal: more damage per TP available`)
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
				this.debug(`Shield (after healing): ${shield.name}`)
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
				`SkipHide: allowHiding=${this.profile.allowHiding}, mpLeft=${this.mpLeft}, alive=${this.leek.maxLife > 0}, targetAlive=${this.target.life > 0}`
			)
			return
		}

		const distance = this.leek.distance(this.target)
		const lifeRatio = this.leek.life / this.leek.maxLife
		const shouldHide = this.strategy.shouldHide(lifeRatio, distance, this.profile.preferredMinRange)

		this.debug(
			`HideCheck: distance=${distance}, lifeRatio=${lifeRatio.toFixed(2)}, shouldHide=${shouldHide}`
		)

		if (shouldHide) {
			this.debug(`Hide: retreat to corner`)
			this.actions.push(
				new Action("hide", () => this.movementBehavior.executeBehavior(MOVEMENT_BEHAVIOR.RETREAT_TO_CORNER), "Smart Retreat")
			)
			this.mpLeft = 0
		}
	}

	execute(): void {
		this.debug(`Execute: ${this.actions.length} actions (TP: ${this.tpLeft} left, MP: ${this.mpLeft} left)`)
		while (this.actions.length > 0) {
			const action = this.actions.shift()
			this.debug(`  → ${action?.name}`)
			action?.action()
		}
		this.debug(`Done: TP: ${this.tpLeft}, MP: ${this.mpLeft}`)
	}
}

function createStrategy(profile: LeekProfile): LeekStrategy {
	if (profile.strategyName === "AGGRESSIVE") {
		return new AggressiveStrategy(profile.aggression)
	}
	if (profile.strategyName === "DEFENSIVE") {
		return new DefensiveStrategy(profile.aggression)
	}
	return new BalancedStrategy(profile.aggression)
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
