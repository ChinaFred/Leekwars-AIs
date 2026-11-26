---
name: analyse-combats
description: Analyser les combats archivés par Garden pour trouver les failles de l'IA Kassbi, comparer deux versions ou expliquer une défaite. À utiliser dès qu'il est question de combats perdus, de taux de victoire ou de régression en combat.
---

# Analyser les combats

Les données sont dans `LWGarden/Data/` (suivi par Git) :

| Fichier | Contenu |
|---|---|
| `resume.md` | Par version : message `Stratégie:`, victoires/défaites, pics d'ops, liste des défaites |
| `publications.json` | Une entrée par PUSH : version, commit, message complet |
| `fights/<id>/fight.json` | Le combat complet (`data.actions`, `report`, `leeks1/2`) |
| `fights/<id>/logs.json` | Les logs de debug de nos poireaux, tour par tour |
| `fights/<id>/meta.json` | Date, compte, état des logs |

Une version est un commit publié ; son message dit ce qu'elle voulait changer.

## Démarche

1. Mets les données à jour : lance le workflow GitHub « Archive des combats » (`archive-leek.yml`, sur la
   branche par défaut), attends sa fin, puis récupère la branche par défaut. Il archive, exporte et régénère
   `resume.md`. Si tu ne peux pas le lancer, dis de quand datent les données (`git log -1 -- LWGarden/Data`).
   Lis ensuite `LWGarden/Data/resume.md` ; s'il n'y a aucun combat, dis-le et arrête.
2. Choisis la question : pourquoi la dernière version perd, ou ce que le dernier changement a produit par rapport
   à la version précédente.
3. Prends les défaites listées (5 à 8 suffisent). Pour chacune :
   `python LWGarden/src/FightSummary.py --fight <id> --grep "PLANNING|Operations"`.
   Adapte la regex au contexte de log utile (`docs/strategies.md`, section journalisation). N'ouvre `fight.json`
   en entier que si les logs ne suffisent pas : il est volumineux.
4. Classe chaque défaite par cause : budget d'ops épuisé (pic proche du plafond de recherche), mauvais
   placement, cible mal choisie, absence de repli, dégâts insuffisants, adversaire hors de portée, autre.
5. Garde les causes qui reviennent dans au moins deux combats. Vérifie dans une victoire que le même schéma n'y
   apparaît pas : sinon ce n'est pas la cause.
6. Remonte à la décision du code : seuil, ordre de planification, score.

## Garde-fous

- Moins de 20 combats par version : un écart de taux de victoire est un indice, pas une preuve.
- Les adversaires changent d'une version à l'autre : compare contre des adversaires de niveau proche.
- Une version marquée « sources modifiées » ne correspond pas exactement à son commit.
- Un combat « sans logs » ne dit que son résultat.

## Livrable

Un brief dans la conversation, 3 failles au plus : constat et identifiants de combat, décision en cause,
alternative, risque, critère de succès. Aucun fichier.
