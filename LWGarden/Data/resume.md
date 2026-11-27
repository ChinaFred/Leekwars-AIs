# Résumé des combats archivés

Généré par Garden (options 7 et 8) ou `python LWGarden/src/FightSummary.py` ; ne pas modifier à la main. Détail d'un combat : `--fight <id>`.

## 4563ada — fix(tactique): repli sans tir remplacé seulement par un plan à dégâts
Compte Kassbi, publié le 2026-11-27T08:44:53Z.
Stratégie : le repli sans dégâts en tête ne cède plus qu'au meilleur plan qui inflige des dégâts (U > 0) sous 0,75 × (PV + soin), marge levée si le plan tue le dernier ennemi ; avance, pas de côté, protection seule ou boost seul ne le remplacent plus (avant : tout plan qui « agit »). Exclusions inchangées : seuil de repli du rôle, tour condamné, plusieurs ennemis, recherche interrompue ; repli avec soin ou bouclier utile libre. Rejeux : 54976625 T3-T4, 54969622 T3, 54974628 T3 gardent 3 sparks ; 54969622 T2 (spark absorbé) redevient le repli.
Combats : 4 — 3 victoires, 1 défaites, 0 nuls (75 % de victoires), 0 sans logs.
Ops : pic maximal 72 % (combat 54982153), médiane des pics 53 %.
Ressources : 42 tours joués, 7 sans aucune action payante (17 %), 75 % des PM inutilisés, 0 tours interrompus ou en erreur.
PT (ligne [History]) : 38 % inutilisés sur 420 disponibles.
Combats les plus gaspilleurs (tours sans action payante) : 54982134 (6/22, victoire), 54981768 (1/11, défaite), 54982153 (0/8, victoire), 54982229 (0/1, victoire).

Défaites :
- 54981768 : 11 tours · vs Poireaufesseur · pic ops 13 %

