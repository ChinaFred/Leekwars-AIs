---
name: profil-ops
description: Mesurer et réduire le coût en opérations de l'IA Kassbi, et comparer deux versions sur des données. À utiliser pour toute optimisation de performance, tout dépassement de budget d'ops, ou avant d'ajouter un cache.
---

# Mesurer avant d'optimiser

Le jeu limite les opérations par tour. Les tests locaux tournent sous Node sans `System` : ils vérifient la
correction, pas le coût. La seule mesure réelle vient des logs de combat.

## Où lire les mesures

- Fin de tour : `Operations: <utilisées>/<max> (<x>%)` (`logTurnOperations`, `src/Toolbox/Debug.ts`).
- Par phase : `<libellé> - # Operations: <n>` avec la classe `Operations` du même fichier, sous le drapeau
  `DEBUGS.OPERATIONS`. Pose-la autour de la phase suspecte, publie, joue quelques combats, archive.
- Plafonds : `src/Classes/Plannification/ExecutionBudget.ts` (`SEARCH_GLOBAL_FRACTION`).

`python LWGarden/src/FightSummary.py --fight <id>` donne les ops par tour ; `--grep "# Operations"` donne le
détail par phase. `LWGarden/Data/resume.md` donne le pic et la médiane par version.

## Démarche

1. Mesure : quel tour, quelle phase, combien. Sans chiffre, ne change rien.
2. Trouve le point chaud : presque toujours une boucle sur cases × ennemis × armes, ou un calcul refait à
   chaque itération (chemin, ligne de vue, portée).
3. Réduis dans cet ordre : ne pas calculer (élaguer tôt, sortir dès qu'un meilleur score est impossible), calculer
   une fois (sortir l'invariant de la boucle, mémoriser pour le tour), calculer moins cher (structure plus simple,
   appel natif plutôt que boucle écrite à la main).
4. Garde le comportement : un test d'équivalence sur quelques cas (ancien résultat = nouveau résultat), comme
   `tests/threat-map-equivalence.test.mjs`. Un seul fichier, quelques cas.
5. Mesure à nouveau en combat. Le message de commit `perf(...)` donne les chiffres avant/après, ou dit que le
   gain n'est pas encore mesuré.

## Comparer deux versions

- Compare les mêmes indicateurs (taux de victoire, pic d'ops, médiane des pics, durée des défaites) sur des
  échantillons de taille proche.
- Moins de 20 combats par version : ne conclus pas sur le taux de victoire.
- Un gain d'ops ne vaut que s'il est réinvesti (recherche plus profonde) ou s'il évite un abandon de plan.

## À ne pas faire

- Inventer un coût en ops : le coût d'une primitive native se mesure, il ne se devine pas.
- Ajouter un cache sans mesure, ni optimiser une phase qui pèse moins de 5 % du tour.
- Changer un seuil tactique sous couvert d'optimisation : c'est un autre commit.
