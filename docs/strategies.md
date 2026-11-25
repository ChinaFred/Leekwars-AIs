# Stratégies de combat de Kassbi

Document de référence unique des décisions tactiques. Les valeurs ci-dessous sont celles du code (`src/Classes/Strategy/*.ts`, `src/Classes/Plannification/Plannification.ts`, `src/Brain/PlanActScenario.ts`) ; en cas d'écart, le code fait foi.

**Règle de maintenance** : tout changement de seuil, de condition ou d'ordre de planification met à jour ce fichier et ajoute ou ajuste un test de régression dans `tests/`.

## Chaîne de décision

1. [`turn()`](../src/Main/Kassbi_Class.ts) met d'abord à jour la mémoire de l'adversaire (voir plus bas, sans effet sur les décisions), puis appelle `planAct(me)` avec le profil par défaut : rôle `BALANCED`, agressivité 50, portée préférée 3–8, soin/bouclier/repli autorisés. L'entrée principale n'utilise donc aujourd'hui que `BalancedStrategy` ; `AggressiveStrategy` et `DefensiveStrategy` s'obtiennent en passant un autre `LeekProfile` à `planAct`.
2. `Plannification` choisit l'arme (`chooseWeapon`), l'équipe si besoin, puis planifie des actions exécutées d'un coup par `execute()`.
3. Ordre normal : `planMove` → `planShootOrChip` → `planChipsActionsAfterShoot` (bouclier, soin) → `planHide` → `planRetreatAfterShoot`.
4. Ordre « situation critique » : si `distance <= 8`, `vie <= 60 %` et `shouldHide` est vrai, l'ordre devient `planHide` → chips → tir → déplacement (→ `planRetreatAfterShoot`, ajouté en fin dans les deux ordres).
5. `planShootOrChip` ne dépend plus de `planMove` : le tir et la chip d'attaque sont planifiés quel que soit l'ordre (arme choisie si besoin). Dans l'ordre critique, le repli s'exécute avant les tirs, qui restent gardés à l'exécution par `canUseWeapon` : ils ne partent que si la cible est encore à portée après le repli.
6. `planRetreatAfterShoot` (recul de `zone_control`) est un no-op si `planHide` ou `planMove` ont déjà consommé les PM (`mpLeft = 0`), donc l'ordre critique n'est pas modifié et `planHide` garde la priorité.

## Profil (`LeekProfile`)

| Champ | Effet |
|---|---|
| `role` / `strategyName` | `AGGRESSIVE`, `DEFENSIVE` ou `BALANCED`. `ATTACKER` est converti en `AGGRESSIVE` ; toute autre valeur devient `BALANCED`. |
| `aggression` (0–100) | Ramenée dans [0, 100] ; ratio `a = aggression / 100` utilisé dans les formules. |
| `preferredMinRange` / `preferredMaxRange` | Portée visée pour le score d'arme et la distance de sécurité du repli. |
| `allowHealing`, `allowShielding`, `allowHiding` | Désactivent respectivement le soin, le bouclier et le repli. |

## Seuils par stratégie

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

## Priorité défense / attaque

`predictContactNextTurn` estime, à partir de la distance, des PM restants et des portées max, qui peut tirer au prochain tour.

- **Défense prioritaire** : l'ennemi peut tirer et pas moi, **ou** les deux peuvent tirer et `vie <= 0,60`. Le bouclier est alors tenté avant le soin, et si un bouclier est planifié le soin est sauté ce tour-là.
- **Attaque favorable** : je peux tirer et pas l'ennemi.

## Comportements de déplacement (`MovementBehavior`)

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

Collecte de données uniquement (`src/Classes/Context/EnemyMemory.ts`, `EnemyProfile.ts`) : **aucun effet sur la tactique**. `turn()` met la mémoire à jour avant `planAct(me)` mais ne la lui transmet pas ; une erreur de la mémoire est journalisée (`reportError`) sans interrompre le tour. Instance exportée : `enemyMemory` dans `Kassbi_Class.ts`.

