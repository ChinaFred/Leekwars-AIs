// @version:5.8
// file version: 1

/**
 * UNE seule règle de danger de coffre (`Chest`, hors des ennemis : `Targets.ts`), ajoutée à la carte de danger
 * (`ThreatMap.ts`, option `extraDanger`, posée par `EnemyMemory.updateThreatMap`) : lue par le plan conjoint, le plan B et
 * `BookPlanner`. L'API ne donne pas les armes du coffre (le journal `[Chest]` n'en liste aucune) ; un coup de coffre tue d'un
 * coup (combats 55005891 et 55005881 : 396 PV d'un coup, force 1000, 20 PT). Danger FORFAITAIRE sur les cases à portée.
 *
 * Relevés (fight.json, 3 combats avec coffre ou ses coups) : le coffre a touché Kassbi à distance de Manhattan 2 (55005891, tour 2,
 * coffre déjà blessé par l'ennemi) et 7 (55005881, tour 5 : coffre intact à la décision du tour 4, blessé par l'ennemi juste
 * avant son coup) ; rien à distance 6 au tour 1 (55005891, intact) ni 11 (55005881, tour 4). Il n'a agi qu'après avoir perdu des PV ;
 * l'ennemi peut le réveiller à tout moment, donc la portée vaut aussi pour un coffre INTACT. Portée exacte inconnue (entre 7 et
 * 10) : 7 est la plus grande distance observée.
 */
/** Danger forfaitaire d'une case à portée d'un coffre : au moins mes PV max (voir `chestDangerOf`). */
export const CHEST_FLAT_DANGER = 1000
/** Portée de Manhattan retenue : la plus grande distance où un coffre a touché Kassbi. */
export const CHEST_REACH = 7

export interface ChestView { readonly life: number; readonly cell: Cell }

/** Danger forfaitaire de la case : celui d'un coffre vivant à `CHEST_REACH` au plus, sinon 0. Immobile : valable à tout tour simulé. */
export function chestDangerOf(chests: readonly ChestView[], myMaxLife: number): (cell: Cell) => number {
	const flat = Math.max(CHEST_FLAT_DANGER, 3 * myMaxLife)
	const live = chests.filter((chest) => chest.life > 0)
	return (cell) => {
		for (const chest of live) {
			if (Math.abs(chest.cell.x - cell.x) + Math.abs(chest.cell.y - cell.y) <= CHEST_REACH) return flat
		}
		return 0
	}
}
