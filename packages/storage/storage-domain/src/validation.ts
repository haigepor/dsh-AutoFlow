/** Shared durable-record validation for open and manual hydration. */
import { DomainError } from './error.ts'

/**
 * Validate a stored value without changing its durable representation.
 * @param domain - Record owner.
 * @param table - Table name, or empty for global.
 * @param key - Record key.
 * @param parse - Schema parse operation.
 * @returns the validated value, retaining any schema failure as the error cause.
 */
export function parseRecord<T>(domain: string, table: string, key: string, parse: () => T): T {
  try { return parse() }
  catch (error) {
    const slot = table === '' ? 'global' : `record '${key}' in table '${table}'`
    throw new DomainError('invalid-record', `domain '${domain}': stored ${slot} does not match its schema`, { detail: { table, key }, cause: error })
  }
}
