// Stop : rappelle une fois que src/ a changé sans tests réussis depuis.
import { isUntested } from "../../scripts/tests-state.mjs"
import { readInput, tell } from "./lib.mjs"

if (!readInput().stop_hook_active && isUntested()) {
	tell("src/ a été modifié sans test réussi depuis. Lance `npm run test:only -- tests/<fichier>.test.mjs` " +
		"(ou `npm test`), ou dis explicitement dans ta réponse que le changement n'est pas testé.")
}
