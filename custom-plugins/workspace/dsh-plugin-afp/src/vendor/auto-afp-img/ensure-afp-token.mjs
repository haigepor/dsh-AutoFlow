import { createAfpRequestHeaders } from './afp-api-client.mjs';
import { createHttpClient } from './http-client.mjs';

const HUB_LOGIN_ENDPOINT = 'https://hub-api-news.app.afp.com/search';
const SELECTIONS_ENDPOINT = 'https://slt-api-news.app.afp.com/get-selections/byuser?includeClientSelections=true';
const LOGIN_QUERY = 'mutation getlogin($username:String!,$password:String!,$lang:String!){ token:login(username:$username,password:$password,lang:$lang){ tokenPayload{ access:access_token refresh:refresh_token } } }';

function valueOf(value) {
  return String(value ?? '').trim();
}

function required(environment, name) {
  const value = valueOf(environment[name]);
  if (!value) throw new Error(`${name} is required to obtain a new AFP access token`);
  return value;
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

/** 使用已知的只读 Selection 接口验证当前 Token 是否仍被 AFP 接受。 */
export async function validateAfpToken(accessToken, {
  fetchImpl = globalThis.fetch,
  selectionsEndpoint = SELECTIONS_ENDPOINT,
  createHeaders = createAfpRequestHeaders,
  requestTimeoutMs = 20_000,
  retries = 2,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  logger,
} = {}) {
  const httpClient = createHttpClient({ fetchImpl, timeoutMs: requestTimeoutMs, retries, sleep, logger, endpointCategory: 'afp-token' });
  const response = await httpClient.request(selectionsEndpoint, {
    method: 'GET',
    headers: createHeaders({ accessToken }),
  });
  if (response.ok) return true;
  if (response.status === 401 || response.status === 403) return false;
  throw new Error(`AFP token validation failed with HTTP ${response.status}`);
}

/** 使用已验证的 getlogin mutation 获取新的 access token；refresh token 不写入结果或 .env。 */
export async function loginAfp(environment, {
  fetchImpl = globalThis.fetch,
  hubLoginEndpoint = HUB_LOGIN_ENDPOINT,
  createHeaders = createAfpRequestHeaders,
  requestTimeoutMs = 20_000,
  retries = 2,
  maxResponseBytes = 512 * 1024,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  logger,
} = {}) {
  const httpClient = createHttpClient({ fetchImpl, timeoutMs: requestTimeoutMs, retries, maxResponseBytes, sleep, logger, endpointCategory: 'afp-token' });
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
  return accessToken;
}

/**
 * 统一执行本地过期判断、远端只读验证与重新登录。
 * 返回值仅供调用方写回 access token；CLI 日志不会输出该字段。
 */
export async function ensureAfpToken({
  environment = process.env,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  refreshMarginSeconds = Number(valueOf(environment.AFP_TOKEN_REFRESH_MARGIN_SECONDS) || 300),
  selectionsEndpoint = SELECTIONS_ENDPOINT,
  hubLoginEndpoint = HUB_LOGIN_ENDPOINT,
  createHeaders = createAfpRequestHeaders,
  requestTimeoutMs = 20_000,
  retries = 2,
  maxResponseBytes = 512 * 1024,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  logger,
} = {}) {
  if (!Number.isFinite(refreshMarginSeconds) || refreshMarginSeconds < 0) throw new Error('AFP_TOKEN_REFRESH_MARGIN_SECONDS must be a non-negative number');
  const existing = valueOf(environment.AFP_ACCESS_TOKEN);
  if (isTokenFresh(existing, { now, refreshMarginSeconds })) {
    const valid = await validateAfpToken(existing, { fetchImpl, selectionsEndpoint, createHeaders, requestTimeoutMs, retries, sleep, logger });
    if (valid) return { source: 'existing', accessToken: existing, expiresAt: decodeJwtExpiry(existing) };
  }
  const accessToken = await loginAfp(environment, {
    fetchImpl, hubLoginEndpoint, createHeaders, requestTimeoutMs, retries, maxResponseBytes, sleep, logger,
  });
  return { source: 'login', accessToken, expiresAt: decodeJwtExpiry(accessToken) };
}
