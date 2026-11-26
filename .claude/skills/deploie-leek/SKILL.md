---
name: deploie-leek
description: Déployer une version validée de l'IA Kassbi sur Leek Wars en posant un tag Git `leek-*`. À utiliser uniquement quand l'utilisateur valide une version ou demande explicitement « déploie sur leek ».
---

# Déployer sur Leek Wars

Un déploiement change l'IA qui combat réellement. Il ne part jamais d'un simple push : il part d'un tag
`leek-*`, posé seulement quand l'utilisateur valide la version ou demande « déploie sur leek ». Ne le propose
pas de toi-même après un changement de code et ne le déduis pas d'un « c'est bon » ambigu : demande.

Le tag déclenche `.github/workflows/deploy-leek.yml` : tests, puis `python LWGarden/src/Garden.py push`
(compte principal, sans suppression distante), puis enregistrement de la publication dans
`LWGarden/Data/publications.json` sur la branche par défaut.

## Avant de poser le tag

1. Le commit à déployer est poussé, et c'est bien celui que l'utilisateur a validé (montre `git log -1`).
2. `git status` est propre ; `npm test` et `npm run typecheck` passent.
3. Le dernier commit qui touche `src/` porte une ligne `Stratégie:` : c'est elle qui décrira la version dans
   l'analyse des combats.

## Poser le tag

```bash
git tag -a "leek-$(date +%Y%m%d-%H%M)" -m "Déploiement : <sujet du commit>" <commit>
git push origin "leek-..."
```

Si le push du tag est refusé depuis cette session, ne contourne pas : donne la commande à l'utilisateur, ou
lance le même workflow à la main (Actions > « Déploiement Leek Wars » > Run workflow) sur la branche voulue.

## Après

- Suis l'exécution du workflow et rapporte son résultat réel. Codes de sortie de `Garden.py push` : 1 échec du
  déploiement, 2 clé `LEEKWARS_API_KEY` absente ou refusée, 3 sources différentes du dernier commit.
- Le workflow écrit aussi `DEPLOYED.ts` à la racine des IA sur Leek Wars (commit, branche, tag, résumé) :
  c'est la référence pour savoir ce qui est déployé. Un avertissement « release file not updated » dans le
  journal signifie que ce fichier n'est pas à jour : signale-le.
- Un déploiement réussi ajoute un commit `chore(data): publication ...` sur la branche par défaut : fais un
  `git pull` avant de continuer à travailler.
- Pour revenir en arrière : pose un tag `leek-*` sur le commit précédent.
