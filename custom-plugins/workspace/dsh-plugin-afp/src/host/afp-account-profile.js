import { createHttpClient } from '../vendor/auto-afp-img/http-client.mjs'
import { createAfpRequestHeaders, readAfpJson } from '../vendor/auto-afp-img/afp-api-client.mjs'

const query = `query user { user {
  login id firstName lastName email clientId expires
  credit { amount } subjectToCredit onlyIncludedDocumentDownload
} }`

function text(value) {
  return typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : null
}

/** Read Hub identity and credit fields without exposing authentication or raw account records.
 * @param {object} options Authenticated transport and bounded deployment settings.
 * @returns {Function} Read-only account profile request.
 */
export function createAccountProfileReader({ accessToken, fetchImpl, sleep, config }) {
  const http = createHttpClient({ fetchImpl, sleep, timeoutMs: config.requestTimeoutMs,
    retries: config.readRetries, maxResponseBytes: config.maxResponseBytes, endpointCategory: 'afp-account' })
  return async () => {
    const response = await http.request(config.loginEndpoint, { method: 'POST',
      headers: createAfpRequestHeaders({ accessToken }), body: JSON.stringify({ operationName: 'user', variables: {}, query }) })
    const payload = await readAfpJson(response, 'user', http)
    const user = payload?.data?.user
    if (!response.ok || payload?.errors?.length || !user || typeof user !== 'object' || Array.isArray(user)) {
      throw new Error('AFP account profile unavailable')
    }
    const amount = user.credit?.amount
    return { login: text(user.login), id: text(user.id), firstName: text(user.firstName), lastName: text(user.lastName),
      email: text(user.email), clientId: text(user.clientId), expires: text(user.expires),
      credit: typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 ? amount : null,
      subjectToCredit: typeof user.subjectToCredit === 'boolean' ? user.subjectToCredit : null,
      onlyIncludedDocumentDownload: typeof user.onlyIncludedDocumentDownload === 'boolean' ? user.onlyIncludedDocumentDownload : null }
  }
}
