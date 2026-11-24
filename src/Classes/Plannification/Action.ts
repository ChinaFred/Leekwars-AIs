// @version:5.8
// file version: 1
export class Action {
	public name = ""
	public action: () => void
	public desc = ""

	constructor(name: string, action: () => void, description = "") {
		this.name = name
		this.action = action
		this.desc = description
	}
}
