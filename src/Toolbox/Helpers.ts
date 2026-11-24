// @version:5.8
// file version: 1
export function copyArray<T>(original: readonly T[]): T[] {
	return original.slice()
}
