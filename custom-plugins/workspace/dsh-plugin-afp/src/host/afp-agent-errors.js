const descriptions = {
  'invalid-arguments': ['validation', 'AFP arguments are invalid.', 'Check required fields, nonblank query, language, paging bounds and mutually exclusive report IDs.'],
  'invalid-cursor': ['validation', 'AFP paging cursor is invalid.', 'For a new search call afp_photo_search_start without any cursor field; legacy first-page callers omit cursor. For later pages use only the cursor returned by the previous successful search with the same query and language. Do not repeat unchanged input automatically.'],
  'collection-unavailable': ['read', 'This unnamed directory entry cannot be browsed as a collection.', 'Choose a named collection from afp_collection_list; an unnamed entry does not prove shared collection access.'],
  'query-rejected': ['read', 'AFP rejected the query request.', 'Check query and paging parameters. For a new search use afp_photo_search_start without cursor; use only a previously returned cursor for later pages. Do not repeat unchanged input automatically.'],
  'session-required': ['availability', 'AFP tools require a Session.', 'Run this tool from a DSH Session.'],
  'feature-disabled': ['availability', 'The required AFP capability is unavailable.', 'Check the plugin feature switch and Host readiness.'],
  'credentials-missing': ['authentication', 'AFP credentials are not configured.', 'Configure an AFP token or username and password in plugin settings.'],
  'login-failed': ['authentication', 'AFP login did not return a usable token.', 'Check credentials and AFP login availability; the cause is not confirmed.'],
  'authentication-failed': ['authentication', 'AFP rejected authentication.', 'Verify or refresh credentials in plugin settings.'],
  'access-denied': ['authorization', 'AFP denied access to this resource.', 'Check the account and resource permissions.'],
  'not-found': ['read', 'The requested AFP resource is unavailable.', 'Check the ID and account; use an existing report or collection.'],
  'rate-limited': ['read', 'AFP limited this read request.', 'Wait before retrying the same read; do not restart a write.'],
  'upstream-unavailable': ['read', 'AFP is temporarily unavailable.', 'Retry the same read later; do not restart a write.'],
  'read-timeout': ['read', 'The AFP read timed out.', 'Retry the same read later or check the configured timeout.'],
  'operation-failed': ['operation', 'AFP operation failed.', 'Check setup and the saved report before any further write; its outcome may be partial.'],
}

/** Fixed error projection; upstream messages are used only for known classifications and never returned.
 * @param {Error} error Failure from argument validation or the AFP service.
 * @param {string} kind Tool presentation kind; only reads permit a retry suggestion.
 * @param {number} durationMs Measured execution duration.
 * @returns {object} Safe model-visible error fields, without upstream bodies or credentials.
 */
export function agentError(error, kind, durationMs) {
  const message = typeof error?.message === 'string' ? error.message : ''
  const read = ['read', 'search'].includes(kind)
  let code = 'operation-failed'
  if (['Invalid AFP arguments', 'Invalid AFP query', 'Choose runId or planId'].includes(message)) code = 'invalid-arguments'
  else if (['AFP cursor must come from a previous photo search', 'Invalid AFP cursor'].includes(message)) code = 'invalid-cursor'
  else if (message === 'AFP collection has no display name') code = 'collection-unavailable'
  else if (message === 'AFP tools require a Session') code = 'session-required'
  else if (/^AFP feature unavailable: [a-z-]+$/.test(message) || ['AFP read capability disabled', 'AFP workbench is disposed', 'AFP workbench disposed'].includes(message)) code = 'feature-disabled'
  else if (message === 'AFP credentials are missing') code = 'credentials-missing'
  else if (message === 'AFP getlogin did not return an access token') code = 'login-failed'
  else if (message === 'AFP collection is not available to this account' || error?.code === 'ENOENT') code = 'not-found'
  else if (/^HTTP (?:request|response body) timed out after \d+ms$/.test(message)) code = 'read-timeout'
  else if (read && /^[A-Za-z][A-Za-z0-9_]* returned GraphQL errors:/.test(message)) code = 'query-rejected'
  else {
    const status = Number(message.match(/^(?:[A-Za-z][A-Za-z0-9_]* failed|AFP token validation failed) with HTTP (\d{3})$/)?.[1])
    if (status === 401) code = 'authentication-failed'
    else if (status === 403) code = 'access-denied'
    else if (status === 404) code = 'not-found'
    else if (status === 429) code = 'rate-limited'
    else if ([408, 500, 502, 503, 504].includes(status)) code = 'upstream-unavailable'
  }
  const [stage, text, advice] = descriptions[code]
  if (read && code === 'operation-failed') return { code, stage: 'read', message: 'AFP read failed.',
    action: 'Check read parameters, credentials and AFP availability. Do not repeat unchanged input automatically.', retryable: false, durationMs }
  return { code, stage, message: text, action: read ? advice : 'Inspect afp_report and current AFP state before creating a new plan; never automatically retry the operation.',
    retryable: read && ['rate-limited', 'upstream-unavailable', 'read-timeout'].includes(code), durationMs }
}
