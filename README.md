# LeekWars - Kassbi

Sources de l'IA **Kassbi** pour [Leek Wars](https://leekwars.com) (`src/`, TypeScript) et **LWGarden**, l'outil
Python qui déploie les sources et archive les combats.

- Stratégie en vigueur : [docs/strategies.md](docs/strategies.md)
- Versions : [ChangeLog.md](ChangeLog.md)
- Déploiement et archive des combats : [LWGarden/README.md](LWGarden/README.md)

## Fonctionnement d'un tour

Point d'entrée : `turn()` dans [`src/Main/Kassbi_Class.ts`](src/Main/Kassbi_Class.ts).

1. **Contexte** : mémoire de l'adversaire, cases atteignables de chaque poireau, carte de danger de mes cases,
   compteur de stagnation.
2. **Planification** (`planAct`, comportement réglé par `leekProfile`) : un plan conjoint attaque / boost /
   protection / déplacement choisi par un score dégâts − risque ; à défaut un plan B séquentiel borné en opérations.
3. **Exécution** : le plan est affiché en entier avant la première action, puis chaque action est revérifiée
   (PT, portée, cooldown) ; un échec arrête la séquence, sans second plan.
4. **Après le plan** : arme équipée au tour 1, puis ligne `Operations:` de fin de tour.

Les décisions, les seuils et leurs limites sont décrits dans [docs/strategies.md](docs/strategies.md).

## Structure du code

| Dossier | Rôle |
|---|---|
| `src/Main/` | Points d'entrée déployés : `Kassbi_Class.ts` (IA de combat), `Kassbi_test.ts` (variante de test) |
| `src/Brain/` | Scénario du tour (`planAct`), boosts de force et de PT, arme du tour 1 |
| `src/Classes/Context/` | Ce que l'IA sait du combat : mémoire de l'adversaire, cases atteignables, carte de danger, stagnation, cibles |
| `src/Classes/Items/` | Armes, puces et effets |
| `src/Classes/Plannification/` | Plan conjoint (`TacticalPlanner` et `Tactical*` : types, score, tour suivant, stagnation, exécution), plan B (`ReservePlan`), budget d'opérations, séquence historique |
| `src/Classes/Strategy/` | Seuils par rôle (`Aggressive`, `Balanced`, `Defensive`) et comportements de déplacement |
| `src/Toolbox/` | Journalisation par contexte, marques sur le terrain, constantes, utilitaires |
| `src/Tests/` | Scripts de test exécutés dans le jeu |
| `tests/` | Tests Node (`*.test.mjs`) sur des mondes simulés ; ils importent `dist/` |
| `types/` | `leekwars.d.ts` : sous-ensemble local de l'API du jeu |
| `scripts/` | Outils du dépôt (contrôle du message de commit, synchronisation des agents) |
| `LWGarden/` | Déploiement vers Leek Wars et archive des combats (Python) |

Chaque fichier `.ts` commence par `// @version:5.8` (version du langage) puis `// file version: N`, à incrémenter
à chaque modification. Les `.leek` de `src/_oldLeekScript/` sont des archives ignorées par Git.

## Commandes

Depuis la racine du dépôt :

```powershell
npm install
npm run hooks:install                          # une fois : modèle et contrôle du message de commit
npm test                                       # construit dist/ puis lance tous les tests
npm run test:only -- tests/strategy.test.mjs   # construit puis lance les tests ciblés
npm run typecheck
python -m unittest discover -s LWGarden/tests -p "test*.py"   # tests de Garden
```

Garden (menu interactif : PULL, PUSH, archive des combats) :

```powershell
python -m pip install -r LWGarden\src\requirements.txt
python LWGarden\src\Garden.py
```

Raccourci Windows : [garden.cmd](garden.cmd) (`garden` dans cmd, `.\garden` dans PowerShell).

`LWGarden/src/config.json` contient vos identifiants : il est ignoré par Git. Ne commitez jamais de mot de passe
ni de clé API.

## Versions et combats

Garden enregistre le message du commit publié comme **version de la stratégie** et y rattache les combats archivés.
Un commit qui modifie `src/**/*.ts` porte donc une ligne `Stratégie:` (effet attendu en combat, valeurs avant et
après) et une ligne `Tests:` ; le hook `commit-msg` le vérifie (modèle : [.gitmessage](.gitmessage)).

Déploiement depuis GitHub : le workflow « Déploiement Leek Wars » (lancement manuel sur la branche par défaut, ou tag
`leek-*` poussé) lance les tests puis `python LWGarden/src/Garden.py push` et pose le tag `leek-*` du déploiement ; voir
[LWGarden/README.md](LWGarden/README.md#déploiement-sans-menu).

Le workflow « Archive des combats » (lancement manuel) récupère les combats récents et les committe.
Les combats archivés sont suivis dans Git sous `LWGarden/Data/`, avec un résumé par version dans
`LWGarden/Data/resume.md` : c'est la matière de l'analyse des défaites.

## Aide au développement

Trois agents assistent le développement : un **développeur** (code et coût en opérations), un **testeur** (peu de
tests, ciblés) et un **stratège** (analyse des combats archivés, alternatives proposées au développeur). Leurs
règles, leurs skills et les hooks sont décrits dans [CLAUDE.md](CLAUDE.md) et `.claude/`.

Les agents Copilot de `.github/agents/` sont générés à partir de `.claude/` : ne les modifiez pas à la main,
lancez `npm run agents:sync`.

## Documentation

Trois documents, volontairement courts : ce README (fonctionnement et structure),
[docs/strategies.md](docs/strategies.md) (stratégie en vigueur) et [ChangeLog.md](ChangeLog.md) (une ligne par
version). Tout le reste est dans le code et dans `git log`.
