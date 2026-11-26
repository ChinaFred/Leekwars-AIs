# Change Log

Une ligne par version, la plus récente en haut. Le détail est dans `git log` : chaque message de commit porte les lignes `Stratégie:` et `Tests:`.

## 2026-11

- 2026-11-26 — Stratège tour par tour : `FightSummary.py --turns` (distance, PM, actions payantes, décisions) ; l'agent juge ressources perdues, choix et chaîne d'actions.
- 2026-11-26 — Archive des combats depuis GitHub : `Garden.py archive` enchaîne archive, export et résumé sans menu ; un workflow manuel committe `LWGarden/Data/`.
- 2026-11-26 — Déploiement par tag : `Garden.py push` sans menu ni suppression distante, lancé par GitHub Actions sur un tag `leek-*` après les tests.
- 2026-11-26 — Aide au dev : agents développeur, testeur, stratège, 4 skills et hooks Claude, agents Copilot générés, docs allégées, combats archivés suivis dans Git avec `resume.md`.
- 2026-11-25 — Diagnostic des logs refusés : l'archive garde âge, erreur et mode d'authentification ; un combat de moins de 10 min est marqué « logs pas encore disponibles ».
- 2026-11-25 — Sortie de stagnation : après 2 tours sans progrès, plan bloqué et ennemis immobiles, Kassbi marche vers une zone de tir sans augmenter son danger (combat 54940819).
- 2026-11-25 — Plafond global de recherche à 80 % : recherche tactique et plan B partagent 800 000 opérations sur 1 000 000 (70 % avant).
- 2026-11-25 — Client API Garden résilient au 401 : ré-authentification unique, disjoncteurs, archivage interrompu après 3 refus.
- 2026-11-25 — Plafond de recherche tactique à 30 % : le repli sûr du tour 5 du combat 54939649 n'est plus perdu (15 % avant).
- 2026-11-25 — Agents allégés et tests consolidés : agents Copilot simplifiés, tests de stratégie et de menace en tableaux de cas.
- 2026-11-25 — Anticipation tactique et carte de menace : futurs tirs et replis préparés, boucliers et boosts adverses estimés.
- 2026-11-25 — Boost de PT : Kassbi lance sa puce de PT avant celle de force ; la carte de danger compte celles de l'ennemi.
- 2026-11-25 — Boost de force : puce lancée en contact si PV ≥ 50 % et gain net positif, ou avec les PT restants (combats 54932471/491/503).
- 2026-11-25 — Carte de danger plus rapide : précalculs et caches de lignes de vue, boosts de force adverses pris en compte.
- 2026-11-25 — Danger multi-armes et survie : jusqu'à 4 armes ennemies avec 1 PT de changement ; pénalité létale de 1000 (combat 54932503).
- 2026-11-25 — Arme du tour 1 et coffres : meilleure arme équipée au tour 1 avec 1 PT restant ; les coffres ne sont plus des ennemis.
- 2026-11-25 — Archives Garden et messages de commit : combats et versions publiées archivés ; modèle et contrôle des messages de commit.
- 2026-11-25 — Plans tactiques et replis fiables : plan complet affiché avant exécution, budgets de recherche et d'exécution distincts.
- 2026-11-25 — Raccourci Windows pour Garden : ajout de `garden.cmd`.
- 2026-11-25 — V1 tactique basée sur le risque : plan conjoint attaque, protection et déplacement selon la carte de danger, avec repli historique.
- 2026-11-25 — Erreurs en rouge et zones sur le terrain : contexte `ERROR` en rouge ; zone accessible et zone de danger marquées avec pause (`Marker.ts`).
- 2026-11-25 — Journalisation par contexte : fonction unique `log(texte, contexte)`, 16 contextes actifs par défaut, textes paresseux.
- 2026-11-25 — Carte de danger (collecte seule) : dégâts potentiels des ennemis par case atteignable, plafond de 8 000 paires.
- 2026-11-25 — Log des opérations : ligne `Operations: n/max (x %)` en fin de tour.
- 2026-11-25 — Cases atteignables (collecte seule) : parcours en largeur borné par les PM, plafond de 500 cases.
- 2026-11-25 — Mémoire de l'adversaire (collecte seule) : items observés, cooldowns suivis, journal borné des coups.
- 2026-11-25 — Repli et tir en ordre critique : cellule de repli loin de l'ennemi, tir planifié aussi en ordre critique, recul de `zone_control` après les tirs.
- 2026-11-24 — Défense, soin et repli plus réactifs : défense si contact mutuel et vie ≤ 60 % ; soin et repli préventifs quand l'ennemi est proche.
- 2026-11-24 — Comportements de déplacement : repli vers un coin, kiting, contrôle de zone ou avance selon qui peut tirer au prochain tour.
- 2026-11-24 — Préparation au contact : prédiction de qui peut tirer au prochain tour ; bouclier avant soin si la défense est prioritaire.
- 2026-11-24 — Kassbi parle : salut au tour 1, provocation quand l'ennemi passe sous 15 % de PV.
- 2026-11-24 — Repli positionnel et soin opportuniste : repli selon la distance ; soin après les tirs, sauté si tirer rapporte plus de 2× le soin.
- 2026-11-24 — Migration TypeScript terminée : 31 modules portés sur l'API objet, sources `.leek` archivées dans `src/_oldLeekScript/` (hors Git et hors PUSH).
- 2026-11-24 — Journalisation des erreurs : rapport structuré (fichier, fonction, message, pile), erreur relancée après journalisation.
- 2026-11-24 — Planificateur et entrée TypeScript : `planAct` et `Kassbi_Class.ts` (`turn()`), modèle de danger, première séquence de combat.
- 2026-11-24 — Première étape TypeScript : profils, stratégies et actions en TypeScript 5.8, tests des seuils de stratégie.
- 2026-11-24 — Sources TypeScript dans Garden : PUSH et PULL des `.ts` en préservant leur extension.
- 2026-11-24 — Garden, synchronisation : déploiement sans suppression distante, clé API, PULL destructif confirmé, lancement depuis la racine.
- 2026-11-24 — Garden, suppressions distantes : IA et dossiers absents de la source mis à la corbeille après confirmation explicite.
- 2026-11-24 — Garden, robustesse : débit sous 5 requêtes par seconde, fins de ligne LF à l'envoi, repli Windows-1252, noms d'IA sans suffixe.
- 2026-11-24 — Documentation et agents : journal à la racine, README LWGarden recentré, agents Copilot configurés.
