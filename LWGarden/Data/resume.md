# Résumé des combats archivés

Généré par Garden (options 7 et 8) ou `python LWGarden/src/FightSummary.py` ; ne pas modifier à la main. Détail d'un combat : `--fight <id>`.

## db21aac — feat(book): arme du tour 1 choisie selon les tours 2-3 du meilleur plan
Compte Kassbi, publié le 2026-11-28T11:53:37Z.
Stratégie : l'arme équipée au tour 1 est celle que le meilleur enchaînement du livre utilise en premier aux tours simulés suivants (TacticalPlan.later). Sans arme prévue (pas de plan, profondeur 1, repli planAct) : dégâts moyens/PT × part des distances de tir plausibles du prochain contact, donc une arme à distance passe devant le corps à corps tant que le contact n'est pas plausible (Magnum au lieu de l'Épée large à 20-32 cases ; l'Épée large redevient éligible à 1-2 cases). Aucune constante nouvelle.
Combats : 1 — 1 victoires, 0 défaites, 0 nuls (100 % de victoires), 0 sans logs.
Ops : pic maximal 73 % (combat 55029308), médiane des pics 73 %.
Ressources : 5 tours joués, 0 sans aucune action payante (0 %), 17 % des PM inutilisés, 0 tours interrompus ou en erreur.
PT (ligne [History]) : 12 % inutilisés sur 49 disponibles.
Combats les plus gaspilleurs (tours sans action payante) : 55029308 (0/5, victoire).

## cb11183 — chore(merge): fusion de Master (ennemi défensif) dans la fuite sans tir
Compte Kassbi, publié le 2026-11-28T11:36:24Z.
Combats : 3 — 2 victoires, 1 défaites, 0 nuls (67 % de victoires), 0 sans logs.
Ops : pic maximal 69 % (combat 55029213), médiane des pics 30 %.
Ressources : 29 tours joués, 2 sans aucune action payante (7 %), 31 % des PM inutilisés, 0 tours interrompus ou en erreur.
PT (ligne [History]) : 34 % inutilisés sur 295 disponibles.
Combats les plus gaspilleurs (tours sans action payante) : 55028853 (2/13, défaite), 55028837 (0/10, victoire), 55029213 (0/6, victoire).

Défaites :
- 55028853 : 13 tours · vs Albertus · pic ops 30 %

## 4665531 — perf(book): marge de coût des nœuds ramenée de 2 à 1,2
Compte Kassbi, publié le 2026-11-28T10:57:18Z.
Stratégie : au niveau 2 du faisceau, le livre ouvre plus de nœuds quand le budget le permet : 5 sur 5 au lieu de 3 sur 5 aux tours 5 et 6 du combat 55027536 (tours finis à 44 % et 41 % des ops) ; marge NODE_COST_MARGIN 2 → 1,2, plafonds globaux inchangés (0,80 et 0,70).
Combats : 6 — 4 victoires, 2 défaites, 0 nuls (67 % de victoires), 0 sans logs.
Ops : pic maximal 65 % (combat 55028293), médiane des pics 44 %.
Ressources : 50 tours joués, 5 sans aucune action payante (10 %), 40 % des PM inutilisés, 0 tours interrompus ou en erreur.
PT (ligne [History]) : 37 % inutilisés sur 506 disponibles.
Combats les plus gaspilleurs (tours sans action payante) : 55028804 (3/8, défaite), 55028293 (2/8, victoire), 55028410 (0/9, victoire), 55028419 (0/11, victoire), 55028463 (0/9, défaite).

Défaites :
- 55028463 : 9 tours · vs Poireaufesseur · pic ops 30 %
- 55028804 : 9 tours · vs tungtung67 · pic ops 59 %

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
