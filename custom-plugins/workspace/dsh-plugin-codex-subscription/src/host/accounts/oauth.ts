/** OAuth PKCE and an owned loopback callback; browser cookies never enter this module. */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { z } from 'zod'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import { AccountError } from './record.ts'
import type { AccountsOptions } from './types.ts'
import { readBoundedJson } from './json.ts'
import { failureDetails } from './failures.ts'

/** Full token exchange result, including metadata omitted by the native pi login. */
export interface OAuthTokens extends OAuthCredential {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
  accountId: string
  idToken?: string | undefined
  email?: string | undefined
  plan?: string | undefined
  workspace?: string | undefined
  userId?: string | undefined
  subscriptionUntil?: number | undefined
}

/** A callback listener and the PKCE request it belongs to. */
export interface OAuthAttempt {
  authorizationUrl: string
  redirectUri: string
  verifier: string
  state: string
  code: Promise<string>
  accept(value: string): void
  /** Acknowledge the authorization outcome after the credential transaction has settled. */
  finish(authorized: boolean): void
  close(): void
}

const jwtSchema = z.object({ exp: z.number().finite().optional(), sub: z.string().optional(), email: z.string().optional(),
  'https://api.openai.com/profile': z.object({ email: z.string().optional() }).optional(),
  'https://api.openai.com/auth': z.object({ chatgpt_account_id: z.string().optional(), chatgpt_plan_type: z.string().optional(),
    chatgpt_workspace_id: z.string().optional(), organization_id: z.string().optional(), chatgpt_user_id: z.string().optional(),
    chatgpt_subscription_active_until: z.string().optional() }).optional() })
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(), id_token: z.string().min(1).optional() })

function claims(token: string) {
  try { return jwtSchema.parse(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))) }
  catch { throw new AccountError('OAuth 身份令牌无法解析。', 'INVALID_TOKEN') }
}

/** Extract display metadata from token claims; these are identity data, not an authorization decision. */
export function tokenMetadata(access: string, idToken?: string, now = Date.now()) {
  const accessClaims = claims(access), identity = idToken === undefined ? accessClaims : claims(idToken)
  const accessAuth = accessClaims['https://api.openai.com/auth'], identityAuth = identity['https://api.openai.com/auth']
  const accountId = accessAuth?.chatgpt_account_id
  if (!accountId || (identityAuth?.chatgpt_account_id !== undefined && identityAuth.chatgpt_account_id !== accountId)
    || identityAuth?.chatgpt_user_id !== undefined && accessAuth?.chatgpt_user_id !== undefined && identityAuth.chatgpt_user_id !== accessAuth.chatgpt_user_id) {
    throw new AccountError('OAuth 令牌缺少账号或身份不一致。', 'INVALID_TOKEN')
  }
  const until = Date.parse(identityAuth?.chatgpt_subscription_active_until ?? accessAuth?.chatgpt_subscription_active_until ?? '')
  const email = identity.email ?? identity['https://api.openai.com/profile']?.email ?? accessClaims.email ?? accessClaims['https://api.openai.com/profile']?.email
  const userId = identityAuth?.chatgpt_user_id ?? accessAuth?.chatgpt_user_id ?? identity.sub ?? accessClaims.sub
  const plan = accessAuth?.chatgpt_plan_type ?? identityAuth?.chatgpt_plan_type
  return { accountId, ...(email === undefined ? {} : { email }), ...(userId === undefined ? {} : { userId }), ...(plan === undefined ? {} : { plan }),
    workspace: identityAuth?.chatgpt_workspace_id ?? identityAuth?.organization_id ?? accessAuth?.chatgpt_workspace_id ?? accountId,
    ...(Number.isFinite(until) && until > now ? { subscriptionUntil: until } : {}) }
}

/** Exchange an authorization code or refresh token using the injected network policy. */
export async function exchangeTokens(options: AccountsOptions, fields: Record<string, string>, signal: AbortSignal, previous?: OAuthTokens): Promise<OAuthTokens> {
  const response = await options.fetch(options.tokenUrl, { method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: options.clientId, ...fields }), signal })
  if (!response.ok) throw new AccountError(`OAuth 令牌兑换失败（HTTP ${response.status}），请检查授权状态。`, 'TOKEN_EXCHANGE_FAILED', response.status,
    await failureDetails(response, options.now?.() ?? Date.now(), signal))
  const raw = await readBoundedJson(response, 65_536, signal)
  const parsed = tokenSchema.safeParse(raw)
  if (!parsed.success) throw new AccountError('OAuth 返回的令牌字段不完整。', 'INVALID_TOKEN')
  const token = parsed.data, refresh = token.refresh_token ?? previous?.refresh
  if (!refresh) throw new AccountError('OAuth 未返回刷新令牌。', 'INVALID_TOKEN')
  const idToken = token.id_token ?? previous?.idToken
  const metadata = tokenMetadata(token.access_token, idToken, options.now?.() ?? Date.now())
  if (previous !== undefined && metadata.accountId !== previous.accountId) throw new AccountError('刷新后账号发生变化，请重新登录。', 'ACCOUNT_CHANGED')
  if (previous !== undefined) {
    const before = tokenMetadata(previous.access, previous.idToken, options.now?.() ?? Date.now())
    const changed = before.userId !== undefined && metadata.userId !== undefined ? before.userId !== metadata.userId
      : before.email !== undefined && metadata.email !== undefined && before.email.trim().toLowerCase() !== metadata.email.trim().toLowerCase()
    if (changed) throw new AccountError('刷新后的用户身份发生变化，请重新登录。', 'ACCOUNT_CHANGED', 401, { authCode: 'TOKEN_INVALIDATED' })
  }
  const now = options.now?.() ?? Date.now(), exp = claims(token.access_token).exp
  const expires = token.expires_in === undefined ? exp === undefined ? undefined : exp * 1000 : now + token.expires_in * 1000
  if (expires === undefined || !Number.isFinite(expires) || expires <= now) throw new AccountError('OAuth 令牌缺少有效到期时间，请重新登录。', 'INVALID_TOKEN')
  return { type: 'oauth', access: token.access_token, refresh, expires,
    ...metadata, ...(idToken === undefined ? {} : { idToken }) }
}

