# Stratégies de combat de Kassbi

Document de référence unique des décisions tactiques. Les valeurs ci-dessous sont celles du code (`src/Classes/Strategy/*.ts`, `src/Classes/Plannification/{Plannification,TacticalPlanner}.ts`, `src/Brain/PlanActScenario.ts`) ; en cas d'écart, le code fait foi.

**Règle de maintenance** : tout changement de seuil, de condition ou d'ordre de planification met à jour ce fichier et ajoute ou ajuste un test de régression dans `tests/`.

## Chaîne de décision

1. [`turn()`](../src/Main/Kassbi_Class.ts) met d'abord à jour la mémoire de l'adversaire et les cartes, puis appelle `planAct(me, undefined, { reachable, threat })` avec le profil par défaut : rôle `BALANCED`, agressivité 50, portée préférée 3–8, soin/bouclier/repli autorisés.
2. `planAct` évalue d'abord des plans conjoints avec `TacticalPlanner` (voir ci-dessous). Si les données ou le budget sont insuffisants, aucune action de cette évaluation n'a été exécutée : repli explicite vers **la séquence historique inchangée**, sur l'ennemi le plus proche. `Kassbi_test.ts` et les appels à deux arguments n'apportent pas de cartes : ils gardent ce repli historique.
3. **Séquence historique seulement** : `Plannification` choisit l'arme (`chooseWeapon`), l'équipe si besoin ; ordre normal : `planMove` → `planShootOrChip` → `planChipsActionsAfterShoot` (bouclier, soin) → `planHide` → `planRetreatAfterShoot`.
4. Ordre « situation critique » : si `distance <= 8`, `vie <= 60 %` et `shouldHide` est vrai, l'ordre devient `planHide` → chips → tir → déplacement (→ `planRetreatAfterShoot`, ajouté en fin dans les deux ordres).
5. `planShootOrChip` ne dépend plus de `planMove` : le tir et la chip d'attaque sont planifiés quel que soit l'ordre (arme choisie si besoin). Dans l'ordre critique, le repli s'exécute avant les tirs, qui restent gardés à l'exécution par `canUseWeapon` : ils ne partent que si la cible est encore à portée après le repli.
6. `planRetreatAfterShoot` (recul de `zone_control`) est un no-op si `planHide` ou `planMove` ont déjà consommé les PM (`mpLeft = 0`), donc l'ordre critique n'est pas modifié et `planHide` garde la priorité.

## Plans conjoints attaque / protection / déplacement

Implémentation : [`TacticalPlanner.ts`](../src/Classes/Plannification/TacticalPlanner.ts). Les seuils de soin, bouclier, chip d'attaque et repli décrits plus bas appartiennent au **repli historique** ; le chemin conjoint met ces actions en concurrence via le score, sans ces seuils. Les autorisations du profil restent obligatoires.

### Données obligatoires et repli

- `ReachableCells` et `ThreatMap` doivent être présentes, du poireau courant et du tour courant. La zone atteignable doit aussi correspondre à la position et aux PM actuels ; `candidateCells` doit correspondre à sa taille.
- Toute troncature (`reachable.truncated`, `threat.truncated`, **`inputsTruncated`**) invalide l'évaluation entière. Chaque case atteignable doit avoir un danger **connu, fini et ≥ 0**, y compris la destination. Aucune valeur manquante n'est remplacée par zéro. Les indisponibilités attendues entraînent un repli motivé ; toute autre exception pendant l'évaluation est signalée avec sa cause et sa pile dans le contexte `ERROR`, puis entraîne aussi le repli sans action tactique préalable. Comme les autres erreurs du dépôt, ce signalement est désactivable via `ERROR`.
- Repli journalisé sous `PLANNING` : `[Plannification] SkipShootOrChip: [Tactical] fallback: <raison>; legacy planning`. Les limites de la carte restent valables même complète : **danger potentiel modélisé = 0 n'est pas une preuve d'absence de menace**.
- Si aucune attaque positive ni protection utile n'est possible dans la zone, retour à l'historique pour ne pas rester immobile hors portée. Si une attaque est possible mais trop risquée au score, un plan sans attaque peut gagner.

### Espace de plans et faisabilité