**Stocké par ennemi vivant** (`EnemyProfile`) : id, nom, niveau, PV max, caractéristiques (force, agilité, sagesse, résistance, science, magie) à l'identification ; armes et puces connues (`weapons`, `chips`, enrichies des items observés) ; arme équipée ; items observés avec premier/dernier tour et nombre d'usages ; cooldowns suivis ; journal des coups (borné à `MAX_HIT_LOG` = 20, les plus anciens sont supprimés). Lecture : `getProfile`, `knownWeapons`, `observedWeapons`, `observedChips`, `maxKnownWeaponRange`, `getCooldown(id, chip)`, `isChipReady(id, chip)` (ennemi inconnu : 0 / prête).

**Usages détectés** (à chaque tour de mon IA) : arme équipée vue ; effets de `entity.launchedEffects` et de `me.effects` dont le lanceur est l'ennemi. Un effet déjà vu et toujours actif n'est pas recompté ; il l'est si sa durée restante dépasse `turns_précédent − tours_écoulés` (relancé) ou s'il avait expiré. La clé de suivi est « item:cible » ; quand un item pose plusieurs effets de durées différentes sur la même cible, c'est la plus grande durée restante de l'appel qui est retenue (l'item n'est compté qu'une fois, et l'effet long encore actif au tour suivant n'est pas pris pour un nouvel usage). Un id numérique d'item n'est résolu que s'il correspond à un seul item connu de l'ennemi (les ids d'armes et de puces peuvent se recouvrir).

**Cooldowns** : à l'usage détecté d'une puce, cooldown suivi = `chip.cooldown` (infini, `< 0` : `INFINITE_COOLDOWN` = 66 = `MAX_TURNS + 2`) ; il diminue de 1 par tour écoulé (`Fight.turn` courant − dernier tour traité, un saut de plusieurs tours décrémente d'autant), minimum 0. Une puce sans cooldown n'est pas suivie. La détection a lieu à mon tour : l'usage réel date d'un tour ennemi antérieur, le cooldown suivi peut donc être **surestimé jusqu'à ~1 tour**.

**Coups reçus** : `endMyTurn` mémorise mes PV en fin de tour ; au tour suivant, la perte = PV mémorisés − PV actuels.

1. Effets de dégâts/poison lancés par l'ennemi sur moi : journalisés « effect » (montant = valeur de l'effet, supposé appliqué une fois par tour) et soustraits de la perte.
2. Perte restante > 0 et un seul ennemi vivant : candidats = arme équipée de l'ennemi + puces offensives (effet `DAMAGE`) connues dont le cooldown suivi est 0. Plage compatible si `perte + 1 ≥ min × (1 + force/100)` et `perte − 1 ≤ max × (1 + force/100) × 1,3 × utilisations × tours_écoulés`. `1,3` = `CRITICAL_FACTOR` (doc officielle) ; utilisations = `floor(PT max vus / coût)` (au moins 1) pour une arme, 1 pour une puce à cooldown. Un seul candidat compatible → « inferred » avec l'item ; zéro ou plusieurs → « ambiguous », item `null`. Plusieurs ennemis vivants : toujours « ambiguous ». Limite connue : la perte de PV étant propre à moi et non à un ennemi, avec N ennemis vivants la même perte « ambiguous » est journalisée dans le journal de chacun des N ennemis (comptée N fois si on additionne les journaux) ; non corrigé car `update` travaille ennemi par ennemi et la corriger exigerait une API de mise à jour groupée.
3. Une inférence n'ajoute **pas** l'item aux items observés et ne pose **pas** de cooldown (seuls les effets le font).

**Limites** : heuristique. Les dégâts instantanés (arme, caillou, foudre) n'apparaissent pas dans `getEffects` ; les boucliers, soins, vol de vie, érosion et zones de dégâts faussent la perte ; les combinaisons arme + puce dans un même tour ne sont pas modélisées (probablement « ambiguous ») ; `entity.tp` lu pendant mon tour n'est pas forcément le TP de l'ennemi pendant le sien (on garde le maximum vu). Non vérifié dans l'API : la forme de `effect.caster`/`item`/`target` (objet ou id, les deux sont gérés), `Chip.cooldown = -1` pour un cooldown infini en TypeScript, et que `chip.currentCooldown` d'une puce d'un ennemi reflète son cooldown (non utilisé).

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
