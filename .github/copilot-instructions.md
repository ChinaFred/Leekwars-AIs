<!-- Généré par `npm run agents:sync` depuis `CLAUDE.md` : ne pas modifier à la main. -->

# Dépôt Leek Wars — IA Kassbi

IA de combat en TypeScript (`src/`), déployée et archivée par LWGarden (`LWGarden/`, Python).
Vue d'ensemble : `README.md`. Stratégie en vigueur : `docs/strategies.md`. Versions : `ChangeLog.md`.

## Qui fait quoi

Choisis le plus petit circuit qui couvre la demande.

| Besoin | Agent | Skill |
|---|---|---|
| Écrire ou corriger le code, réduire le coût en opérations | `developpeur` | `profil-ops` |
| Valider un changement avant commit ou PUSH | `testeur` | `test-minimal` |
| Juger les décisions tour par tour (PT/PM perdus, choix, chaîne d'actions), proposer des alternatives | `stratege` | `analyse-combats` |
| Mettre à jour README, stratégie ou ChangeLog | celui qui fait le changement | `doc-light` |

- Changement de code : `developpeur`, puis `testeur`. Le `stratege` n'intervient que si la décision tactique est en jeu.
- Le `stratege` ne modifie rien : il remet un brief (3 failles au plus) que le `developpeur` implémente.
- Ne présente jamais une validation non exécutée comme réussie, ni une hypothèse comme un fait.

## Commandes

- `npm test` : build puis toute la suite. `npm run test:only -- tests/x.test.mjs` : build puis tests ciblés.
  Les tests importent `dist/` : un `node --test` direct peut tester du code périmé.
- `npm run typecheck`.
- `python -m unittest discover -s LWGarden/tests -p "test*.py"` si `LWGarden/` change.
- `python LWGarden/src/FightSummary.py` : régénère `LWGarden/Data/resume.md` ; `--fight <id> --turns` déroule
  un combat tour par tour.
- Combats récents : workflow GitHub « Archive des combats » (`Garden.py archive` : archive, export, résumé),
  puis `git pull`. `python LWGarden/src/Garden.py export` refait export et résumé hors ligne.
- `npm run agents:sync` après toute modification de `CLAUDE.md` ou de `.claude/agents/`.

## Règles du code

- IA actives : `src/**/*.ts`. `src/_oldLeekScript/` est une archive : ne pas y toucher.
- Tout `.ts` commence par `// @version:5.8` (version du langage, ne pas la changer) puis `// file version: N` ;
  incrémente `N` dans chaque fichier modifié.
- Pas de nouveau fichier `.ts` sous `src/` : la clé API du déploiement ne peut pas créer une IA sur Leek Wars.
  Mets le code dans un fichier existant, ou demande à l'utilisateur de créer le fichier vide sur le site d'abord.
- `types/leekwars.d.ts` est un sous-ensemble local de l'API du jeu : vérifie une fonction absente dans la
  documentation officielle avant de l'utiliser.
- Un changement de seuil, de condition ou d'ordre de planification met à jour `docs/strategies.md` et a un test
  de régression qui échoue sans lui.

## Documents et fichiers

- Réponds dans la conversation : pas de fichier de rapport, de résumé, d'audit ou de sortie de tests, et aucune
  redirection de sortie vers le dépôt. Un hook refuse tout nouveau `.md`/`.txt` hors `docs/`.
- Trois documents seulement, avec un budget de taille vérifié au commit (`scripts/check-doc-budget.mjs`) :
  `README.md`, `docs/strategies.md`, `ChangeLog.md` (une ligne par version, uniquement lors d'un commit demandé).
- `LWGarden/Data/` (combats archivés et `resume.md`) est suivi par Git ; `Data/exports/` ne l'est pas.

## Sécurité

- N'expose jamais de mot de passe, jeton ou secret. N'ouvre pas `LWGarden/src/config.json`.
- Ne pousse pas de code et ne déclenche pas de PUSH Garden sans demande explicite.
- Déploiement sur Leek Wars : seulement quand l'utilisateur valide une version ou demande « déploie sur leek »,
  par un tag `leek-*` (skill `deploie-leek`), jamais à chaque push.

## Commits

Garden enregistre le message du commit publié comme « version de la stratégie » (voir `.gitmessage`).

- Sujet `type(portée): description` (72 caractères au plus), types `feat|fix|perf|refactor|docs|test|chore|build|ci|style`.
- Si `src/**/*.ts` change (feat, fix, perf, refactor) : une ligne `Stratégie:` (effet attendu en combat, valeurs
  avant/après, ou « aucun changement de comportement ») et une ligne `Tests:`.
- Un commit = un seul changement de stratégie. Publie depuis un arbre propre.

## Garder Claude et Copilot synchronisés

`CLAUDE.md` et `.claude/agents/*.md` sont la source. `.github/copilot-instructions.md` et
`.github/agents/*.agent.md` sont générés par `npm run agents:sync` : ne les modifie pas à la main.
Le hook Git `pre-commit` refuse un commit où ils divergent.
