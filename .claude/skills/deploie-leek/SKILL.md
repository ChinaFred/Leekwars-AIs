---
name: deploie-leek
description: Déployer une version validée de l'IA Kassbi sur Leek Wars en posant un tag Git `leek-*`. À utiliser uniquement quand l'utilisateur valide une version ou demande explicitement « déploie sur leek ».
---

# Déployer sur Leek Wars

Un déploiement change l'IA qui combat réellement. Il ne part jamais d'un simple push : il part du workflow
« Déploiement Leek Wars », lancé seulement quand l'utilisateur valide la version ou demande « déploie sur leek ».
Ne le propose pas de toi-même après un changement de code et ne le déduis pas d'un « c'est bon » ambigu : demande.

`.github/workflows/deploy-leek.yml` : tests, puis `python LWGarden/src/Garden.py push` (compte principal, sans
suppression distante), puis tag `leek-AAAAMMJJ-HHMM` posé par le workflow sur le commit déployé (seulement si le
déploiement réussit), puis enregistrement de la publication dans `LWGarden/Data/publications.json` sur la branche
par défaut. Les tags `leek-*` sont l'historique des déploiements.

## Avant de lancer

1. Le commit à déployer est fusionné dans la branche par défaut, et c'est bien celui que l'utilisateur a validé
   (montre `git log -1`). Le workflow refuse tout commit absent de la branche par défaut : fusionne d'abord.
2. `git status` est propre ; `npm test` et `npm run typecheck` passent.
3. Le dernier commit qui touche `src/` porte une ligne `Stratégie:` : c'est elle qui décrira la version dans
   l'analyse des combats.

## Lancer

Lance le workflow `deploy-leek.yml` sur la branche par défaut (outil GitHub `actions_run_trigger`, méthode
`run_workflow` ; ou Actions > « Déploiement Leek Wars » > Run workflow). Ne pousse pas de tag depuis une session
Claude cloud : elle ne peut pousser que sa branche, le push d'un tag y est refusé (403).

Depuis un poste local, pousser un tag reste possible et déclenche le même workflow :

```bash
git tag -a "leek-$(date +%Y%m%d-%H%M)" -m "Déploiement : <sujet du commit>" <commit>
git push origin "leek-..."
```

## Après

- Suis l'exécution du workflow et rapporte son résultat réel. Codes de sortie de `Garden.py push` : 1 échec du
  déploiement, 2 clé `LEEKWARS_API_KEY` absente ou refusée, 3 sources différentes du dernier commit.
- Le workflow écrit aussi `DEPLOYED.ts` à la racine des IA sur Leek Wars (version, date, origine avec le tag, ligne
  `Stratégie:`) : c'est la référence pour savoir ce qui est déployé. Un avertissement « release file not updated »
  dans le journal signifie que ce fichier n'est pas à jour : signale-le.
- Un déploiement réussi ajoute un tag `leek-*` et un commit `chore(data): publication ...` sur la branche par
  défaut : fais un `git pull` avant de continuer à travailler.
- Pour revenir en arrière : déploie le commit précédent (tag `leek-*` poussé sur ce commit depuis un poste local,
  ou revert fusionné puis nouveau lancement du workflow).
