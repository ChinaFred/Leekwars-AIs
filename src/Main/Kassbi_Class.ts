// @version:5.8
// file version: 1
import { planAct } from "../Brain/PlanActScenario.js"

export function turn(): void {
	planAct(Fight.me)
}
