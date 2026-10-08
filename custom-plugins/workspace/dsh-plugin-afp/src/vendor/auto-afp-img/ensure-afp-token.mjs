import { createAfpRequestHeaders, readAfpJson, isAfpAuthenticationError } from './afp-api-client.mjs';
import { createHttpClient } from './http-client.mjs';

const HUB_LOGIN_ENDPOINT = 'https://hub-api-news.app.afp.com/search';
const FAR_ENDPOINT = 'https://far-api-news.app.afp.com/';
const LOGIN_QUERY = 'mutation getlogin($username:String!,$password:String!,$lang:String!){ token:login(username:$username,password:$password,lang:$lang){ tokenPayload{ access:access_token refresh:refresh_token } } }';
const REFRESH_QUERY = 'mutation refreshToken($refreshToken:String!,$username:String!){ token:refresh(refresh_token:$refreshToken,username:$username){ access:access_token refresh:refresh_token } }';

function valueOf(value) {
  return String(value ?? '').trim();
}

function required(environment, name) {
  const value = valueOf(environment[name]);
  if (!value) throw new Error(`${name} is required to obtain a new AFP access token`);
  return value;
}

function renewalRequired() {
  const error = new Error('AFP authentication requires renewed credentials');
  error.afpFailure = { category: 'authentication' };
  return error;
}

