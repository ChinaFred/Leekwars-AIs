# LWGarden

LWGarden is a Python command-line tool for synchronizing local Leek Wars AI
source files with your accounts. It handles deployment and downloads; it does
not implement or configure the combat behavior of any AI. See the
[root README](../README.md) and [project changelog](../ChangeLog.md).

## How-To
Install Python 3, then from the repository root run:

```powershell
python -m pip install -r LWGarden\src\requirements.txt
python LWGarden\src\Garden.py
```

## Synchronizing source files

Run `python LWGarden\src\Garden.py` from the repository root. Option `1`
downloads sources from Leek Wars, while options `5` and `6` deploy local `.leek`
and `.ts` files to the primary or secondary accounts configured in
`LWGarden\src\config.json`. Garden preserves the local folder hierarchy when
deploying and creates or updates the corresponding remote AIs.

Remote AIs and folders absent from the local source can also be moved to the
Leek Wars trash, but only after Garden lists them and you type `DELETE`. Use
this only when the configured source folder is the complete set of AIs to keep.
Source files are read as UTF-8. Legacy Windows-1252 files are decoded in memory
for API upload and reported as informational messages. Garden normalizes line
endings to LF for the API; local source files are not rewritten.
Garden spaces all API requests by at least 0.21 seconds (under five requests
per second). If the API rate-limits a request anyway, it waits for the
server-provided retry delay and retries it up to three times before reporting
the error.
Garden remembers how the last connection was made (login/password or API key,
in memory only). If an authenticated request gets HTTP 401, it authenticates
again once and replays that request; if that fails, the original response is
returned. After a refused re-login (HTTP 401/403, no token, rejected API key),
Garden stops re-logging in until the next successful connection; after a temporary
failure (network error, 5xx, 429) it waits 30 seconds before trying again. An endpoint that still answers 401 after a successful
re-login does not trigger another one until it succeeds. GET requests are also retried up to twice, with a short backoff, after
a network error or a 5xx response.
An error after earlier successful requests may leave the remote garden only
partially deployed; rerun the PUSH after resolving a persistent error.
After option `6`, even on failure, Garden logs back in to the primary account.

Garden uses the current path-based API (`ai/get-farmer-tree`, `ai-folder/create`,
`ai/create`, `ai/read` and `ai/write`) with Bearer-token authentication.

For the primary account, Garden uses `LEEKWARS_API_KEY` when it is set;
otherwise it falls back to the primary account credentials in `config.json`.
From a PowerShell terminal at the repository root, enter the key without
putting it in shell history, then start Garden:

```powershell
$secureKey = Read-Host "Leek Wars API key" -AsSecureString
$env:LEEKWARS_API_KEY = [System.Net.NetworkCredential]::new("", $secureKey).Password
python LWGarden\src\Garden.py
Remove-Item Env:LEEKWARS_API_KEY
```

The key is only used for the primary account. Secondary accounts still use
their configured credentials. Never commit or share the key.

The source directory configured by `AIs_folder` is the synchronization scope. It is
resolved relative to `LWGarden/src`, regardless of the current working
directory; in this checkout, set it to `../../src/`. This keeps all AI logic in
the repository's root `src/` directory. Option `1` pulls from Leek Wars into
that directory, replacing it after you type `OVERWRITE`. Options `5` and `6`
push `.leek` and `.ts` files from that directory to the primary and secondary
accounts, respectively. Garden removes `.leek` when mapping a LeekScript source to its
remote AI path; it preserves `.ts`, since the extension identifies the
TypeScript language. PULL preserves `.ts` and adds `.leek` to extensionless
LeekScript AI paths. The local `src/_oldLeekScript/` archive is excluded from
PUSH.
For each account, remote-only AIs and folders are listed before any deletion;
type `DELETE` to move them to the server trash, or enter anything else to keep
them.

## Déploiement sans menu

