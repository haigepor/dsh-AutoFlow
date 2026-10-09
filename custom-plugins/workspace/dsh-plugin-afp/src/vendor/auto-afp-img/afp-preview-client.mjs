import { createHttpClient } from './http-client.mjs';
import { readAfpJson } from './afp-api-client.mjs';

const FAR_ENDPOINT = 'https://far-api-news.app.afp.com/';
const APICORE_MEDIA_ENDPOINT = 'https://afp-apicore-prod.afp.com/objects/api/medias';
const AFP_ORIGIN = 'https://newsroom.afp.com';
const AFP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

const PHOTO_PREVIEW_QUERY = `query getPhotosByIds($ids:[String!]!,$input:PhotoQueryByIdsInput) {
  docs: photosByIds(ids:$ids,input:$input) {
    id: uno
    guid
    mockup: medias(query:{role:Mockup}) { href role type width height }
  }
}`;

/** 从详情响应中选出 Mockup 媒体引用，不接触 HighRes/MidRes 等下载媒体。 */
export function findMockupReference(photo) {
  const mockups = Array.isArray(photo?.mockup) ? photo.mockup : [];
  const media = mockups.find((item) => String(item?.role ?? '').toLowerCase() === 'mockup') ?? mockups[0];
  const reference = String(media?.href ?? '').trim();
  if (!reference) throw new Error('photo mockup is unavailable');
  return reference;
}

function readToken(accessToken = process.env.AFP_ACCESS_TOKEN) {
  const token = String(accessToken ?? '').trim();
  if (!token) throw new Error('AFP_ACCESS_TOKEN is required');
  return token;
}

function isPrivateOrLocalHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/[\[\]]/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1') return true;
  if (host.includes(':')) return /^(?:f[cd]|fe8[0-9a-f]):/i.test(host);
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = octets;
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function hostFromEndpoint(endpoint) {
  return new URL(endpoint).hostname.toLowerCase();
}

function allowedHostSet({ farEndpoint, apicoreEndpoint, allowedCdnHosts }) {
  return new Set([
    hostFromEndpoint(farEndpoint),
    hostFromEndpoint(apicoreEndpoint),
    ...(Array.isArray(allowedCdnHosts) ? allowedCdnHosts : String(allowedCdnHosts ?? '').split(','))
      .map((host) => String(host).trim().toLowerCase())
      .filter(Boolean),
  ]);
}

function isAllowedPreviewUrl(value, allowedHosts) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('preview URL is invalid');
  }
  if (url.protocol !== 'https:') throw new Error('preview URL must use HTTPS');
  if (url.username || url.password) throw new Error('preview URL must not contain credentials');
  if (isPrivateOrLocalHost(url.hostname)) throw new Error('preview URL points to a local or internal host');
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    const error = new Error('preview URL host is not allowlisted');
    error.code = 'preview-host-blocked';
    error.hostname = url.hostname.toLowerCase();
    throw error;
  }
  return url;
}

export function validatePreviewUrl(reference, { apicoreEndpoint = APICORE_MEDIA_ENDPOINT, allowedCdnHosts = [] } = {}) {
  const allowedHosts = allowedHostSet({ farEndpoint: FAR_ENDPOINT, apicoreEndpoint, allowedCdnHosts });
  const raw = /^https?:\/\//i.test(reference)
    ? String(reference)
    : (() => {
      const url = new URL(apicoreEndpoint);
      url.searchParams.set('id', reference);
      url.searchParams.set('step', '5');
      return url.toString();
    })();
  return isAllowedPreviewUrl(raw, allowedHosts).toString();
}

function previewUrl(reference, apicoreEndpoint, allowedCdnHosts) {
  return validatePreviewUrl(reference, { apicoreEndpoint, allowedCdnHosts });
}

function isAfpTrustedHost(hostname, farEndpoint, apicoreEndpoint) {
  const host = String(hostname).toLowerCase();
  return host === hostFromEndpoint(farEndpoint) || host === hostFromEndpoint(apicoreEndpoint);
}

function redirectLocation(response, currentUrl) {
  if (![301, 302, 303, 307, 308].includes(response.status)) return null;
  const location = response.headers.get('location');
  return location ? new URL(location, currentUrl).toString() : null;
}

