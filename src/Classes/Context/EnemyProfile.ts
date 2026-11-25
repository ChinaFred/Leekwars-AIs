// @version:5.8
// file version: 1

/** Nombre maximal de coups conservés par ennemi (mémoire bornée). */
export const MAX_HIT_LOG = 20

/**
 * Cooldown suivi pour une puce à cooldown infini. Doc officielle de getCooldown :
 * « MAX_TURNS + 2 juste après l'usage » avec MAX_TURNS = 64. On suppose que `Chip.cooldown`
 * vaut -1 pour un cooldown infini (comme getChipCooldown) : non vérifié pour la propriété TS.
 */
export const INFINITE_COOLDOWN = 66

/**
 * - "effect"    : dégâts lus sur un effet actif dont l'ennemi est le lanceur (item connu si résolu) ;
 * - "inferred"  : un seul candidat (arme équipée ou puce offensive prête) est compatible avec la perte de PV ;
 * - "ambiguous" : zéro ou plusieurs candidats compatibles (ou plusieurs ennemis vivants) : item = null.
 */
export type HitSource = "effect" | "inferred" | "ambiguous"

export interface EnemyHit {
	turn: number
	amount: number
	item: Weapon | Chip | null
	source: HitSource
}

export interface EnemyStats {
	strength: number
	agility: number
	wisdom: number
	resistance: number
	science: number
	magic: number
}

/** `count` = nombre d'usages détectés (puce/effet) ou de changements d'arme équipée vue. */
export interface ObservedItem<T extends Weapon | Chip> {
	item: T
	firstTurn: number
	lastTurn: number
	count: number
}

/** Ce que l'on sait d'un ennemi : instantané à l'identification, enrichi par EnemyMemory.update. */
export class EnemyProfile {
	readonly id: number
	readonly name: string
	readonly level: number
	readonly maxLife: number
	readonly stats: EnemyStats
	readonly identifiedTurn: number
	readonly knownWeapons: Weapon[]
	readonly knownChips: Chip[]
	equippedWeapon: Weapon | null
	readonly observedWeapons = new Map<number, ObservedItem<Weapon>>()
	readonly observedChips = new Map<number, ObservedItem<Chip>>()
	readonly hits: EnemyHit[] = []
	/** Plus grand `entity.tp` vu pendant mon tour (le TP de l'ennemi à son propre tour n'est pas lisible). */
	maxTpSeen = 0
	/** Dernier tour pour lequel les cooldowns ont été avancés. */
	lastTurn: number
	/** Dernière observation par « item:cible » d'un effet (détection de nouveaux usages). */
	readonly effectSeen = new Map<string, { turn: number, turns: number }>()
	private readonly cooldowns = new Map<number, number>()

	constructor(entity: Entity, turn: number) {
		this.id = entity.id
		this.name = entity.name
		this.level = entity.level
		this.maxLife = entity.maxLife
		this.stats = {
			strength: entity.strength,
			agility: entity.agility,
			wisdom: entity.wisdom,
			resistance: entity.resistance,
			science: entity.science,
			magic: entity.magic
		}
		this.identifiedTurn = turn
		this.lastTurn = turn
		this.knownWeapons = [...(entity.weapons ?? [])]
		this.knownChips = [...(entity.chips ?? [])]
		this.equippedWeapon = entity.weapon ?? null
	}

	/** Retourne true si l'arme est vue pour la première fois. */
	observeWeapon(weapon: Weapon, turn: number, countUse: boolean): boolean {
		const seen = this.observedWeapons.get(weapon.id)
		if (seen === undefined) {
			this.observedWeapons.set(weapon.id, { item: weapon, firstTurn: turn, lastTurn: turn, count: 1 })
			if (!this.knownWeapons.some((known) => known.id === weapon.id)) {
				this.knownWeapons.push(weapon)
			}
			return true
		}
		seen.lastTurn = turn
		if (countUse) {
			seen.count++
		}
		return false
	}

	/** Retourne true si la puce est vue pour la première fois. */
	observeChip(chip: Chip, turn: number): boolean {
		const seen = this.observedChips.get(chip.id)
		if (seen === undefined) {
			this.observedChips.set(chip.id, { item: chip, firstTurn: turn, lastTurn: turn, count: 1 })
			if (!this.knownChips.some((known) => known.id === chip.id)) {
				this.knownChips.push(chip)
			}
			return true
		}
		seen.lastTurn = turn
		seen.count++
		return false
	}

	addHit(hit: EnemyHit): void {
		this.hits.push(hit)
		if (this.hits.length > MAX_HIT_LOG) {
			this.hits.splice(0, this.hits.length - MAX_HIT_LOG)
		}
	}

	/** Pose le cooldown suivi après un usage détecté (rien si la puce n'a pas de cooldown). */
	startCooldown(chip: Chip): void {
		const base = chip.cooldown ?? 0
		if (base === 0) {
			return
		}
		this.cooldowns.set(chip.id, base < 0 ? INFINITE_COOLDOWN : base)
	}

	/** Avance les cooldowns suivis jusqu'à `turn` (1 par tour écoulé, minimum 0). */
	advanceTo(turn: number): void {
		const delta = turn - this.lastTurn
		if (delta <= 0) {
			return
		}
		this.lastTurn = turn
		for (const [chipId, remaining] of this.cooldowns) {
			if (remaining - delta <= 0) {
				this.cooldowns.delete(chipId)
			} else {
				this.cooldowns.set(chipId, remaining - delta)
			}
		}
	}

	/** Cooldown restant estimé (0 = prête ou jamais vue utilisée). */
	getCooldown(chip: Chip): number {
		return this.cooldowns.get(chip.id) ?? 0
	}

	isChipReady(chip: Chip): boolean {
		return this.getCooldown(chip) === 0
	}
}
