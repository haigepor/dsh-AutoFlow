/** Hash a stable string. */
import { createHash } from 'node:crypto'

/** Hash a stable string. @param {string} text Identity. @returns {string} Hex digest. */
export function hash(text) { return createHash('sha256').update(text).digest('hex') }
