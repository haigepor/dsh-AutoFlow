/** Stable task/session identities only for the two article plugin modules matched by fixture.mjs. */
export { createHash } from 'node:crypto'
let ordinal = 0
export function randomUUID() { return `a1000000-0000-4000-8000-${String(++ordinal).padStart(12, '0')}` }
