/**
 * Per-workspace composer input history behind the ↑↓ recall gesture. One
 * bucket per workspace (cwd, else session id), newest first, persisted to
 * localStorage with an in-memory mirror so `list` never re-parses on render.
 * Unavailable storage (privacy modes, quota) degrades to the memory mirror —
 * recall then works for the document lifetime only.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const STORAGE_KEY = 'dsh.conversation.input-history.v1'
const PER_SCOPE_LIMIT = 200
const SCOPE_LIMIT = 20
const ENTRY_LIMIT = 8000
const TOTAL_LIMIT = 1_000_000

const NO_ENTRIES: readonly string[] = []

/**
 * Bucket scope for one session.
 * @param cwd - workspace directory, when available.
 * @param sessionId - fallback identity without a workspace.
 * @returns workspace directory or session identity.
 */
export function historyScopeOf(cwd: string | undefined, sessionId: SessionId): string {
  return cwd !== undefined && cwd !== '' ? cwd : sessionId
}

function storage(): Storage | null {
  try {
    // lib.dom types localStorage as always present; sandboxed runtimes omit it.
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage
  } catch (_error) {
    // SecurityError from privacy modes: the mirror below keeps this session's history.
    return null
  }
}

let loaded = false
const scopes = new Map<string, string[]>()

function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  let raw: string | null | undefined
  try {
    raw = storage()?.getItem(STORAGE_KEY)
  } catch (_error) {
    // Storage reads can be denied even when the Storage object is accessible.
    return
  }
  if (raw === undefined || raw === null) return
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (_error) {
    // Corrupt payload: start from an empty history rather than failing recall.
    return
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
  const record = (parsed as { scopes?: unknown }).scopes
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return
  const buckets = new Map<string, unknown>(Object.entries(record))
  const order: unknown = (parsed as { order?: unknown }).order
  const ordered = Array.isArray(order) ? order.filter((key): key is string => typeof key === 'string') : []
  // Object property enumeration sorts numeric keys; the saved order owns LRU.
  for (const scope of new Set([...ordered, ...buckets.keys()])) {
    const entries = buckets.get(scope)
    if (!Array.isArray(entries)) continue
    const valid = entries.filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.slice(0, ENTRY_LIMIT))
    if (valid.length === 0) continue
    scopes.set(scope, valid.slice(0, PER_SCOPE_LIMIT))
  }
  prune()
}

function serializedLength(): number {
  return JSON.stringify({ order: [...scopes.keys()], scopes: Object.fromEntries(scopes) }).length
}

/** Enforce the scope-count and total-serialized-size caps, oldest first. */
function prune(): void {
  for (const oldest of scopes.keys()) {
    if (scopes.size <= SCOPE_LIMIT) break
    scopes.delete(oldest)
  }
  for (const [oldest, entries] of scopes) {
    if (serializedLength() <= TOTAL_LIMIT) break
    if (scopes.size > 1) {
      scopes.delete(oldest)
      continue
    }
    // The sole scope is over budget: shed its oldest entries until it fits.
    while (entries.length > 0 && serializedLength() > TOTAL_LIMIT) entries.pop()
    if (entries.length === 0) scopes.delete(oldest)
  }
}

function persist(): void {
  const store = storage()
  if (store === null) return
  try {
    store.setItem(STORAGE_KEY, JSON.stringify({ order: [...scopes.keys()], scopes: Object.fromEntries(scopes) }))
  } catch (_error) {
    // Quota exceeded: the write is dropped and the memory mirror stays authoritative.
  }
}

/**
 * Record one submitted text at the front of its workspace bucket.
 * @param text - the submitted draft text (already non-empty at the call site).
 * @param scope - the bucket scope ({@link historyScopeOf}).
 */
export function remember(text: string, scope: string): void {
  ensureLoaded()
  const entry = text.slice(0, ENTRY_LIMIT)
  const entries = scopes.get(scope) ?? []
  const existing = entries.indexOf(entry)
  if (existing !== -1) entries.splice(existing, 1)
  entries.unshift(entry)
  if (entries.length > PER_SCOPE_LIMIT) entries.length = PER_SCOPE_LIMIT
  // Re-insert so Map order doubles as the recency order prune() relies on.
  scopes.delete(scope)
  scopes.set(scope, entries)
  prune()
  persist()
}

/**
 * Read one bucket, newest first. Served from the mirror — never re-parses
 * storage on a render-path call.
 * @param scope - the bucket scope ({@link historyScopeOf}).
 * @returns the recorded texts, newest first.
 */
export function list(scope: string): readonly string[] {
  ensureLoaded()
  return scopes.get(scope) ?? NO_ENTRIES
}

/**
 * Test seam: drop the mirror so a spec starts from empty. By default the
 * persisted payload goes too; `keepStorage` simulates a fresh document
 * reading the same storage.
 * @param keepStorage - retain the persisted payload for a reload pass.
 */
export function resetInputHistoryForTests(keepStorage = false): void {
  if (!keepStorage) {
    try {
      storage()?.removeItem(STORAGE_KEY)
    } catch (_error) {
      // Denied removal must not prevent resetting the in-memory mirror.
    }
  }
  scopes.clear()
  loaded = false
}
