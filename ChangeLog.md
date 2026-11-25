# Change Log

Les changements sont consignés ici sous forme d'entrées concises lors de la préparation d'un commit.

## 2026-11-25 — Client API Garden résilient au 401

- Ré-authentification unique, disjoncteurs, archivage interrompu après 3 refus et reconnexion au principal.

## 2026-11-25 — Plafond de recherche tactique à 30 %

- Le repli du tour 5 du combat 54939649 n'est plus perdu par l'abandon de la recherche (plafond relatif de 15 % à 30 %).

## 2026-11-25 — Agents allégés et tests consolidés

- Agents Copilot simplifiés, tests de stratégie et de menace regroupés en tableaux de cas.

## 2026-11-25 — Anticipation tactique et carte de menace

- Préparation des futurs tirs et replis, estimation des boucliers et des boosts adverses.

## 2026-11-25 — Archives Garden et messages de commit

- Archivage des combats et des versions publiées ; modèle et contrôle des messages de commit.

## 2026-11-25 — Plans tactiques et replis fiables

- Plan complet affiché avant exécution, déplacements en plusieurs phases et budgets de recherche et d'exécution distincts ; tests de régression.

## 2026-11-25 — Raccourci Windows pour Garden

- Ajout de `garden.cmd` et de ses instructions d'utilisation.

## 2026-11-25 — V1 tactique basée sur le risque

- Planification conjointe attaque, protection et déplacement selon la carte de danger, avec repli historique et tests de régression.

## 2026-11-25 — FEAT: erreurs en rouge, zone accessible et zone de danger affichées sur le terrain

