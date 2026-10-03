import { createHttpClient } from './http-client.mjs';
import { isIP } from 'node:net';

const FAR_ENDPOINT = 'https://far-api-news.app.afp.com/';
const SELECTIONS_ENDPOINT = 'https://slt-api-news.app.afp.com';
const AFP_ORIGIN = 'https://newsroom.afp.com';
const AFP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const PHOTOS_BY_IDS_QUERY = `query getPhotosByIds($ids:[String!]!,$input:PhotoQueryByIdsInput) {
  docs: photosByIds(ids:$ids,input:$input) {
    id: uno
    guid title caption
    afpEntityKeyword { keyword }
    partner { gcp { provider_code } }
  }
}`;

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
  hubEndpoint = 'https://hub-api-news.app.afp.com/search',
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
  // Billable writes need a dedicated single-attempt transport: an ambiguous
  // response must never make the client submit the purchase a second time.
  const purchaseHttp = createHttpClient({ fetchImpl, timeoutMs: requestTimeoutMs, retries: 0,
    maxResponseBytes, sleep, logger, endpointCategory: 'afp-purchase' });

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

  async function downloadPhotoDetails(id) {
    if (typeof id !== 'string' || !id || id.length > 256) throw new Error('photo id must be a non-empty string');
    const query = `query getPhoto($id:String!,$getSelections:Boolean!){ photo(id:$id,getSelections:$getSelections){
      id guid title downloadableMedias { role name mediaKey cost width height sizeInBytes validateOrderId payable isViewOnly renditionType href }
    } }`;
    return httpClient.retryOperation(async () => {
      const response = await httpClient.request(hubEndpoint, { method: 'POST', headers: createHeaders({ accessToken }),
        body: JSON.stringify({ operationName: 'getPhoto', variables: { id, getSelections: true }, query }) });
      const payload = await readJson(response, 'getPhoto', httpClient);
      return payload?.data?.photo ?? null;
    });
  }

  function blockedDeliveryHost(hostname) {
    const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
    if (isIP(host) === 4) {
      const [a, b] = host.split('.').map(Number)
      return a === 0 || a === 10 || a === 127 || a >= 224
        || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
        || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127
    }
    return isIP(host) === 6 && (host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd')
      || /^fe[89ab]/.test(host) || host.startsWith('ff') || host.startsWith('::ffff:'))
  }

  function deliveryUrl(value) {
    let url;
    try { url = new URL(value); } catch (error) { throw new Error('AFP returned an invalid delivery URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || blockedDeliveryHost(url.hostname)) {
      throw new Error('AFP returned a disallowed delivery URL');
    }
    return url;
  }

  return {
    /** Read allowlisted photo metadata by stable AFP IDs without requesting media references. */
    async photosByIds(ids) {
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)) throw new Error('photo ids must be non-empty strings');
      if (ids.length < 1 || ids.length > 120) throw new Error('photo ids must contain 1..120 entries');
      const payload = await graphQl({ operationName: 'getPhotosByIds', variables: { ids: [...ids], input: { isUno: true } }, query: PHOTOS_BY_IDS_QUERY });
      return Array.isArray(payload?.data?.docs) ? payload.data.docs : [];
    },
    /** Read AFP downloadable media metadata; media keys and URLs must stay in the Host. */
    downloadPhotoDetails,
    /** Submit one confirmed paid-photo mutation exactly once; requestId is not a delivery identifier. */
    async buyPhoto({ id, cost, mediaKeys }) {
      if (typeof id !== 'string' || !id || id.length > 256 || !Number.isFinite(cost) || cost < 0
        || !Array.isArray(mediaKeys) || !mediaKeys.length || mediaKeys.some(key => typeof key !== 'string' || !key)) {
        throw new Error('invalid confirmed AFP purchase');
      }
      const query = `mutation buyPhoto($id:String!,$cost:Float!,$mediaKeys:[String!]!){ buyPhoto(id:$id,cost:$cost,mediaKeys:$mediaKeys){ requestId status } }`;
      const response = await purchaseHttp.request(hubEndpoint, { method: 'POST', headers: createHeaders({ accessToken }),
        body: JSON.stringify({ operationName: 'buyPhoto', variables: { id, cost, mediaKeys }, query }) });
      const payload = await purchaseHttp.readResponseJson(response);
      if (response.status !== 202) throw new Error('AFP purchase did not return the verified 202 accepted status');
      if (!payload || payload.errors?.length || !payload.data?.buyPhoto) throw new Error('AFP purchase response is ambiguous; do not retry');
      return { accepted: true, status: 202, hasRequestId: typeof payload.data.buyPhoto.requestId === 'string' };
    },
    /** Download AFP-delivered bytes without forwarding credentials to its signed media URL.
     * @param {string} href AFP-delivered HTTPS URL held by the Host.
     * @param {number} maxRedirects Redirect limit.
     * @param {number} timeoutMs Per-request timeout in milliseconds.
     * @param {AbortSignal} [signal] Profile-job cancellation signal.
     * @returns {Promise<Response>} Unbuffered image response body.
     */
    async downloadMedia(href, maxRedirects = 3, timeoutMs = requestTimeoutMs, signal) {
      if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5) throw new Error('invalid AFP redirect limit');
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('invalid AFP delivery timeout');
      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      let url = deliveryUrl(href);
      for (let redirect = 0; redirect <= maxRedirects; redirect++) {
        const response = await fetchImpl(url.href, { method: 'GET', redirect: 'manual',
          headers: { accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' }, signal: requestSignal });
        if (response.status < 300 || response.status >= 400) return response;
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirect === maxRedirects) throw new Error('AFP delivery redirect limit exceeded');
        url = deliveryUrl(new URL(location, url).href);
      }
      throw new Error('AFP delivery redirect limit exceeded');
    },
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
    /** Remove selected document relationships without deleting the selection. */
    async deleteSelectionDocs(selectionId, docIds) {
      if (!Array.isArray(docIds) || !docIds.length || docIds.some(id => typeof id !== 'string' || !id)) throw new Error('photo IDs are required');
      return selectionRequest(`/delete-selection-docs/${encodeURIComponent(selectionId)}`, {
        method: 'PUT', body: { docIds: [...new Set(docIds)], deleteAll: false },
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