/** 创建视觉复核所需的短生命周期 AFP 浏览器请求头，预览链接始终只在内存内使用。 */
function previewHeaders(accessToken, { accept = 'application/json, text/plain, */*', contentType = 'application/json' } = {}) {
  return {
    accept,
    'accept-language': 'en-US,en;q=0.9',
    authorization: `Bearer ${accessToken}`,
    ...(contentType ? { 'content-type': contentType } : {}),
    origin: AFP_ORIGIN,
    referer: `${AFP_ORIGIN}/`,
    'user-agent': AFP_USER_AGENT,
    'x-trace-id': crypto.randomUUID(),
    'x-span-id': crypto.randomUUID(),
  };
}

/**
 * 创建仅供视觉复核使用的预览客户端。
 * 每次请求只把 mockup URL 用于当前内存下载，返回值刻意不包含 URL 或媒体引用。
 */
export function createAfpPreviewClient({
  accessToken = readToken(),
  fetchImpl = globalThis.fetch,
  farEndpoint = FAR_ENDPOINT,
  apicoreEndpoint = APICORE_MEDIA_ENDPOINT,
  // Mockup/预览高峰期可能需要超过一分钟，避免把可重试的响应体延迟误记为预览失败。
  requestTimeoutMs = 180_000,
  retries = 2,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  allowedCdnHosts = process.env.AFP_PREVIEW_CDN_HOSTS ?? '',
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  logger,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new Error('requestTimeoutMs must be a positive integer');
  if (!Number.isInteger(retries) || retries < 0) throw new Error('retries must be a non-negative integer');
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) throw new Error('maxRedirects must be a non-negative integer');
  if (typeof sleep !== 'function') throw new Error('sleep must be a function');
  const allowedHosts = allowedHostSet({ farEndpoint, apicoreEndpoint, allowedCdnHosts });
  const httpClient = createHttpClient({
    fetchImpl,
    timeoutMs: requestTimeoutMs,
    retries,
    maxResponseBytes,
    sleep,
    logger,
    endpointCategory: 'afp-preview',
  });

  async function request(requestOnce, url, options, { followRedirects = false } = {}) {
    let currentUrl = isAllowedPreviewUrl(url, allowedHosts).toString();
    let currentOptions = { ...options, redirect: 'manual' };
    for (let redirectCount = 0; ; redirectCount += 1) {
      const currentHost = new URL(currentUrl).hostname;
      const headers = { ...(currentOptions.headers ?? {}) };
      if (!isAfpTrustedHost(currentHost, farEndpoint, apicoreEndpoint)) {
        delete headers.authorization;
        delete headers.Authorization;
      }
      const response = await requestOnce(currentUrl, { ...currentOptions, headers });
      const nextUrl = followRedirects ? redirectLocation(response, currentUrl) : null;
      if (!nextUrl) return response;
      // 跳转响应不再使用；先释放其流，再检查目标域名，避免失败时留下未消费连接。
      await response.body?.cancel();
      if (redirectCount >= maxRedirects) throw new Error('preview redirect limit exceeded');
      currentUrl = isAllowedPreviewUrl(nextUrl, allowedHosts).toString();
      currentOptions = { ...currentOptions, headers };
    }
  }

  return {
    async getPreviewBytes(photoId) {
      const payload = await httpClient.retryOperation(async requestOnce => {
        const response = await request(requestOnce, farEndpoint, {
          method: 'POST',
          headers: previewHeaders(accessToken),
          body: JSON.stringify({
            operationName: 'getPhotosByIds',
            variables: { ids: [String(photoId)], input: { isUno: true } },
            query: PHOTO_PREVIEW_QUERY,
          }),
        });
        return readAfpJson(response, 'getPhotosByIds', httpClient);
      });
      const photo = payload?.data?.docs?.find((item) => item?.id === String(photoId));
      if (!photo) throw new Error('requested photo mockup is unavailable');
      const reference = findMockupReference(photo);
      const mediaReference = previewUrl(reference, apicoreEndpoint, allowedCdnHosts);
      // 图片下载重试复用已读 metadata，不再次查询同一张图片的详情。
      return httpClient.retryOperation(async requestOnce => {
        const mediaResponse = await request(requestOnce, mediaReference, {
          method: 'GET',
          headers: previewHeaders(accessToken, { accept: 'image/jpeg,image/png,image/webp,image/gif', contentType: null }),
        }, { followRedirects: true });
        if (!mediaResponse.ok) throw new Error(`mockup download failed with HTTP ${mediaResponse.status}`);
        return {
          bytes: await httpClient.readResponseBytes(mediaResponse),
          contentType: mediaResponse.headers.get('content-type')?.split(';')[0] || 'application/octet-stream',
        };
      });
    },
  };
}
