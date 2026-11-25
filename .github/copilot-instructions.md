# Instructions du dépôt Leek Wars

## Pas de fichiers de rapport (règle valable pour tous les agents)

- Réponds dans la conversation : diagnostics, plans, audits, synthèses, résultats de tests, comptes rendus de validation, guides de déploiement. Ne les écris pas dans des fichiers.
- Ne crée aucun fichier `.md` ou `.txt` de notes, rapport, résumé, audit, index, statut, « sign-off », guide ou journal de commandes (par ex. `*_REPORT`, `*_SUMMARY`, `FINAL_*`, `VALIDATION_*`, `00_READ_ME_FIRST`).
- Ne redirige pas la sortie de commandes (`>`, `Tee-Object`, `Out-File`, `--output`) vers le dépôt (ex. `test-output.txt`, `test-results.txt`). Lis la sortie du terminal ; si un fichier temporaire est indispensable, place-le hors du dépôt et supprime-le.
- Exception : l'utilisateur demande explicitement un fichier persistant. Dans ce cas, modifie d'abord un document existant ; sinon crée un seul fichier court sous `docs/` (jamais à la racine), sans dupliquer une analyse existante.
- À la racine, seuls `README.md` et `ChangeLog.md` sont des documents. `ChangeLog.md` reçoit une entrée très succincte uniquement lors d'un commit explicitement demandé ; il reste référencé dans `README.md` et `LWGarden/README.md` (pas de copie sous `LWGarden/`).
- Un agent qui en délègue un autre (y compris `explore`, `task`, `general-purpose`) recopie cette règle dans le prompt de délégation.

## Sécurité

- N'expose jamais de mots de passe, jetons ou secrets. N'ouvre pas `LWGarden/src/config.json` sauf nécessité stricte et n'en reproduis jamais le contenu.

## Sources du dépôt

- Les IA actives sont en TypeScript (`src/**/*.ts`) ; les `.leek` de `src/_oldLeekScript/` sont des archives ignorées par Git : ne pas les modifier.
- Tout `.ts` commence par `// @version:5.8` (version du langage, ne pas la modifier pour marquer une révision) puis `// file version: N`. Incrémente `file version` dans chaque fichier touché.
- Référence des stratégies : `docs/strategies.md`. Tout changement de seuil, de condition ou d'ordre de planification met ce fichier à jour et ajoute ou ajuste un test de régression.
- `types/leekwars.d.ts` est un sous-ensemble local de l'API du jeu, pas une source exhaustive.
