// @version:5.8
// file version: 6

/**
 * Nombre de tours consécutifs sans progrès réel à partir duquel la sortie de stagnation s'applique.
 * 2 : un seul tour d'attente isolé (tour de boost, ennemi qui bouge) n'est pas une stagnation ; au deuxième tour
 * sans progrès, la situation est la même et la décision est déterministe, donc un troisième tour identique
 * n'apporterait rien. Perdre 2 tours d'un combat de 64 tours reste négligeable.
 * Combat 54940819 : 53 tours d'immobilité (T12 à T64) faute de cette règle.
 */
export const STAGNATION_TURNS = 2

/**
 * Compteur de tours consécutifs SANS PROGRÈS RÉEL. Mémorisé entre les tours par `Kassbi_Class.ts` (même mécanisme
 * que `enemyMemory`) et lu par le planificateur via `TacticalContext`.
 *
 * Définition : un tour est sans progrès s'il n'a ni infligé de dégâts (la somme des PV ennemis vivants n'a pas
 * baissé) ni établi un NOUVEAU RECORD de proximité, c'est-à-dire une distance de Manhattan à l'ennemi le plus proche
 * strictement inférieure au minimum atteint depuis le dernier dégât. Le record compte que ce soit moi qui avance ou
 * l'ennemi qui s'approche. Conséquences : rester immobile, ou osciller A → B → A → B (même entre 2 ou 3 cases), sans
 * jamais battre le record, est de la stagnation ; une approche normale bat le record à chaque tour ; un déplacement de
 * sortie de stagnation qui ne bat pas le record ne remet rien à zéro (le détour peut durer plusieurs tours).
 * Remise à zéro : dégâts infligés, nouveau record, ou tir RÉEL prévu par le planificateur normal (`noteOffense`) : une
 * offensive seulement « disponible » mais jamais jouée (danger trop élevé) ne remet RIEN à zéro.
 *
 * Garantie (combat 54940819, mesures du Testeur) : la sortie n'agit que si le plan normal est bloqué (ni tir ni
 * déplacement) ou si une sortie est déjà engagée (`commit`, `escaping`) ; sinon le plan normal est exécuté tel quel,
 * donc la règle ne retarde jamais un tir par rapport à la règle désactivée.
 *
 * Épisode : de la première sortie engagée jusqu'à un dégât, un record de proximité, un tir réel prévu ou un mouvement
 * des ennemis. Pendant tout l'épisode, les cases de départ (dont la case de stagnation d'origine) et d'arrivée des
 * sorties sont mémorisées : ni la sortie ni le plan normal ne peuvent s'y déplacer (anti-oscillation 187 → 133 → 187),
 * sauf un tir réel ou un record, qui terminent l'épisode. Limite acceptée : contre un ennemi qui alterne immobilité et
 * déplacement, la garantie « jamais plus lent » n'est pas démontrée (voir `docs/strategies.md`).
 *
 * Limite : la distance de Manhattan ignore les murs ; une route qui s'éloigne à vol d'oiseau n'est donc jamais un
 * « progrès » ici, ce qui est voulu (c'est précisément le minimum local à quitter par la distance de marche).
 */
export class StagnationTracker {
	private turnSeen = -1
	private enemyLifeSeen: number | null = null
	private record = Number.POSITIVE_INFINITY
	private count = 0
	private engaged = false
	/** Cases de départ et d'arrivée des sorties depuis le dernier dégât/record/tir : jamais re-choisies comme destination. */
	private readonly visitedCells = new Set<string>()
	private enemyKeySeen: string | null = null
	private pendingKey: string | undefined = undefined
	private stillTurns = 0

	/** Positions des ennemis vivants (clé), à fournir juste avant `observe` du même tour. */
	noteEnemyPositions(key: string): void { this.pendingKey = key }

	/** Tours consécutifs sans progrès réel, vus au début du tour courant. */
	get turns(): number { return this.count }

	/**
	 * Stagnation à traiter : au moins `STAGNATION_TURNS` tours sans progrès réel ET ennemis immobiles pendant tout ce
	 * temps. Un ennemi qui bouge (fuite, approche) rend un plan normal bloqué transitoire : la règle reste hors jeu,
	 * le plan normal est exécuté tel quel (contre un ennemi qui fuit, l'engagement dérivait la trajectoire).
	 */
	get active(): boolean { return this.count >= STAGNATION_TURNS && this.stillTurns >= STAGNATION_TURNS }

	/** Une sortie de stagnation est engagée : elle continue (distance de marche) jusqu'à levée ou interruption. */
	get escaping(): boolean { return this.engaged }

	/** Cette case a-t-elle déjà servi de départ ou d'arrivée à une sortie depuis la dernière remise à zéro ? */
	visited(cell: Cell): boolean { return this.visitedCells.has(`${cell.x},${cell.y}`) }

	/** Une distance de Manhattan à l'ennemi battrait-elle le record de proximité (ce qui terminerait l'épisode) ? */
	beatsRecord(enemyDistance: number): boolean { return enemyDistance < this.record }

	/**
	 * À appeler au début de MON tour, avant la planification (idempotent dans un même tour).
	 * `enemyLife` = somme des PV des ennemis vivants (une mort ou un coup la fait baisser) ;
	 * `enemyDistance` = distance de Manhattan de ma case à l'ennemi vivant le plus proche.
	 * Les positions ennemies (`noteEnemyPositions`, appelé juste avant) sont facultatives : sans elles, ennemis supposés immobiles.
	 */
	observe(turn: number, enemyLife: number, enemyDistance: number): void {
		if (turn === this.turnSeen) return
		const enemyKey = this.pendingKey
		this.pendingKey = undefined
		if (this.turnSeen >= 0) {
			const moved = enemyKey !== undefined && this.enemyKeySeen !== null && enemyKey !== this.enemyKeySeen
			if (moved) { this.stillTurns = 0; this.engaged = false; this.visitedCells.clear() } else this.stillTurns++
			const damaged = this.enemyLifeSeen !== null && enemyLife < this.enemyLifeSeen
			if (damaged || enemyDistance < this.record) {
				this.count = 0
				this.engaged = false
				this.visitedCells.clear()
				this.record = enemyDistance
			} else this.count++
		} else this.record = enemyDistance
		this.enemyKeySeen = enemyKey ?? null
		this.turnSeen = turn
		this.enemyLifeSeen = enemyLife
	}

	/** Le planificateur engage la sortie origin -> destination : elle continue tant qu'aucune levée ni interruption. */
	commit(origin?: Cell, destination?: Cell): void {
		this.engaged = true
		for (const cell of [origin, destination]) if (cell) this.visitedCells.add(`${cell.x},${cell.y}`)
	}

	/**
	 * Lève l'engagement (plus aucune case sûre plus proche par la marche) : le plan normal reprend la main. Le compteur
	 * et les cases visitées sont conservés : la sortie ne peut se ré-engager que si le plan normal est de nouveau bloqué,
	 * et jamais vers une case déjà visitée (pas d'oscillation A → B → A).
	 */
	release(): void { this.engaged = false }

	/** Un tir RÉEL est prévu ce tour par le planificateur normal : il garde la main, la sortie est désengagée. */
	noteOffense(): void { this.count = 0; this.engaged = false; this.visitedCells.clear() }
}