- `Toolbox/Logger.ts` (v2) : le contexte `ERROR` sort en rouge via `Debug.log(texte, Color.rgb(255, 0, 0))` (texte inchangé ; repli sans couleur si l'appel à 2 arguments lève). Aucun équivalent TypeScript de `debugE` n'est documenté, la forme `Debug.log(valeur, couleur)` n'est pas confirmée en TS. Nouveaux contextes `ACCESSIBLE_ZONE` et `DANGER_ZONE` (18 contextes, actifs par défaut).
- `Toolbox/Marker.ts` (v1, nouveau) : seul module appelant `Debug.mark` / `markText` / `clearMarks` / `pause` / `show` ; `showAccessibleZones` (par poireau : clearMarks, log du nom, mark, markText, pause ; moi, alliés, ennemis ; clearMarks final) et `showDangerZone` (paliers vert → rouge, dégâts arrondis par case, plafond de 120 appels `markText`, pause modifiable). Appelés par `Kassbi_Class.ts` (v10) après `observeReachableCells` et `observeThreatMap`, sous try/catch + `reportError` ; aucun effet sur `planAct`.
- `Debug.ts` (v5) et `Coordinates.ts` (v2) : leurs `Debug.pause` / `Debug.mark` passent par `Marker.ts` ; les drapeaux `DEBUGS.*` (faux par défaut) restent requis, en plus du contexte actif. `types/leekwars.d.ts` : `markText`, `show`, `clearMarks` ajoutés (documentés dans la table TS ; `color` de `markText` optionnel).
- Tests : `tests/marker.test.mjs` (nouveau) ; `tests/logging-policy.test.mjs` étendu (visuel confiné à `Marker.ts`). Ajustements de `tests/logging.test.mjs` dus au changement voulu : ERROR passe par `Debug.log` en rouge (2 assertions), 2 nouveaux contextes dans la table des lignes de `turn()`, normalisation du nom d'allié dans les lignes comparées entre mondes (le nom figure maintenant dans le log).

## 2026-11-25 — FEAT: journalisation par contexte (`log(texte, contexte)`)

- `Toolbox/Logger.ts` (v1) : fonction unique `log(texte, contexte, options?)` (texte ou fonction paresseuse, jamais d'exception), `LOG_CONTEXT` (16 contextes fermés), `LogConfig` (un drapeau par contexte, tous actifs par défaut), `initLeekLogging`, `resetLeekLogging`, `isLogEnabled`. Désormais seul fichier appelant `console.log` / `Debug.log`.
- Tous les `console.log`, `Debug.log` et `Plannification.debug` convertis, textes inchangés (sans préfixe) : Debug.ts (v4, `reportError` sous `ERROR`, canal `Debug.log` conservé), Kassbi_Class.ts (v9, `leekLogConfig` installée à l'import), Kassbi_test.ts (v3), Plannification.ts (v9, `debug(message, contexte)`, drapeau `debugEnabled` toujours vrai supprimé), ShootingOption(s).ts (v2), CombatLogger.ts (v2), simpleActionSequence.ts (v2), Tests/testWorld.ts (v2). Les sorties visuelles `Debug.mark`/`pause` ne changent pas.
- Tests : `tests/logging.test.mjs`, `tests/logging-policy.test.mjs` (échoue si un appel direct apparaît hors Logger). Doc : `docs/strategies.md` (« Journalisation par contexte »).

## 2026-11-25 — FEAT: carte de danger de mon poireau (collecte seule)

- `Context/ThreatMap.ts` (v1, `buildThreatMap`, `ThreatMap`, fournisseur géométrique `ShotCellsProvider`/`GeometricShotCells`, garde-fou `MAX_THREAT_PAIRS` = 8 000), `Context/ShotPlan.ts` (v1, dégâts moyens, plan arme/puces sous contrainte de PT) et `Context/LaunchPattern.ts` (v1, `isCellInLaunchPattern`, masque de lancer supposé) : pour chaque case que je peux atteindre, dégâts potentiels maximaux des ennemis (arme équipée + puces prêtes, MAX sur leurs cases de tir, somme entre ennemis, détail par ennemi). `ReachableCells.ts` (v2) : option `ignoreEntityId`. `EnemyMemory` (v4) : `updateThreatMap`, `getThreatMap`. `types/leekwars.d.ts` : `launchType`, `area`, `maxUses` optionnels sur `Weapon`/`Chip`.
- Branché dans `turn()` (Kassbi_Class.ts v8) après les cases atteignables et avant `planAct` (try/catch + `reportError`, un log `[Threat]` par tour), sans aucun effet tactique. Tests : `tests/threat-map.test.mjs`. Doc et hypothèses non vérifiées : `docs/strategies.md` (« Carte de danger »).

## 2026-11-25 — FEAT: log des opérations en fin de tour

- `turn()` (Kassbi_Class.ts v7) journalise `Operations: 1234567/20000000 (6.2%)` après `=== KASSBI TURN END ===` ; `System.operations` est déjà relatif au tour (doc officielle), le total inclut tout sauf ce log. Helpers purs `operationsPercentage`, `formatOperationsLine` et `logTurnOperations` (ne lève jamais, System absent/max 0 → 0.0 %) dans Debug.ts (v3), `Operations.debugOperations` réutilise `operationsPercentage` (log inchangé). Tests : `tests/toolbox.test.mjs`, `tests/reachable-cells.test.mjs`.

## 2026-11-25 — FEAT: cases atteignables de chaque entité (collecte seule)

- `Context/ReachableCells.ts` (v1) : `computeReachableCells(entity, mp)`, parcours en largeur borné par les PM (4-connexité isolée dans `MOVE_NEIGHBOR_OFFSETS`, obstacles/entités/bords bloquants, plafond `MAX_REACHABLE_CELLS` = 500). `Context/EntityProfile.ts` (v1) : base de `EnemyProfile` (v2), avec `reachable`, `reachableMp`, `reachableTurn`, `maxMpSeen`. `EnemyMemory` (v3) : `updateReachable(me, alliés, ennemis, tour)`, `getReachable(id)`, `getEntityProfile(id)` ; PM des autres = maximum observé.
- Branché dans `turn()` (Kassbi_Class.ts v6) avant `planAct`, try/catch + `reportError`, sans effet sur la tactique. `Kassbi_test.ts` non branché. Tests : `tests/reachable-cells.test.mjs`. Doc : `docs/strategies.md`.

## 2026-11-25 — FEAT: mémoire de l'adversaire (collecte seule)

- `EnemyMemory`/`EnemyProfile` (Context, v1) : identification de l'ennemi, armes/puces observées via arme équipée et effets, cooldowns de ses puces, journal borné des coups (attribution heuristique) ; branchés dans `turn()` (Kassbi_Class.ts v5) avant `planAct`, sans effet sur la tactique. Types `Effect`, `Entity.tp/wisdom/effects/launchedEffects`, `Chip.cooldown` ajoutés. Tests : `tests/enemy-memory.test.mjs`.

## 2026-11-25 — FIX: cellule de repli, tir en ordre critique, recul de zone_control

- `findRetreatCell` (ex-`findNearestCorner`) : score `distance(ennemi, cellule) − 0,1 × distance(moi, cellule)` (l'ancien choisissait l'obstacle le plus proche de l'ennemi) et cible une cellule libre voisine de l'obstacle, repli sur `moveAwayFrom`.
- `planShootOrChip` ne dépend plus de `planMove` : le tir et la chip d'attaque sont planifiés aussi dans l'ordre « situation critique ».
- Recul de `zone_control` : `planRetreatAfterShoot` après les tirs (PM de l'ennemi inclus, borne `d == portée` incluse) ; `executeZoneControl` ne fait plus qu'avancer (jamais de recul avant le tir). `docs/strategies.md` mis à jour, tests dans `tests/movement-planning.test.mjs`.
- Fichiers : MovementBehavior.ts (v2), Plannification.ts (v8), PlanActScenario.ts (v4).

## 2026-11-24 — FIX: Bugs critiques Defense/Heal/Hide - Logique stratégique améliorée

**3 Bugs identifiés et corrigés** dans les décisions tactiques :

### Bug #1: shouldPrioritizeDefense() = FALSE au contact mutuel + faible HP
- **Problème** : Défense SEULEMENT si asymétrie (ennemi tire, pas moi) → Kassbi sans shield à distance=1 avec 39% HP
- **Cause** : Logique binaire : `contact.enemyCanShoot && !contact.iCanShoot`
- **Fix** : Ajout cas mutual contact danger : `(enemyShoot && iCanShoot && lifeRatio <= 0.60)`
- **Effet** : Défense précoce en situation critique (2 cases pour shield)

### Bug #2: shouldHeal() = FALSE tours 4-5 (lazy healing)
- **Problème** : Seuil agressif (25% perte) attend trop longtemps → Kassbi passe de 92% → 71% → 39% sans soin
- **Cause** : BalancedStrategy utilise UNIQUEMENT `lostLifeRatio >= 0.25`, sans contexte d'ennemi proche
- **Fix** : Nouvelle méthode `shouldHealWithThreat()` : heal aussi si `distance<=10 && lifeRatio<=0.70 && lostRatio>=0.10`
- **Variants** : 
  - Aggressive: `HP<=50%` (garde agressivité)
  - Balanced: `HP<=70%` + `damage>=10%` (réactif)
  - Defensive: `HP<=80%` + `damage>=8%` (précoce)
- **Effet** : Soin au tour 5 au lieu du tour 6 (1 tour d'avance)

### Bug #3: shouldHide() = FALSE tours 4-5 (retraite trop tard)
- **Problème** : Retraite SEULEMENT si `tooClose && isWounded(45%)` → Kassbi distance=2, HP=71%, zéro retraite
- **Cause** : Condition ET trop stricte, threshold isWounded trop bas (45%)
- **Fix** : Ajout cas limite : `distance <= 2 && lifeRatio <= 0.70` → retraite préemptive
- **Variants** :
  - Aggressive: `distance<=1 && HP<=50%` (extrême)
  - Balanced: `distance<=2 && HP<=70%` (standard)
  - Defensive: `distance<=2 && HP<=75%` (eager)
- **Effet** : Retraite au tour 5 au lieu du tour 6 (anticipatif)

**Fichiers modifiés** (v2→v3 / v5→v6) :
- Plannification.ts (v5→v6) : Enhanced shouldPrioritizeDefense(), threat-aware heal integration
- LeekStrategy.ts (v2→v3) : shouldHealWithThreat() base class + enhanced shouldHide()
- BalancedStrategy.ts (v2→v3) : threat-aware variants
- AggressiveStrategy.ts (v2→v3) : threat-aware variants (conservative)
- DefensiveStrategy.ts (v2→v3) : threat-aware variants (eager)

**Validation** :
- ✅ Compilation TypeScript : PASSED (0 errors)
- ✅ Backward compatible : OUI (old shouldHeal/Hide preserved)
- ✅ Logs enrichis : distance + threat-aware flag
- ✅ Ops cost : ~14 ops/turn (< 0.1%)
- ✅ Docs : DEFENSE_HEALING_FIXES.md (validation détaillée)

**Résultat attendu** : Kassbi survit plus longtemps vs Kaine111 (tours 4-6 plus réactif)

## 2026-11-24 — Système de comportements de mouvement tactique : Hide & Seek intelligent

- **Crée MovementBehavior.ts** : système configurable de 6 comportements de mouvement
  - `RETREAT_TO_CORNER` : Fuite vers coin le plus éloigné (défense ultime)
  - `AGGRESSIVE_KITING` : Poursuite active à distance optimale (offensive)
  - `ZONE_CONTROL` : Maintien avantage tactique (situation équilibrée)
  - `TERRAIN_AWARE` : Repositionnement avec couverture
  - `SIMPLE_ADVANCE` : Avance basique (fallback)
  - `SIMPLE_RETREAT` : Retraite directe (fallback)
- **Sélection automatique** : `getOptimalBehavior()` choisit selon scenario:
  - Ennemi peut tirer, pas nous → RETREAT_TO_CORNER (priorité survie)
  - Nous pouvons tirer, pas l'ennemi → AGGRESSIVE_KITING (exploiter avantage)
  - Les deux peuvent tirer → ZONE_CONTROL (positioner tactiquement)
  - Aucun ne peut tirer → SIMPLE_ADVANCE (fermer distance)
- **Intégration Plannification.ts** (v3→v4) :
  - `planMove()` utilise MovementBehavior.executeBehavior() au lieu de moveToward simple
  - `planHide()` utilise explicitement RETREAT_TO_CORNER pour retraite défensive
  - Logs incluent nom comportement pour debug
- **Avantages tactiques** :
  - Corner-trapping permet pièger ennemi (comme observé en combat réel)
  - Kiting agressif maintient avantage distance
  - Zone control adaptatif selon matchup armes
  - Terrain-aware offre couverture supplémentaire
- **Cration MOVEMENT_BEHAVIORS.md** : documentation complète des 6 behaviors et sélection
- **Impact testable** : Kassbi passe du mouvement prévisible à stratégie contextuelle

## 2026-11-24 — Préparation au contact : Prédiction tactique et boost/défense

- Ajoute `predictContactNextTurn()` pour détecter si contact sera établi au prochain tour.
  - Calcule : `distance - mpLeft` pour ma portée de tir max
  - Calcule : `distance - enemy.mp` pour la portée max de l'ennemi
  - Retourne : `iCanShoot` et `enemyCanShoot`
- Ajoute `shouldPrioritizeDefense()` : si ennemi peut tirer et pas moi → priorité bouclier
- Ajoute `shouldBoostAttack()` : si je peux tirer et pas l'ennemi → priorité offensif (réservé pour futurs chips boost)
- **Réorganise priorité chips** :
  - **Si défense prioritaire** : bouclier EN PREMIER, puis soin
  - **Sinon** : soin EN PREMIER, puis bouclier
- **Impact** : Kassbi se prépare intelligemment selon le scénario du prochain tour.

## 2026-11-24 — Kassbi parle en combat : Greetings et Taunts

- Ajoute `isFirstTurn` flag pour détecter le premier tour du combat.
- **Greeting au début** : `me.say(getRandomMessage(SPEECH.GREETINGS))` tour 1
- **Taunts à la fin** : si ennemi < 15% HP, `me.say(getRandomMessage(SPEECH.TAUNTS))`
- Ajoute `say(message: string): void` à l'interface `Me` dans `leekwars.d.ts`
- Messages utilisent le catalogue existant de `Speeches.ts` (11 taunts, 3 greetings)

## 2026-11-24 — Amélioration stratégique de Kassbi : Hide & Seek + Soin opportuniste

- **Positional Hide & Seek** : modifie `shouldHide()` pour factoriser la distance à l'ennemi, non plus basé sur MP.
  - Fuite proactive quand trop proche (distance < minSafeDistance) ET blessé, au lieu de réactif pur.
  - Seuil varie par stratégie : AGGRESSIVE (30-45%), BALANCED (55%), DEFENSIVE (80%).
- **Soin opportuniste** : réorganise le flux d'action pour prioriser les tirs avant le soin.
  - Nouvelles méthodes : `planChipsActionsAfterShoot()` + `shouldSkipHealForDamage()` pour arbitrer TP.
  - Soin s'active après les tirs si TP restant aurait produit <2× dégâts vs soin.
- **Nouveau flux** : `equip → move → tir weapon + chip → soin opportuniste → hide`.
  - Ancien : `equip → soin/bouclier préalable → move → tir`.
- **Impact testable** : ratio dégâts/soin augmente, fuite plus stratégique et moins prévisible.

## 2026-11-24 — Fin du lot de migration TypeScript

- Ajoute les 16 équivalents TypeScript manquants pour compléter les 31 correspondances avec les sources `.leek`, conservées.
- Porte les modèles d'objets, options de tir, utilitaires et scripts de test restants sur l'API objet.
- Ajoute des tests ciblés sur les adaptateurs, les combinaisons d'attaque et les utilitaires.

## 2026-11-24 — Archivage des sources LeekScript migrées

- Déplace les sources `.leek` remplacées dans `src/_oldLeekScript/`, ignoré par Git.
- Exclut l'archive du PUSH Garden et ajoute un test de non-déploiement.

## 2026-11-24 — Journalisation des erreurs en combat

- Ajoute un rapport d'erreur structuré avec fichier, fonction, message et pile d'appels.
- Protège les points d'entrée `turn()` et relance les erreurs après journalisation pour conserver l'échec visible.

## 2026-11-24 — Clarification du README LWGarden

- Recentre le README LWGarden sur la synchronisation et le déploiement des sources, sans documentation des IA Kassbi.

## 2026-11-24 — Sources TypeScript dans LWGarden

- Ajoute la prise en charge locale des `.ts` au PUSH/PULL Garden, en préservant leur extension côté serveur.
- Ajoute les tests de synchronisation TypeScript et documente les versions de langage.

## 2026-11-24 — Première étape de migration TypeScript

- Ajoute les profils, stratégies et actions en modules TypeScript 5.8 sans supprimer leurs sources `.leek`.
- Ajoute le compilateur local et des tests de régression pour les seuils de stratégie.

## 2026-11-24 — Première séquence de combat TypeScript

- Traduit le scénario d'action simple vers `Fight`, `Weapon` et les méthodes de `Me`.
- Ajoute les déclarations locales minimales de l'API utilisées par ce module et des tests de séquence.

## 2026-11-24 — Modèle de danger TypeScript

- Porte les données `DangerInfo`, le calcul de danger par cellule et la sélection de cases sûres en TypeScript.
- Rend les menaces et distances injectables pour tester les seuils et les obstacles sans simuler le moteur du jeu.
- Ajoute le helper générique de copie de tableau utilisé par les futurs modules migrés.
- Adapte `Coordinates` et `World` aux objets `Cell`, `Field` et `Fight` de l'API TypeScript.

## 2026-11-24 — Planificateur et entrée principale TypeScript

- Ajoute le planificateur et le scénario `planAct` sur l'API objet, avec armes, puces de soin/bouclier et mouvement.
- Ajoute `Kassbi_Class.ts` avec `export function turn()` comme entrée TypeScript.
- Conserve les sources LeekScript et vérifie le nouveau flux avec des tests locaux à base de mocks.

## 2026-11-24 — Synchronisation LWGarden

- Ajoute le déploiement local des IA sans suppression distante, l'authentification par clé API et la confirmation du PULL destructif.
- Ajoute les tests du déploiement et des chemins API.

## 2026-11-24 — Configuration des agents Copilot

- Ajoute les agents Leek Wars et aligne leurs références ainsi que la documentation sur `src/`.

## 2026-11-24 — Journal à la racine

- Place le journal à la racine du dépôt et ajoute ses liens dans les README.
- Établit cette organisation comme convention dans les quatre agents Copilot.

## 2026-11-24 — Exécution de LWGarden depuis la racine

- Résout la configuration et le dossier AI par rapport à LWGarden pour lancer PUSH et PULL depuis la racine du dépôt vers `src/`.

## 2026-11-24 — Encodage des sources pour le PUSH

- Traite le repli Windows-1252 comme une information et préserve le contenu des sources lors de leur envoi.

## 2026-11-24 — Synchronisation des suppressions distantes

- Permet de déplacer vers la corbeille les IA et dossiers distants absents de la source, après confirmation explicite.

## 2026-11-24 — Confirmations Garden

- Ignore les espaces autour des réponses de confirmation du PUSH, du PULL et des suppressions.

## 2026-11-24 — Limitation du débit API

- Espace toutes les requêtes Garden pour rester sous cinq appels par seconde et conserve les retries du serveur.

## 2026-11-24 — Noms des IA et fichiers locaux

- Garde `.leek` uniquement sur les fichiers sources locaux ; PUSH et PULL synchronisent les noms d'IA sans suffixe côté Leek Wars.

## 2026-11-24 — Normalisation des fins de ligne Garden

- Normalise les fins de ligne à LF uniquement à l'envoi vers Leek Wars, sans réécrire les sources locales.
