---
name: analyse-combats
description: Analyser tour par tour les combats archivés de l'IA Kassbi - PT et PM gaspillés, choix tactiques contestables, cohérence de la chaîne d'actions - comparer deux versions ou expliquer un combat. À utiliser dès qu'il est question de la qualité du jeu de l'IA, de combats perdus ou de régression.
---

# Analyser les combats

L'objet de l'analyse est la décision prise à chaque tour, pas le résultat du combat. Victoire et défaite servent
à choisir quoi regarder, pas à conclure.

## Données (`LWGarden/Data/`, suivi par Git)

| Fichier | Contenu |
|---|---|
| `resume.md` | Par version : résultats, pics d'ops, tours sans action payante, PM inutilisés, combats les plus gaspilleurs |
| `publications.json` | Une entrée par PUSH : version, commit, message complet |
| `fights/<id>/fight.json` | Le combat complet (`data.actions`, `data.leeks`, `report`) |
| `fights/<id>/logs.json` | Les logs de debug de nos poireaux, par action |

`python LWGarden/src/FightSummary.py --fight <id> --turns` donne, pour chaque tour : distance à l'ennemi avant
et après, mouvement de l'ennemi juste avant (rapproché, éloigné), PM utilisés sur PM disponibles, tirs, puces et
changements d'arme, dégâts infligés et subis, ops, drapeaux « À examiner », puis les logs de décision (plan
retenu avec PT prévus et restants, boosts, replis, abandons de recherche).

Limite : les PM utilisés sont exacts ; les PT restants ne sont pas dans l'archive. Déduis-les des logs
(`"tp":{"available","planned","remainingIfExecuted"}`, `TP 10 → 7`, coûts de la ligne `[Chips]`). Un tour sans
aucune action payante a perdu tous ses PT.

## Démarche

1. Mets les données à jour : lance le workflow GitHub « Archive des combats » (`archive-leek.yml`, sur la
   branche par défaut), attends sa fin, puis récupère la branche par défaut. Si tu ne peux pas le lancer, dis
   de quand datent les données (`git log -1 -- LWGarden/Data`). S'il n'y a aucun combat, dis-le et arrête.
2. Lis `resume.md` : la ligne « Ressources » et les combats les plus gaspilleurs disent où regarder.
3. Choisis 6 à 8 combats : les plus gaspilleurs, quelques défaites, et au moins deux victoires.
4. Déroule chacun avec `--turns` et pose les trois questions à chaque tour.
5. Regroupe les anomalies par schéma, garde ceux qui reviennent dans au moins deux combats, puis remonte à la
   décision du code (seuil, ordre de planification, score) en t'appuyant sur le log qui la justifie.

## Les trois questions, à chaque tour

**Ressources perdues**
- Des PM restent : y avait-il une case plus utile (portée de tir, couverture, rapprochement) ?
- Des PT restent : boost, soin, protection, changement d'arme ou tir étaient-ils possibles ?
- Tour vide ou interrompu : est-ce le budget d'ops (pic proche du plafond), une erreur, ou un plan absent ?

**Choix contestables**, au regard du mouvement de l'adversaire
- Recul ou immobilité alors que l'adversaire s'éloigne ou ne peut pas tirer.
- Approche à découvert alors qu'il attend à portée ; tir à dégâts faibles alors qu'un pas donnait mieux.
- Cible, arme ou puce : y avait-il plus de dégâts utiles pour le même coût ?

**Cohérence de la chaîne d'actions**, au regard des tours suivants
- Effet posé trop tôt : bouclier ou boost dont la durée expire avant le contact (compare la durée à la distance
  divisée par les PM cumulés des deux camps).
- Effet oublié : contact au tour suivant sans boost de PT ou de force, sans protection alors que les PT restent.
- Ordre : déplacement avant ou après le tir, boost avant ou après l'attaque, arme équipée au bon tour.
- Continuité : le plan du tour contredit-il celui du tour précédent (aller-retour, cible changée sans raison) ?

Pour chaque anomalie, écris l'alternative concrète : « au tour 4, à distance 7 avec 10 PT et 5 PM, avancer de
2 cases et tirer au lieu de rester immobile ».

## Garde-fous

- Vérifie une règle avant de l'invoquer (durée d'un effet, temps de recharge, portée) : code ou source fiable.
- Vérifie dans un combat gagné que le schéma n'y est pas tout aussi fréquent sans conséquence.
- Moins de 20 combats par version : un écart de taux de victoire est un indice, pas une preuve.
- Une version marquée « sources modifiées » ne correspond pas exactement à son commit.

## Livrable

Un brief dans la conversation, 3 failles au plus : constat chiffré (PT, PM, dégâts), combats et tours, décision
en cause, alternative, risque, critère de succès. Aucun fichier.
