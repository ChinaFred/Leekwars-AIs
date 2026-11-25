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
| `src/Brain/` | Orchestration d'un tour : `planAct(me, profile?)` crée une `Plannification` puis l'exécute ; `simpleActionSequence` est une séquence simple (avancer, tirer, s'éloigner) sans stratégie. |
| `src/Classes/Strategy/` | Décisions tactiques (soin, bouclier, repli, choix d'arme) par stratégie `Aggressive`, `Balanced`, `Defensive`, et comportements de déplacement. |
| `src/Classes/Plannification/` | Construit la liste d'actions du tour (arme, déplacement, tir, chips, repli, recul après tir) puis l'exécute. |
| `src/Classes/Context/`, `Items/` | Monde, carte de danger, coordonnées, armes, puces et effets. `Context/EnemyMemory.ts` (instance `enemyMemory` exportée par `Kassbi_Class.ts`) mémorise l'adversaire : armes/puces connues et observées, cooldowns de ses puces, journal borné des coups ; lecture seule pour un usage futur (`getProfile`, `observedChips`, `maxKnownWeaponRange`, `isChipReady`…), elle n'influence pas `planAct`. |
| `src/Toolbox/` | Constantes, calculs, aides, débogage, répliques. |
| `types/leekwars.d.ts` | Déclarations locales (sous-ensemble) de l'API du jeu utilisées pour le typage. |
| `tests/` | Tests Node (`*.test.mjs`) exécutés sur le code compilé dans `dist/`. |

Changer de stratégie : passer un `LeekProfile` à `planAct`.

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
