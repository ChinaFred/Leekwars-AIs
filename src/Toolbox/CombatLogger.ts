// @version:5.8
// file version: 1
export interface CombatDecision {
	turn: number
	phase: string
	decision: string
	reason: string
	tpBefore: number
	tpAfter: number
	mpBefore: number
	mpAfter: number
	distance: number
	myLife: number
	myMaxLife: number
	enemyLife: number
	enemyMaxLife: number
	behavior?: string
}

export class CombatLogger {
	private decisions: CombatDecision[] = []
	private currentTurn = 0

	setTurn(turn: number): void {
		this.currentTurn = turn
	}

	logDecision(
		phase: string,
		decision: string,
		reason: string,
		tpBefore: number,
		tpAfter: number,
		mpBefore: number,
		mpAfter: number,
		me: Me,
		target: Entity,
		behavior?: string
	): void {
		const distance = me.distance(target)
		this.decisions.push({
			turn: this.currentTurn,
			phase,
			decision,
			reason,
			tpBefore,
			tpAfter,
			mpBefore,
			mpAfter,
			distance,
			myLife: me.life,
			myMaxLife: me.maxLife,
			enemyLife: target.life,
			enemyMaxLife: target.maxLife,
			behavior
		})
	}

	printDecisions(): void {
		console.log("\n=== KASSBI COMBAT DECISIONS LOG ===")
		for (const decision of this.decisions) {
			console.log(
				`\n[Tour ${decision.turn}] ${decision.phase}\n` +
					`  Decision: ${decision.decision}\n` +
					`  Reason: ${decision.reason}\n` +
					`  TP: ${decision.tpBefore} → ${decision.tpAfter} (used: ${decision.tpBefore - decision.tpAfter})\n` +
					`  MP: ${decision.mpBefore} → ${decision.mpAfter} (used: ${decision.mpBefore - decision.mpAfter})\n` +
					`  Distance: ${decision.distance}\n` +
					`  My HP: ${decision.myLife}/${decision.myMaxLife} (${Math.round((decision.myLife / decision.myMaxLife) * 100)}%)\n` +
					`  Enemy HP: ${decision.enemyLife}/${decision.enemyMaxLife} (${Math.round((decision.enemyLife / decision.enemyMaxLife) * 100)}%)\n` +
					(decision.behavior ? `  Behavior: ${decision.behavior}\n` : "")
			)
		}
		console.log("\n=== END LOG ===\n")
	}

	exportJson(): string {
		return JSON.stringify(this.decisions, null, 2)
	}

	getTurnsAnalysis(): Map<number, CombatDecision[]> {
		const byTurn = new Map<number, CombatDecision[]>()
		for (const decision of this.decisions) {
			if (!byTurn.has(decision.turn)) {
				byTurn.set(decision.turn, [])
			}
			byTurn.get(decision.turn)!.push(decision)
		}
		return byTurn
	}
}

export const globalCombatLogger = new CombatLogger()