`python LWGarden/src/Garden.py push` déploie les sources sur le compte principal sans
aucune question, pour un usage automatique. Il lit `LEEKWARS_API_KEY` (ou le compte
principal de `config.json` s'il existe ; sans `config.json`, les sources sont `src/`),
ne supprime jamais rien côté serveur, refuse des sources différentes du dernier commit et
enregistre la publication. Codes de sortie : `0` déployé ou déjà à jour, `1` échec,
`2` clé absente ou refusée, `3` sources modifiées.

Le workflow `.github/workflows/deploy-leek.yml` l'utilise : il se déclenche sur un tag
`leek-*` (ou à la main dans l'onglet Actions), lance les tests, déploie, puis committe
`Data/publications.json` sur la branche par défaut. Il lui faut le secret
`LEEKWARS_API_KEY` du dépôt GitHub.

De même, `python LWGarden/src/Garden.py archive` enchaîne sans question l'archive des
combats récents, l'export de toutes les versions et `Data/resume.md` (options `7` et `8`,
toujours ensemble ; l'option `7` du menu fait désormais de même). `Garden.py export`
refait l'export et le résumé à partir des combats déjà archivés, sans connexion. Le
workflow « Archive des combats » (`.github/workflows/archive-leek.yml`, lancement manuel)
exécute `archive` puis committe `LWGarden/Data/` sur la branche par défaut.

```powershell
git tag -a leek-20261126-1 -m "Déploiement : sortie de stagnation"
git push origin leek-20261126-1
```

## Archive des combats et versions

Les options `7` et `8` constituent une base locale pour analyser les combats
avec une IA. Tout est écrit sous `LWGarden/Data/`, suivi par Git sauf `exports/` (qui duplique
`fights/`) : committez-le après un archivage (`chore(data): ...`) pour que les
agents d'analyse y aient accès. Les options `7` et `8` réécrivent aussi
`Data/resume.md`, le résumé par version (victoires, défaites, pics d'ops) à lire
en premier ; `python LWGarden/src/FightSummary.py --fight <id>` détaille un combat (dossier
modifiable par `data_folder` dans `config.json`, relatif à `LWGarden/src`).

- **Publication** : à chaque PUSH (options `5` et `6`) qui modifie le compte,
  Garden enregistre la date, le commit de `HEAD` (hash, sujet, message complet) et
  si les sources diffèrent de ce commit (`dirty`, auquel cas la version est
  `<hash>-dirty-<empreinte>` et Garden avertit que le message ne décrit pas
  exactement le code). Un PUSH identique à la version précédente du compte n'est
  pas enregistré. Garden avertit si le message n'a pas de ligne `Stratégie:`.
- **Option `7`** : lit l'historique du compte principal (`history/get-farmer-history`),
  puis pour chaque combat terminé non archivé télécharge le combat
  (`fight/get`) et les logs de debug de vos poireaux (`fight/get-logs`, identifiant
  de session requis). Les combats dont les logs n'ont pas pu être lus sont
  retéléchargés au passage suivant (Garden affiche un avertissement) ; l'archivage
  s'interrompt après 3 refus HTTP 401 consécutifs sur les logs (session invalide), les
  combats restants étant traités au passage suivant. Pour chaque échec de logs, la console
  indique l'âge du combat, le mode d'authentification (login ou clé API), l'issue de la
  ré-authentification et le message d'erreur du serveur (tronqué) ; `meta.json` garde
  `logs_error` et `logs_age_seconds`. Un 401/403/404 sur un combat de moins de 10 minutes
  (`LOGS_NOT_READY_SECONDS`, **hypothèse non confirmée**) est marqué `logs_not_ready`, ne
  compte pas pour l'interruption (sauf si une ré-authentification a été refusée, ou si la
  date du combat dépasse de plus de 5 minutes l'horloge locale) : relancez l'archivage quelques minutes plus tard. Les jetons et mots de passe
  éventuellement renvoyés dans un corps d'erreur sont masqués avant stockage et affichage ;
  archivez régulièrement, le serveur ne
  conserve pas forcément les logs indéfiniment.
- **Version d'un combat** : dernière publication du même compte dont la date est
  antérieure ou égale à celle du combat. Avant la première publication
  enregistrée, la version est `unknown-version`.
- **Option `8`** : écrit `Data/exports/<version>.json` par version (publication avec
  message du commit, puis pour chaque combat : résultat `win/loss/draw`, résumé,
  rapport et `debug_logs`). Chaque entrée indique son compte et sa publication ;
  si plusieurs publications partagent une version, `publications` les liste et
  `version` vaut `null`. Les actions détaillées restent dans
  `Data/fights/<id>/fight.json` ; les autres comptes d'un même combat sont
  enregistrés dans des dossiers distincts.
- **Rétention** : les 10 dernières publications par compte (`retention_versions`
  dans `config.json`) ; les combats antérieurs à la plus ancienne conservée sont
  supprimés. Un retour à une version antérieure compte comme une nouvelle publication.

Pour que le message de commit serve à l'analyse, suivez le format du fichier
`.gitmessage` à la racine (`npm run hooks:install` active le modèle et le contrôle) :
sujet `type(portée): description`, puis `Stratégie:` (effet attendu en combat,
seuils changés) et `Tests:` quand `src/*.ts` change. Publiez depuis un arbre propre.

Tests : `python -m unittest discover -s LWGarden/tests -p "test*.py"`.

## Source language versions

Every `.leek` source file must start with `// @version:4`. TypeScript `.ts`
files use `// @version:5.8`. The second comment, `// file version: 1`, records
the source file version; increment it whenever that file's code changes
significantly.