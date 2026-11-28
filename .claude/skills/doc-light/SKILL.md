---
name: doc-light
description: Tenir à jour la documentation légère du dépôt (README, stratégie, ChangeLog) sans la laisser grossir. À utiliser quand un changement modifie la structure du code, un seuil tactique, ou lors d'un commit.
---

# Documentation légère

Trois documents, chacun avec un rôle et un budget. `node scripts/check-doc-budget.mjs` vérifie les budgets ; le
hook Git `pre-commit` le lance.

| Document | Rôle | Budget |
|---|---|---|
| `README.md` | Fonctionnement global et structure du code | 120 lignes |
| `docs/strategies.md` | La stratégie en vigueur : chaîne de décision, seuils, limites | 250 lignes |
| `ChangeLog.md` | Une ligne par version | 200 caractères par ligne, 200 lignes |

## Règles

- Décris l'état actuel, pas le chemin pour y arriver : l'historique est dans `git log`, où chaque commit porte
  `Stratégie:` et `Tests:`.
- Une information vit à un seul endroit. Un seuil est dans `docs/strategies.md` avec son fichier source ; le
  README y renvoie.
- Quand tu ajoutes, retire : ce qui est remplacé disparaît du document au lieu d'être marqué « historique ».
- Pas de récit de combat, de justification longue ni de liste de tests. Un tableau vaut mieux que trois
  paragraphes.
- Tout seuil cité est vérifié dans le code au moment de l'écrire.

## Quand mettre à jour

| Changement | Document |
|---|---|
| Dossier, point d'entrée, commande | `README.md` |
| Seuil, condition, ordre de planification, score | `docs/strategies.md` |
| Observation, lignes de journal, faisceau, exécution du plan | `docs/observation-et-faisceau.md` (en plus de `docs/strategies.md` si un seuil change) |
| Commit demandé par l'utilisateur | `ChangeLog.md` : `- AAAA-MM-JJ — titre : effet en combat chiffré` |

Si le budget est dépassé, condense le document : ne relève pas le budget.
