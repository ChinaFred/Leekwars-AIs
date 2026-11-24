# LWGarden

LWGarden is the deployment tool maintained in this repository for synchronizing
local Leek Wars AI sources. General project documentation: [root README](../README.md).

Python 🐍  console app for managing your garden on LeekWars

## Features
* Download of your leek files from [LeeKWars](https://www.leekwars.com)
* Get Register, to check saved data

## How-To
* Install python 3 on your computer
* pip3 install -r requirements.txt

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

Run the manager from the `src` directory with `python Garden.py`, then choose
option `5` to deploy the local `.leek` files to the primary account configured
in `config.json`. The deploy keeps the local folder hierarchy, creates missing
AIs, updates changed AIs, and leaves unrelated remote AIs untouched.
Source files are read as UTF-8, with Windows-1252 used for files that are not
valid UTF-8.
If the API rate-limits a deploy request, Garden waits for the server-provided
retry delay and retries it up to three times before reporting the error.
An error after earlier successful requests may leave the remote garden only
partially deployed; rerun the PUSH after resolving a persistent error.

Garden uses the current path-based API (`ai/get-farmer-tree`, `ai-folder/create`,
`ai/create`, `ai/read` and `ai/write`) with Bearer-token authentication.

For the primary account, Garden uses `LEEKWARS_API_KEY` when it is set;
otherwise it falls back to the primary account credentials in `config.json`.
From a PowerShell terminal in `src`, enter the key without putting it in shell
history, then start Garden:

```powershell
$secureKey = Read-Host "Leek Wars API key" -AsSecureString
$env:LEEKWARS_API_KEY = [System.Net.NetworkCredential]::new("", $secureKey).Password
python Garden.py
Remove-Item Env:LEEKWARS_API_KEY
```

The key is only used for the primary account. Secondary accounts still use
their configured credentials. Never commit or share the key.

The source directory configured by `AIs_folder` is the deployment scope, so
review it before deploying. In this checkout, set it to `../../src/` when
running Garden from `LWGarden/src`. Option `1` is a PULL from Leek Wars to local and
replaces that directory; it requires typing `OVERWRITE`. Options `5` and `6`
are PUSH operations from local to the primary and secondary accounts,
respectively, and do not delete remote AIs.

## LeekScript version

Every `.leek` source file must start with `// @version:4`. This selects the
LeekScript language version; keep it at `4` when changing code. The second
comment, `// file version: 1`, records the source file version. Increment it
whenever that file's code changes significantly.