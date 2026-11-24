# LeekWars - Kassbi

Ce dépôt contient les sources de l'IA Kassbi (`src/`) et LWGarden, l'outil
Python de synchronisation et de déploiement vers Leek Wars. Garden prend en
charge les sources LeekScript `.leek` et TypeScript `.ts`.

## Utiliser LWGarden

Depuis la racine du dépôt, dans PowerShell :

```powershell
python -m pip install -r LWGarden\src\requirements.txt
python LWGarden\src\Garden.py
```

La configuration, l'authentification, les options PULL/PUSH et les précautions
de déploiement sont décrites dans [LWGarden/README.md](LWGarden/README.md).
Le [journal des modifications](ChangeLog.md) récapitule les changements du dépôt.
Le fichier local `LWGarden/src/config.json` est ignoré par Git ; ne commitez
jamais de mot de passe ni de clé API.

Les tests de l'outil se lancent depuis la racine :

```powershell
python -m unittest discover -s LWGarden/tests -p "test*.py"
```

Le compilateur TypeScript local est épinglé à la version 5.8 :

```powershell
npm install
npm run typecheck
npm test
```

Les déclarations de `types/leekwars.d.ts` sont un sous-ensemble local des membres de l'API utilisés par les modules migrés, pas une définition complète de l'API du jeu.

## Conventions LeekScript

Les anciens fichiers `.leek` sont archivés dans `src/_oldLeekScript/`, ignorés
par Git et exclus du déploiement Garden. Les IA actives sont en TypeScript
`.ts` (`// @version:5.8`, avec `// file version: N`).
Incrémentez la version du fichier lorsque son contenu est modifié de façon
significative.
