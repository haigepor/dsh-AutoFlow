import { createHttpClient } from './http-client.mjs';

const FAR_ENDPOINT = 'https://far-api-news.app.afp.com/';
const SELECTIONS_ENDPOINT = 'https://slt-api-news.app.afp.com';
const AFP_ORIGIN = 'https://newsroom.afp.com';
const AFP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

/**
 * 构造 AFP Web 应用所需的最小浏览器请求头。
 * 每个请求生成独立 trace/span ID，避免复用认证上下文或把敏感信息落盘。
 */
export function createAfpRequestHeaders({
  accessToken,
  contentType = 'application/json',
  accept = 'application/json, text/plain, */*',
  idFactory = () => crypto.randomUUID(),
} = {}) {
  const headers = {
    accept,
    'accept-language': 'en-US,en;q=0.9',
    origin: AFP_ORIGIN,
    referer: `${AFP_ORIGIN}/`,
    'user-agent': AFP_USER_AGENT,
    'x-trace-id': idFactory(),
    'x-span-id': idFactory(),
  };
  if (contentType) headers['content-type'] = contentType;
  if (String(accessToken ?? '').trim()) headers.authorization = `Bearer ${accessToken}`;
  return headers;
}

/** 从进程环境读取认证令牌；调用方不得把返回值写入文件或日志。 */
export function readAccessToken(environment = process.env) {
  const token = String(environment.AFP_ACCESS_TOKEN ?? '').trim();
  if (!token) throw new Error('AFP_ACCESS_TOKEN is required');
  return token;
}

async function readJson(response, operation, httpClient) {
  const payload = await httpClient.readResponseJson(response);
  if (!response.ok) throw new Error(`${operation} failed with HTTP ${response.status}`);
  if (payload?.errors?.length) {
    const message = String(payload.errors[0]?.message ?? 'unknown GraphQL error')
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 240);
    throw new Error(`${operation} returned GraphQL errors: ${message}`);
  }
  return payload;
}

/**
 * 创建 AFP FAR/SLT 的最小客户端。
 * 认证令牌只存在于闭包和 HTTP 请求头中，公共返回值不会回显令牌或请求头。
 */
export function createAfpApiClient({
  accessToken = readAccessToken(),
  fetchImpl = globalThis.fetch,
  farEndpoint = FAR_ENDPOINT,
  selectionsEndpoint = SELECTIONS_ENDPOINT,
  createHeaders = createAfpRequestHeaders,
  // FAR 的长分页响应偶发超过一分钟；延长单请求/响应体窗口，避免长批次被误判为失败。
  requestTimeoutMs = 180_000,
  retries = 2,
  maxResponseBytes = 4 * 1024 * 1024,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  logger,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  const httpClient = createHttpClient({
    fetchImpl,
    timeoutMs: requestTimeoutMs,
    retries,
    maxResponseBytes,
    sleep,
    logger,
    endpointCategory: 'afp-api',
  });

  async function graphQl(request) {
    return httpClient.retryOperation(async () => {
      const response = await httpClient.request(farEndpoint, {
        method: 'POST',
        headers: createHeaders({ accessToken }),
        body: JSON.stringify(request),
      });
      return readJson(response, request.operationName, httpClient);
    });
  }

  async function selectionRequest(path, { method = 'GET', body } = {}) {
    return httpClient.retryOperation(async () => {
      const response = await httpClient.request(`${selectionsEndpoint}${path}`, {
        method,
        headers: createHeaders({ accessToken }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return readJson(response, `selection ${method} ${path}`, httpClient);
    });
  }

  return {
    async searchPhotos(request) {
      const payload = await graphQl(request);
      return payload?.data?.photos ?? payload?.data?.search ?? payload?.photos ?? payload?.search ?? { docs: [] };
    },
    async listSelections() {
      const payload = await selectionRequest('/get-selections/byuser?includeClientSelections=true');
      return Array.isArray(payload) ? payload : (payload?.selections ?? payload?.data ?? []);
    },
    async createPrivateSelection(name) {
      return selectionRequest('/create-selection', { method: 'POST', body: { name, isPrivate: true } });
    },
    /** 将已确认的私有收藏夹改为精确名称；调用方负责处理重名和所有权冲突。 */
    async renameSelection(selectionId, name) {
      return selectionRequest(`/update-selection/${encodeURIComponent(selectionId)}`, { method: 'PUT', body: { name } });
    },
    async getSelection(selectionId) {
      return selectionRequest(`/get-selections/byid/${encodeURIComponent(selectionId)}`);
    },
    async addSelectionDoc(selectionId, doc) {
      return selectionRequest(`/add-selection-docs/${encodeURIComponent(selectionId)}`, {
        method: 'PUT',
        body: { docs: [doc] },
      });
    },
    /** 精确清空一个已确认的 Selection；调用方必须先完成名称和私有属性校验。 */
    async clearSelectionDocs(selectionId) {
      return selectionRequest(`/delete-selection-docs/${encodeURIComponent(selectionId)}`, {
        method: 'PUT',
        body: { docIds: [], deleteAll: true },
      });
    },
  };
}
