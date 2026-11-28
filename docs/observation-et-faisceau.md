# Observation du tour, faisceau et exécution

Ce document décrit ce que fait l'IA principale (`src/Main/Kassbi_Book.ts`) à chaque tour, dans l'ordre : observer,
construire les plans, choisir, exécuter. Les valeurs chiffrées sont celles du code ; elles sont heuristiques et n'ont
pas toutes été calibrées en combat. Les seuils et la stratégie en vigueur sont dans `docs/strategies.md`.

## 1. Observation du tour

### Ce qui est observé

`observeTurn` (`src/Brain/TurnObservation.ts`) s'exécute au début du tour, avant toute décision. Ordre des étapes :

1. **Ennemis** : un ennemi vu pour la première fois est identifié (nom, niveau, PV max, armes et puces connues). À chaque
   tour, la mémoire (`EnemyMemory`) note les armes et puces qu'il vient de montrer, sa posture (combien de tours il a
   attaqué, avancé, reculé, soigné, protégé) et le dernier coup qu'il m'a porté (montant, arme ou puce supposée).
2. **Coffres** : les coffres vivants sont suivis à part. Ils ne sont jamais comptés comme ennemis.
3. **Cases atteignables** : pour moi, mes alliés et les ennemis, avec les PM de chacun.
4. **Carte de danger** : pour chaque case que je peux atteindre, une estimation des dégâts que les ennemis pourraient
   m'y infliger au tour suivant. Elle est calculée à partir des cases atteignables des ennemis, de leurs armes et puces
   connues et de la ligne de vue. Le danger des coffres y est ajouté.
5. **Affichages** de la zone accessible, du danger et de la zone visée : coupés par défaut, car ils coûtent beaucoup
   d'opérations (290 000 à 690 000 pour la zone visée).
6. **Stagnation** : compte les tours consécutifs sans tir ni progrès.
7. **Historique** : ouvre la ligne du tour dans l'historique des actions.

Chaque étape est protégée séparément. Si l'une échoue, l'erreur est journalisée et le tour continue : la collecte de
données ne doit jamais empêcher de jouer. La liste des ennemis vivants n'est demandée au jeu qu'une seule fois par tour.

Si les cases atteignables ou la carte de danger sont tronquées (trop de cases), le livre ne joue pas ce tour-là et le
plan de repli (`planAct`) prend le relais.

### Ce qui est journalisé et comment

Toute sortie passe par une seule fonction, `log(texte, contexte)` (`src/Toolbox/Logger.ts`) :

- Chaque ligne appartient à un **contexte** : `movement`, `strategy`, `combat`, `weapon`, `armor`, `chip`, `planning`,
  `memory`, `reachable`, `threat`, `operations`, `speech`, `error`, `system`, `debug`, plus les trois contextes
  d'affichage (`accessible_zone`, `danger_zone`, `target_zone`).
- Un contexte inactif n'écrit rien. Le texte peut être donné sous forme de fonction : elle n'est exécutée que si le
  contexte est actif, ce qui évite de payer le formatage inutilement.
- La configuration est dans `Kassbi_Book.ts` (`leekLogConfig`) : tout est actif sauf les trois contextes d'affichage.
- La sortie va à `console.log`. Les erreurs (contexte `error`) sortent en rouge via `Debug.log`.
- `log` ne lève jamais d'exception : un journal ne doit pas interrompre un tour.
- Seul `Logger.ts` appelle `console.log` ou `Debug.log` ; un test (`logging-policy`) le vérifie.

Lignes écrites pendant l'observation :

| Ligne | Contexte | Sens |
|---|---|---|
| `[EnemyMemory] Identified <nom> (#id) lvl, PV, armes, puces` | memory | première apparition |
| `[EnemyMemory] <nom> observed: ...` | memory | arme ou puce vue pour la première fois |
| `[EnemyMemory] <nom> stance ... (attack, approach / flee, heal, shield)` | memory | comptes par type d'action |
| `[EnemyMemory] <nom> hit N with X (source)` | memory | coup reçu ; la source dit si l'objet est supposé (`inferred`) |
| `[Reachable] me:N (PM)` | reachable | nombre de cases atteignables |
| `[Threat] N/M cells, danger max, min, safest, ...` | threat | résumé de la carte de danger ; `TRUNCATED` si incomplète |

Lignes écrites ensuite, pendant la planification, l'exécution et en fin de tour :

- `=== KASSBI BOOK TURN START ===` et `END` (contexte `system`), puis `Version : <commit> — <sujet>` juste après le début : la constante `DEPLOYED_VERSION` de `src/DEPLOYED.ts`, que LWGarden réécrit à chaque PUSH (`locale (non déployée)` hors déploiement).
- `[Book] ...` et `[Tactical] ...` (contexte `planning`) : voir les parties 2 et 3.
- `[History] T<tour> TP <utilisés>/<dispo> MP <utilisés>/<dispo> dealt <n> taken <n> passive <n> | <action>:<résultat>:<dégâts>`
  (contexte `combat`) : ce que le tour a réellement fait. Un `-` veut dire dégâts non mesurables, un `?` appel sans retour.
