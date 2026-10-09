/** Fixed read-failure fields; never persist provider messages, credentials, URLs or response bodies.
 * @param {Error} error Transport or provider failure.
 * @param {string} stage Owned operation phase.
 * @returns {object} Safe error code, phase and bounded-retry eligibility.
 */
export function readFailure(error, stage) {
  const category = error?.afpFailure?.category;
  const status = error?.httpStatus ?? Number(String(error?.message ?? '').match(/with HTTP (\d{3})$/)?.[1]);
  let code = 'read-failed';
  if (error?.code === 'preview-host-blocked') code = 'preview-host-blocked';
  else if (stage === 'checkpoint-save' && ['EPERM', 'EACCES', 'EBUSY', 'EINTR', 'ENOSPC', 'EIO'].includes(error?.code)) code = 'checkpoint-save-failed';
  else if (category === 'authentication' || status === 401) code = 'authentication-failed';
  else if (category === 'authorization' || status === 403) code = 'access-denied';
  else if (category === 'schema') code = 'api-schema-rejected';
  else if (category === 'query') code = 'query-rejected';
  else if (category === 'rate-limit' || status === 429) code = 'rate-limited';
  else if (category === 'service' || [500, 502, 503, 504].includes(status)) code = 'upstream-unavailable';
  else if (error?.name === 'TimeoutError' || error?.name === 'AbortError'
    || /^HTTP (?:request|response body) timed out after \d+ms$/.test(error?.message ?? '') || status === 408) code = 'read-timeout';
  else if (error?.name === 'TypeError' || /^(?:fetch failed|network failure)$/.test(error?.message ?? '')) code = 'network-failed';
  return { code, stage, retryable: ['rate-limited', 'upstream-unavailable', 'read-timeout', 'network-failed'].includes(code),
    ...(code === 'preview-host-blocked' && typeof error?.hostname === 'string' && error.hostname.length <= 253
      && /^[a-z0-9.-]+$/.test(error.hostname) ? { host: error.hostname } : {}) };
}

/** Project a saved error through the same fixed vocabulary, excluding arbitrary durable fields.
 * @param {object} failure Saved run failure.
 * @returns {object} Safe code, stage and retryability.
 */
export function savedReadFailure(failure) {
  const codes = ['read-failed', 'authentication-failed', 'access-denied', 'api-schema-rejected', 'query-rejected',
    'rate-limited', 'upstream-unavailable', 'read-timeout', 'network-failed', 'cancelled', 'preview-host-blocked', 'checkpoint-save-failed'];
  const stages = ['connection', 'collections', 'search', 'preview', 'vision', 'confirmation', 'visual', 'completed',
    'refresh', 'read', 'write', 'progress-update', 'progress-output', 'checkpoint-save'];
  const code = codes.includes(failure?.code) ? failure.code : 'read-failed';
  const stage = stages.includes(failure?.stage) ? failure.stage : 'unknown';
  return { code, stage, retryable: ['rate-limited', 'upstream-unavailable', 'read-timeout', 'network-failed', 'cancelled'].includes(code),
    ...(code === 'preview-host-blocked' && typeof failure?.host === 'string' && failure.host.length <= 253
      && /^[a-z0-9.-]+$/.test(failure.host) ? { host: failure.host } : {}) };
}
