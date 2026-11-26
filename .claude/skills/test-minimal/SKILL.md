---
name: test-minimal
description: Tester un changement de l'IA Kassbi avec le minimum de tests utiles, ou élaguer des tests redondants. À utiliser avant un commit ou un PUSH, pour écrire un test de régression, ou quand la suite devient trop lourde.
---

# Tester beaucoup avec peu

Un test paie sa place s'il échoue quand un comportement utile casse. Tout le reste est du poids.

## Quoi tester

| Changement | Test attendu |
|---|---|
| Seuil, condition, ordre de planification | Un tableau de cas : juste en dessous, juste au-dessus du seuil |
| Bug vu en combat | Un cas qui rejoue la situation (monde minimal, identifiant du combat dans le nom) |
| Optimisation sans changement de comportement | Équivalence ancien/nouveau sur quelques cas |
| Refactorisation, renommage, logs, documentation | Rien de nouveau : la suite existante suffit |

## Démarche

1. Lis le diff. Écris en une phrase ce qui peut casser.
2. Cherche le test qui couvre déjà ce comportement (`grep` du nom de la fonction dans `tests/`). Ajoute une
   ligne à son tableau de cas plutôt qu'un fichier.
3. Vérifie que le nouveau cas échoue sans le changement (`git stash` du code, ou inverse la condition).
4. Pendant le travail : `npm run test:only -- tests/<fichier>.test.mjs`. À la fin, une fois : `npm test` et
   `npm run typecheck`. Si `LWGarden/` change : `python -m unittest discover -s LWGarden/tests -p "test*.py"`.

## À ne pas écrire

- Un test par fonction ou par branche « pour la couverture ».
- La comparaison à un oracle naïf, les bornes extrêmes d'une fonction secondaire, les tests de getters.
- Un second test qui vérifie la même chose sous un autre nom, ou un test qui recopie l'implémentation.
- Un gros monde de combat quand trois cases et un ennemi suffisent.

## Élaguer (sur demande)

1. Repère les candidats : fichiers les plus longs (`wc -l tests/*.mjs | sort -n`), cas presque identiques,
   tests d'un code supprimé.
2. Ne supprime ou ne fusionne que ce qui vérifie exactement le même comportement qu'un test conservé.
3. Preuve : casse volontairement le comportement, le test conservé doit échouer. Suite verte avant et après.
4. Rapporte ce qui a été retiré et pourquoi, avec le nombre de lignes avant et après.

## Limite à dire

Les tests tournent sous Node, hors du jeu : ils ne prouvent ni la compilation sur Leek Wars ni le coût en ops.