- `Operations: utilisées/max (pourcentage)` (contexte `operations`) : coût du tour.
- `SEARCH CUT [origine] cause=... ops=...` (en rouge) : une recherche a été coupée par un plafond. Une ligne par coupure.

Ces lignes sont ce que lit `python LWGarden/src/FightSummary.py --fight <id> --turns`.

## 2. Construction du faisceau et choix du plan

Le « faisceau » (beam) est une recherche qui garde seulement les 5 meilleures suites d'actions à chaque niveau, au lieu
d'explorer toutes les possibilités. Code : `BookPlanner.ts` (préparation), `BookBeam.ts` (recherche),
`BookObjective.ts` (score), `CombatBook.ts` (table de combos).

### Préparation

- Le livre ne joue que s'il y a au moins un ennemi vivant, que les cases et la carte de danger sont complètes et à
  jour pour ce tour, et qu'il reste assez d'opérations. Sinon il rend la main (`planAct`).
- L'**objectif** de score dépend de l'agressivité du profil (50 aujourd'hui, donc l'objectif `damage`).
- L'**état de départ** contient ma case, mes PV, PT, PM, les temps de recharge de mes puces, mes bonus actifs, les ennemis
  (case et PV) et l'arme en main.
- La **table de combos** est calculée une fois par état de statistiques : pour une distance, une ligne de vue, un
  alignement, un nombre de PT et les puces disponibles, elle donne directement le meilleur enchaînement d'armes et de
  puces et ses dégâts nets des boucliers de la cible. Le faisceau lit cette table au lieu de recalculer les tirs.

### Un niveau de recherche = un tour simulé

Pour chaque tour simulé, à partir de chaque état du faisceau :

1. **Candidats** : pour chaque case atteignable, chaque ennemi et chaque variante de boost (aucun boost, force, PT,
   agilité, PM), on lit le combo dans la table. Sans tir possible, un seul candidat par case (contre l'ennemi le plus
   proche).
2. **Évaluation** d'un candidat (`stepOf`) :
   - dégâts utiles = dégâts du combo, avec critiques espérés, plafonnés par les PV de la cible ;
   - danger exposé = danger de la case finale, moins les boucliers lancés ; 0 si le tir tue le dernier ennemi
     (avec 10 % de marge) ;
   - le candidat est **létal** si le danger exposé atteint mes PV (soin compris) ; il reçoit alors une pénalité de 1000.
3. **Score d'un tour** (objectif `damage`, agressivité 50) :
   `1 × dégâts + 0,5 × soin − 0,5 × danger exposé + 0,5 × dégâts si la cible meurt`, et `+ 1,25 × progrès vers
   l'ennemi` seulement si le tour n'inflige aucun dégât. La pénalité létale s'ajoute dans tous les profils.
4. **Raffinement** : les candidats sont regroupés par ensemble d'actions (même cible, même combo, même boost). On garde
   les 12 meilleurs groupes, classés sur leur potentiel (danger final supposé nul). Pour chacun on cherche :
   - la **meilleure case de recul** : la case de moindre danger atteignable avec les PM qui restent après le tir ;
   - le meilleur **soin ou bouclier** à ajouter, si le profil l'autorise.
5. **Sélection** : on garde les 5 meilleurs candidats de clés distinctes, en prenant d'abord le meilleur de chaque
   groupe d'actions. Cela évite qu'un plan qui investit (un boost par exemple) soit éliminé avant d'avoir payé.

### Passage au tour simulé suivant