function closeServer(server: Server): void { server.close(); server.closeAllConnections() }

/** Start the first available callback port; manual paste uses the same state validation. */
export async function createOAuthAttempt(options: AccountsOptions): Promise<OAuthAttempt> {
  const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url')
  let resolveCode: (code: string) => void = () => {}
  const code = new Promise<string>(resolve => { resolveCode = resolve })
  let resolveOutcome: (authorized: boolean) => void = () => {}, finished = false
  const outcome = new Promise<boolean>(resolve => { resolveOutcome = resolve })
  const finish = (authorized: boolean): void => { if (!finished) { finished = true; resolveOutcome(authorized) } }
  let callbackResponse: ServerResponse | undefined
  let redirectUri = '', accepted = false
  const accept = (value: string) => {
    if (accepted) throw new AccountError('登录回调已经处理。', 'LOGIN_ALREADY_COMPLETED')
    let url: URL
    try { url = new URL(value) } catch { throw new AccountError('请粘贴完整的登录回调地址。', 'INVALID_CALLBACK') }
    const expected = new URL(redirectUri)
    if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.searchParams.get('state') !== state) {
      throw new AccountError('登录回调地址或 state 不匹配。', 'INVALID_STATE')
    }
    if (url.searchParams.has('error')) throw new AccountError('登录授权被拒绝，请重新登录。', 'AUTHORIZATION_DECLINED')
    const authorizationCode = url.searchParams.get('code')
    if (!authorizationCode || authorizationCode.length > 8192) throw new AccountError('登录回调缺少授权码。', 'INVALID_CALLBACK')
    accepted = true; resolveCode(authorizationCode)
  }
  let listening: Server | undefined
  for (const port of options.callbackPorts) {
    const server = createServer(async (request, response) => {
      response.setHeader('cache-control', 'no-store'); response.setHeader('content-type', 'text/plain; charset=utf-8')
      response.setHeader('referrer-policy', 'no-referrer'); response.setHeader('x-content-type-options', 'nosniff')
      try {
        if (request.method !== 'GET' || (request.url?.length ?? 0) > 16_384) throw new AccountError('无效回调请求。', 'INVALID_CALLBACK')
        accept(new URL(request.url ?? '/', redirectUri).toString())
        callbackResponse = response
        // 收到 code 仅代表回调有效；兑换和持久化都成功后才关闭浏览器窗口。
        const authorized = await outcome, nonce = randomBytes(16).toString('base64')
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.setHeader('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`)
        response.writeHead(authorized ? 200 : 400)
        response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AutoFlow · ChatGPT</title><body><h1>${authorized ? '登录成功' : '登录失败'}</h1><p>${authorized ? '账号已保存，正在关闭此窗口；如果窗口仍然显示，请手动关闭。' : '授权未完成，请返回 AutoFlow 重试。'}</p><script nonce="${nonce}">history.replaceState(null,'','/auth/callback');${authorized ? 'window.close();' : ''}</script></body></html>`)
      } catch { response.writeHead(400); response.end('登录回调无效，请返回 AutoFlow 重试。') }
    })
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new AccountError('无法读取登录回调端口。', 'CALLBACK_FAILED')
      redirectUri = `http://localhost:${address.port}/auth/callback`; listening = server; break
    } catch (error) {
      closeServer(server)
      if (!(error instanceof Error && 'code' in error && typeof error.code === 'string' && ['EADDRINUSE', 'EACCES', 'EPERM'].includes(error.code))) throw error
    }
  }
  // 两个标准端口都被占用时保留手动粘贴路径，不抢占其他应用的监听器。
  if (!redirectUri) redirectUri = `http://localhost:${options.callbackPorts[0]}/auth/callback`
  const authorize = new URL(options.authorizeUrl)
  authorize.search = new URLSearchParams({ response_type: 'code', client_id: options.clientId, redirect_uri: redirectUri,
    scope: 'openid profile email offline_access', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'codex_cli_rs' }).toString()
  return { authorizationUrl: authorize.toString(), redirectUri, verifier, state, code, accept, finish, close: () => {
    finish(false)
    if (listening === undefined) return
    const server = listening
    server.close(); server.closeIdleConnections()
    // 等待有效回调写完 HTML；直接销毁连接会吞掉成功页面与关闭脚本。
    if (callbackResponse !== undefined && !callbackResponse.writableFinished && !callbackResponse.destroyed) {
      callbackResponse.once('finish', () => { server.closeAllConnections() })
      callbackResponse.once('close', () => { server.closeAllConnections() })
    } else server.closeAllConnections()
  } }
}
