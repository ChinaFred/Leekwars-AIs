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

## Source language versions

Every `.leek` source file must start with `// @version:4`. TypeScript `.ts`
files use `// @version:5.8`. The second comment, `// file version: 1`, records
the source file version; increment it whenever that file's code changes
significantly.