1. Toutes les cibles vivantes, toutes mes armes (dont l'arme équipée) et les puces offensives prêtes entrent en compétition dans les bornes ci-dessous. Un plan attaque **une seule cible depuis une seule case de tir**, avec au plus une arme ; l'option sans arme existe, y compris si je n'ai aucune arme.
2. Cases de tir natives, calculées une fois par `(cible, item)` : `Fight.weaponCells(target, weapon)` et `me.chipCells(chip, target)`, déjà utilisées par `ShootingOptions`. Elles filtrent portées minimale/maximale, motif de lancer et LOS. **Le score de `ShootingOptions` n'est pas utilisé**, ni le glouton `planShots` de la carte de danger. `toCandidate`/`maxUsesOf` sont réutilisés pour les dégâts bruts et limites.
   Une puce offensive n'est créditée que si `me.canUseChip(chip, target)` est **vrai depuis la case actuelle** et que la case hypothétique figure dans `chipCells`. Si ce test est faux, la puce est exclue pour cette cible, mais les autres attaques restent candidates. Ce refus ne prouve **pas** que la puce serait inutilisable ailleurs : il peut être dû uniquement à la portée ou à la LOS, ou à une restriction supplémentaire impossible à distinguer depuis l'origine. Si la case actuelle figure dans `chipCells` malgré le refus, celui-ci est identifié comme une divergence avec les cellules ; sinon la cause est indéterminée. Sans API vérifiée permettant d'isoler ces restrictions à distance, l'exclusion est délibérément prudente ; si rien d'autre n'est exploitable, repli historique avec le motif `offensive chip refused at current cell` ou `offensive chip legality unverified` (ce dernier prioritaire si les deux cas existent). Une puce déjà utilisable peut encore être planifiée après déplacement, mais le succès futur n'est pas garanti et `canUseChip` est revérifié sur place.
3. Départ → tir : coût BFS de ma zone courante. Tir → destination : **nouveau BFS depuis la case de tir**, avec uniquement `PM − coût avant tir`. Occupants et obstacles bloquent le passage ; la destination doit aussi appartenir à la zone initiale et être connue de la carte. Cela inclut les trajets aller-retour, sans réutiliser les PM du départ. Le modèle garde l'hypothèse de 4-connexité de `ReachableCells`.
4. Pour chaque arme et budget de PT, sac à dos borné par coût **exact** : tous les nombres de tirs permis par `maxUses` et les PT, chaque puce au plus une fois (même cooldown nul). Aucun filtre « ratio de puce supérieur à celui de l'arme ». Les puces peuvent utiliser un reliquat ou battre une combinaison gloutonne. Changer d'arme coûte **1 PT**, inclus avant comparaison ; pas de changement dans les plans sans tir d'arme.
5. Protection : tous les sous-ensembles de puces prêtes, abordables, actuellement utilisables sur moi, dont les seules features sont `HEAL`, `ABSOLUTE_SHIELD`, `RELATIVE_SHIELD`. `allowHealing`/`allowShielding` filtrent les types ; pas de crédit pour des buffs non simulés. Une puce ne peut pas être à la fois support et attaque dans ce modèle.
6. Ordre exécuté : **déplacement avant tir → protection → équipement éventuel → puces offensives → tirs → déplacement final**. Les PT de protection sont réservés avant de composer l'attaque. Si `allowHiding = false`, destination = case de tir et un plan sans dégâts estimés positifs ne peut pas changer de case avant tir ; l'approche permettant des dégâts utiles reste autorisée.

### Score et compromis explicite

Pour chaque impact offensif, estimation `d = max(0, dégâts moyens bruts × (1 − clamp(bouclier relatif cible, 0, 100)/100) − max(0, bouclier absolu cible))`. C'est une approximation statique : pas d'arrondis moteur ni de simulation des variations de bouclier. Dégâts utiles `U = min(PV actuels cible, Σ d)` : l'excès de dégâts n'est pas récompensé.

Avec `D` le danger **brut inchangé** de la destination :

- soin crédité `H = min(PV manquants, Σ soin moyen × (1 + sagesse/100))` ;
- protection absolue de base `A = Σ valeur moyenne ABSOLUTE_SHIELD`, relative `R = min(100, Σ valeur moyenne RELATIVE_SHIELD)` ;
- crédit d'armure **heuristique** `C = min(D, A + D × R/100)` : seulement un impact d'armure absolue crédité, sans amplification par la résistance, ni multiplication par le nombre de tirs possibles ;
- poids `w = facteur rôle × (1,5 − agressivité/100)` ; facteur rôle = **0,75 AGGRESSIVE**, **1 BALANCED**, **1,25 DEFENSIVE** (donc `w = 1` par défaut) ;
- **score = `U − w × (D − C) + w × H`**. À égalité : danger brut inférieur, puis PT dépensés inférieurs, puis PM totaux inférieurs, puis ordre d'énumération stable.

Ce score échange des dégâts moyens **ce tour** contre une menace potentielle **au prochain tour ennemi**, de précision différente ; il ne constitue ni une probabilité de survie ni un minimax exact. Le crédit de soin et d'armure n'est pas une réduction garantie de dégâts. Les boucliers déjà présents sur moi ne sont pas déduits de `D` ; les buffs de protection ne sont pas garantis par une simulation moteur. La portée préférée n'est pas un bonus du score conjoint (elle reste utilisée par l'historique).

**Jamais de retrait d'un ennemi de la carte sur la seule base de dégâts moyens**, même si `U` atteint ses PV : le danger reste celui de tous les ennemis modélisés. À l'exécution seulement, `target.life <= 0` arrête les attaques restantes ; le déplacement final reste possible.

### Exécution dynamique et budget

- Avant l'approche : recalcul d'atteignabilité avec les PM réels, coût ≤ budget prévu ; `moveToward(cell, coût)` puis vérification de la **case réellement atteinte**. Sinon arrêt du plan, journalisé.
- Chaque protection/attaque vérifie vie, PT actuels, cooldown, limites, possession de la puce, puis `canUseChip` / `canUseWeapon`. Une arme n'est tirée que si elle est réellement équipée (un équipement raté ne fait pas tirer l'ancienne au mauvais coût). Avant le déplacement final : nouveau BFS avec `min(PM réels, PM après tir prévus)`, destination réellement atteignable ; échec/obstacle/arrivée incomplète journalisés.
- Aucun retour à l'historique **après** début d'exécution : éviter doubles actions/doubles dépenses. Pas de recomposition optimale après échec, variation des dégâts ou mort effective ; certaines ressources peuvent rester inutilisées.
- Bornes `TACTICAL_LIMITS` : **85 cases**, **4 ennemis**, **4 armes**, **8 puces offensives**, **3 protections**, **30 PT**. Au-delà, repli historique explicite, pas de sous-ensemble caché présenté comme optimum. Au plus **100 000 unités de travail** de recherche (itérations comptées, **pas des opérations moteur**), puis abandon de l'ensemble.
- Si les compteurs `System` sont disponibles : contrôle périodique (toutes les 64 unités, dès la première), ainsi qu'avant/après les fournisseurs natifs de cases et les BFS de recherche ; abandon à **70 % du budget total** utilisé, ou **15 % du budget total** consommé depuis le début de la recherche. Réserve indicative pour l'exécution/le repli ; une primitive native ou un BFS entre deux contrôles peut dépasser cette réserve. Aucun coût réel en ops n'a été mesuré. Les tableaux de PT font au plus 31 entrées ; une seule table par cible/case/arme dessert tous les budgets de protection, les cellules natives sont mises en cache pour l'évaluation, pas recalculées pour chaque couple.

**Limites restantes** : une seule cible/case de tir, pas de tir-déplacement-tir ; pas de simulation de zones et dommages collatéraux, effets secondaires des items, poison, érosion, vol de vie, critiques, arrondis, résistances spéciales, contre-effets ou combos de buffs. Les dégâts de zone ou features multiples peuvent donc être mal valorisés. Les restrictions peuvent changer après le départ et restent contrôlées à l'exécution ; la séquence historique de repli conserve ses propres limites, dont sa puce d'attaque non gardée à l'exécution. La doc officielle [canUseChip](https://leekwars.com/help/documentation/canUseChip) décrit une vérification depuis la position courante (portée et LOS, sans PT ni cooldown) ; elle ne confirme pas un test de restrictions à position hypothétique en TypeScript. Les PT/cooldowns restent vérifiés séparément. La ThreatMap conserve son propre glouton et ses menaces omises (ci-dessous) : une attaque optimisée ne rend pas sa défense exhaustive. À vérifier en combat réel : équivalence des cellules natives avec les tirs depuis une position hypothétique, API TypeScript `Fight.weaponCells(target, weapon)` (usage local existant), surcharge `moveToward(Cell, mp)` (déclaration et usages locaux, documentation générale TypeScript moins détaillée), coût des primitives, effets exacts des boucliers. Tests : mondes simulés dans `tests/tactical-planner.test.mjs` et `tests/tactical-chip-safety.test.mjs`, pas mesure de force en combat.

