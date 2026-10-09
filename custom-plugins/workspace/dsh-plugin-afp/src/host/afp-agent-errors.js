const descriptions = {
  'invalid-run-id': ['validation', 'AFP run ID is an invalid placeholder.', 'Use the real ID returned by afp_refresh or a saved plan. For metadata selection pass runId=null.'],
  'report-parameters-conflict': ['validation', 'AFP report parameters conflict.', 'Pass only kind=run|plan and id. Do not pass runId and planId.'],
  'selection-missing-photos': ['validation', 'Selected IDs lack successful reads in this Turn.', 'Read these photos with afp_photo_details or choose IDs from successful local result pages before selecting again.'],
  'selection-report-missing': ['validation', 'The visual report has not been read in this Turn.', 'Read afp_report with kind=run and the real run id, or use basis=metadata with runId=null.'],
  'selection-visual-rejected': ['validation', 'Some selected photos did not pass the visual report.', 'Select only IDs kept by that run; use metadata basis only when reporting unverified metadata results.'],
  'selection-basis-conflict': ['validation', 'Selection basis and runId conflict.', 'Use basis=metadata and runId=null, or basis=visual and a real runId. Never use a placeholder id.'],
  'refresh-mode-conflict': ['validation', 'Refresh mode and arguments conflict.', 'Start: mode=start, categories and runId=null. Resume: mode=resume, categories=[] and a real runId.'],
  'refresh-busy': ['availability', 'This AFP run already has an active task.', 'Wait for the original job to end, or stop it with job_kill and wait for termination, then resume the same runId. Never automatically retry or start another run.'],
  'selection-unverified': ['validation', 'AFP final selection lacks the required evidence.', 'Use IDs returned by successful AFP reads in this Turn. For visual acceptance, read afp_report in this Turn and select only IDs kept in that saved run.'],
  'invalid-arguments': ['validation', 'AFP arguments are invalid.', 'Check required fields, nonblank query, language, paging bounds and explicit report kind/id.'],
  'invalid-cursor': ['validation', 'AFP paging cursor is invalid.', 'For a new search call afp_photo_search_start without any cursor field; legacy first-page callers omit cursor. For later pages use only the cursor returned by the previous successful search with the same query and language. Do not repeat unchanged input automatically.'],
  'collection-unavailable': ['read', 'This unnamed directory entry cannot be browsed as a collection.', 'Choose a named collection from afp_collection_list; an unnamed entry does not prove shared collection access.'],
  'query-rejected': ['read', 'AFP returned a GraphQL error; the rejection cause may be unconfirmed.', 'Check the safe upstream category, account access and API compatibility before changing keywords. For a new search use afp_photo_search_start without cursor. Do not repeat unchanged input automatically.'],
  'upstream-error': ['read', 'AFP returned an unclassified API error.', 'The cause is unconfirmed. Inspect the safe upstream category and API compatibility; do not automatically change keywords or repeat unchanged input.'],
  'api-schema-rejected': ['read', 'AFP rejected the requested API fields.', 'Check AFP API compatibility and request fields. Changing keywords alone does not resolve an API field error. Do not repeat unchanged input automatically.'],
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
  const failure = error?.afpFailure
  const categories = new Set(['authentication', 'authorization', 'schema', 'query', 'rate-limit', 'service', 'unknown'])
  const upstream = failure?.protocol === 'graphql' && categories.has(failure.category)
    && Number.isInteger(failure.httpStatus) && failure.httpStatus >= 100 && failure.httpStatus <= 599
    ? { protocol: 'graphql', httpStatus: failure.httpStatus, category: failure.category } : undefined
  let code = 'operation-failed'
  if (['Invalid AFP arguments', 'Invalid AFP query', 'Choose runId or planId'].includes(message)) code = 'invalid-arguments'
  else if (message === 'AFP run ID is invalid') code = 'invalid-run-id'
  else if (message === 'AFP report parameters conflict') code = 'report-parameters-conflict'
  else if (message === 'AFP selected photos lack read evidence') code = 'selection-missing-photos'
  else if (message === 'AFP visual report lacks current turn evidence') code = 'selection-report-missing'
  else if (message === 'AFP selection is not visually accepted') code = 'selection-visual-rejected'
  else if (['AFP metadata selection requires null runId', 'AFP visual selection requires a runId'].includes(message)) code = 'selection-basis-conflict'
  else if (message === 'AFP refresh mode conflicts with arguments') code = 'refresh-mode-conflict'
  else if (message === 'AFP refresh run is busy') code = 'refresh-busy'
  else if (['AFP selection lacks current turn evidence', 'AFP selection is not visually accepted'].includes(message)) code = 'selection-unverified'
  else if (['AFP cursor must come from a previous photo search', 'Invalid AFP cursor'].includes(message)) code = 'invalid-cursor'
  else if (message === 'AFP collection has no display name') code = 'collection-unavailable'
  else if (message === 'AFP tools require a Session') code = 'session-required'
  else if (/^AFP feature unavailable: [a-z-]+$/.test(message) || ['AFP read capability disabled', 'AFP workbench is disposed', 'AFP workbench disposed'].includes(message)) code = 'feature-disabled'
  else if (message === 'AFP credentials are missing') code = 'credentials-missing'
  else if (message === 'AFP getlogin did not return an access token') code = 'login-failed'
  else if (failure?.category === 'authentication') code = 'authentication-failed'
  else if (message === 'AFP collection is not available to this account' || error?.code === 'ENOENT') code = 'not-found'
  else if (/^HTTP (?:request|response body) timed out after \d+ms$/.test(message)) code = 'read-timeout'
  else if (read && /^[A-Za-z][A-Za-z0-9_]* returned GraphQL errors:/.test(message)) {
    code = new Map([['authentication', 'authentication-failed'], ['authorization', 'access-denied'],
      ['schema', 'api-schema-rejected'], ['query', 'query-rejected'], ['rate-limit', 'rate-limited'], ['service', 'upstream-unavailable']])
      .get(upstream?.category) ?? 'upstream-error'
  }
  else {
    const status = Number(message.match(/^(?:[A-Za-z][A-Za-z0-9_]* failed|AFP token validation failed) with HTTP (\d{3})$/)?.[1])
    if (status === 401) code = 'authentication-failed'
    else if (status === 403) code = 'access-denied'
    else if (status === 404) code = 'not-found'
    else if (status === 429) code = 'rate-limited'
    else if ([408, 500, 502, 503, 504].includes(status)) code = 'upstream-unavailable'
  }
  const [stage, text, advice] = descriptions[code]
  // 活跃任务结束后可用相同参数续跑，不能把临时忙碌永久缓存为本轮无效输入。
  if (code === 'refresh-busy') return { code, stage, message: text, action: advice, retryable: true, durationMs }
  if (read && code === 'operation-failed') return { code, stage: 'read', message: 'AFP read failed.',
    action: 'Check read parameters, credentials and AFP availability. Do not repeat unchanged input automatically.', retryable: false, durationMs }
  return { code, stage, message: text, action: read ? advice : 'Inspect afp_report and current AFP state before creating a new plan; never automatically retry the operation.',
    retryable: read && ['rate-limited', 'upstream-unavailable', 'read-timeout'].includes(code), durationMs,
    ...(read && upstream ? { upstream } : {}) }
}
