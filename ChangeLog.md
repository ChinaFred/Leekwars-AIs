# Change Log

Les changements sont consignés ici sous forme d'entrées concises lors de la préparation d'un commit.

## 2026-11-24 — Fin du lot de migration TypeScript

- Ajoute les 16 équivalents TypeScript manquants pour compléter les 31 correspondances avec les sources `.leek`, conservées.
- Porte les modèles d'objets, options de tir, utilitaires et scripts de test restants sur l'API objet.
- Ajoute des tests ciblés sur les adaptateurs, les combinaisons d'attaque et les utilitaires.

## 2026-11-24 — Archivage des sources LeekScript migrées

- Déplace les sources `.leek` remplacées dans `src/_oldLeekScript/`, ignoré par Git.
- Exclut l'archive du PUSH Garden et ajoute un test de non-déploiement.

## 2026-11-24 — Journalisation des erreurs en combat

- Ajoute un rapport d'erreur structuré avec fichier, fonction, message et pile d'appels.
- Protège les points d'entrée `turn()` et relance les erreurs après journalisation pour conserver l'échec visible.

## 2026-11-24 — Clarification du README LWGarden

- Recentre le README LWGarden sur la synchronisation et le déploiement des sources, sans documentation des IA Kassbi.

## 2026-11-24 — Sources TypeScript dans LWGarden

- Ajoute la prise en charge locale des `.ts` au PUSH/PULL Garden, en préservant leur extension côté serveur.
- Ajoute les tests de synchronisation TypeScript et documente les versions de langage.

## 2026-11-24 — Première étape de migration TypeScript

- Ajoute les profils, stratégies et actions en modules TypeScript 5.8 sans supprimer leurs sources `.leek`.
- Ajoute le compilateur local et des tests de régression pour les seuils de stratégie.

## 2026-11-24 — Première séquence de combat TypeScript

- Traduit le scénario d'action simple vers `Fight`, `Weapon` et les méthodes de `Me`.
- Ajoute les déclarations locales minimales de l'API utilisées par ce module et des tests de séquence.

## 2026-11-24 — Modèle de danger TypeScript

- Porte les données `DangerInfo`, le calcul de danger par cellule et la sélection de cases sûres en TypeScript.
- Rend les menaces et distances injectables pour tester les seuils et les obstacles sans simuler le moteur du jeu.
- Ajoute le helper générique de copie de tableau utilisé par les futurs modules migrés.
- Adapte `Coordinates` et `World` aux objets `Cell`, `Field` et `Fight` de l'API TypeScript.

## 2026-11-24 — Planificateur et entrée principale TypeScript

- Ajoute le planificateur et le scénario `planAct` sur l'API objet, avec armes, puces de soin/bouclier et mouvement.
- Ajoute `Kassbi_Class.ts` avec `export function turn()` comme entrée TypeScript.
- Conserve les sources LeekScript et vérifie le nouveau flux avec des tests locaux à base de mocks.

## 2026-11-24 — Synchronisation LWGarden

- Ajoute le déploiement local des IA sans suppression distante, l'authentification par clé API et la confirmation du PULL destructif.
- Ajoute les tests du déploiement et des chemins API.

## 2026-11-24 — Configuration des agents Copilot

- Ajoute les agents Leek Wars et aligne leurs références ainsi que la documentation sur `src/`.

## 2026-11-24 — Journal à la racine

- Place le journal à la racine du dépôt et ajoute ses liens dans les README.
- Établit cette organisation comme convention dans les quatre agents Copilot.

## 2026-11-24 — Exécution de LWGarden depuis la racine

- Résout la configuration et le dossier AI par rapport à LWGarden pour lancer PUSH et PULL depuis la racine du dépôt vers `src/`.

## 2026-11-24 — Encodage des sources pour le PUSH

- Traite le repli Windows-1252 comme une information et préserve le contenu des sources lors de leur envoi.

## 2026-11-24 — Synchronisation des suppressions distantes

- Permet de déplacer vers la corbeille les IA et dossiers distants absents de la source, après confirmation explicite.

## 2026-11-24 — Confirmations Garden

- Ignore les espaces autour des réponses de confirmation du PUSH, du PULL et des suppressions.

## 2026-11-24 — Limitation du débit API

- Espace toutes les requêtes Garden pour rester sous cinq appels par seconde et conserve les retries du serveur.

## 2026-11-24 — Noms des IA et fichiers locaux

- Garde `.leek` uniquement sur les fichiers sources locaux ; PUSH et PULL synchronisent les noms d'IA sans suffixe côté Leek Wars.

## 2026-11-24 — Normalisation des fins de ligne Garden

- Normalise les fins de ligne à LF uniquement à l'envoi vers Leek Wars, sans réécrire les sources locales.
