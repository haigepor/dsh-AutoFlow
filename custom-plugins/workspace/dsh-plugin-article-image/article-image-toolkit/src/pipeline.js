/** Retrieval strategy ladder: which attempts to make, decided by why the previous one failed. */

/**
 * Failure families name what a further attempt could realistically change.
 *
 * - `content`: the document arrived but its delivered text is unusable without script
 *   execution, so a browser builds a different document.
 * - `client`: the server likely refused this client rather than the content (403 against a
 *   non-browser user agent); a real browser presents different request metadata.
 * - `size`: the raw document exceeds the byte budget, but a browser request is a different
 *   fetch: the renderer prunes the DOM before serializing, so a page whose source is 20 MB of
 *   inlined script can still snapshot at article scale.
 * - `decision`: the server answered about access or existence — 404, 429, 5xx, a login wall,
 *   a subscription wall. Rendering reproduces the same answer, so it is not attempted.
 * - `transport`: no document arrived. Rendering repeats the same network path.
 */
const FAMILIES = new Map([
  ['article-extraction', 'content'], ['article-short', 'content'], ['article-truncated', 'content'], ['article-challenge', 'content'],
  ['article-access', 'client'],
  ['article-resource-limit', 'size'], ['article-html-limit', 'size'],
  ['article-not-found', 'decision'], ['article-rate-limit', 'decision'], ['article-server', 'decision'],
  ['article-login', 'decision'], ['article-restricted', 'decision'], ['article-url-blocked', 'decision'],
  ['article-timeout', 'transport'], ['article-network', 'transport'], ['article-interrupted', 'transport'],
  ['article-unsupported', 'transport'],
  ['article-render', 'transport'], ['article-render-unavailable', 'transport'],
])

/**
 * Classify one failure.
 * Unknown codes default to `transport`: a failure nobody classified must not trigger an
 * expensive browser launch on the assumption that rendering would help.
 * @param {string} code Failure code.
 * @returns {string} Family name.
 */
export function failureFamily(code) {
  return FAMILIES.get(code) ?? 'transport'
}

/**
 * Rungs in escalation order, with the families that justify entering them.
 * `structured` reads the same bytes as `static`, so it is a second projection, not a new request.
 * `browser` covers both the serialized document and the live visible text: one render, two
 * projections, so a page that loses text on serialization never pays for a second navigation.
 */
export const RUNGS = [
  { id: 'static', families: new Set(['content', 'client', 'size', 'decision', 'transport']) },
  { id: 'structured', families: new Set(['content']) },
  { id: 'browser', families: new Set(['content', 'client', 'size']) },
]

/**
 * Plan the ladder for one retrieval.
 * @param {string} renderMode `never`, `fallback` or `always`.
 * @returns {string[]} Ordered rung ids.
 */
export function planRungs(renderMode) {
  if (renderMode === 'always') return ['browser']
  if (renderMode === 'never') return ['static', 'structured']
  return ['static', 'structured', 'browser']
}

/**
 * Pick the next rung a failure justifies.
 * Rungs in between are skipped rather than treated as a dead end: `structured` only
 * re-projects the bytes static already has, so a 403 (`client`) goes straight to `browser`.
 * A `decision` failure matches no rung, which ends the ladder without a browser launch.
 * @param {string[]} rungs Planned ladder.
 * @param {string} current Rung that failed.
 * @param {string} failure Failure code from that rung.
 * @returns {string|null} Rung to attempt next, or null when the ladder is exhausted.
 */
export function escalate(rungs, current, failure) {
  const family = failureFamily(failure)
  const start = rungs.indexOf(current)
  if (start < 0) return null
  for (let index = start + 1; index < rungs.length; index++) {
    const entry = RUNGS.find(value => value.id === rungs[index])
    if (entry?.families.has(family)) return entry.id
  }
  return null
}