## Profil (`LeekProfile`)

| Champ | Effet |
|---|---|
| `role` / `strategyName` | `AGGRESSIVE`, `DEFENSIVE` ou `BALANCED`. `ATTACKER` est converti en `AGGRESSIVE` ; toute autre valeur devient `BALANCED`. |
| `aggression` (0–100) | Ramenée dans [0, 100] ; ratio `a = aggression / 100` utilisé dans les formules. |
| `preferredMinRange` / `preferredMaxRange` | Portée visée pour le score d'arme et la distance de sécurité du repli. |
| `allowHealing`, `allowShielding`, `allowHiding` | Désactivent respectivement le soin, le bouclier et le repli. |

## Seuils par stratégie (séquence historique)

`vie` = PV / PV max ; `perte` = (PV max − PV) / PV max ; `d` = distance à la cible. Colonne « a = 0,5 » : valeur à l'agressivité par défaut (50).

| Décision | Balanced | Aggressive | Defensive |
|---|---|---|---|
| Soin | `perte >= 0,15 + 0,10a` (0,20) | `vie <= 0,40 − 0,15a` (0,325) | `vie <= 0,90 − 0,15a` (0,825) ou `perte >= 0,35` |
| Soin si menace | en plus : `d <= 10`, `vie <= 0,70`, `perte >= 0,10` | en plus : `d <= 10`, `vie <= 0,50` | en plus : `d <= 10`, `vie <= 0,80`, `perte >= 0,08` |
| Bouclier | `d <= portée de menace` et `vie <= 0,95 − 0,20a` (0,85) | `vie <= 0,45 − 0,15a` (0,375) et `d <= portée de menace` | `d <= portée de menace + 1` et `vie <= 0,98 − 0,10a` (0,93) |
| Repli (trop près et blessé) | `d < max(2, minRange − 1)` et `vie <= 0,55 − 0,20a` (0,45) | idem avec `vie <= 0,30 − 0,15a` (0,225) | idem avec `vie <= 0,80 − 0,10a` (0,75) |
| Repli (préventif) | `d <= 8` et `vie <= 0,40` | `d <= 1` et `vie <= 0,50`, ou `d <= 10` et `vie <= 0,25` | `d <= 7` et `vie <= 0,55 − 0,10a` (0,50) |
| Chip d'attaque | `vie >= 0,50 − 0,20a` (0,40) | `vie >= 0,45 − 0,25a` (0,325) | `vie >= 0,75 − 0,20a` (0,65) |
| Pénalité d'arme (par unité d'écart de portée moyenne) | `0,045 − 0,015a` | `0,02 − 0,01a` | `0,07 − 0,015a` |

