# LWGarden

LWGarden is the deployment tool maintained in this repository for synchronizing
local Leek Wars AI sources. See the [root README](../README.md) and
[project changelog](../ChangeLog.md).

Python 🐍  console app for managing your garden on LeekWars

## Features
* Download of your leek files from [LeeKWars](https://www.leekwars.com)
* Get Register, to check saved data

## How-To
Install Python 3, then from the repository root run:

```powershell
python -m pip install -r LWGarden\src\requirements.txt
python LWGarden\src\Garden.py
```

## Kassbi AI entry point and combat profiles

`../src/Main/Kassbi_Class.leek` is the primary Kassbi entry source and
uses the `planAct` planner. Deploying the file uploads its source; it does not
select the AI for a leek in Leek Wars, so select `Main/Kassbi_Class.leek` in the
game separately. `Main/Kassbi_test.leek` is an example profile for testing.

The profile role selects the combat style, while `aggression` (clamped to
`0..100`) tunes that style's weapon-range preference and health thresholds:

* **Aggressive** favors damage, delays healing and hiding, and uses offensive
  chips at lower life.
* **Balanced** trades damage against preferred range and uses intermediate
  thresholds.
* **Defensive** heals and hides earlier, considers shielding at a wider threat
  distance, and saves offensive chips until healthier.

The `allowHealing`, `allowShielding`, and `allowHiding` settings remain hard
switches for their corresponding support actions.

## Deploying AIs

Run `python LWGarden\src\Garden.py` from the repository root, then choose
option `5` to deploy the `.leek` files under the repository's root `src/`
directory to the primary account configured in `LWGarden\src\config.json`.
The deploy keeps the local folder hierarchy and creates or updates local AIs.
Remote AIs and folders absent from the source can also be moved to the Leek Wars
trash, but only after Garden lists them and you type `DELETE`. Use this only
when the configured source folder is the complete set of AIs to keep.
Source files are read as UTF-8. Legacy Windows-1252 files are decoded in memory
for API upload and reported as informational messages; the local source files
are not rewritten.
Garden spaces all API requests by at least 0.21 seconds (under five requests
per second). If the API rate-limits a request anyway, it waits for the
server-provided retry delay and retries it up to three times before reporting
the error.
An error after earlier successful requests may leave the remote garden only
partially deployed; rerun the PUSH after resolving a persistent error.

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

The source directory configured by `AIs_folder` is the deployment scope. It is
resolved relative to `LWGarden/src`, regardless of the current working
directory; in this checkout, set it to `../../src/`. This keeps all AI logic in
the repository's root `src/` directory. Option `1` pulls from Leek Wars into
that directory, replacing it after you type `OVERWRITE`. Options `5` and `6`
push its `.leek` files to the primary and secondary accounts, respectively.
The `.leek` suffix belongs to local source filenames; Garden removes it when
creating or matching an AI on Leek Wars, whose AI path/name has no source-file
extension. PULL adds `.leek` to downloaded filenames so they are usable in
`src/` and picked up by the next PUSH.
For each account, remote-only AIs and folders are listed before any deletion;
type `DELETE` to move them to the server trash, or enter anything else to keep
them.

## LeekScript version

Every `.leek` source file must start with `// @version:4`. This selects the
LeekScript language version; keep it at `4` when changing code. The second
comment, `// file version: 1`, records the source file version. Increment it
whenever that file's code changes significantly.