/** 读取 JWT payload 的 exp；非 JWT 或无 exp 的 Token 返回 null，后续以远端只读校验确认有效性。 */
export function decodeJwtExpiry(token) {
  const payload = String(token ?? '').split('.')[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const exp = Number(parsed?.exp);
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** 在刷新窗口内的 JWT 视为即将过期；非 JWT 交由 AFP 的只读请求验证。 */
export function isTokenFresh(token, { now = Date.now(), refreshMarginSeconds = 300 } = {}) {
  const normalized = valueOf(token);
  if (!normalized) return false;
  const expiresAt = decodeJwtExpiry(normalized);
  return expiresAt === null || expiresAt > now + refreshMarginSeconds * 1000;
}

/** 解析本地 .env 的简单 KEY=VALUE 格式，认证信息仅保留在当前进程内存。 */
export function parseEnvText(content) {
  return String(content ?? '').split(/\r?\n/).reduce((environment, line) => {
    if (!line || /^\s*#/.test(line)) return environment;
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) return environment;
    const [, key, rawValue] = match;
    const quoted = rawValue.match(/^(["'])(.*)\1$/);
    environment[key] = quoted ? quoted[2] : rawValue;
    return environment;
  }, {});
}

/** 原地更新一项 .env 配置，保留现有注释、排序和其余配置。 */
export function upsertEnvValue(content, key, value) {
  const normalized = String(value ?? '');
  if (/\r|\n/.test(normalized)) throw new Error(`${key} must be a single-line value`);
  const expression = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*$`, 'm');
  const next = `${key}=${normalized}`;
  const source = String(content ?? '');
  return expression.test(source)
    ? source.replace(expression, next)
    : `${source.replace(/\s*$/, '')}\n${next}\n`;
}

/** 验证实际 FAR 图片读取能力；SLT 的 HTTP 200 不能证明图片接口接受同一 token。 */
export async function validateAfpToken(accessToken, {
  fetchImpl = globalThis.fetch,
  farEndpoint = FAR_ENDPOINT,
  createHeaders = createAfpRequestHeaders,
  requestTimeoutMs = 20_000,
  retries = 2,
  maxResponseBytes = 512 * 1024,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  logger,
} = {}) {
  const http = createHttpClient({ fetchImpl, timeoutMs: requestTimeoutMs, retries, maxResponseBytes, sleep, logger, endpointCategory: 'afp-token' });
  try {
    const response = await http.request(farEndpoint, { method: 'POST', headers: createHeaders({ accessToken }),
      body: JSON.stringify({ operationName: 'getPhotos', variables: { input: { lang: 'en', maxRows: 1 } },
        query: 'query getPhotos($input:PhotoQueryInput){photos(input:$input){docs:photos{id:uno} hasMore}}' }) });
    const result = (await readAfpJson(response, 'getPhotos', http))?.data?.photos;
    if (!Array.isArray(result?.docs)) throw new Error('AFP token validation returned invalid photo metadata');
    return true;
  } catch (error) {
    if (isAfpAuthenticationError(error)) return false;
    throw error;
  }
}

/** 获取 Host 私有的 access/refresh grant；认证 mutation 单次提交，禁止输出凭据。 */
export async function loginAfpGrant(environment, {
  fetchImpl = globalThis.fetch,
  hubLoginEndpoint = HUB_LOGIN_ENDPOINT,
  createHeaders = createAfpRequestHeaders,
  requestTimeoutMs = 20_000,
  maxResponseBytes = 512 * 1024,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  logger,
} = {}) {
  const httpClient = createHttpClient({ fetchImpl, timeoutMs: requestTimeoutMs, retries: 0, maxResponseBytes, sleep, logger, endpointCategory: 'afp-token' });
  const response = await httpClient.request(hubLoginEndpoint, {
    method: 'POST',
    headers: createHeaders({}),
    body: JSON.stringify({
      operationName: 'getlogin',
      variables: {
        username: required(environment, 'AFP_USERNAME'),
        password: required(environment, 'AFP_PASSWORD'),
        lang: valueOf(environment.AFP_LANG) || 'en',
      },
      query: LOGIN_QUERY,
    }),
  });
  const payload = await httpClient.readResponseJson(response);
  const accessToken = valueOf(payload?.data?.token?.tokenPayload?.access);
  if (!response.ok || payload?.errors?.length || !accessToken) throw new Error('AFP getlogin did not return an access token');
  return { accessToken, refreshToken: valueOf(payload?.data?.token?.tokenPayload?.refresh) };
}

/** 保留原字符串调用接口；新 Host 使用 loginAfpGrant 保存刷新凭据。 */
export async function loginAfp(environment, options) {
  return (await loginAfpGrant(environment, options)).accessToken;
}

/** 按官网 refreshToken mutation 更新凭据；刷新请求的 Authorization 使用原始 access token。 */
export async function refreshAfpGrant(environment, {
  fetchImpl = globalThis.fetch, hubLoginEndpoint = HUB_LOGIN_ENDPOINT, createHeaders = createAfpRequestHeaders,
  requestTimeoutMs = 20_000, maxResponseBytes = 512 * 1024,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), logger,
} = {}) {
  const http = createHttpClient({ fetchImpl, timeoutMs: requestTimeoutMs, retries: 0, maxResponseBytes, sleep, logger, endpointCategory: 'afp-token' });
  const headers = createHeaders({});
  if (valueOf(environment.AFP_ACCESS_TOKEN)) headers.authorization = valueOf(environment.AFP_ACCESS_TOKEN);
  const response = await http.request(hubLoginEndpoint, { method: 'POST', headers, body: JSON.stringify({ operationName: 'refreshToken',
    variables: { refreshToken: required(environment, 'AFP_REFRESH_TOKEN'), username: required(environment, 'AFP_USERNAME') }, query: REFRESH_QUERY }) });
  const payload = await readAfpJson(response, 'refreshToken', http);
  const accessToken = valueOf(payload?.data?.token?.access), refreshToken = valueOf(payload?.data?.token?.refresh);
  if (!accessToken || !refreshToken) throw new Error('AFP refreshToken did not return a complete grant');
  return { accessToken, refreshToken };
}

/**
 * 执行本地过期判断、FAR 校验和一次更新；缓存校验的 GraphQL 权限拒绝允许更新，新 grant 拒绝仍直接失败。
 * access/refresh 返回值只能保存到 Host 凭据服务，不能进入工具输出或业务文件。
 */
export async function ensureAfpToken({
  environment = process.env,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  refreshMarginSeconds = Number(valueOf(environment.AFP_TOKEN_REFRESH_MARGIN_SECONDS) || 300),
  farEndpoint = FAR_ENDPOINT,
  hubLoginEndpoint = HUB_LOGIN_ENDPOINT,
  createHeaders = createAfpRequestHeaders,
  requestTimeoutMs = 20_000,
  retries = 2,
  maxResponseBytes = 512 * 1024,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  logger,
  forceRefresh = false,
  autoRefresh = true,
} = {}) {
  if (!Number.isFinite(refreshMarginSeconds) || refreshMarginSeconds < 0) throw new Error('AFP_TOKEN_REFRESH_MARGIN_SECONDS must be a non-negative number');
  const existing = valueOf(environment.AFP_ACCESS_TOKEN);
  const options = { fetchImpl, farEndpoint, hubLoginEndpoint, createHeaders, requestTimeoutMs, retries, maxResponseBytes, sleep, logger };
  if (!forceRefresh && isTokenFresh(existing, { now, refreshMarginSeconds })) {
    try {
      const valid = await validateAfpToken(existing, options);
      if (valid) return { source: 'existing', accessToken: existing, refreshToken: valueOf(environment.AFP_REFRESH_TOKEN), expiresAt: decodeJwtExpiry(existing) };
    } catch (error) {
      // FAR 实测以 GraphQL FORBIDDEN 拒绝旧登录；仅此缓存校验允许一次恢复，新 grant 与业务权限拒绝仍直接失败。
      if (!autoRefresh || error?.afpFailure?.protocol !== 'graphql' || error.afpFailure.httpStatus !== 200
        || error.afpFailure.category !== 'authorization') throw error;
    }
  }
  if (existing && !autoRefresh) {
    throw renewalRequired();
  }
  let grant, source = 'login';
  if (autoRefresh && valueOf(environment.AFP_REFRESH_TOKEN) && valueOf(environment.AFP_USERNAME)) {
    try { grant = await refreshAfpGrant(environment, options); source = 'refresh'; }
    catch (error) {
      // 仅明确认证拒绝才能回退登录；网络、权限及协议错误不能触发额外认证请求。
      if (!isAfpAuthenticationError(error) || !valueOf(environment.AFP_PASSWORD)) throw error;
    }
  }
  if (!grant && (!valueOf(environment.AFP_USERNAME) || !valueOf(environment.AFP_PASSWORD))) throw renewalRequired();
  grant ??= await loginAfpGrant(environment, options);
  if (!await validateAfpToken(grant.accessToken, options)) {
    throw renewalRequired();
  }
  return { source, ...grant, expiresAt: decodeJwtExpiry(grant.accessToken) };
}