## 9fa57c2 — fix(tactique): tour condamné sans boost crédité, kill prioritaire
Compte Kassbi, publié le 2026-11-26T21:51:51Z.
Stratégie : tour condamné = seuil létal atteint sur la case de moindre danger avec chaque protection candidate ; alors une cible tuée (dégâts moyens ≥ ses PV) passe avant le score et le crédit futur F des boosts vaut 0 avec ou sans tir (avant : F jusqu'à 0,75 × PV de la cible). Soin, protection et case finale inchangés ; hors tour condamné, aucun changement. Rejeux : 54969530 T10 cure + rock (31,2 attendus au lieu de 0), 54969527 T6 protein + rock (65,85 au lieu de 42,75), 54969622 T8 repli seul ; 54969530 T8 et 54969622 T7 identiques.
Combats : 11 — 6 victoires, 5 défaites, 0 nuls (55 % de victoires), 0 sans logs.
Ops : pic maximal 88 % (combat 54979777), médiane des pics 43 %.
Ressources : 167 tours joués, 46 sans aucune action payante (28 %), 43 % des PM inutilisés, 0 tours interrompus ou en erreur.
PT (ligne [History]) : 50 % inutilisés sur 1685 disponibles.
Combats les plus gaspilleurs (tours sans action payante) : 54979777 (20/31, défaite), 54972471 (17/55, victoire), 54972543 (2/8, victoire), 54976625 (2/9, défaite), 54974628 (2/10, défaite).

Défaites :
- 54972647 : 7 tours · vs PoisRond · pic ops 42 %
- 54972715 : 15 tours · vs Massko · pic ops 48 %
- 54974628 : 11 tours · vs Poireaufesseur · pic ops 43 %
- 54976625 : 10 tours · vs Albertus · pic ops 72 %
- 54979777 : 35 tours · vs Destan · pic ops 88 %

## 28942a4 — chore(merge): Master (boost d'agilité, tag du workflow) dans la branche
Compte Kassbi, publié le 2026-11-26T21:15:47Z.
Combats : 28 — 24 victoires, 3 défaites, 1 nuls (86 % de victoires), 0 sans logs.
Ops : pic maximal 67 % (combat 54969294), médiane des pics 29 %.
Ressources : 308 tours joués, 54 sans aucune action payante (18 %), 49 % des PM inutilisés, 0 tours interrompus ou en erreur.
PT (ligne [History]) : 46 % inutilisés sur 3116 disponibles.
Combats les plus gaspilleurs (tours sans action payante) : 54969550 (22/53, victoire), 54969537 (3/10, victoire), 54969301 (2/8, victoire), 54969533 (2/8, victoire), 54969622 (2/8, défaite).

Défaites :
- 54969527 : 6 tours · vs Yanolo · pic ops 37 %
- 54969530 : 10 tours · vs Mivaugue · pic ops 63 %
- 54969622 : 8 tours · vs LeekMyVegetable · pic ops 48 %

## 09838c1 — fix(tactique): historique des actions dans un fichier existant
Compte Kassbi, publié le 2026-11-26T17:36:51Z.
Stratégie : aucun changement de comportement par rapport à f418b84 (passivité tirée des dégâts mesurés de mes actions, poids du risque 1 / 0,5 / 0 à 2 / 3 / 4 tours passifs, marge de 0,75 x (PV + soin) à poids réduit, ligne [History] en fin de tour) ; seul l'emplacement du code change.
Combats : 1 — 1 victoires, 0 défaites, 0 nuls (100 % de victoires), 0 sans logs.
Ops : pic maximal 44 % (combat 54965081), médiane des pics 44 %.
Ressources : 7 tours joués, 0 sans aucune action payante (0 %), 31 % des PM inutilisés, 0 tours interrompus ou en erreur.
PT (ligne [History]) : 40 % inutilisés sur 73 disponibles.
Combats les plus gaspilleurs (tours sans action payante) : 54965081 (0/7, victoire).

## b7c7b61 — refactor(plan): createStrategy dans LeekProfile.ts, sans nouveau fichier
Compte Kassbi, publié le 2026-11-26T10:44:25Z.
Stratégie : aucun changement de comportement.
Combats : 1 — 0 victoires, 0 défaites, 1 nuls (0 % de victoires), 0 sans logs.
Ops : pic maximal 39 % (combat 54953080), médiane des pics 39 %.
Ressources : 64 tours joués, 6 sans aucune action payante (9 %), 46 % des PM inutilisés, 0 tours interrompus ou en erreur.
Combats les plus gaspilleurs (tours sans action payante) : 54953080 (6/64, nul).

## unknown-version — version inconnue
Combats : 128 — 92 victoires, 23 défaites, 13 nuls (72 % de victoires), 0 sans logs.
Ops : pic maximal 98 % (combat 54942202), médiane des pics 43 %.
Ressources : 1787 tours joués, 751 sans aucune action payante (42 %), 57 % des PM inutilisés, 11 tours interrompus ou en erreur.
Combats les plus gaspilleurs (tours sans action payante) : 54941300 (11/12, défaite), 54931868 (5/7, victoire), 54941022 (42/64, nul), 54941210 (42/64, nul), 54941603 (42/64, nul).

Défaites :
- 54932341 : 11 tours · vs EnSahWolf · pic ops 62 %
- 54932503 : 8 tours · vs SK8 · pic ops 40 %
- 54933977 : 16 tours · vs Opex · pic ops 85 %
- 54941018 : 11 tours · vs MimiRigonne · pic ops 56 %
- 54941056 : 6 tours · vs Nanméoui · pic ops 74 %
- 54941300 : 13 tours · vs OneJus · pic ops 72 %
- 54941308 : 11 tours · vs Coyotte · pic ops 77 %
- 54942202 : 7 tours · vs Shangrill · pic ops 98 %
- 54944549 : 45 tours · vs CousinOignon · pic ops 65 %
- 54944699 : 25 tours · vs PrototypeA04 · pic ops 71 %
- 54944700 : 18 tours · vs KrazyKlick · pic ops 44 %
- 54944834 : 11 tours · vs Sanguinaire67 · pic ops 26 %
- 54944844 : 23 tours · vs gryka · pic ops 38 %
- 54946689 : 21 tours · vs Poireaufesseur · pic ops 24 %
- 54946723 : 9 tours · vs Sanguinaire67 · pic ops 33 %
- … et 8 plus anciennes.
