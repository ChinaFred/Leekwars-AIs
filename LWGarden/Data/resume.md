# Résumé des combats archivés

Généré par Garden (options 7 et 8) ou `python LWGarden/src/FightSummary.py` ; ne pas modifier à la main. Détail d'un combat : `--fight <id>`.

## 4665531 — perf(book): marge de coût des nœuds ramenée de 2 à 1,2
Compte Kassbi, publié le 2026-11-28T10:57:18Z.
Stratégie : au niveau 2 du faisceau, le livre ouvre plus de nœuds quand le budget le permet : 5 sur 5 au lieu de 3 sur 5 aux tours 5 et 6 du combat 55027536 (tours finis à 44 % et 41 % des ops) ; marge NODE_COST_MARGIN 2 → 1,2, plafonds globaux inchangés (0,80 et 0,70).
Combats : 3 — 3 victoires, 0 défaites, 0 nuls (100 % de victoires), 0 sans logs.
Ops : pic maximal 65 % (combat 55028293), médiane des pics 51 %.
Ressources : 28 tours joués, 2 sans aucune action payante (7 %), 38 % des PM inutilisés, 0 tours interrompus ou en erreur.
PT (ligne [History]) : 34 % inutilisés sur 285 disponibles.
Combats les plus gaspilleurs (tours sans action payante) : 55028293 (2/8, victoire), 55028410 (0/9, victoire), 55028419 (0/11, victoire).

## e7ef19c — perf(ops): zones d'affichage coupées par défaut dans Kassbi_Book
Compte Kassbi, publié le 2026-11-28T10:37:22Z.
Stratégie : aucun changement de comportement du plan ; la zone visée (290k à 690k ops par tour, jamais transmise au planificateur) n'est plus calculée en combat, ce qui libère du budget pour la recherche du livre.
Combats : 1 — 0 victoires, 1 défaites, 0 nuls (0 % de victoires), 0 sans logs.
Ops : pic maximal 58 % (combat 55027536), médiane des pics 58 %.
Ressources : 9 tours joués, 1 sans aucune action payante (11 %), 29 % des PM inutilisés, 0 tours interrompus ou en erreur.
PT (ligne [History]) : 51 % inutilisés sur 93 disponibles.
Combats les plus gaspilleurs (tours sans action payante) : 55027536 (1/9, défaite).

Défaites :
- 55027536 : 10 tours · vs Vanellope · pic ops 58 %

## 8a79845 — chore(merge): intègre Master dans la branche de l'agressivité
Compte Kassbi, publié le 2026-11-28T10:04:17Z.
Combats : 3 — 0 victoires, 3 défaites, 0 nuls (0 % de victoires), 0 sans logs.
Ops : pic maximal 82 % (combat 55025819), médiane des pics 73 %.
Ressources : 24 tours joués, 5 sans aucune action payante (21 %), 28 % des PM inutilisés, 0 tours interrompus ou en erreur.
PT (ligne [History]) : 47 % inutilisés sur 241 disponibles.
Combats les plus gaspilleurs (tours sans action payante) : 55026416 (2/8, défaite), 55025819 (2/9, défaite), 55025104 (1/7, défaite).

Défaites :
- 55025104 : 7 tours · vs tungtung67 · pic ops 73 %
- 55025819 : 9 tours · vs leghapilu · pic ops 82 %
- 55026416 : 8 tours · vs Billloute · pic ops 54 %

## 8150386 — feat(book): crédit de boost sans tir et rejeu du compteur de duel
Compte Kassbi, publié le 2026-11-27T21:41:15Z.
Stratégie : Kassbi_Book seulement. Boost de force sans tir crédité de
Combats : 16 — 15 victoires, 0 défaites, 1 nuls (94 % de victoires), 0 sans logs.
Ops : pic maximal 74 % (combat 55007909), médiane des pics 42 %.
Ressources : 189 tours joués, 47 sans aucune action payante (25 %), 56 % des PM inutilisés, 0 tours interrompus ou en erreur.
PT (ligne [History]) : 51 % inutilisés sur 1940 disponibles.
Combats les plus gaspilleurs (tours sans action payante) : 55009037 (35/64, nul), 55007928 (3/10, victoire), 55007909 (2/8, victoire), 55007925 (1/5, victoire), 55008923 (1/5, victoire).

## 7092a85 — feat(book): sortie de duel AGGRESSIVE, repli sûr, budget de profondeur
Compte Kassbi, publié le 2026-11-27T21:00:53Z.
Stratégie : Kassbi_Book seulement (non branché aux IA actives). Corrige le
Combats : 20 — 19 victoires, 0 défaites, 1 nuls (95 % de victoires), 0 sans logs.
Ops : pic maximal 52 % (combat 55006374), médiane des pics 38 %.
Ressources : 208 tours joués, 56 sans aucune action payante (27 %), 41 % des PM inutilisés, 0 tours interrompus ou en erreur.
PT (ligne [History]) : 52 % inutilisés sur 2134 disponibles.
Combats les plus gaspilleurs (tours sans action payante) : 55006373 (33/64, nul), 55006498 (6/19, victoire), 55006497 (2/7, victoire), 55006376 (1/4, victoire), 55006380 (2/8, victoire).

## 7e7313d — fix(book): Kassbi_Book suit les boosts de PM décidés dans le plan
Compte Kassbi, publié le 2026-11-27T19:54:53Z.
Stratégie : aucun changement de comportement des IA actives. Kassbi_Book
Combats : 34 — 29 victoires, 3 défaites, 2 nuls (85 % de victoires), 0 sans logs.
Ops : pic maximal 82 % (combat 55005747), médiane des pics 60 %.
Ressources : 415 tours joués, 64 sans aucune action payante (15 %), 50 % des PM inutilisés, 0 tours interrompus ou en erreur.
PT (ligne [History]) : 35 % inutilisés sur 4186 disponibles.
Combats les plus gaspilleurs (tours sans action payante) : 55005881 (2/4, défaite), 55005587 (22/51, victoire), 55005608 (5/13, victoire), 55005734 (2/7, victoire), 55005611 (2/8, victoire).

Défaites :
- 55005849 : 7 tours · vs Gorglucks, Destan, Hakuko, dilph, DEVaporator · pic ops 53 %
- 55005881 : 5 tours · vs HatsuNekron · pic ops 48 %
- 55005891 : 2 tours · vs LaZeraclure · pic ops 25 %
