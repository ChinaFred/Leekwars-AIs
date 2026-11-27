# Stratégies de combat de Kassbi

Stratégie **en vigueur**, sans historique. Le code fait foi ; les constantes citées sont suivies de leur fichier. Tout changement de seuil, de condition ou d'ordre de planification met ce fichier à jour (lignes concernées
seulement) et ajoute ou ajuste un test de régression. L'historique est dans [`ChangeLog.md`](../ChangeLog.md) et `git log`.

**Sommaire** — [Chaîne de décision](#chaîne-de-décision) · [Plan conjoint](#plan-conjoint-tacticalplannerts) : [score](#score-et-compromis-explicite),
[stagnation](#sortie-de-stagnation), [bornes et ops](#bornes-et-budget-dopérations) · [Plan B](#plan-b-reserveplants) · [Boosts](#boosts-srcbrainstrengthboostts) ·
[Seuils par stratégie](#seuils-par-stratégie-strategyts) · [Mémoire de l'adversaire](#mémoire-de-ladversaire) :
[cases atteignables](#cases-atteignables-reachablecellsts), [carte de danger](#carte-de-danger-threatmapts-shotplants-launchpatternts) · [Journalisation](#journalisation-toolboxloggerts-toolboxmarkerts) · [Limites connues](#limites-connues)

## Chaîne de décision

Un tour, dans l'ordre (`src/Main/Kassbi_Class.ts`, `turn()`) :

1. **Observer** (`observeTurn`, `src/Brain/TurnObservation.ts`) : mémoire de l'adversaire, coffres, cases atteignables, carte de danger, stagnation, historique.
   Chaque collecte est protégée : une erreur est journalisée (`ERROR`) sans interrompre le tour.
2. **Boost de PM** (`castMpBoost`) : lancé si la règle de « Boosts » le demande ; cases atteignables et danger recalculés.
3. **`planAct`** (`src/Brain/PlanActScenario.ts`) avec `leekProfile`, le **point de réglage du comportement**
   (`Kassbi_Class.ts` : `AGGRESSIVE`, agressivité 50, soin/bouclier/repli autorisés ; voir « Comportement configuré ») :
   - **plan conjoint** (`TacticalPlanner.ts`) si les cartes du tour sont complètes ;
   - sinon **plan B** (`ReservePlan.ts`), séquentiel et borné ;
   - sans `Field.cellFromXY`, `Fight.weaponCells` ou `me.canUseChip` (API du jeu actuel) : aucune action, absence
     journalisée (`PLANNING`).
4. **Arme du tour 1** (`equipOpeningWeapon`) : si aucune arme n'est équipée et qu'il reste 1 PT, équiper la meilleure
   (dégâts moyens par PT, puis portée la plus longue). Puis mémorisation des PV de fin de tour.

Un plan est entièrement décidé et affiché (`PLANNING`) **avant** sa première action, boosts de force, de PT et d'agilité compris ; hors du
plan, `turn()` ne lance que le boost de PM (il en change les entrées). Exécution commencée, aucun second plan : un échec l'arrête.

**Coffres** (`Targets.ts`) : une entité `Chest` n'est ni ciblée ni comptée comme ennemi (danger, mémoire, plans) ; elle est suivie à part (`[Chest]`, contexte `MEMORY`).
**Piège du coffre** (`springChestTrap`, `src/Brain/ChestTrap.ts`, entre le boost de PM et `planAct`) : si je peux frapper un coffre depuis ma case (arme équipée, puce à dégâts, ou autre arme au prix de 1 PT) et qu'un ennemi vivant en est **strictement** plus proche que moi (distance), je tire sur le coffre tant que PT et tirs le permettent (arme équipée, puces, autres armes), puis `moveAwayFrom` le **coffre** avec tous mes PM. Ce tour remplace le plan ; sans tir abouti, le plan normal joue. Ligne `[ChestTrap]` (`PLANNING`). Condition de distance en vol d'oiseau, sans trajet ni PM adverses : heuristique non calibrée.

## Plan conjoint (`TacticalPlanner.ts`)

Compare en un seul score attaque, boost, protection et déplacement. Un plan = **une cible, une case de tir, au plus une arme**, plus des puces offensives, de protection et de boost ; l'option sans tir (progression, couvert, support) concourt aussi. Code : recherche dans `TacticalPlanner.ts`, types et bornes `TacticalTypes.ts`, score `TacticalScore.ts`, tour suivant `TacticalNextTurn.ts`, stagnation `TacticalStagnation.ts`, exécution `TacticalExecution.ts`.

**Conditions** : `ReachableCells` et `ThreatMap` du tour courant, non tronquées, danger connu, fini et ≥ 0 sur chaque case atteignable. Sinon le danger est **inconnu** (jamais remplacé par zéro) et on passe au plan B.

**Cases de tir** : listes natives `Fight.weaponCells` / `me.chipCells` (portée, motif dont le lancer en ligne, ligne de vue) ; pas d'appel natif si aucune case de ma zone n'est à portée de Manhattan de la cible. Arme et puce offensive sont créditées sur leurs cases atteignables (déplacement puis tir). Puce écartée si `me.canUseChip` la refuse alors que ma case est dans sa liste
(restriction inconnue) ; jamais tirée d'une case de sa zone d'effet si un effet peut toucher le lanceur (`selfHitRadius`).

**Ordre exécuté** : approche → boost (PT, force, agilité) → protection → équipement → puces offensives → tirs → déplacement
final. Chaque action revérifie PV, PT, cooldown, `canUseWeapon` / `canUseChip` ; retour natif > 0 = tir fait. Une puce offensive au cooldown de base nul (`Chip.cooldown`, `chipUsesOf`) est planifiée et relancée tant que `maxUses` et les PT le permettent ; sinon 1 fois.
Une puce refusée à l'arrivée est journalisée (`chip unavailable`) et sautée : le reste du plan continue, ses PT ne sont pas replanifiés.

### Score et compromis explicite

| Terme | Définition |
|---|---|
| `U` | dégâts utiles = `min(PV cible, Σ dégâts moyens)` après boucliers relatif et absolu de la cible |
| `D` | danger brut de la case finale (carte de danger) |
| `H` | soin crédité = `min(PV manquants, Σ soin moyen × (1 + sagesse/100))` |
| `C` | crédit d'armure = `min(D, A + D × R/100)` (`A` bouclier absolu, `R` relatif plafonné à 100) |
| `w` | poids du risque (`riskWeight`, commun au plan B) = facteur de rôle × `(1,5 − agressivité/100)` ; rôle : 0,5 `AGGRESSIVE`, 1 `BALANCED`, 1,5 `DEFENSIVE` ; × `RETREAT_RISK_FACTOR` (2) sous le seuil de repli du rôle |
| `p` | facteur de passivité (`riskFactor`, `StagnationTracker.ts`), de 1 à 0, ou au plancher du rôle : voir « Passivité » |
| `a` | poids d'approche = facteur de rôle × `(0,5 + agressivité/100)`, borné à [0,5 ; 1/`NEXT_TURN_WEIGHT`] : `a` × `NEXT_TURN_WEIGHT` ≤ 1, des dégâts remis au tour suivant ne valent jamais plus que ceux de ce tour |
| `G` | progrès sans tir = distance gagnée vers la cible (Manhattan, ou trajet futur) ; le journal garde la distance brute |
| `F` | crédit des tours suivants d'un boost (voir « Boosts ») ; 0 sans boost |
| `N` | valeur de la case finale au tour suivant = `a` × `NEXT_TURN_WEIGHT` (0,75) × `min(PV cible − U_max, dégâts moyens possibles au tour suivant depuis cette case)`, `U_max` = plus grand `U` qu'un plan quelconque peut infliger ce tour ; voir « Anticipation » |

- **Offensif** : `U − R_c + w × H + F + N`. **Sans attaque** : `a × G − R_c + w × H + F + N`.
- **Recul sans tir** (plan sans dégâts, tir absorbé compris, dont `G` < 0 et la distance Manhattan augmentent, vers une case moins dangereuse que la mienne, sans protection utile : soin crédité > 0 ou crédit de bouclier > 0 sur la case finale) : classé comme les autres pendant la recherche ; à la fin d'une recherche **complète**, s'il est en tête, il cède au meilleur plan qui **inflige des dégâts** (`U` > 0) avec un danger exposé < `PASSIVE_DANGER_LIFE_FRACTION` × (PV + `H`) — marge sans objet si ce plan tue le dernier ennemi (`KILL_MARGIN`) —, même si un plan sans dégâts est mieux classé que lui ; ligne `retreat without damage refused` (`PLANNING`). Sans un tel plan le recul est gardé (`BALANCED`) : avance, pas de côté, protection ou boost seuls ne le remplacent pas. `AGGRESSIVE` : il cède alors au meilleur plan sans attaque qui avance (`G` > 0) ou agit sur place (`G` = 0 avec soin, bouclier utile ou boost crédité) sous la même marge de danger, même si aucune attaque n'est possible ce tour (phase d'approche) ; ligne `aggressive posture: retreat without damage refused` ; ni pas de côté ni autre recul, et pas vers une case visitée par une sortie de stagnation. Le refus ne rend jamais un plan nul, vide ou létal. Filtre inactif : `DEFENSIVE` (se mettre à couvert sans tirer est son jeu), recherche interrompue (candidat borné inchangé), seuil de repli du rôle, tour condamné, plusieurs ennemis (`G` ne mesure que le premier), plan B. Non concernés : recul après des dégâts, pas en arrière à danger égal ou supérieur (il ne vaut que par `N`), sortie de stagnation. Un ennemi plus lent que moi ne l'autorise pas.
- **Coût de risque** `R_c = w × p × (D − C)`, plus `LETHAL_PENALTY` (1000) et le dépassement si `D − C ≥ m × (PV + H)` :
  la survie prime sur les dégâts (à ce seuil `N` = 0). `m` = 1, ou `PASSIVE_DANGER_LIFE_FRACTION` (0,75) dès que `p < 1`.
- **`R_c = 0`** si le plan tue le **dernier** ennemi vivant avec une marge `KILL_MARGIN` (1,1 × ses PV) ; alors `N` = 0.
- **Tour condamné** (`doomed`) : si le seuil de `LETHAL_PENALTY` est atteint sur la case de moindre danger avec **chaque** protection candidate (donc pour tout plan) : une cible tuée (dégâts moyens ≥ ses PV) passe avant le score, et `F` = 0 avec ou sans tir (un boost ne vaut que par les dégâts de ce tour). Soin, protection et case finale gardent le score ; ligne `doomed turn` (`PLANNING`). Si une protection ramène une case sous le seuil : règle normale.
- Égalités : danger brut inférieur, PT dépensés inférieurs, distance de tir futur inférieure, PM inférieurs.

Par défaut (`AGGRESSIVE`, 50) `w = 0,5` et `a = 1,25`. Le score échange des dégâts moyens de ce tour et la valeur de la position au suivant contre une menace potentielle au tour ennemi : ni probabilité de survie ni minimax.

**Passivité** (contre le refus de combat) : `p = max(plancher du rôle, 1 − 0,5 × (tours passifs − 2))`, soit 1 jusqu'à 2 tours passifs, 0,5 au 3e, puis 0 au 4e (`PASSIVE_TURNS_AT_FULL_RISK`, `PASSIVE_RISK_STEP`) sauf `DEFENSIVE` (plancher 0,5 : jamais téméraire, et pas de sortie de stagnation « à `p = 0` »). Un tour est **actif** si une de mes actions a fait perdre des PV à sa cible, mesurés autour de l'appel natif (`StagnationTracker.ts`), quel que soit le soin adverse ; tir raté ou absorbé (0 PV), dégât d'allié ou de poison : tour passif. Un tour qui bat la plus petite distance à l'ennemi depuis la dernière mort d'un ennemi (approche) gèle le compteur.
Dès que le compteur réduit le poids (3e tour passif), `m` garde le danger accepté sous 75 % de mes PV (critiques × 1,3 non modélisés) ; `w × H` n'est pas réduit. Le plan B n'applique pas `p`.

**Comportement configuré** (seuils du tableau « Seuils par stratégie », `vie` et distance à l'ennemi vivant le plus proche prises au début du tour, depuis ma case) : une puce de **soin** n'est candidate que si le profil l'autorise et que le seuil « Soin » ou « Soin si menace » est atteint ; un **bouclier**, que si le seuil « Bouclier » l'est ; sous le seuil de **repli** (profil autorisant le repli), `w` double : le danger de la case finale pèse deux fois plus, donc le plan préfère une case sûre et un recul après tir, et le recul sans tir est admis (voir « Score »). `RETREAT_RISK_FACTOR` est heuristique, non calibré.
**Posture du rôle** (`posture`, `TacticalScore.ts`, seul endroit où le rôle règle le plan conjoint) : les mêmes tactiques, pondérées. `BALANCED` à agressivité 50 est la référence. Valeurs heuristiques, non calibrées en combat.

| Levier | `AGGRESSIVE` | `BALANCED` | `DEFENSIVE` |
|---|---|---|---|
| Facteur de rôle de `w` (plan B compris) | 0,5 | 1 | 1,5 |
| Facteur de rôle de `a` (poids de `G` et `N`) | 1,25 | 1 | 0,75 |
| Plancher de `p` | 0 | 0 | 0,5 |
| Recul sans tir en tête | cède à un plan à dégâts, sinon à une avance | cède à un plan à dégâts | jamais filtré |
| Arme visée par le trajet futur | meilleurs dégâts moyens sur un tour (tirs permis par PT et `maxUses`, 1 PT si hors main) | première de la liste (arme en main) | plus longue portée max |

**Anticipation** (un seul ennemi, sinon `N` = 0). **`N`** (`nextTurn` dans le journal du plan) valorise la **position** finale, jamais des dégâts non infligés : il ne dépend que de la case finale et de l'arme en main à la fin du plan.
`U_max` étant une constante du tour, renoncer à un tir coûte ses dégâts pleins, et si un plan peut prendre tous les PV de la cible ce tour `N` = 0 partout (classement identique à celui sans `N`). Cible supposée **immobile** ; un item est utilisable depuis une case
si une case de sa liste native de tir est à au plus mes PM de marche (cases libres). Items : armes dont la liste a déjà été obtenue ce tour, puces offensives créditées ce tour (même règle que la recherche : voir « Cases de tir ») de cooldown de base 0 ou 1 ; aucun appel natif de plus.
Dégâts : maximum exact (sac à dos des puces, une arme au plus, 1 PT si elle n'est pas en main à la fin du plan), PT et force du début de ce tour moins les boosts qui expirent, sans les boosts du plan (leur gain futur est `F`).
Après un tir, la case finale maximise `N` − coût de risque parmi les cases atteignables avec les PM restants (sans `N` : la case de moindre danger). Allocation : 5 % des opérations (`NEXT_TURN_FRACTION`) ; dépassée, `N` = 0 pour **toutes** les cases, ligne `PLANNING`. Le plan B n'a pas `N`.
La distance à une case de tir ne départage que les égalités. **Trajet futur sans tir** : si aucun tir d'arme n'est possible ce tour, un BFS (160 cases, 8 pas, 8 lignes de vue, 2 % des opérations) cherche une case de tir de l'arme visée (selon le rôle : « Posture du rôle ») et remplace `G` Manhattan par la distance de trajet.

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
- **Limites acceptées** : contre un ennemi qui alterne immobilité et fuite, le premier tir peut être retardé ;
  le plan B n'a pas la mémoire des cases visitées. Deux tests de caractérisation figent ces cas
  (`tests/stagnation-escape-fight-54940819.test.mjs`).

### Bornes et budget d'opérations

| Borne | Valeur | Fichier |
|---|---|---|
| `TACTICAL_LIMITS` | 113 cases, 4 ennemis, 4 armes, 8 puces offensives, 3 protections, 30 PT, 100 000 unités de travail | `TacticalTypes.ts` |
| Arrêt de la recherche (relatif) | 30 % des opérations du tour depuis son entrée (`SEARCH_FRACTION`) | `TacticalTypes.ts` |
| Arrêt de la recherche (global) | 80 % du total, partagé avec le plan B et la carte de danger (`SEARCH_GLOBAL_FRACTION`) | `ExecutionBudget.ts` |
| Garde d'exécution | continuer si `max − ops > 3 % × max + 2 × plus gros segment observé` (`TAIL_FRACTION`) | `ExecutionBudget.ts` |

Au-delà d'une borne (par exemple plus de 113 cases atteignables, soit dès 8 PM en terrain ouvert) : repli explicite sur le plan B. Une recherche interrompue garde le meilleur candidat **complet** connu, jamais une moitié de plan.
Les 80 % ne limitent pas l'exécution : un plan retenu s'exécute tant que le garde d'exécution le permet.

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

Passé 80 % d'opérations au départ, le plan B tourne en mode dégradé (8 premières cases natives, pas de progression).

## Boosts (`src/Brain/StrengthBoost.ts`)

Une puce est un boost de force (`BUFF_STRENGTH`, ou effet 38), de PT (`BUFF_TP`, 32) ou de PM (`BUFF_MP`, 31) : au plus une
par type et par tour (le plus grand gain), jamais tant que l'effet est actif. Force et PT : **composante du plan**, PT d'abord.

- **Plan conjoint** : 4 variantes au plus (aucun, PT, force, les deux ; une seule sans boost prêt). PT du plan = PT − coûts + PT gagnés
  (partie entière du gain moyen) ; dégâts calculés avec la force boostée : le gain de ce tour est dans `U`.
  `F` = `FUTURE_TURN_WEIGHT` (0,75) × (durée − 1) tours pleins de l'arme du plan (force : gain % des dégâts de base ;
  PT : tirs entiers en plus), plafonné par 0,75 × les PV restants de la cible : un boost ne bat jamais le coup fatal.
- **Plan avec tir** : pas de boost sous 50 % de PV (`MIN_LIFE_RATIO_FOR_BOOST`). **Plan sans tir** : boost seulement si `F > 0` (durée ≥ 2) et si l'ennemi le plus proche est à portée max de mes armes + 2 × mes PM + ses PM.
  Sans tir seulement (PT sinon perdus ; combat 54991104), `F` de PT = le meilleur de trois scénarios de portée en maximum exact (`planShots`) : arme, puces offensives prêtes de cooldown de base 0 ou 1, arme + puces. Crédit optimiste assumé.
- **Plan B** : avec un tir d'arme, gain net du modèle à une arme (`boostNetDamage`, `tpBoostNetDamage`) > 0 et PV ≥ 50 % ;
  les tirs prévus sont réduits d'autant. Sinon, règle « sans tir » avec les PT que ni l'attaque ni les supports n'emploient.
- **Agilité, boost de remplissage** (`withAgilityFill`, `pickAgilityBoost` ; `BUFF_AGILITY` ou effet 41, dont Étirement) : ajouté au plan conjoint **retenu**, hors score et hors recherche, si les PT que le plan n'emploie pas (PT − dépensés, sans les PT attendus d'un boost de PT ; − 1 PT gardé pour l'arme du tour 1) couvrent son coût, sans effet d'agilité actif, gain ≥ 1, `canUseChip` sur moi, et si le plan attaque ce tour ou (durée ≥ 2 et ennemi à la portée « sans tir » ci-dessus). Lancé après PT et force, avant protection et tirs ; pas de seuil de PV ; jamais en plan B.
- **Boost de PM** (`decideMpBoost`, avant le plan ; gain = partie entière ≥ 1), si tout est vrai : PV ≥ 50 % ; cases du tour
  non tronquées, sans case de tir native d'une arme ou puce offensive prête payable ; zone à PM + gain non tronquée, ≤ 113 cases
  (sinon plan B), avec une case de tir d'une arme payable après le boost (+ 1 PT si non équipée) ; opérations < 80 %.

## Seuils par stratégie (`Strategy/*.ts`)

Les classes `Strategy` fournissent les seuils du rôle au plan conjoint et au plan B : soin, bouclier, repli (poids `w`).
`vie` = PV / PV max ; `perte` = 1 − `vie` ; `d` = distance à la cible ; `a` = agressivité / 100 (0,5 par défaut,
valeur correspondante entre parenthèses).

| Décision | Balanced | Aggressive | Defensive |
|---|---|---|---|
| Soin | `perte ≥ 0,15 + 0,10a` (0,20) | `vie ≤ 0,40 − 0,15a` (0,325) | `vie ≤ 0,90 − 0,15a` (0,825) ou `perte ≥ 0,35` |
| Soin si menace (`d ≤ 10`) | `vie ≤ 0,70` et `perte ≥ 0,10` | `vie ≤ 0,50` | `vie ≤ 0,80` et `perte ≥ 0,08` |
| Bouclier | `d ≤ portée de menace` et `vie ≤ 0,95 − 0,20a` (0,85) | `d ≤ portée de menace` et `vie ≤ 0,45 − 0,15a` (0,375) | `d ≤ portée de menace + 1` et `vie ≤ 0,98 − 0,10a` (0,93) |
| Repli (trop près et blessé) | `vie ≤ 0,55 − 0,20a` (0,45) | `vie ≤ 0,30 − 0,15a` (0,225) | `vie ≤ 0,80 − 0,10a` (0,75) |
| Repli préventif | `d ≤ 8` et `vie ≤ 0,40` | `d ≤ 1` et `vie ≤ 0,50`, ou `d ≤ 10` et `vie ≤ 0,25` | `d ≤ 7` et `vie ≤ 0,55 − 0,10a` (0,50) |

- « Trop près » : `d < 2` (`MIN_SAFE_DISTANCE`, `LeekStrategy.ts`), sans réglage de profil. Portée de menace : PM de l'ennemi + portée max de son arme.

## Mémoire de l'adversaire

Fichiers : `EnemyMemory.ts`, `EnemyProfile.ts`. Mise à jour au début de chaque tour ; seules les **cartes** du tour sont transmises à `planAct`.

- **Par ennemi** : caractéristiques, armes et puces connues ou observées, arme équipée, PT et PM maximaux vus,
  cooldowns suivis, journal des coups (`MAX_HIT_LOG` = 20).
- **Cooldowns** : posés à l'usage détecté (effets lancés), −1 par tour ; cooldown infini = `INFINITE_COOLDOWN` (66).
  La détection ayant lieu à mon tour, un cooldown peut être surestimé d'environ 1 tour.
- **Attribution des coups** : heuristique. La perte de PV non expliquée par un effet est attribuée à un item
  seulement si un seul candidat est compatible (plage de dégâts avec force, critique `CRITICAL_FACTOR` = 1,3) ;
  sinon « ambiguous ». Une inférence ne pose ni item observé ni cooldown.

### Cases atteignables (`ReachableCells.ts`)

Parcours en largeur en 4-connexité depuis la case de l'entité, borné par ses PM ; obstacles et autres entités
bloquent. Plafond `MAX_REACHABLE_CELLS` = 500 (au-delà, `truncated`). Mes PM sont ceux du tour ; ceux d'un autre
poireau sont le maximum observé. C'est une photographie du début de mon tour.

### Carte de danger (`ThreatMap.ts`, `ShotPlan.ts`, `LaunchPattern.ts`)

Pour chaque case que je peux atteindre : somme, sur les ennemis, de leurs meilleurs dégâts potentiels au prochain tour.

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
`Marker.ts` le seul qui marque le terrain ou met en pause. Tous les contextes sont actifs par défaut ; en couper un :
`leekLogConfig.setEnabled(LOG_CONTEXT.DANGER_ZONE, false)`. Un texte paresseux (`() => string`) n'est évalué que si son contexte est actif.

Contextes utiles à l'analyse : `PLANNING` (plan avant exécution, replis `[Tactical]`, `[Reserve]`), `THREAT`,
`REACHABLE`, `MEMORY`, `CHIP` (`[Boost]`), `OPERATIONS` (ligne `Operations:` de fin de tour), `ERROR` (en rouge).
`ACCESSIBLE_ZONE`, `DANGER_ZONE` et `TARGET_ZONE` affichent les zones sur le terrain avec une pause : à couper hors mise au point. `TARGET_ZONE` (zone visée : toutes les cases qu'un ennemi peut toucher, atteignables par moi ou non, mêmes marques que `DANGER_ZONE`) est le seul qui calcule, avant le plan et seulement s'il est actif (`buildTargetZone`, `ThreatMap.ts`) : mêmes dégâts par case que la carte de danger, par recherche bornée (case de tir la plus proche, puis alignées, diagonales, autres à portée utile ; arrêt à la borne des items à portée ; à dégâts égaux la case de tir peut différer) ; au plus `MAX_TARGET_ZONE_PAIRS` = 16 000 paires et arrêt à 50 % des opérations du tour (`TARGET_ZONE_OPERATIONS_FRACTION`), au-delà `TRUNCATED` avec cases évaluées/candidates dans le log (cases proches de moi gardées) ; le log donne paires, lignes de vue et opérations, pris sur le budget du plan.
Fin de tour (`StagnationTracker.ts`, `COMBAT`, 8 tours gardés, tout plan) : `[History] T<tour> TP <utilisés>/<dispo> MP <utilisés>/<dispo>
dealt <n> taken <n> passive <n> | <action>:<retour natif>:<dégâts>; …` (`move`, `equip` ; `?` sans retour, `-` non mesurable).

## Limites connues

- Une seule cible et une seule case de tir par plan ; pas de tir-déplacement-tir. Puce au cooldown de base inconnu : 1 usage. Une puce planifiée remet la stagnation à zéro même si elle est refusée à l'arrivée (le même plan peut se répéter).
- Non simulés : zones d'effet (seule garde : `selfHitRadius`, puces seulement, champs `area` / `targets` non vérifiés en
  combat), poison, vol de vie, critiques (agilité / 1000, × 1,3 : absents du score, gain de l'agilité non mesuré), arrondis du moteur, combos de buffs.
- Les coûts en opérations sont estimés, pas mesurés sur le moteur ; une primitive native peut franchir un plafond entre deux contrôles.
- Hypothèses d'API non vérifiées en combat réel : masque `launchType` (`LaunchPattern.ts`), ligne de vue ignorant les entités, `entity.strength` incluant les buffs actifs, durée des effets des puces (`Effect.turns` = 1 : dernier tour), cooldown de base 1 = puce prête au tour suivant, détection `instanceof Chest`.
- Danger modélisé nul ≠ absence de menace (items ou PM adverses jamais observés) ; danger létal ≠ mort certaine. `KILL_MARGIN`, `LETHAL_PENALTY`, `RETREAT_RISK_FACTOR`, `FUTURE_TURN_WEIGHT`, `NEXT_TURN_WEIGHT`, posture du rôle, passivité et sa marge : non calibrés. Tour condamné : estimation, pas une certitude (54969530 tour 8, 54969622 tour 7 : survie réelle avec soin + casque, plans inchangés) ; hors de ce cas, le boost sans tir reste plafonné à 0,75 × PV de la cible, plus haut qu'avec tir (`tests/doomed-turn-fights.test.mjs`). Recul sans tir refusé : la case finale est plus exposée (rejeux `tests/doomed-turn-fights.test.mjs` : danger 0 → 118 à 184, pour 11,9 à 72,4 dégâts moyens ; garde-fous : `tests/retreat-filter-safety.test.mjs`), effet en combat non mesuré ; l'avance `AGGRESSIVE` sans tir s'expose de même sans infliger de dégâts (54969622 tour 2 : danger 0 → 184).
- `N` : l'ennemi bouge en réalité (la promesse d'un tir peut ne pas être tenue) ; les items d'une case peuvent demander des cases de tir différentes ; un item hors de portée de ma zone ce tour, inabordable, en cooldown ou de cooldown de base > 1 n'est pas compté ; `U_max` (même réalisable seulement à fort danger) comprime `N` ; `N` et `F` s'additionnent sans plafond commun. Combat 54965081, tour 4 : à 0,75 (`BALANCED`) le repli garde l'avantage ; `AGGRESSIVE` (`a` × 0,75 = 0,94, `w` = 0,5) va tirer au neutrino, danger 252,8 au lieu de 142,2.
- Boost de PT : le plan suppose les PT gagnés dès le lancer (gain moyen) ; sinon ses derniers tirs sont annulés par leurs contrôles. Soin et bouclier dépendent des seuils de vie du rôle, plus de la seule carte de danger.
- Boost de PM : danger des cases débloquées non regardé (si le plan refuse d'y aller, ses PT sont perdus ce tour) ; pas pour fuir.
- `types/leekwars.d.ts` est un sous-ensemble local de l'API : les tests valident la logique, pas la force en combat.
