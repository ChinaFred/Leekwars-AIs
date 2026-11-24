# LeekWars - Kassbi

Ce dépôt contient les sources LeekScript de l'IA Kassbi (`src/`) et LWGarden,
l'outil Python de synchronisation et de déploiement vers Leek Wars.

## Utiliser LWGarden

Depuis PowerShell :

```powershell
cd LWGarden\src
python -m pip install -r requirements.txt
python Garden.py
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

## Conventions LeekScript

Les fichiers `.leek` conservent l'en-tête `// @version:4`, suivi de
`// file version: N`. Incrémentez la version du fichier lorsque son contenu
est modifié de façon significative.
