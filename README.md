# LeekWars - Kassbi

Ce dépôt contient les sources de l'IA Kassbi (`src/`) et LWGarden, l'outil
Python de synchronisation et de déploiement vers Leek Wars. Garden prend en
charge les sources LeekScript `.leek` et TypeScript `.ts`.

## Utiliser LWGarden

Depuis la racine du dépôt, dans PowerShell :

```powershell
python -m pip install -r LWGarden\src\requirements.txt
python LWGarden\src\Garden.py
```

La configuration, l'authentification, les options PULL/PUSH et les précautions
de déploiement sont décrites dans [LWGarden/README.md](LWGarden/README.md).
Le [journal des modifications](ChangeLog.md) récapitule les changements du dépôt.
Le fichier local `LWGarden/src/config.json` est ignoré par Git ; ne commitez
jamais de mot de passe ni de clé API.

Les tests de l'outil se lancent depuis la racine :

```powershell
python -m unittest discover -s LWGarden/tests -p "test*.py"
```

Le compilateur TypeScript local est épinglé à la version 5.8 :

```powershell
npm install
npm run typecheck
npm test
```

Les déclarations de `types/leekwars.d.ts` sont un sous-ensemble local des membres de l'API utilisés par les modules migrés, pas une définition complète de l'API du jeu.

## Architecture et usage du code

Les sources actives de l'IA sont dans `src/` (TypeScript, déployées par Garden) :

| Dossier | Rôle |
|---|---|
| `src/Main/` | Points d'entrée du combat : `Kassbi_Class.ts` exporte `turn()` (appelé à chaque tour), `Kassbi_test.ts` est une variante d'essai (profil `AGGRESSIVE`, agressivité 75, sans repli). |
| `src/Brain/` | Orchestration d'un tour : `planAct(me, profile?, context?)` évalue puis exécute un plan conjoint si les cartes du contexte sont complètes et actuelles ; sinon repli journalisé sur `Plannification` ; `simpleActionSequence` est une séquence simple (avancer, tirer, s'éloigner) sans stratégie. |
| `src/Classes/Strategy/` | Décisions tactiques (soin, bouclier, repli, choix d'arme) par stratégie `Aggressive`, `Balanced`, `Defensive`, et comportements de déplacement. |
| `src/Classes/Plannification/` | `TacticalPlanner.ts` compare des plans réalisables attaque + protection + déplacement avant/après tir (recherche bornée, contrôles dynamiques). `Plannification.ts` conserve la séquence historique de repli quand les données ou le budget sont insuffisants. |
| `src/Classes/Context/`, `Items/` | Monde, coordonnées, armes, puces et effets. `EnemyMemory.ts` (instance `enemyMemory` exportée par `Kassbi_Class.ts`) mémorise items, cooldowns et coups observés ; ses cartes du tour sont transmises à `planAct`. `ReachableCells.ts` calcule les cases atteignables (BFS borné par les PM, 4-connexité supposée), accessibles via `enemyMemory.getReachable(id)`. `ThreatMap.ts` (avec `ShotPlan.ts`, `LaunchPattern.ts`) estime le danger potentiel par case (arme équipée + puces prêtes, portée/lancer/LOS, tir après déplacement), accessible via `enemyMemory.getThreatMap()` ; modèle incomplet, jamais une garantie de sécurité. |
| `src/Toolbox/` | Constantes, calculs, aides, débogage, répliques. `Logger.ts` : toute sortie texte passe par `log(texte, contexte)` (contextes `LOG_CONTEXT`, tous actifs par défaut, désactivables par poireau via `leekLogConfig.setEnabled(contexte, false)`) ; erreurs (`ERROR`) en rouge ; `Marker.ts` : seules sorties visuelles (`Debug.mark`/`markText`/`clearMarks`/`pause`), dont les zones accessibles et la zone de danger (contextes `ACCESSIBLE_ZONE` / `DANGER_ZONE`, actifs par défaut, avec pauses) ; voir « Journalisation par contexte » dans [docs/strategies.md](docs/strategies.md). |
| `types/leekwars.d.ts` | Déclarations locales (sous-ensemble) de l'API du jeu utilisées pour le typage. |
| `tests/` | Tests Node (`*.test.mjs`) exécutés sur le code compilé dans `dist/`. |

Changer de stratégie : passer un `LeekProfile` à `planAct`.

`Kassbi_Class.turn()` transmet `enemyMemory.getReachable(me.id)` et `enemyMemory.getThreatMap()` dans le troisième argument `{ reachable, threat }` de `planAct`. Les appels sans contexte, dont l'exemple ci-dessous, gardent la séquence historique. Les formules du score, bornes et limites du modèle sont détaillées dans [docs/strategies.md](docs/strategies.md).

```ts
const profile = new LeekProfile()
profile.setRole("DEFENSIVE")        // AGGRESSIVE | DEFENSIVE | BALANCED (ATTACKER = AGGRESSIVE)
profile.setAggression(30)           // 0-100
profile.setPreferredRange(3, 8)
profile.setSupportOptions(true, true, true) // soin, bouclier, repli
planAct(me, profile)
```

Par défaut, `turn()` utilise un profil `BALANCED` (agressivité 50, portée 3–8). Les seuils de chaque stratégie, l'ordre de planification et la façon de tester un changement sont décrits dans [docs/strategies.md](docs/strategies.md) ; ce fichier doit être mis à jour avec tout changement de seuil.

## Conventions de fichiers

Les anciens fichiers `.leek` sont archivés dans `src/_oldLeekScript/`, ignorés
par Git et exclus du déploiement Garden. Les IA actives sont en TypeScript
`.ts` : chaque fichier commence par `// @version:5.8` (version du langage,
inchangée) puis `// file version: N`. Incrémentez `file version` à chaque
modification du fichier.
