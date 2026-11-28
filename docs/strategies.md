# Stratégies de combat de Kassbi

Stratégie **en vigueur**, sans historique. Le code fait foi ; les constantes citées sont suivies de leur fichier. Tout changement de seuil, de condition ou d'ordre de planification met ce fichier à jour (lignes concernées
seulement) et ajoute ou ajuste un test de régression. L'historique est dans [`ChangeLog.md`](../ChangeLog.md) et `git log`.

**Sommaire** — [Chaîne de décision](#chaîne-de-décision) · [Plan conjoint](#plan-conjoint-tacticalplannerts) : [score](#score-et-compromis-explicite),
[stagnation](#sortie-de-stagnation), [bornes et ops](#bornes-et-budget-dopérations) · [Plan B](#plan-b-reserveplants) · [Boosts](#boosts-srcbrainstrengthboostts) ·
[Seuils par stratégie](#seuils-par-stratégie-strategyts) · [Mémoire de l'adversaire](#mémoire-de-ladversaire) :
[cases atteignables](#cases-atteignables-reachablecellsts), [carte de danger](#carte-de-danger-threatmapts-shotplants-launchpatternts) · [Journalisation](#journalisation-toolboxloggerts-toolboxmarkerts) · [Limites connues](#limites-connues)

## Chaîne de décision

**Stratégie principale : le livre de combos** (`src/Main/Kassbi_Book.ts`, `turn()`). Le **plan conjoint** (`TacticalPlanner.ts`, plan B `ReservePlan.ts`, exécution `TacticalExecution.ts`) est le **repli gelé** du livre : il ne reçoit plus d'évolution et ne sert que si le livre ne rend pas de plan.

Un tour, dans l'ordre :

1. **Paroles** : salutation au tour 1 (`greetOnce`), puis récit du poireau avec les PT restants en fin de tour (`tellLeekLife`) ; 2 `say` au plus par tour (`TurnSpeech.ts`).
2. **Observer** (`observeTurn`, `src/Brain/TurnObservation.ts`) : mémoire de l'adversaire, coffres, cases atteignables, carte de danger, stagnation, historique. Chaque collecte est protégée : une erreur est journalisée (`ERROR`) sans interrompre le tour.
3. **Piège du coffre** (`springChestTrap`) : s'il s'applique, il remplace le plan.
4. **Livre** (`planWithBook`, `BookPlanner.ts`) avec `leekProfile` (`Kassbi_Book.ts` : `new LeekProfile(50)`, agressivité fixée à la construction, soin/bouclier/repli autorisés), l'objectif `OBJECTIVES.damage` (`BookObjective.ts`) et le compteur de duel `StandoffTracker`. Le tour 1 du meilleur enchaînement est exécuté par `executeTacticalPlan`.
5. **Repli** : sans plan du livre (données absentes, budget coupé, aucune action utile, erreur), `planAct` (`src/Brain/PlanActScenario.ts`) avec le même `leekProfile` :
   - **plan conjoint** (`TacticalPlanner.ts`) si les cartes du tour sont complètes ;
   - sinon **plan B** (`ReservePlan.ts`), séquentiel et borné ;
   - sans `Field.cellFromXY`, `Fight.weaponCells` ou `me.canUseChip` (API du jeu actuel) : aucune action, absence
     journalisée (`PLANNING`).
6. **Arme du tour 1** (`equipOpeningWeapon`) : si aucune arme n'est équipée et qu'il reste 1 PT, équiper la meilleure
   (dégâts moyens par PT, puis portée la plus longue). Puis mémorisation des PV de fin de tour.

Un plan est entièrement décidé et affiché (`PLANNING`) **avant** sa première action, tous les boosts compris (force, PT, agilité, PM) :
on observe, on compare, on planifie, on exécute ; aucune action n'est lancée ni décidée hors du plan. Exécution commencée, aucun second plan : un échec l'arrête.

**Coffres** (`Targets.ts`) : une entité `Chest` n'est ni ciblée ni comptée comme ennemi (danger, mémoire, plans) ; elle est suivie à part (`[Chest]`, contexte `MEMORY`). **Danger du coffre** (`ChestDanger.ts`, une seule règle, ajoutée par `EnemyMemory.updateThreatMap` à la carte de danger lue par le plan conjoint, le plan B et `BookPlanner`) : tout coffre vivant ajoute un danger forfaitaire `max(CHEST_FLAT_DANGER = 1000, 3 × mes PV max)` aux cases à distance de Manhattan ≤ `CHEST_REACH` = 7, coffre intact ou blessé (un coup tue : combats 55005891 et 55005881, 396 PV d'un coup, touché à 2 et à 7 cases ; l'ennemi le réveille en le blessant). Le coffre n'entre toujours ni dans `enemyCount` ni dans le détail `breakdown`. Le danger compte sur la case FINALE comme tout danger : tirer depuis une case à portée puis la quitter reste permis. Le coffre n'agit qu'à son tour : portée exacte inconnue (entre 7 et 10), arme inconnue de l'API ; heuristique non calibrée, qui peut interdire un disque de rayon 7 autour du coffre.
**Piège du coffre** (`springChestTrap`, `src/Brain/ChestTrap.ts`, entre l'observation et `planAct`) : si je peux frapper un coffre depuis ma case (arme équipée, puce à dégâts, ou autre arme au prix de 1 PT) et qu'un ennemi vivant en est **strictement** plus proche que moi (distance), je tire sur le coffre tant que PT et tirs le permettent (arme équipée, puces, autres armes), puis `moveAwayFrom` le **coffre** avec tous mes PM. Ce tour remplace le plan ; sans tir abouti, le plan normal joue. Ligne `[ChestTrap]` (`PLANNING`). Condition de distance en vol d'oiseau, sans trajet ni PM adverses : heuristique non calibrée. Interaction avec le danger du coffre : le piège fait foi quand il s'applique (il remplace le plan, ne lit pas la carte et fuit le coffre) ; sinon le plan lit le danger du coffre.

## Plan conjoint (`TacticalPlanner.ts`)

Compare en un seul score attaque, boost, protection et déplacement. Un plan = **une cible, une case de tir, au plus une arme**, plus des puces offensives, de protection et de boost ; l'option sans tir (progression, couvert, support) concourt aussi. Code : recherche dans `TacticalPlanner.ts`, types et bornes `TacticalTypes.ts`, score `TacticalScore.ts`, tour suivant `TacticalNextTurn.ts`, stagnation `TacticalStagnation.ts`, exécution `TacticalExecution.ts`.

**Conditions** : `ReachableCells` et `ThreatMap` du tour courant, non tronquées, danger connu, fini et ≥ 0 sur chaque case atteignable. Sinon le danger est **inconnu** (jamais remplacé par zéro) et on passe au plan B.

**Cases de tir** : listes natives `Fight.weaponCells` / `me.chipCells` (portée, motif dont le lancer en ligne, ligne de vue) ; pas d'appel natif si aucune case de ma zone n'est à portée de Manhattan de la cible. Arme et puce offensive sont créditées sur leurs cases atteignables (déplacement puis tir). Puce écartée si `me.canUseChip` la refuse alors que ma case est dans sa liste
(restriction inconnue) ; jamais tirée d'une case de sa zone d'effet si un effet peut toucher le lanceur (`selfHitRadius`).

**Ordre exécuté** : boost de PM (s'il est dans le plan ; un échec arrête le plan) → approche → boost (PT, force, agilité ; l'agilité est choisie par le score comme les autres) → protection → équipement → puces offensives → tirs → déplacement
final. Chaque action revérifie PV, PT, cooldown, `canUseWeapon` / `canUseChip` ; retour natif > 0 = tir fait. Avant chaque tir d'un laser, la ligne réelle est relue (entités à jour, `laserRefusal`) : un coffre, ou un allié absent de `laserAllies`, annule le tir (`weapon shot cancelled`, `PLANNING`). Une puce offensive au cooldown de base nul (`Chip.cooldown`, `chipUsesOf`) est planifiée et relancée tant que `maxUses` et les PT le permettent ; sinon 1 fois.
Une puce refusée à l'arrivée est journalisée (`chip unavailable`) et sautée : le reste du plan continue, ses PT ne sont pas replanifiés.

### Score et compromis explicite

| Terme | Définition |
|---|---|
| `U` | dégâts utiles = `min(PV cible, Σ dégâts moyens)` après boucliers relatif et absolu de la cible |
| `D` | danger brut de la case finale (carte de danger) |
| `H` | soin crédité = `min(PV manquants, Σ soin moyen × (1 + sagesse/100))` |
| `C` | crédit d'armure = `min(D, A + D × R/100)` (`A` bouclier absolu, `R` relatif plafonné à 100) |
| `w` | poids du risque (`riskWeight`, commun au plan B) = 0,5 × `(1,5 − agressivité/100)` ; × `RETREAT_RISK_FACTOR` (2) sous le seuil de repli |
| `p` | facteur de passivité (`riskFactor`, `StagnationTracker.ts`), de 1 à 0, (plancher 0) : voir « Passivité » |
| `a` | poids d'approche = 1,25 × `(0,5 + agressivité/100)`, borné à [0,5 ; 1/`NEXT_TURN_WEIGHT`] : `a` × `NEXT_TURN_WEIGHT` ≤ 1, des dégâts remis au tour suivant ne valent jamais plus que ceux de ce tour |
| `G` | progrès sans tir = distance gagnée vers la cible (Manhattan, ou trajet futur) ; le journal garde la distance brute |
| `F` | crédit des tours suivants d'un boost (voir « Boosts ») ; 0 sans boost |
| `N` | valeur de la case finale au tour suivant = `a` × `NEXT_TURN_WEIGHT` (0,75) × `min(PV cible − U_max, dégâts moyens possibles au tour suivant depuis cette case)`, `U_max` = plus grand `U` qu'un plan quelconque peut infliger ce tour ; voir « Anticipation » |

- **Laser d'arme** (`area` = 2, `LaserLine.ts`, `LaserShot.ts`) : la ligne tirée de la case de tir vers la cible (distance de Manhattan de `minRange` à `maxRange`, arrêt à un obstacle si l'arme exige la ligne de vue) touche tout ce qu'elle porte, devant ou derrière la cible. Les touches collatérales s'ajoutent au score du plan (cible, case de tir et au plus une arme inchangées) : `+ Σ min(PV, tirs × dégâts nets)` sur chaque AUTRE ennemi, `− Σ min(PV, tirs × dégâts nets)` sur chaque allié ou invocation (un allié tué compte pour tous ses PV), boucliers et force boostée comptés ; `U` et le test de meurtre ne portent que sur la cible. Un **coffre** sur la ligne écarte l'option (le blesser le réveille), sauf `ChestTrap` qui le vise. La visée est optimisée par le choix de la cible principale (`useWeapon` ne vise qu'une entité) ; viser un allié ou une case vide n'est pas envisagé. Un tir à bilan net ≤ 0 ne remplace jamais un recul sans dégâts. Les alliés acceptés sont notés dans le plan (`laserAllies`) : voir « Ordre exécuté ».
- **Offensif** : `U − R_c + w × H + F + N`. **Sans attaque** : `a × G − R_c + w × H + F + N`.
- **Recul sans tir** (plan sans dégâts, tir absorbé compris, dont `G` < 0 et la distance Manhattan augmentent, vers une case moins dangereuse que la mienne, sans protection utile : soin crédité > 0 ou crédit de bouclier > 0 sur la case finale) : classé comme les autres pendant la recherche ; à la fin d'une recherche **complète**, s'il est en tête, il cède au meilleur plan qui **inflige des dégâts** (`U` > 0) avec un danger exposé < `PASSIVE_DANGER_LIFE_FRACTION` × (PV + `H`) — marge sans objet si ce plan tue le dernier ennemi (`KILL_MARGIN`) —, même si un plan sans dégâts est mieux classé que lui ; ligne `retreat without damage refused` (`PLANNING`). Sans un tel plan il cède alors au meilleur plan sans attaque qui avance (`G` > 0) ou agit sur place (`G` = 0 avec soin, bouclier utile ou boost crédité) sous la même marge de danger, même si aucune attaque n'est possible ce tour (phase d'approche) ; ligne `aggressive posture: retreat without damage refused` ; ni pas de côté ni autre recul, et pas vers une case visitée par une sortie de stagnation. Le refus ne rend jamais un plan nul, vide ou létal. Filtre inactif : recherche interrompue (candidat borné inchangé), seuil de repli, tour condamné, plusieurs ennemis (`G` ne mesure que le premier), plan B. Non concernés : recul après des dégâts, pas en arrière à danger égal ou supérieur (il ne vaut que par `N`), sortie de stagnation. Un ennemi plus lent que moi ne l'autorise pas.
- **Coût de risque** `R_c = w × p × (D − C)`, plus `LETHAL_PENALTY` (1000) et le dépassement si `D − C ≥ m × (PV + H)` :
  la survie prime sur les dégâts (à ce seuil `N` = 0). `m` = 1, ou `PASSIVE_DANGER_LIFE_FRACTION` (0,75) dès que `p < 1`.
- **`R_c = 0`** si le plan tue le **dernier** ennemi vivant avec une marge `KILL_MARGIN` (1,1 × ses PV) ; alors `N` = 0.
- **Tour condamné** (`doomed`) : si le seuil de `LETHAL_PENALTY` est atteint sur la case de moindre danger avec **chaque** protection candidate (donc pour tout plan) : une cible tuée (dégâts moyens ≥ ses PV) passe avant le score, et `F` = 0 avec ou sans tir (un boost ne vaut que par les dégâts de ce tour). Soin, protection et case finale gardent le score ; ligne `doomed turn` (`PLANNING`). Si une protection ramène une case sous le seuil : règle normale.
- Égalités : danger brut inférieur, PT dépensés inférieurs, distance de tir futur inférieure, PM inférieurs.

À agressivité 50 `w = 0,5` et `a = 1,25`. Le score échange des dégâts moyens de ce tour et la valeur de la position au suivant contre une menace potentielle au tour ennemi : ni probabilité de survie ni minimax.

**Passivité** (contre le refus de combat) : `p = 1 − 0,5 × (tours passifs − 2)`, soit 1 jusqu'à 2 tours passifs, 0,5 au 3e, puis 0 au 4e (`PASSIVE_TURNS_AT_FULL_RISK`, `PASSIVE_RISK_STEP`). Un tour est **actif** si une de mes actions a fait perdre des PV à sa cible, mesurés autour de l'appel natif (`StagnationTracker.ts`), quel que soit le soin adverse ; tir raté ou absorbé (0 PV), dégât d'allié ou de poison : tour passif. Un tour qui bat la plus petite distance à l'ennemi depuis la dernière mort d'un ennemi (approche) gèle le compteur.
Dès que le compteur réduit le poids (3e tour passif), `m` garde le danger accepté sous 75 % de mes PV (critiques × 1,3 non modélisés) ; `w × H` n'est pas réduit. Le plan B n'applique pas `p`.
**Ennemi blessé** (`woundedRiskFactor`, `TacticalScore.ts`) : si la cible de progression (`enemies[0]`) a moins de 30 % de ses PV max (`WOUNDED_ENEMY_LIFE_FRACTION`), `p` vaut 0 (`WOUNDED_RISK_FACTOR`, le plus petit des deux facteurs s'applique) et `m` garde 75 % de mes PV : Kassbi poursuit au lieu de tenir une case sans danger (54995131, tour 5 : 98/318 PV, 10 PT et 5 PM perdus). 30 % et 0 non mesurés.

**Comportement configuré** (seuils de « Agressivité », repli gelé, `vie` et distance à l'ennemi vivant le plus proche prises au début du tour, depuis ma case) : une puce de **soin** n'est candidate que si le profil l'autorise et que le seuil « Soin » ou « Soin si menace » est atteint ; un **bouclier**, que si le seuil « Bouclier » l'est ; sous le seuil de **repli** (profil autorisant le repli), `w` double : le danger de la case finale pèse deux fois plus, donc le plan préfère une case sûre et un recul après tir, et le recul sans tir est admis (voir « Score »). `RETREAT_RISK_FACTOR` est heuristique, non calibré.
**Posture** (`posture`, `TacticalScore.ts`, seul endroit où le comportement règle le plan conjoint en dehors des seuils) : `w` × 0,5, `a` × 1,25, plancher de `p` 0, recul sans tir en tête cédant à un plan à dégâts puis à une avance, arme visée par le trajet futur = meilleurs dégâts moyens sur un tour (tirs permis par PT et `maxUses`, 1 PT si hors main). Valeurs heuristiques (anciennement `AGGRESSIVE`), non calibrées en combat.

**Anticipation** (un seul ennemi, sinon `N` = 0). **`N`** (`nextTurn` dans le journal du plan) valorise la **position** finale, jamais des dégâts non infligés : il ne dépend que de la case finale et de l'arme en main à la fin du plan.
`U_max` étant une constante du tour, renoncer à un tir coûte ses dégâts pleins, et si un plan peut prendre tous les PV de la cible ce tour `N` = 0 partout (classement identique à celui sans `N`). Cible supposée **immobile** ; un item est utilisable depuis une case
si une case de sa liste native de tir est à au plus mes PM de marche (cases libres). Items : armes dont la liste a déjà été obtenue ce tour, puces offensives créditées ce tour (même règle que la recherche : voir « Cases de tir ») de cooldown de base 0 ou 1 ; aucun appel natif de plus.
Dégâts : maximum exact (sac à dos des puces, une arme au plus, 1 PT si elle n'est pas en main à la fin du plan), PT et force du début de ce tour moins les boosts qui expirent, sans les boosts du plan (leur gain futur est `F`).
Après un tir, la case finale maximise `N` − coût de risque parmi les cases atteignables avec les PM restants (sans `N` : la case de moindre danger). Allocation : 5 % des opérations (`NEXT_TURN_FRACTION`) ; dépassée, `N` = 0 pour **toutes** les cases, ligne `PLANNING`. Le plan B n'a pas `N`.
La distance à une case de tir ne départage que les égalités. **Trajet futur sans tir** : si aucun tir d'arme n'est possible ce tour, un BFS (160 cases, 8 pas, 8 lignes de vue, 2 % des opérations) cherche une case de tir de l'arme visée (voir « Posture ») et remplace `G` Manhattan par la distance de trajet.

### Sortie de stagnation

Fichiers : `StagnationTracker.ts`, `TacticalStagnation.ts`. Évite de rester bloqué derrière un mur (minimum local de Manhattan).

- **Tour sans progrès** : ni dégâts infligés, ni nouveau record de proximité à l'ennemi le plus proche. Rester immobile ou osciller compte de la même façon.
- **Déclenchement** : `STAGNATION_TURNS` = 2 tours sans progrès, ennemis **immobiles** sur ces tours, et plan normal
  **bloqué** (ni tir, ni déplacement, ni protection) ou sortie déjà engagée.
- **Destination** : case atteignable dont la distance de **marche** vers une zone de tir est strictement plus courte
  (BFS inverse, 613 cases au plus), même si Manhattan augmente, avec un danger ≤ celui de la case
  actuelle ; à `p = 0`, toute case de danger inférieur à 75 % de mes PV. Sinon maintien, motivé dans le journal.
- **Plafond d'opérations du BFS** (`OPS_BUDGET`, `Toolbox/Budgets.ts`) : 4 % par tour bloqué (le premier tour où la sortie
  agit compte 1), multiplié par ce nombre, au plus 30 %, jamais au-delà de 80 % du total. Avant : 2 % fixes, atteints à
  chaque tour (combat 54994953, zone de tir à 25 cases : 61 tours immobiles). Coût réel du BFS non mesuré.
- **Repli** si le BFS s'arrête sur ce plafond : avancer vers la case atteignable la plus proche de la cible (Manhattan,
  mêmes règles de danger et de cases visitées). Le maintien « safety first » n'est annoncé que si un danger écarte une case plus proche.
- **Fin d'épisode** : dégât, record de proximité, tir réel prévu ou ennemi qui bouge. Les cases visitées pendant
  l'épisode ne sont pas revisitées pour progresser ; une retraite vers un danger strictement inférieur reste permise.
- **Limites acceptées** : contre un ennemi qui alterne immobilité et fuite, le premier tir peut être retardé ; le plan B n'a pas la mémoire des cases visitées. Deux tests de caractérisation figent ces cas
  (`tests/stagnation-escape-fight-54940819.test.mjs`).

### Bornes et budget d'opérations

| Borne | Valeur | Fichier |
|---|---|---|
| `TACTICAL_LIMITS` | 113 cases, 4 ennemis, 4 armes, 8 puces offensives, 3 protections, 30 PT, 100 000 unités de travail | `TacticalTypes.ts` |
| Arrêt de la recherche (relatif) | 60 % des opérations du tour depuis son entrée (`OPS_BUDGET.TACTICAL_SEARCH`, avant : 30 %) | `TacticalTypes.ts` |
| Arrêt de la recherche (global) | 80 % du total, partagé avec le plan B et la carte de danger (`SEARCH_GLOBAL_FRACTION`) | `ExecutionBudget.ts` |
| Garde d'exécution | continuer si `max − ops > 3 % × max + 2 × plus gros segment observé` (`TAIL_FRACTION`) | `ExecutionBudget.ts` |

Au-delà d'une borne (par exemple plus de 113 cases atteignables, soit dès 8 PM en terrain ouvert) : repli explicite sur le plan B. Une recherche interrompue garde le meilleur candidat **complet** connu, jamais une moitié de plan.
Les 80 % ne limitent pas l'exécution : un plan retenu s'exécute tant que le garde d'exécution le permet.
La seconde recherche du boost de PM a son propre `Budget` (mêmes bornes, 60 % depuis son entrée, 80 % global, 113 cases) et n'est lancée que sur un candidat. Coût mesuré en ticks de recherche (pas en opérations moteur) sur les mondes de test : 123 → 624 ticks (25 → 61 cases) et 275 → 1 047 (61 → 113 cases), soit 4 à 5 × la recherche sans boost ; opérations réelles non mesurées (le journal `[Boost] MP:` donne ticks et opérations en combat).

**Livre** (stratégie principale, voir « Chaîne de décision ») : `Main/Kassbi_Book.ts` joue le tour par faisceau (5 enchaînements, jusqu'à 3 tours) sur une table de combos (`CombatBook.ts`, `BookBeam.ts`, `BookPlanner.ts`) ; aux tours simulés 2 et 3 l'ennemi avance vers moi de ses PM, sauf posture `defensive` (`moverByStance`, `retreatFromMe` : il recule, sans soin ni armure simulés ; hypothèse non vérifiée) ; repli gelé sur `planAct`. Repli après tir cherché par groupe d'actions classé sur son potentiel (danger final nul), pas sur son score « sur place ». Laser d'arme : le faisceau ne simule pas la ligne ; le plan retenu est écarté (repli `planAct`) si la ligne touche un coffre ou si les alliés touchés coûtent plus que les ennemis ne rapportent, sinon il note `laserAllies` (visée non optimisée, tours simulés suivants non vérifiés). Niveau 2 seulement en duel (`BookStandoff.ts` : ≥ 6 tours, mes PV stables, dégâts infligés ≥ 15 % des PV max adverses mais baisse nette < 15 %) ou si un plan non létal inflige plus ; en duel limite létale × (1 + 0,25 par tour au-delà de la fenêtre, 2,0 au plus), jamais à 2 × mes PV ni sous 50 % de PV, poids du danger réduit, budget du faisceau 0,70 du total depuis sa création (duel compris ; avant 0,25 / 0,30), toujours borné par le plafond global 0,80; 3e tour (niveau 3) tenté tant que le livre a consommé moins de `BOOK_DEEPEN_FRACTION` = 0,30 du total (avant 0,08 = 160 000 ops, jamais atteint : le niveau 2 seul coûte 400-540 k ops, combat 55028419 tour 8, `profile aggression 50: depth 3` absent des 77 combats archivés ; pic attendu 60-70 % sur les gros tours, non mesuré) ; niveau suivant ouvert pour autant de nœuds que `reste ops / (coût mesuré d'un nœud × NODE_COST_MARGIN)` le permet, `NODE_COST_MARGIN` = 1,2 (avant 2 : combat 55027536, tours 5 et 6, 3 nœuds sur 5 ouverts à 44 % / 41 % des ops ; un nœud du niveau 2 coûte ≈ la moitié du niveau 1 mesuré ; un niveau coupé en cours est abandonné) ; la coupure journalise `operations reserve (book fraction)` ou `(global cap)`. Politique, non mesurée en combat. Les seuils du plan conjoint ci-dessus ne s'appliquent qu'au repli. Boost de force posé sans tir (cible lointaine) : crédit `IDLE_BOOST_SHOT_WEIGHT` = 0,75 × (durée − tour du premier tir) × gain de dégâts du boost, seulement si aucun tour suivant n'est simulé ; durées relevées dans fight.json : protein 2 tours, motivation 3 (le tour du lancer compte pour 1, effet retiré au début de mon tour suivant). Fuite sans tir au tour 1 (`penalizeFleeNoShot`, `BookBeam.ts`) : une étape à 0 dégât, en recul, sans soin ni bouclier perd `FLEE_NO_SHOT_WEIGHT` = 1,0 × les dégâts de la meilleure étape non létale du tour qui tire (une fois, niveau 1 seulement ; aucune pénalité si tout tir est létal). Combat 55028419 tour 8 : recul + protein 158,4 contre tir 77,2, avec la règle 64,5 ; non calibré, effet en combat non mesuré.

## Plan B (`ReservePlan.ts`)

Heuristique séquentielle, utilisée quand le plan conjoint est indisponible ou interrompu. **Pas un optimum.**

1. Bornes `RESERVE_LIMITS` : 4 ennemis, 4 armes (équipée d'abord), 8 puces, BFS de 500 cases, liste native de
   613 cases. Recherche limitée à **3 %** des opérations depuis son entrée et aux 80 % globaux.
2. Attaque : **coût d'approche minimal** ; à coût égal, maximiser `min(PV cible, dégâts × tirs) − w × danger`.
   Un seul item offensif ; une puce offensive seulement si elle est utilisable depuis la case actuelle (relancée tant que les PT le permettent si son cooldown de base est nul).
   Boost décidé ensuite, avant l'exécution, annoncé dans le plan et lancé avant l'attaque (voir « Boosts »).
3. Sans attaque : progression ou couvert si `G − w × danger` bat le score de rester ; danger inconnu → seul un
   progrès strictement positif.
4. Supports (soin, bouclier) avec les PT restants, aux seuils du tableau ci-dessous.
5. Repli final vers une case de danger connu strictement inférieur ; sans carte valide, `moveAwayFrom` l'ennemi le plus proche.

Laser d'arme : le tir est écarté si la ligne touche un coffre ou si `dégâts sur la cible + touches collatérales` ≤ 0 (alliés touchés plus qu'il ne rapporte) ; sinon ses dégâts valent ce total pour le classement ; même revérification avant tir que le plan conjoint. Pas d'optimisation de la visée en plan B.

Passé 80 % d'opérations au départ, le plan B tourne en mode dégradé (8 premières cases natives, pas de progression).

## Boosts (`src/Brain/StrengthBoost.ts`)

Une puce est un boost de force (`BUFF_STRENGTH`, ou effet 38), de PT (`BUFF_TP`, 32) ou de PM (`BUFF_MP`, 31) : au plus une
par type et par tour (le plus grand gain), jamais tant que l'effet est actif. Force, PT et agilité : **composantes du plan**, PT d'abord, agilité en dernier.

- **Plan conjoint** : 8 variantes au plus (aucun, PT, force, les deux, chacun avec ou sans agilité ; une seule sans boost prêt). PT du plan = PT − coûts + PT gagnés
  (partie entière du gain moyen) ; dégâts calculés avec la force boostée : le gain de ce tour est dans `U`.
  `F` = `FUTURE_TURN_WEIGHT` (0,75) × (durée − 1) tours pleins de l'arme du plan (force : gain % des dégâts de base ;
  PT : tirs entiers en plus), plafonné par 0,75 × les PV restants de la cible : un boost ne bat jamais le coup fatal.
- **Plan avec tir** : pas de boost sous 50 % de PV (`MIN_LIFE_RATIO_FOR_BOOST`). **Plan sans tir** : boost seulement si `F > 0` (durée ≥ 2) et si l'ennemi le plus proche est à portée max de mes armes + 2 × mes PM + ses PM.
  Sans tir seulement (PT sinon perdus ; combat 54991104), `F` de PT = le meilleur de trois scénarios de portée en maximum exact (`planShots`) : arme, puces offensives prêtes de cooldown de base 0 ou 1, arme + puces. Crédit optimiste assumé.
- **Plan B** : avec un tir d'arme, gain net du modèle à une arme (`boostNetDamage`, `tpBoostNetDamage`) > 0 et PV ≥ 50 % ;
  les tirs prévus sont réduits d'autant. Sinon, règle « sans tir » avec les PT que ni l'attaque ni les supports n'emploient.
- **Agilité** (`BoostVariant.agility`, `pickAgilityBoost` ; `BUFF_AGILITY` ou effet 41, dont Étirement) : variante du plan conjoint, **choisie ou refusée par le score** face aux tirs, soins et boucliers qui se disputent les PT. Variante possible si sans effet d'agilité actif, gain ≥ 1, `canUseChip` sur moi (erreur native = non utilisable), coût ≤ PT − coûts des autres boosts **sans compter les PT gagnés** (`tpGain` = 0 : un boost de PT qui donnerait moins que prévu ne coûte jamais un tir). Gain = `agilityCritGain` = 0,3 × agilité / 1000 de dégâts moyens (plafonné à 100 % de critique) : ce tour `U` × gain (nul si le tir tue la cible) + `F` = 0,75 × (durée − 1) tours de tirs entiers de l'arme du plan × gain, dans le même plafond que les autres boosts (0 si tour condamné). Sans tir : même règle que les autres boosts (`idleBoosts`, ennemi à portée, `F` > 0 donc durée ≥ 2). Sous 50 % de PV : seule variante de boost permise (ses PT ne servent à rien d'autre ; le score tranche). Tour 1 sans arme équipée et plan sans arme : 1 PT gardé pour `equipOpeningWeapon`. Lancé après PT et force, avant protection et tirs ; jamais en plan B.
- **Boost de PM** (`TacticalPlan.mpBoost`, `decideMpBoost`, `decideFleeMpBoost`, `TurnObservation.mpBoostCandidate` ; gain = partie entière ≥ 1) : **composante du plan**, première action exécutée. Rien n'est lancé avant la recherche. Après la recherche sans boost (inchangée), le planificateur demande un candidat à l'observation (lecture seule, aucune dépense) :
  - `unlock` (`decideMpBoost`) si : puce prête et utilisable sur moi ; PV ≥ 50 % ; cases du tour non tronquées, sans case de tir native d'une arme ou puce offensive prête payable ; zone à PM + gain non tronquée, ≤ 113 cases, avec une case de tir d'une arme payable après le boost (+ 1 PT si non équipée) ; opérations < 80 % ;
  - sinon `flee` (`decideFleeMpBoost`) si le meilleur plan sans boost a un danger ≥ mes PV : mêmes gardes (puce, cartes, 113 cases, opérations), sans condition de tir ni de PV.
  Le candidat porte la zone à PM + gain et SA carte de danger (`EnemyMemory.threatMapFor`, entrées ennemies de la carte du tour, ligne de vue partagée). **Seconde recherche** complète (`evaluate` avec `Frame` : PM + gain, PT − coût, zone et danger boostés ; listes natives d'armes et de puces réutilisées, jamais refaites ; aucun effet de bord sur la stagnation ; prochain tour à PM + gain si durée ≥ 2). Le plan boosté (`tpUsed` + coût) remplace le plan sans boost seulement s'il le **bat strictement au même score** : le danger des cases débloquées y compte (coût de risque, létalité), la fuite aussi. Référence : le score du plan sans boost, sinon celui du meilleur plan classé sans action (rester sur place). Tour condamné : tuer d'abord. Plan boosté avec tir refusé sous 50 % de PV ; erreur, limite ou absence de plan de la seconde recherche : plan sans boost gardé. Ligne `[Boost] MP:` (`PLANNING`) : scores, dangers, motif, ticks de la seconde recherche (et opérations si `System`). Exécution : lancer du boost, puis approche avec les PM réels ; refus natif ou PM non gagnés = **arrêt du plan** (rien d'autre n'est tenté).
  Un plan boosté qui reste sur place (boost seul) est possible : il vaut par `N` à PM + gain.

## Agressivité (`LeekProfile`, `BookObjective.ts`, `TacticalScore.ts`)

`LeekProfile(agressivité)` fixe l'agressivité (0–100, immuable ; `Kassbi_Book.ts` : 50). Les comportements permis (`allowHealing`, `allowShielding`, `allowHiding`, tous vrais) sont à revoir.

**Livre** : l'agressivité choisit le scénario retenu par le score (`objectiveFor`, interpolation linéaire des poids du `TurnOutcome`, 50 = `OBJECTIVES.damage`). Soin et bouclier ne sont plus filtrés par des seuils : permis si le profil l'autorise (soin seulement s'il manque des PV), le score tranche. La pénalité létale ne dépend pas de l'agressivité. Poids non calibrés :

| Poids | 0 (prudent) | 50 | 100 (ardent) |
|---|---|---|---|
| dégâts | 0,8 | 1 | 1,2 |
| soin | 1 | 0,5 | 0,1 |
| bouclier | 0,4 | 0 | 0 |
| danger exposé | 1,2 | 0,5 | 0,2 |
| progrès sans tir | 0,4 | 1,25 | 2,5 |
| prime de mise à mort | 0,3 | 0,5 | 0,7 |

**Repli gelé** (plan conjoint, plan B ; fonctions de `TacticalScore.ts`, `vie` = PV / PV max, `d` = distance à la cible, `a` = agressivité / 100, valeur à 0,5 entre parenthèses) :

| Décision | Seuil |
|---|---|
| Soin (`shouldHeal`) | `vie ≤ 0,40 − 0,15a` (0,325) |
| Soin si menace (`d ≤ 10`) | `vie ≤ 0,50` |
| Bouclier | `d ≤ portée de menace` et `vie ≤ 0,45 − 0,15a` (0,375) |
| Repli (trop près et blessé) | `vie ≤ 0,30 − 0,15a` (0,225) |
| Repli préventif | `d ≤ 1` et `vie ≤ 0,50`, ou `d ≤ 10` et `vie ≤ 0,25` |

- « Trop près » : `d < 2` (`MIN_SAFE_DISTANCE`). Portée de menace : PM de l'ennemi + portée max de son arme.

## Mémoire de l'adversaire

Fichiers : `EnemyMemory.ts`, `EnemyProfile.ts`. Mise à jour au début de chaque tour ; seules les **cartes** du tour sont transmises à `planAct`.

- **Par ennemi** : caractéristiques, armes et puces connues ou observées, arme équipée, PT et PM maximaux vus,
  cooldowns suivis, journal des coups (`MAX_HIT_LOG` = 20).
- **Cooldowns** : posés à l'usage détecté (effets lancés), −1 par tour ; cooldown infini = `INFINITE_COOLDOWN` (66). La détection ayant lieu à mon tour, un cooldown peut être surestimé d'environ 1 tour.
- **Attribution des coups** : heuristique. La perte de PV non expliquée par un effet est attribuée à un item
  seulement si un seul candidat est compatible (plage de dégâts avec force, critique `CRITICAL_FACTOR` = 1,3) ;
  sinon « ambiguous ». Une inférence ne pose ni item observé ni cooldown.
- **Historique des tours adverses** (`EnemyBehavior.ts`, `EnemyProfile.turnLog`, `MAX_TURN_LOG` = 8) : fin de mon tour = case et PV de chaque ennemi (`endMyTurn`) ; début du suivant = un enregistrement : fuite (distance à MA case de fin de tour ≥ +1) ou approche (≤ −1), frappe (dégâts attribuables hors effet en cours, ou item à dégâts détecté), soin (PV regagnés ou item de soin), armure (item de bouclier).
- **Posture** (`EnemyMemory.stanceOf`, `assessStance`, ligne `[EnemyMemory] … stance`, `MEMORY`) : sur `STANCE_WINDOW` = 5 tours, défensifs (fuite + soin + armure) contre agressifs (frappe + approche), un point par type et par tour ; `defensive`/`aggressive` si écart / total ≥ `STANCE_MARGIN` = 0,34, sinon `mixed` ; `unknown` sous `MIN_TURNS_FOR_STANCE` = 2 tours ou sans point. **Donnée seule : aucune décision n'en dépend.**

### Cases atteignables (`ReachableCells.ts`)

Parcours en largeur en 4-connexité depuis la case de l'entité, borné par ses PM ; obstacles et autres entités
bloquent. Plafond `MAX_REACHABLE_CELLS` = 500 (au-delà, `truncated`). Mes PM sont ceux du tour ; ceux d'un autre
poireau sont le maximum observé. C'est une photographie du début de mon tour.

### Carte de danger (`ThreatMap.ts`, `ShotPlan.ts`, `LaunchPattern.ts`)

Pour chaque case que je peux atteindre : somme, sur les ennemis, de leurs meilleurs dégâts potentiels au prochain tour. S'y ajoute, sur les cases à portée d'un coffre vivant, le danger forfaitaire du coffre (`ChestDanger.ts`, option `extraDanger`).

- **Armes** : l'arme équipée et les autres armes connues, au prix de 1 PT de changement (`WEAPON_SWAP_TP`) ;
  une arme par plan, 4 au plus par ennemi (`MAX_THREAT_WEAPONS`).
- **Dégâts** : moyenne des effets `DAMAGE` × (1 + force/100) ; tirs = `floor(PT / coût)` plafonné par `maxUses`.
  Valeur brute : sans critique, ni mes boucliers, ni ma résistance.
- **Puces** : offensives, prêtes selon la mémoire ; cooldown de base nul : autant de fois que PT et `maxUses` le permettent, sinon une fois. Maximum exact des dégâts arme + puces dans les PT (`planShots`) ; le plan « puces seules » (sans PT de changement d'arme) concourt toujours.
- **Boosts adverses** : jusqu'à 3 puces de force ou de PT (`MAX_THREAT_BOOSTS`) lancées avant de tirer.
- **Portée** : l'ennemi se déplace (PM maximaux vus) puis tire ; distance, motif de lancer, puis ligne de vue si
  l'item l'exige. La valeur d'une case est le maximum sur ses cases de tir.
- **Garde-fous** : `MAX_THREAT_PAIRS` = 16 000 paires (case de tir, ma case) et arrêt à 80 % des opérations ;
  au-delà, `truncated` : les cases non évaluées sont absentes, jamais présentées comme sûres.

Les tests vérifient les écarts **documentés** de la carte, jamais exacte à 100 % : au plus `MAX_THREAT_WEAPONS`
armes, sélection bornée des boosts, élagage des configurations dominées (`tests/threat-map-equivalence.test.mjs`).

## Journalisation (`Toolbox/Logger.ts`, `Toolbox/Marker.ts`)

Toute sortie passe par `log(texte, contexte)` ; `Logger.ts` est le seul fichier qui écrit dans le log de combat,
`Marker.ts` le seul qui marque le terrain ou met en pause. Tous les contextes sont actifs par défaut (`LogConfig`), sauf `ACCESSIBLE_ZONE`, `DANGER_ZONE` et `TARGET_ZONE`, coupés dans `leekLogConfig` (`Kassbi_Book.ts`) : la zone visée coûte 290k à 690k ops par tour ; les réactiver pour une mise au point :
`leekLogConfig.setEnabled(LOG_CONTEXT.DANGER_ZONE, true)`. Un texte paresseux (`() => string`) n'est évalué que si son contexte est actif.

Contextes utiles à l'analyse : `PLANNING` (plan avant exécution, replis `[Tactical]`, `[Reserve]`), `THREAT`,
`REACHABLE`, `MEMORY`, `CHIP` (`[Boost]`), `OPERATIONS` (ligne `Operations:` de fin de tour), `ERROR` (en rouge).
Recherche coupée ou écartée par un plafond : une ligne rouge `SEARCH CUT [<origine>] cause=<…> ops=<n>/<max> …` (`logSearchCut`), au point où le plafond est décidé, une fois par coupure (borne testée en boucle : à la sortie). Bornes de volume : `cause=<quoi> bound (<valeur> > <borne>)` puis `repli=<qui reprend>`. Origines et causes : `livre` (`BookBeam.ts` : `work limit`, `operations reserve (global cap|book fraction)`, `deepen fraction`, `remaining ops < node cost`, `beam nodes bound` ; `BookPlanner.ts` : `enemies bound`, `truncated data`), `tactique`, `boost PM` (seconde recherche) et `tour suivant` (`Budget`, `TacticalTypes.ts` : `search bound`, `operations reserve (global cap|search fraction)` ; `TacticalPlanner.ts`/`TacticalScore.ts` : `cells`, `PT`, `enemies`, `weapons`, `attack chips`, `protections`, `native cells` `bound`, `truncated data (zone atteignable|carte de danger|données de la carte de danger)`), `boost PM` aussi pour `cells bound` de la zone boostée (`StrengthBoost.ts`), `carte de danger` et `zone visée` (`ThreatMap.ts` : `pairs cap`, `operations ceiling`, `threat weapons bound` (`MAX_THREAT_WEAPONS`), `threat boosts bound` (`MAX_THREAT_BOOSTS`)), `stagnation` (`walking route allowance`, `walking route cells bound` à 613 cases, `native cells bound`), `plan B` (`ReservePlan.ts` : `search margin reached`, `operations reserve (global cap)`, `hard operations reserve`, `candidate bound`, `native cells bound`). Non couvert : portée infinie de `buildTargetZone` (entrée non gérée, `TRUNCATED` seul), coupure de la zone atteignable à 481 cases (vue par `truncated data`), bornes BFS du plan B (500 cases), largeur et profondeur du faisceau (`BEAM_WIDTH`, `BEAM_DEPTH`, `REFINE_KEEP` : tri, pas des plafonds).
`ACCESSIBLE_ZONE`, `DANGER_ZONE` et `TARGET_ZONE` affichent les zones sur le terrain avec une pause : coupés par défaut en combat. `TARGET_ZONE` (zone visée : toutes les cases qu'un ennemi peut toucher, atteignables par moi ou non, mêmes marques que `DANGER_ZONE`) est le seul qui calcule, avant le plan et seulement s'il est actif (`buildTargetZone`, `ThreatMap.ts`) : mêmes dégâts par case que la carte de danger, par recherche bornée (case de tir la plus proche, puis alignées, diagonales, autres à portée utile ; arrêt à la borne des items à portée ; à dégâts égaux la case de tir peut différer) ; au plus `MAX_TARGET_ZONE_PAIRS` = 16 000 paires et arrêt à 50 % des opérations du tour (`TARGET_ZONE_OPERATIONS_FRACTION`), au-delà `TRUNCATED` avec cases évaluées/candidates dans le log (cases proches de moi gardées) ; le log donne paires, lignes de vue et opérations, pris sur le budget du plan.
Fin de tour (`StagnationTracker.ts`, `COMBAT`, 8 tours gardés, tout plan) : `[History] T<tour> TP <utilisés>/<dispo> MP <utilisés>/<dispo>
dealt <n> taken <n> passive <n> | <action>:<retour natif>:<dégâts>; …` (`move`, `equip` ; `?` sans retour, `-` non mesurable).

## Limites connues

- Une seule cible et une seule case de tir par plan ; pas de tir-déplacement-tir. Puce au cooldown de base inconnu : 1 usage. Une puce planifiée remet la stagnation à zéro même si elle est refusée à l'arrivée (le même plan peut se répéter).
- Non simulés : zones d'effet, laser d'ARME excepté (seule garde des puces : `selfHitRadius`, champs `area` / `targets` non vérifiés en
  combat), poison, vol de vie, critiques (agilité / 1000, × 1,3 : seul le gain d'un boost d'agilité est crédité, l'agilité de base n'est pas dans le score ni dans le danger ; gain réel non mesuré), arrondis du moteur, combos de buffs.
- Les coûts en opérations sont estimés, pas mesurés sur le moteur ; une primitive native peut franchir un plafond entre deux contrôles.
- Hypothèses d'API non vérifiées en combat réel : masque `launchType` (`LaunchPattern.ts`), ligne de vue ignorant les entités, `entity.strength` incluant les buffs actifs, durée des effets des puces (`Effect.turns` = 1 : dernier tour), cooldown de base 1 = puce prête au tour suivant, détection `instanceof Chest`. Laser : `Weapon.area` = 2 (`Area.java` du moteur ; 13 = premier en ligne ; non confirmé dans la doc officielle, inaccessible), `Cell.entity` et `Cell.obstacle` vrais pour `Field.cellFromXY`, ligne arrêtée par un obstacle seulement si `needsLos`, sans atténuation, alliés et invocations tous touchés ; laser de puce, laser ennemi (carte de danger) et alliés visés volontairement non traités ; coût en opérations de la ligne non mesuré (≤ 8 appels `cellFromXY` par case de tir et cible).
- Danger modélisé nul ≠ absence de menace (items ou PM adverses jamais observés) ; danger létal ≠ mort certaine. `KILL_MARGIN`, `LETHAL_PENALTY`, `RETREAT_RISK_FACTOR`, `FUTURE_TURN_WEIGHT`, `NEXT_TURN_WEIGHT`, posture, passivité et sa marge : non calibrés. Tour condamné : estimation, pas une certitude (54969530 tour 8, 54969622 tour 7 : survie réelle avec soin + casque, plans inchangés) ; hors de ce cas, le boost sans tir reste plafonné à 0,75 × PV de la cible, plus haut qu'avec tir (`tests/doomed-turn-fights.test.mjs`). Recul sans tir refusé : la case finale est plus exposée (rejeux `tests/doomed-turn-fights.test.mjs` : danger 0 → 118 à 184, pour 11,9 à 72,4 dégâts moyens ; garde-fous : `tests/retreat-filter-safety.test.mjs`), effet en combat non mesuré ; l'avance sans tir s'expose de même sans infliger de dégâts (54969622 tour 2 : danger 0 → 184).
- `N` : l'ennemi bouge en réalité (la promesse d'un tir peut ne pas être tenue) ; les items d'une case peuvent demander des cases de tir différentes ; un item hors de portée de ma zone ce tour, inabordable, en cooldown ou de cooldown de base > 1 n'est pas compté ; `U_max` (même réalisable seulement à fort danger) comprime `N` ; `N` et `F` s'additionnent sans plafond commun. Combat 54965081, tour 4 : à 0,75 (`BALANCED`) le repli garde l'avantage ; `AGGRESSIVE` (`a` × 0,75 = 0,94, `w` = 0,5) va tirer au neutrino, danger 252,8 au lieu de 142,2.
- Boost de PT : le plan suppose les PT gagnés dès le lancer (gain moyen) ; sinon ses derniers tirs sont annulés par leurs contrôles. Soin et bouclier dépendent des seuils de vie du comportement, plus de la seule carte de danger.
- Boost de PM : la fuite se déclenche si le danger du meilleur plan sans boost ≥ mes PV (seuil non calibré) ; PM supposés gagnés dès le lancer (sinon arrêt du plan, PT perdus) ; seconde recherche : coût non mesuré en opérations réelles (voir « Bornes ») ; un boost de PM seul, valorisé par `N` à PM + gain, peut être choisi sans tir ; comparaison au score du plan sans boost, non calibrée.
- Posture adverse : seuils non calibrés ; soin net (masqué si mes dégâts l'effacent), armure vue seulement si l'effet est lisible ; la fuite mesure son déplacement, pas son intention (kiting → `mixed`).
- `types/leekwars.d.ts` est un sous-ensemble local de l'API : les tests valident la logique, pas la force en combat.