- Score d'arme = dégâts moyens du tour − pénalité × |portée moyenne préférée − portée moyenne de l'arme|. L'arme au meilleur score est choisie.
- La portée de menace du bouclier est `PM de l'ennemi + portée max de son arme` (à défaut, la portée max de l'arme choisie).
- Le soin n'est planifié que si le chip `bandage` est équipé, prêt, abordable en PT, soigne moins que la vie perdue, et qu'il ne vaut pas mieux tirer : on saute le soin si `dégâts moyens par PT × coût du soin > 2 × soin moyen` (`shouldSkipHealForDamage`).
- `LeekStrategy` (classe de base, repli à 0,45 − 0,10a) n'est pas instanciée par `createStrategy` ; elle sert de base commune.

## Priorité défense / attaque (séquence historique)

`predictContactNextTurn` estime, à partir de la distance, des PM restants et des portées max, qui peut tirer au prochain tour.

- **Défense prioritaire** : l'ennemi peut tirer et pas moi, **ou** les deux peuvent tirer et `vie <= 0,60`. Le bouclier est alors tenté avant le soin, et si un bouclier est planifié le soin est sauté ce tour-là.
- **Attaque favorable** : je peux tirer et pas l'ennemi.

## Comportements de déplacement historiques (`MovementBehavior`)

Choisis dans `planMove` quand l'arme ne peut pas tirer sur la cible (PM restants > 0), selon `predictContactNextTurn` :

| Situation | Comportement |
|---|---|
| L'ennemi peut tirer, pas moi | `retreat_to_corner` : choisit l'obstacle maximisant `distance(ennemi, obstacle) − 0,1 × distance(moi, obstacle)` (loin de l'ennemi, légère pénalité de distance depuis moi), puis se dirige vers une cellule **libre** (`empty`) voisine de cet obstacle, strictement plus loin de l'ennemi que moi (meilleur score `distance(ennemi, cellule) − 0,1 × distance(moi, cellule)`) ; sinon fuite directe `moveAwayFrom` |
| Je peux tirer, pas l'ennemi | `aggressive_kiting` : reste vers la distance moyenne des portées max |
| Les deux peuvent tirer | `zone_control` : phase d'approche (avance si je ne peux pas tirer, ne recule jamais avant de tirer) ; phase de recul planifiée **après** les tirs (voir ci-dessous) |
| Aucun ne peut tirer | `simple_advance` |

**Recul de `zone_control` (`planRetreatAfterShoot`)** : déplacer ne coûte pas de PT, donc on tire d'abord puis on recule avec les PM restants. Conditions (toutes requises) : repli autorisé par le profil (`allowHiding`), au moins une attaque (tir ou chip) planifiée, `mpLeft > 0`, ennemi vivant, ennemi à portée d'atteinte, et un recul de `mpLeft` cases peut en sortir. Avec `d` la distance, `PM_e` les PM de l'ennemi et `R_e` la portée max de son arme (1 si inconnue) :

- à portée d'atteinte : `d − PM_e <= R_e` (la borne `d == R_e` avec `PM_e = 0` est donc incluse) ;
- sortie possible : `d + mpLeft − PM_e > R_e` (optimiste : suppose que `moveAwayFrom` gagne `mpLeft` cases ; murs et obstacles peuvent en gagner moins).

Si ces conditions sont réunies, l'action `retreat after shoot` est ajoutée après les tirs, `mpLeft` passe à 0 (`planHide` ne double pas le déplacement) ; à l'exécution, `executeZoneRetreat` revérifie `d − PM_e <= R_e` avant `moveAwayFrom`. Si l'ennemi ne peut pas m'atteindre, ou si je ne peux pas en sortir, je reste en place (pas de recul inutile).

`terrain_aware` et `simple_retreat` existent mais ne sont pas sélectionnés par `getOptimalBehavior`. Le repli de `planHide` utilise toujours `retreat_to_corner` et consomme tous les PM restants.

## Mémoire de l'adversaire

Mémoire (`src/Classes/Context/EnemyMemory.ts`, `EnemyProfile.ts`) : `turn()` la met à jour avant `planAct` et transmet maintenant ses **cartes du tour**, pas les profils ni le journal des coups. Les cooldowns/items connus et maxima de PT/PM influencent indirectement la carte de danger. Une erreur de collecte est journalisée (`reportError`) sans interrompre le tour ; des cartes insuffisantes entraînent le repli historique explicite. Instance exportée : `enemyMemory` dans `Kassbi_Class.ts`.

**Stocké par ennemi vivant** (`EnemyProfile`) : id, nom, niveau, PV max, caractéristiques (force, agilité, sagesse, résistance, science, magie) à l'identification ; armes et puces connues (`weapons`, `chips`, enrichies des items observés) ; arme équipée ; items observés avec premier/dernier tour et nombre d'usages ; cooldowns suivis ; journal des coups (borné à `MAX_HIT_LOG` = 20, les plus anciens sont supprimés). Lecture : `getProfile`, `knownWeapons`, `observedWeapons`, `observedChips`, `maxKnownWeaponRange`, `getCooldown(id, chip)`, `isChipReady(id, chip)` (ennemi inconnu : 0 / prête).

**Usages détectés** (à chaque tour de mon IA) : arme équipée vue ; effets de `entity.launchedEffects` et de `me.effects` dont le lanceur est l'ennemi. Un effet déjà vu et toujours actif n'est pas recompté ; il l'est si sa durée restante dépasse `turns_précédent − tours_écoulés` (relancé) ou s'il avait expiré. La clé de suivi est « item:cible » ; quand un item pose plusieurs effets de durées différentes sur la même cible, c'est la plus grande durée restante de l'appel qui est retenue (l'item n'est compté qu'une fois, et l'effet long encore actif au tour suivant n'est pas pris pour un nouvel usage). Un id numérique d'item n'est résolu que s'il correspond à un seul item connu de l'ennemi (les ids d'armes et de puces peuvent se recouvrir).

**Cooldowns** : à l'usage détecté d'une puce, cooldown suivi = `chip.cooldown` (infini, `< 0` : `INFINITE_COOLDOWN` = 66 = `MAX_TURNS + 2`) ; il diminue de 1 par tour écoulé (`Fight.turn` courant − dernier tour traité, un saut de plusieurs tours décrémente d'autant), minimum 0. Une puce sans cooldown n'est pas suivie. La détection a lieu à mon tour : l'usage réel date d'un tour ennemi antérieur, le cooldown suivi peut donc être **surestimé jusqu'à ~1 tour**.

**Coups reçus** : `endMyTurn` mémorise mes PV en fin de tour ; au tour suivant, la perte = PV mémorisés − PV actuels.

1. Effets de dégâts/poison lancés par l'ennemi sur moi : journalisés « effect » (montant = valeur de l'effet, supposé appliqué une fois par tour) et soustraits de la perte.
2. Perte restante > 0 et un seul ennemi vivant : candidats = arme équipée de l'ennemi + puces offensives (effet `DAMAGE`) connues dont le cooldown suivi est 0. Plage compatible si `perte + 1 ≥ min × (1 + force/100)` et `perte − 1 ≤ max × (1 + force/100) × 1,3 × utilisations × tours_écoulés`. `1,3` = `CRITICAL_FACTOR` (doc officielle) ; utilisations = `floor(PT max vus / coût)` (au moins 1) pour une arme, 1 pour une puce à cooldown. Un seul candidat compatible → « inferred » avec l'item ; zéro ou plusieurs → « ambiguous », item `null`. Plusieurs ennemis vivants : toujours « ambiguous ». Limite connue : la perte de PV étant propre à moi et non à un ennemi, avec N ennemis vivants la même perte « ambiguous » est journalisée dans le journal de chacun des N ennemis (comptée N fois si on additionne les journaux) ; non corrigé car `update` travaille ennemi par ennemi et la corriger exigerait une API de mise à jour groupée.
3. Une inférence n'ajoute **pas** l'item aux items observés et ne pose **pas** de cooldown (seuls les effets le font).

**Limites** : heuristique. Les dégâts instantanés (arme, caillou, foudre) n'apparaissent pas dans `getEffects` ; les boucliers, soins, vol de vie, érosion et zones de dégâts faussent la perte ; les combinaisons arme + puce dans un même tour ne sont pas modélisées (probablement « ambiguous ») ; `entity.tp` lu pendant mon tour n'est pas forcément le TP de l'ennemi pendant le sien (on garde le maximum vu). Non vérifié dans l'API : la forme de `effect.caster`/`item`/`target` (objet ou id, les deux sont gérés), `Chip.cooldown = -1` pour un cooldown infini en TypeScript, et que `chip.currentCooldown` d'une puce d'un ennemi reflète son cooldown (non utilisé).

### Cases atteignables (`ReachableCells.ts`)

Données utilisées par le planificateur conjoint (ma zone), la carte de danger et les visualisations. Au début de chaque tour, après l'identification des ennemis et avant `planAct`, `turn()` appelle `enemyMemory.updateReachable(me, alliés, ennemis vivants, Fight.turn)` (try/catch + `reportError`, fonction `observeReachableCells` ; un seul log `[Reachable] me:23 (3 MP), ally#5:12 (2 MP), enemy#2:13 (2 MP)` par tour). Seul `Kassbi_Class.ts` est branché ; `Kassbi_test.ts` ne l'est pas.

- **Calcul** : `computeReachableCells(entity, mp, turn)` = parcours en largeur depuis `entity.cell`, au plus `mp` pas. Résultat : cases atteignables avec leur coût en PM (case de départ incluse, coût 0), `mp` utilisés, tour, drapeau `truncated` ; `canReach(cell)`, `costTo(cell)` (`null` si inatteignable), `size`, `cells()`, `entries()`. Pas d'appel à `Field.pathLength` : seulement `Field.cellFromXY`, une fois par coordonnée, soit au plus ~4 appels par case atteinte.
- **Plafond de sécurité** : `MAX_REACHABLE_CELLS` = 500 cases retenues (un losange complet va jusqu'à 15 PM = 481 cases ; la carte en compte 613 au plus). Au-delà, `truncated = true` : toutes les cases de coût < c et une partie de celles de coût c.
- **PM utilisés** : moi → `me.mp` du tour courant. Allié/ennemi → plus grand `entity.mp` vu pendant mon tour (`maxMpSeen`), hypothèse : ce sont ses PM du prochain tour. Stockés dans le profil (`reachableMp`, `reachableTurn`, `reachable`). Conséquences : un autre poireau vu la première fois avec `mp` = 0 (PM restants de son dernier tour ?) n'a que sa case de départ jusqu'à ce qu'une valeur plus grande soit observée ; un bonus/malus de PM temporaire fausse le maximum (non décrémenté).
- **Voisinage** : 4-connexité `(x ± 1, y)`, `(x, y ± 1)`, isolée dans `MOVE_NEIGHBOR_OFFSETS`. Non vérifiée en combat réel (même hypothèse que `findRetreatCell`, qui garde sa propre constante).
- **Cases bloquantes** : hors grille (`cellFromXY` = `null`), `Cell.obstacle`, ou `Cell.entity` d'une autre entité (alliée ou ennemie : hypothèse qu'une entité bloque le passage, y compris pour ses alliés). `Cell.empty` n'est pas utilisé (sens vis-à-vis des entités non vérifié). Les autres entités sont considérées immobiles pendant le déplacement ; leur position est celle du début de mon tour.
- **Profils** : `EntityProfile` (base : id, nom, niveau, `maxMpSeen`, `reachable`) ; `EnemyProfile` en hérite (tests existants inchangés). Moi et mes alliés ont un `EntityProfile` (hors `has`/`getProfile`, réservés aux ennemis). Lecture : `getReachable(id)`, `getEntityProfile(id)`. Une entrée par entité, `reachable` remplacé à chaque tour ; pas de recalcul si le tour, la case de départ et les PM sont identiques (appel répété dans le même tour). Entité morte (`life <= 0` ou absente de la liste des vivants) : profil allié supprimé ; pour un ennemi, `reachable` est effacé et le profil conservé (il porte la mémoire existante).
- **Limites** : photographie du début de mon tour, périmée dès que quelqu'un bouge ; ne tient compte ni des effets de zone ni du coût réel des déplacements du moteur ; `Fight.getAllies()` pourrait inclure les alliés morts (vérifié par `life > 0`, non confirmé dans la doc) ; coût en ops non mesuré.
- **Option `ignoreEntityId`** : `computeReachableCells(entity, mp, turn, { ignoreEntityId })` traite la case de cette entité comme libre (utilisée pour la carte de danger). Sans option, comportement inchangé.

### Carte de danger (`ThreatMap.ts`, `ShotPlan.ts`, `LaunchPattern.ts`)

Carte utilisée par le planificateur conjoint pour le danger final ; l'historique `Plannification` ne la lit pas. Au début de chaque tour, après `observeReachableCells` et avant `planAct`, `turn()` appelle `enemyMemory.updateThreatMap(me, ennemis vivants, Fight.turn)` (fonction `observeThreatMap`, try/catch + `reportError` ; un seul log par tour : `[Threat] 23/23 cells, danger max 15.0 min 0.0, safest (5,5), 1 armed enemies, 299 pairs, 0 LoS`, ou `[Threat] unavailable` si mes cases atteignables du tour manquent). Son coût est inclus dans la ligne `Operations:` de `logTurnOperations`. Lecture : `enemyMemory.getThreatMap()` (une seule carte, remplacée à chaque tour) → `dangerAt(cell)` (`null` hors carte), `breakdownAt(cell)`, `entries()`, `maxDanger`, `minDanger`, `safestCells()`, `size`, `turn`, `truncated`, `inputsTruncated`, `pairsEvaluated`, `lineOfSightCalls`.

**Règles** (valeurs et formules) :

1. Une entrée par case que je peux atteindre (`ReachableCells` de moi, case actuelle incluse). Danger = Σ sur les ennemis de leurs meilleurs dégâts potentiels sur cette case.
2. Arme prise en compte : l'arme ÉQUIPÉE de l'ennemi (`entity.weapon`) uniquement. Dégâts moyens d'un tir = Σ (`minValue` + `maxValue`) / 2 des features `Effect.DAMAGE` × (1 + force / 100) (même formule que `Plannification`), sans critique (pas de × 1,3), sans mes boucliers ni ma résistance : valeur brute.
3. Tirs d'arme = `floor(PT / coût)` plafonné par `weapon.maxUses` (`-1` ou propriété absente : pas de plafond ; `0` lu littéralement = aucun tir). PT = `max(maxTpSeen, entity.tp)` (`maxTpSeen` existait déjà dans `EnemyProfile`). Coût ≤ 0 ou non fini : item ignoré.
4. Puces : connues de l'ennemi (`knownChips`), avec au moins une feature `DAMAGE`, **prêtes** (`isChipReady` : cooldown suivi = 0) et de coût ≤ PT. Une puce n'est candidate que si (dégâts moyens / coût) > (dégâts moyens de l'arme / coût de l'arme), comparaison stricte, **quand l'arme peut aussi toucher depuis la case de tir** ; si l'arme ne touche pas (ou n'existe pas), toute puce offensive utilisable est candidate. Plusieurs puces : tri par dégâts/PT décroissant (stable), prises tant qu'elles tiennent dans les PT restants (glouton, pas d'optimum exact). Chaque puce au plus une fois par plan (lecture prudente de « une puce n'est utilisée qu'une fois par tour », quel que soit son cooldown) ; `maxUses` = 0 l'exclut. Dégâts du plan = Σ puces + tirs d'arme avec les PT restants (`floor((PT − coûts) / coût arme)`, plafonné par `maxUses`). Le plan « arme seule » est toujours calculé ; le meilleur des deux est retenu (à égalité : arme seule), donc jamais moins que l'arme seule. Les tirs d'items alternatifs ne sont jamais additionnés : un plan = une combinaison réalisable avec les PT.
5. Portée par item : depuis une case de tir S, un plan ne contient que les items qui touchent ma case X depuis S : distance de Manhattan `|dx| + |dy|` dans `[minRange, maxRange]`, puis motif du type de lancer (`isCellInLaunchPattern`), puis `Field.lineOfSight(S, X)` seulement si `item.needsLos` (mémorisée par paire ordonnée (S, X) pendant la construction ; appelée après les filtres géométriques seulement). Valeur de X pour un ennemi = MAX sur toutes ses cases de tir S ; pas de somme entre cases S. À égalité, la case S la moins coûteuse en PM est conservée. L'ennemi ne peut pas tirer depuis X elle-même (j'y serais).
6. Plusieurs ennemis : valeurs additionnées par case ; `breakdownAt(cell)` garde, par ennemi (dégâts > 0), les dégâts, la case de tir S retenue, l'arme, le nombre de tirs et les puces du plan.
7. Cases de tir de l'ennemi = ses cases atteignables avec `maxMpSeen` PM EN IGNORANT mon entité (`computeReachableCells(..., { ignoreEntityId: me.id })`), recalculées à la volée à chaque tour (un parcours de plus par ennemi offensif, ≤ ~4 × 500 appels à `Field.cellFromXY`, non stocké). Un ennemi sans item offensif exploitable n'est pas parcouru du tout.
8. Garde-fou : `MAX_THREAT_PAIRS` = 8 000 paires (S, X) examinées par carte, tous ennemis confondus (cas courant ≈ 1 000 par ennemi : 41 × 25 pour 4 PM de l'ennemi et 3 des miens). Au-delà, `truncated = true` : seules les cases X évaluées pour tous les ennemis sont conservées (les autres sont absentes, jamais présentées comme sûres) ; la carte ne contient alors que des cases proches de moi (ordre du parcours en largeur). `inputsTruncated` signale qu'une `ReachableCells` en entrée (ma carte ou celle d'un ennemi, plafond 500) était elle-même tronquée.

**Hypothèses non vérifiées** :

1. **Masque de lancer** : `launchType` lu comme un masque de bits, 1 = cases alignées (dx = 0 ou dy = 0), 2 = diagonales (|dx| = |dy| ≠ 0), 4 = autres. LINE=1, DIAGONAL=2, STAR=3 (lignes + diagonales), STAR_INVERTED=4 (autres seulement), DIAGONAL_INVERTED=5 (lignes + autres), LINE_INVERTED=6 (diagonales + autres), CIRCLE=7 (tout). Seule la valeur de `LAUNCH_TYPE_LINE` = 1 est confirmée par la doc. Table isolée dans `isCellInLaunchPattern`. `launchType` absent ou hors 1..7 : traité comme CIRCLE.
2. **Force** : `entity.strength` inclut déjà les buffs en cours (« boost actuel ») ; les effets `BUFF_STRENGTH` ne sont pas ajoutés.
3. **PT** : `entity.tp` lu pendant mon tour peut être les PT restants de l'ennemi ; le maximum observé (`maxTpSeen`) estime ses PT au prochain tour (jamais décrémenté : un bonus/malus temporaire fausse le maximum).
4. **Ligne de vue** : `Field.lineOfSight` ne tient peut-être pas compte des entités (seulement du terrain) ; dans le jeu une entité pourrait bloquer la vue.
5. **Tir après déplacement** : l'ennemi se déplace jusqu'à S puis tire tout (pas de tir-déplacement-tir, pas de mouvement entre deux tirs).
6. **Ignorer mon entité** : ma case actuelle est libre pour lui (je pars peut-être). Mais ma case de destination X n'est pas traitée comme obstacle sur son trajet (surestimation possible), les autres entités restent des obstacles à leur position de début de tour, et deux ennemis peuvent partager la même case de tir.
7. **Cooldowns** : l'état `isChipReady` est une estimation (voir « Mémoire de l'adversaire ») ; la nature offensive d'une puce vient de ses features `DAMAGE`.
8. **API** : `Weapon`/`Chip` portent `launchType`, `area`, `maxUses` (encyclopédie JavaScript/TypeScript ; `-1` = illimité selon `getWeaponMaxUses`) ; déclarés optionnels dans `types/leekwars.d.ts`. La forme exacte des valeurs TypeScript n'est pas vérifiée en combat.

**Hors périmètre (limites)** : zone d'effet (`area`) autour de la cible, poison et dégâts sur la durée, changement d'arme, critiques, boucliers/résistance, soins/vol de vie, dégâts de tir sur mes alliés, tir sur une case autre que X, usages multiples d'une même puce. La méthode géométrique est un fournisseur interchangeable (`ShotCellsProvider.canHit`) : une version native via `Fight.weaponCells(cell, item)` pourra la remplacer ; elle n'est pas implémentée. Coût en ops non mesuré ; borne : ≤ 8 000 paires × (1 + nombre de puces offensives) appels `canHit`, et au plus autant d'appels à `Field.lineOfSight` (une fois par paire (S, X), tous items confondus).

## Journalisation par contexte (`Toolbox/Logger.ts`)

Toute sortie texte du log de combat passe par une seule fonction, `log(texte, contexte, options?)`. `Logger.ts` est le seul fichier de `src/` qui appelle réellement `console.log` / `Debug.log` ; `Marker.ts` est le seul qui appelle `Debug.mark` / `markText` / `clearMarks` / `pause` / `show` (les deux garanties sont testées par `tests/logging-policy.test.mjs`, sans autre exception). Les sorties visuelles prennent aussi un contexte (voir « Marques et pauses » ci-dessous).

- **Défaut : tous les contextes actifs**, même sans init explicite. `LogConfig` porte un drapeau par contexte : `isEnabled(c)`, `setEnabled(c, bool)`, `setAll(bool)`, `enabledContexts()`. `Kassbi_Class.ts` (et `Kassbi_test.ts`) crée `leekLogConfig` (tous actifs) et l'installe à l'import par `initLeekLogging(leekLogConfig)`. Désactiver un contexte : `leekLogConfig.setEnabled(LOG_CONTEXT.WEAPON, false)`. `resetLeekLogging()` réinstalle une configuration neuve, tous actifs (tests).
- **Texte inchangé, sans préfixe** : actif → `console.log(texte)` ; inactif → aucune sortie. Les formats existants (`=== KASSBI TURN END ===`, `Operations: …`, `[Reachable] …`, `[Threat] …`) sont conservés ; l'ordre de fin de tour reste TURN END puis `Operations:` en dernier.
- **Version paresseuse** : `texte` peut être `() => string`, évaluée seulement si le contexte est actif (évite gabarits de chaîne, `toFixed`, appels d'API comme `me.distance` quand c'est désactivé). `isLogEnabled(c)` permet d'éviter une boucle avant d'appeler `log` (utilisé par les dumps `debugSet`, `debugMap`, `ShootingOption(s)`, `CombatLogger.printDecisions`).
- **Canal** : `console.log` par défaut. Avec `options.color`, `Debug.log(texte, couleur)` (console.log ne colore pas : bannières de tour et lignes d'opérations gardent leur couleur). `reportError` utilise `options.sink = "debug"` (canal `Debug.log`) sous le contexte `ERROR`. Repli sur l'autre canal si l'un est indisponible.
- **ERROR en rouge** : tout message du contexte `ERROR` sans couleur explicite sort par `Debug.log(texte, Color.rgb(255, 0, 0))` (le texte est inchangé). Doc officielle : `debugE(objet)` existe en LeekScript (« les messages d'erreur apparaissent en rouge dans le rapport de combat ») mais **aucun équivalent TypeScript** (`Debug.error`, `Debug.warn`…) n'est documenté : il n'est ni utilisé ni déclaré. La page `debug` ne montre que `Debug.log(x)` à un argument ; la forme `Debug.log(valeur, couleur)` (équivalent supposé de `debugC`, LeekScript seul) **n'est pas confirmée** pour TypeScript. Garde-fous : si l'appel à 2 arguments lève, repli sur `Debug.log(valeur)` (message conservé, sans rouge) ; sans `Color` ou sans `Debug.log`, repli sur `console.log`. Désactiver `ERROR` masque toujours les erreurs (même test d'activation que les autres contextes).
- **ERROR est configurable** : le désactiver masque aussi les rapports de `reportError` / `withErrorReporting` (l'erreur est quand même relancée).
- **Ne lève jamais** : configuration invalide (→ défaut), texte non chaîne (transmis tel quel), texte paresseux qui lève (rien n'est affiché, l'erreur est avalée), contexte inconnu (traité comme inactif), console absente.

| Contexte | Logs rattachés |
|---|---|
| `SYSTEM` | `=== KASSBI TURN START/END ===`, bannières `debugBeginTurn` / `debugEndTurn` (début/fin de tour) |
| `COMBAT` | `My HP…`, `Enemy: …`, `Enemy HP: …` (état du combat), `CombatLogger.printDecisions` |
| `SPEECH` | `[Speech] Greeting`, `[Speech] Taunt` |
| `MEMORY` | `[EnemyMemory] Identified / observed / hit` |
| `REACHABLE` | `[Reachable] …` |
| `THREAT` | `[Threat] …` et `[Threat] unavailable` |
| `OPERATIONS` | `Operations: …` (`logTurnOperations`), `Operations.debugOperations` (en plus de `DEBUGS.OPERATIONS`), ligne `OPERATIONS:` de `debugEndTurn` |
| `ERROR` | `reportError` (JSON) |
| `WEAPON` | Plannification : `Weapon …`, `ChosenWeapon`, `EquipWeapon`, `SkipEquipWeapon`, `Shoot`, `SkipShoot` ; `simpleActionSequence` (« No equipped weapon… ») |
| `MOVEMENT` | Plannification : `Move`, `SkipMove`, `Hide`, `RetreatAfterShoot` |
| `ARMOR` | Plannification : `Shield (defense priority)`, `Shield (after healing)` |
| `CHIP` | Plannification : `AttackChip`, `Heal`, `SkipHeal` |
| `STRATEGY` | Plannification : `PredictContactNextTurn`, `ChipsAfterShoot`, `SkipChipsAfterShoot`, `HideCheck`, `SkipHide`, `RetreatCheck`, `SkipRetreatAfterShoot` |
| `PLANNING` | Plannification : `Execute`, `  → action`, `Done`, `SkipShootOrChip` ; plans `[Tactical]`, repli explicite et interruptions d'exécution |
| `SHOOTING` | `ShootingOption.debugUsedItems`, `ShootingOptions.debugDamagingItems` / `debugShootingOptions` |
| `DEBUG` | `debugSet`, `debugMap`, `Tests/testWorld.ts` ; marques `Coordinates.mark` / `markArray` |
| `ACCESSIBLE_ZONE` | « Accessible zone » : `Accessible zone: <nom> (<n> cells, <mp> MP)` + marques + pause (voir ci-dessous) |
| `DANGER_ZONE` | « Danger zone » : `Danger zone: <n> cells, max <x>` + marques + pause (voir ci-dessous) |

### Marques et pauses (`Toolbox/Marker.ts`)

Toute sortie visuelle passe par `markCells`, `markTextCells`, `clearAllMarks`, `pauseFight` (primitives : paramètre `context`, et `gate` pour un ancien drapeau `DEBUGS.*`) et par les deux séquences `showAccessibleZones` et `showDangerZone`. Aucune fonction ne lève ; contexte inactif → **aucun** appel `Debug.*`, aucun calcul de liste de cases ni de couleur (`Color.rgb` n'est appelé que pour une sortie réelle). Ces sorties sont purement visuelles : `planAct` n'en lit rien, aucune décision tactique ne change. Marques visibles seulement du fermier de l'entité (doc).

- **Défaut : actifs** (comme tous les contextes). Désactiver : `leekLogConfig.setEnabled(LOG_CONTEXT.ACCESSIBLE_ZONE, false)` et/ou `…DANGER_ZONE, false` (ou `setAll(false)`). Les pauses ralentissent la relecture : prévoir de les couper hors mise au point.
- **Zone accessible** (`Kassbi_Class.turn`, après `observeReachableCells`) : pour chaque poireau vivant, dans l'ordre moi, alliés, ennemis : `clearMarks` → log du nom → `mark` de ses cases atteignables (une couleur par camp : moi bleu, allié vert, ennemi rouge) → `markText` de son nom (10 caractères max) sur sa case → `pause`. Puis `clearMarks` final. Les `Cell` viennent de `ReachableCells.cells()` (stockées) : **aucun appel à `Field.cellFromXY`** de plus. Poireau sans zone calculée (mort, inconnu) : ignoré.
- **Zone de danger** (`turn`, après `observeThreatMap`, mon poireau seulement) : `clearMarks` → log → un `mark` par palier de danger relatif (5 paliers, vert → rouge ; palier = `min(4, floor(5 × danger / dangerMax))`, tout vert si dangerMax = 0), un `markText` par **texte distinct** (dégâts arrondis, au plus 10 caractères, ≤ 9 999 999 999 ; cases de même texte regroupées) → `pause` → `clearMarks`. Seules les cases **évaluées** sont marquées (une carte tronquée laisse les autres vierges) ; carte absente ou vide : rien. Plafond : `MARKER_SETTINGS.maxDangerTextCalls` = 120 appels `markText` (les cases les plus proches d'abord ; les autres restent colorées sans texte). Pause modifiable : `MARKER_SETTINGS.dangerZonePause` (défaut vrai) ; si faux, pas de pause **et pas de `clearMarks` final** (il rendrait les marques invisibles) : elles restent jusqu'au prochain `clearMarks` (début de la séquence suivante).
- **Formes d'API utilisées** : `Debug.mark(cells, color)` (doc TypeScript), `Debug.markText(cells, text, color)`, `Debug.clearMarks()`, `Debug.pause()`. La table TypeScript documente `markText(cells, text)` ; l'argument `color` n'est documenté qu'en LeekScript (repli sur `markText(cells, text)` si l'appel à 3 arguments lève). La forme « map cellule → texte » est documentée pour LeekScript, **non confirmée en TypeScript** (forme d'objet inconnue) : non utilisée ; on regroupe par texte avec un tableau de cases. Pas de `duration` passée (non confirmée en TS) : les marques sont effacées explicitement.
- **Coût estimé (non mesuré en TypeScript)** : la doc LeekScript donne 164 opérations pour `mark` et `markText`, 30 pour `pause`, 15 pour `clearMarks`, 100 pour `debug`. Zone accessible ≈ (15 + 100 + 164 + 164 + 30) ≈ 470 ops par poireau + construction de la liste de cases (≤ 500 par poireau) ; zone de danger ≈ jusqu'à 5 × 164 + 120 × 164 ≈ 20 500 ops au plus (en pratique nettement moins : peu de textes distincts). Le coût réel apparaît dans la ligne `Operations:` de fin de tour ; pour l'éviter, désactiver les contextes.
- **Anciens marquages `DEBUGS.*`** (faux par défaut, inchangés) : une sortie exige le **contexte actif ET le drapeau vrai**. `debugPause` (`CONST_DEBUG_PAUSE`) → contexte `SYSTEM` ; pause de `Operations.debugOperations` (`DEBUGS.OPERATIONS`) → contexte `OPERATIONS`. `Coordinates.mark` / `markArray` n'ont pas de drapeau : contexte `DEBUG` seul (une case inexistante lève toujours `RangeError`). `CONST_MARK_DANGERMAP`, `CONST_REACHABLE_CELLS`, `MARK_CELLS_TO_SHOOT_FROM`, `SAFE_PLACES` ne sont lus nulle part aujourd'hui (aucun marquage correspondant dans `ShootingOption(s)` ni `Brain/`).
- **Hypothèses non vérifiées** : durée par défaut des marques (non passée) ; effet réel de `pause()` dans un combat hors test (doc : « met en pause le combat, uniquement pour le fermier ») et son éventuelle limite ; coût réel en opérations ; troncature à 10 caractères du texte (doc LeekScript) ; lisibilité d'un texte blanc sur les couleurs choisies ; `Debug.log(valeur, couleur)` en TypeScript.

Limites : le préfixe `[Plannification] ` est ajouté par `Plannification.debug(message, contexte)` (texte inchangé). Un log paresseux désactivé coûte encore la création de la fermeture et l'appel à `log` (coût en ops non mesuré). Le canal `Debug.log` (couleur, erreurs) et `console.log` sont supposés tous deux visibles dans le log de combat : non vérifié en combat réel. Un texte paresseux qui lève n'est plus signalé par `reportError`.

## Points à vérifier

- `findRetreatCell` suppose que les voisins orthogonaux d'une cellule sont `(x ± 1, y)` et `(x, y ± 1)`, que `Cell.empty` signifie « ni obstacle ni entité » et que `Field.distance` est cohérent avec `Entity.distance` ; non vérifié contre l'API de combat réelle (les tests utilisent des mocks). Seuls les voisins de l'obstacle le mieux noté sont essayés : sans voisin valide, repli sur `moveAwayFrom`.
- Le recul après tir suppose que `moveAwayFrom` éloigne réellement de `mpLeft` cases ; un terrain contraint peut laisser l'IA à portée de l'ennemi (sans pire que rester).
- Dans l'ordre critique, le repli précède les tirs ; une arme à courte portée peut donc ne plus tirer après le repli (tirs gardés par `canUseWeapon`, pas d'erreur mais PT non dépensés). La chip d'attaque n'est pas gardée à l'exécution (échec silencieux de `useChip` si hors portée).
- `LeekProfile` a `preferredMinRange = 1` par défaut, alors que `planAct` crée un profil avec 3–8 : le comportement dépend de qui construit le profil.
- Les types de `types/leekwars.d.ts` sont un sous-ensemble local de l'API du jeu ; les comportements de `Field`, `Chip` et `Fight` en combat réel ne sont pas validés par les tests.

## Comment tester une modification

- Un changement de seuil s'accompagne d'un test dans `tests/strategy.test.mjs` ou `tests/threat-aware-strategy.test.mjs` : valeur juste en dessous et au-dessus du seuil, pour chaque stratégie touchée.
- Un changement d'ordre de planification ou de déplacement s'accompagne d'un test exécutant `planAct` sur un monde simulé (voir `tests/movement-planning.test.mjs`).
- `npm test` (construit `dist/` puis lance les tests) et `npm run typecheck` doivent passer.
- Ces tests valident la logique de décision, pas la force en combat : comparer deux variantes demande des combats réels ou simulés, à consigner dans la conversation ou dans `ChangeLog.md` (une ligne), pas en rapport.

## Historique

Les anciens rapports d'analyse ont été supprimés ; ils restent consultables dans l'historique Git. `ChangeLog.md` résume chaque changement en quelques lignes.