Pour chaque candidat gardé, on calcule l'état suivant : ma case finale, mes PV (− 50 % du danger exposé + soin), les
temps de recharge, les bonus restants, les PV de la cible, et la nouvelle case des ennemis. Par hypothèse, un ennemi
**avance vers moi de tous ses PM** (il recule s'il a été classé `defensive`) et ne se soigne ni ne se protège. Cette
hypothèse n'est pas vérifiée en combat. Le danger d'une case hors de la carte réelle est celui de la case connue la plus
proche.

Le score d'une suite est la somme des scores de ses tours, pondérés **1, 0,6 et 0,4** : le tour réel compte plus que
les tours imaginés.

### Profondeur et budget

- Le niveau 1 est toujours complet. Le niveau 2 est toujours ouvert. Le niveau 3 est ouvert tant que le livre a
  consommé moins de 30 % des opérations, ou si un boost est en jeu.
- Le faisceau dispose de 70 % des opérations du tour ; aucune recherche ne dépasse 80 %.
- Avant d'ouvrir un niveau, on estime le coût d'un nœud d'après le niveau précédent. Si le budget ne couvre pas tous les
  nœuds, seuls les meilleurs sont développés. Un niveau coupé en cours est abandonné : le niveau précédent, complet,
  reste valable. Chaque coupure écrit une ligne `SEARCH CUT`.

### Choix du meilleur plan

- La meilleure suite est celle dont le score total est le plus haut. En cas d'égalité : danger plus bas, moins de PT
  dépensés, moins de PM.
- Seul le **premier tour** de cette suite est exécuté. Au tour suivant, tout est recalculé avec l'état réel.
- Le premier tour est transformé en plan (`toPlan`) : cible, case de tir, armes et nombre de tirs (jusqu'à deux armes, `weaponSegments`), puces, protections,
  boosts, case finale, PM avant et après le tir.
- Contrôle du laser : le faisceau ne simule pas la ligne du laser. Le plan est écarté si la ligne touche un coffre ou
  si les alliés touchés coûtent plus que l'ennemi ne rapporte. Un plan à deux armes dont l'une est un laser est écarté.
- Si la meilleure suite ne fait rien ce tour-ci, ou si aucun plan n'existe, le plan de repli `planAct` joue : un tour
  n'est jamais perdu.

Lignes de journal (contexte `planning`) :

- `[Book] profile ..., depth N, ... cut / skipped` : profondeur atteinte et raison d'un arrêt.
- `[Book] ops: prepare ..., beam ...` : opérations de la préparation et de la recherche.
- `[Book] beam <score>: [PV avant>après combo dmg heal danger s score]` : les 5 suites gardées. Un score très négatif
  (autour de −1000) signale que le plan est létal.
- `[Book] unchosen with more damage: ...` : le meilleur plan non retenu qui infligeait plus, et pourquoi.
- `[Book] chosen: ...` : le plan retenu.

## 3. Exécution du plan

`executeTacticalPlan` (`TacticalExecution.ts`) joue le plan retenu. Avant la première action, il journalise le plan
complet (`[Tactical] plan {...}`) : PT et PM disponibles et prévus, armes, puces, dégâts utiles et danger estimés.

Ordre des actions :

1. boost de PM, s'il y en a un (échec : tout le plan s'arrête, car les cases prévues ne sont plus atteignables) ;
2. déplacement vers la case de tir ;
3. boosts (leurs PT, force ou agilité servent aux actions suivantes) ;
4. protections (soin, bouclier) ;
5. changement d'arme, au prix de 1 PT (la 1re arme ; la 2e, s'il y en a une, entre les tirs de la 1re et les siens, voir 7) ;
6. puces offensives ;
7. tirs d'arme, segment par segment (jusqu'à deux armes différentes : tirs, changement d'arme à 1 PT, tirs) ;
8. déplacement final vers la case de moindre danger.

Garde-fous :

- Avant chaque action le jeu est interrogé (puce prête, PT suffisants, cible à portée, ligne de vue). Un refus annule
  cette action, journalise `execution: ...`, et le reste du plan continue, sauf si le boost de PM ou le déplacement vers la case de tir échoue : le plan s'arrête alors.
- Aucun second plan n'est cherché après une dépense de PT : un échec ne déclenche jamais de nouvelle séquence.
- Si les ennemis ne sont plus où le plan les attendait, le plan est abandonné ou le déplacement final annulé.
- L'exécution s'arrête quand il reste moins de 3 % des opérations plus deux fois le plus gros segment déjà observé.
- Chaque action est journalisée avant son exécution (`[Tactical] phase before action {...}`).

Après le plan : choix de l'arme d'ouverture si besoin (`equipOpeningWeapon`), enregistrement des PV de fin de tour pour
attribuer les dégâts subis au tour suivant, fermeture de la ligne `[History]`, réplique du poireau, puis la ligne
`Operations`.

## 4. Lire un tour dans un journal

Exemple : combat 55029810, tour 2 (lignes abrégées).

```
[Threat] 47/47 cells, danger max 249.3 min 0.0 ...      carte de danger
[Book] profile aggression 50: depth 1, 5 plans, ...      faisceau, une seule profondeur
[Book] beam 79.5: [340>340 flame+flash+spark dmg 204.1 heal 0.0 danger 249.3 s 79.5]
[Book] chosen: [340>340 flame+flash+spark ...]           plan retenu
[Tactical] phase before action {"phase":"approach",...}  déplacement
[Tactical] phase before action {"phase":"offensive chip","chip":"flame",...}
[History] T2 TP 10/10 MP 4/5 dealt 186 taken 0 ...       ce qui s'est vraiment passé
```

Ce tour a joué en profondeur 1 : le tour suivant n'a pas été simulé, ce qui a conduit à la modification « niveau 2
toujours ouvert » (voir `docs/strategies.md`).
