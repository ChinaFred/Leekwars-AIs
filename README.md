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

Raccourci : le script [garden.cmd](garden.cmd) à la racine lance la même commande
(`garden` dans cmd, `.\garden` dans PowerShell ; PowerShell n'exécute pas un script
du dossier courant sans `.\`). Ajoutez la racine du dépôt à votre `PATH` pour taper
`garden` depuis n'importe où. Les dépendances restent à installer une fois (commande ci-dessus).

La configuration, l'authentification, les options PULL/PUSH et les précautions
de déploiement sont décrites dans [LWGarden/README.md](LWGarden/README.md).
Le [journal des modifications](ChangeLog.md) récapitule les changements du dépôt.
Le fichier local `LWGarden/src/config.json` est ignoré par Git ; ne commitez
jamais de mot de passe ni de clé API.

Les tests de l'outil se lancent depuis la racine :

```powershell
python -m unittest discover -s LWGarden/tests -p "test*.py"
```

Garden archive aussi les combats et leurs logs de debug pour l'analyse par IA, en
les rattachant à la version publiée (message du commit) : voir
[LWGarden/README.md](LWGarden/README.md#archive-des-combats-et-versions). Pour que les
messages de commit portent l'intention tactique, activez une fois le modèle et le
contrôle de message (`Stratégie:` et `Tests:` requis quand `src/*.ts` change) :

```powershell
npm run hooks:install
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
| `src/Brain/` | Orchestration d'un tour : `planAct(me, profile?, context?)` évalue puis exécute un plan conjoint si les cartes du contexte sont complètes et actuelles ; sinon plan B borné `ReservePlan` (également sans contexte). `simpleActionSequence` est une séquence simple (avancer, tirer, s'éloigner) sans stratégie. |
| `src/Classes/Strategy/` | Décisions tactiques (soin, bouclier, repli, choix d'arme) par stratégie `Aggressive`, `Balanced`, `Defensive`, et comportements de déplacement. |
| `src/Classes/Plannification/` | `TacticalPlanner.ts` compare attaque + protection + déplacements et progression sans tir, sur un graphe atteignable et des tables d'attaque mémorisés ; un arrêt de recherche conserve un candidat complet déjà validé si disponible. `ReservePlan.ts` prépare avant toute action approche minimale → attaque/équipement → supports et alternatives → destination de repli ou absence motivée, en réutilisant dangers/cellules natives valides ; l'exécution contrôle les ressources réelles et les branches annoncées. Recherche tactique et plan B arrêtés à 85 % globaux (`SEARCH_GLOBAL_FRACTION`, 850 000 sur 1 000 000), la recherche tactique aussi à 30 % consommés depuis son entrée et le plan B à 3 % ; `ExecutionBudget.ts` garde séparément une marge résiduelle de 3 % + deux fois le plus gros segment d'exécution observé, sans garantie du coût des primitives opaques. `Plannification.ts` assure la compatibilité historique, explicitement conditionnelle si les API nécessaires manquent, avec le même garde d'exécution. |
| `src/Classes/Context/`, `Items/` | Monde, coordonnées, armes, puces et effets. `EnemyMemory.ts` (instance `enemyMemory` exportée par `Kassbi_Class.ts`) mémorise items, cooldowns et coups observés ; ses cartes du tour sont transmises à `planAct`. `ReachableCells.ts` calcule les cases atteignables (BFS borné par les PM, 4-connexité supposée), accessibles via `enemyMemory.getReachable(id)`. `ThreatMap.ts` (avec `ShotPlan.ts`, `LaunchPattern.ts`) estime le danger potentiel par case (arme équipée + puces prêtes, portée/lancer/LOS, tir après déplacement), accessible via `enemyMemory.getThreatMap()` ; modèle incomplet, jamais une garantie de sécurité. |
| `src/Toolbox/` | Constantes, calculs, aides, débogage, répliques. `Logger.ts` : toute sortie texte passe par `log(texte, contexte)` (contextes `LOG_CONTEXT`, tous actifs par défaut, désactivables par poireau via `leekLogConfig.setEnabled(contexte, false)`) ; erreurs (`ERROR`) en rouge ; `Marker.ts` : seules sorties visuelles (`Debug.mark`/`markText`/`clearMarks`/`pause`), dont les zones accessibles et la zone de danger (contextes `ACCESSIBLE_ZONE` / `DANGER_ZONE`, actifs par défaut, avec pauses) ; voir « Journalisation par contexte » dans [docs/strategies.md](docs/strategies.md). |
| `types/leekwars.d.ts` | Déclarations locales (sous-ensemble) de l'API du jeu utilisées pour le typage. |
| `tests/` | Tests Node (`*.test.mjs`) exécutés sur le code compilé dans `dist/`. |

Changer de stratégie : passer un `LeekProfile` à `planAct`.

`Kassbi_Class.turn()` transmet `enemyMemory.getReachable(me.id)` et `enemyMemory.getThreatMap()` dans le troisième argument `{ reachable, threat }` de `planAct`. Les appels sans contexte, dont l'exemple ci-dessous, utilisent le plan B avec danger explicitement inconnu (aucun couvert garanti). Les formules du score, bornes et limites du modèle sont détaillées dans [docs/strategies.md](docs/strategies.md).

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
