// PreToolUse (Write) : refuse la création de fichiers de notes ou de rapports hors des emplacements prévus.
import { existsSync } from "node:fs"
import { join } from "node:path"
import { readInput, repoPath, root, tell } from "./lib.mjs"

const ALLOWED = /^(README\.md|ChangeLog\.md|CLAUDE\.md|docs\/[^/]+\.md|LWGarden\/README\.md|LWGarden\/Data\/|\.claude\/|\.github\/|LWGarden\/src\/requirements\.txt$)/

const path = repoPath(readInput().tool_input?.file_path)
if (path && /\.(md|txt)$/i.test(path) && !ALLOWED.test(path) && !existsSync(join(root, path))) {
	tell(`Création refusée : ${path}. Pas de fichier de rapport, de notes ou de sortie de tests dans le dépôt ` +
		"(CLAUDE.md) : réponds dans la conversation, ou complète README.md, ChangeLog.md ou un document de docs/.")
}
