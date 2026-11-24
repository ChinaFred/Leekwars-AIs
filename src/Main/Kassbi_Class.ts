// @version:5.8
// file version: 2
import { planAct } from "../Brain/PlanActScenario.js"
import { withErrorReporting } from "../Toolbox/Debug.js"

export function turn(): void {
	withErrorReporting("src/Main/Kassbi_Class.ts", "turn", () => {
		planAct(Fight.me)
	})
}
