import { createHttpClient } from './http-client.mjs';
import { readAfpJson } from './afp-api-client.mjs';
import { isBlockedMediaHost } from './afp-media-host.mjs';

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

/** 优先选择可用 Mockup，兼容无档位旧引用；显式下载档位和非字符串引用不进入预览。 */
export function findMockupReference(photo) {
  const mockups = Array.isArray(photo?.mockup) ? photo.mockup : [];
  const usable = item => typeof item?.href === 'string' && item.href.trim();
  const media = mockups.find(item => usable(item) && String(item?.role ?? '').trim().toLowerCase() === 'mockup')
    ?? mockups.find(item => usable(item) && !String(item?.role ?? '').trim());
  const reference = media?.href.trim();
  if (!reference) throw new Error('photo mockup is unavailable');
  return reference;
}

function readToken(accessToken = process.env.AFP_ACCESS_TOKEN) {
  const token = String(accessToken ?? '').trim();
  if (!token) throw new Error('AFP_ACCESS_TOKEN is required');
  return token;
}

function hostFromEndpoint(endpoint) {
  return new URL(endpoint).hostname.toLowerCase();
}

/** 只接纳官方响应提供的标准 CloudFront HTTPS 分发域名；白名单仅属于当前图片下载。 */
function discoverCloudFrontHost(reference, allowedHosts) {
  let url;
  try { url = new URL(reference); } catch (_error) { return; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !/^d[a-z0-9]{8,64}\.cloudfront\.net$/.test(url.hostname)) return;
  allowedHosts.add(url.hostname.toLowerCase());
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

function isAllowedPreviewUrl(value, allowedHosts, trustedOrigins) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('preview URL is invalid');
  }
  if (url.protocol !== 'https:') throw new Error('preview URL must use HTTPS');
  if (url.username || url.password) throw new Error('preview URL must not contain credentials');
  if (isBlockedMediaHost(url.hostname)) throw new Error('preview URL points to a local or internal host');
  if (url.port && !trustedOrigins.has(url.origin)) throw new Error('preview URL port is not configured');
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    const error = new Error('preview URL host is not allowlisted');
    error.code = 'preview-host-blocked';
    error.hostname = url.hostname.toLowerCase();
    throw error;
  }
  return url;
}

/** Validate an HTTPS Mockup URL or convert an opaque media reference to the configured APICore URL.
 * @param {string} reference Mockup URL or APICore media identifier.
 * @param {object} [options] Configured endpoints and exact CDN hostnames.
 * @returns {string} Allowed URL; unconfigured ports and internal addresses are rejected.
 */
export function validatePreviewUrl(reference, { farEndpoint = FAR_ENDPOINT, apicoreEndpoint = APICORE_MEDIA_ENDPOINT, allowedCdnHosts = [] } = {}) {
  const allowedHosts = allowedHostSet({ farEndpoint, apicoreEndpoint, allowedCdnHosts });
  const trustedOrigins = new Set([new URL(farEndpoint).origin, new URL(apicoreEndpoint).origin]);
  const raw = /^https?:\/\//i.test(reference)
    ? String(reference)
    : (() => {
      const url = new URL(apicoreEndpoint);
      url.searchParams.set('id', reference);
      url.searchParams.set('step', '5');
      return url.toString();
    })();
  return isAllowedPreviewUrl(raw, allowedHosts, trustedOrigins).toString();
}

function previewUrl(reference, apicoreEndpoint, allowedCdnHosts, farEndpoint) {
  return validatePreviewUrl(reference, { farEndpoint, apicoreEndpoint, allowedCdnHosts });
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
  autoDiscoverCdnHosts = false,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  logger,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  if (typeof autoDiscoverCdnHosts !== 'boolean') throw new Error('autoDiscoverCdnHosts must be boolean');
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new Error('requestTimeoutMs must be a positive integer');
  if (!Number.isInteger(retries) || retries < 0) throw new Error('retries must be a non-negative integer');
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) throw new Error('maxRedirects must be a non-negative integer');
  if (typeof sleep !== 'function') throw new Error('sleep must be a function');
  const allowedHosts = allowedHostSet({ farEndpoint, apicoreEndpoint, allowedCdnHosts });
  const trustedOrigins = new Set([new URL(farEndpoint).origin, new URL(apicoreEndpoint).origin]);
  const httpClient = createHttpClient({
    fetchImpl,
    timeoutMs: requestTimeoutMs,
    retries,
    maxResponseBytes,
    sleep,
    logger,
    endpointCategory: 'afp-preview',
  });

  async function request(requestOnce, url, options, { followRedirects = false, previewHosts = allowedHosts } = {}) {
    let currentUrl = isAllowedPreviewUrl(url, previewHosts, trustedOrigins).toString();
    const currentOptions = { ...options, redirect: 'manual' };
    for (let redirectCount = 0; ; redirectCount += 1) {
      const currentOrigin = new URL(currentUrl).origin;
      // 每跳从原请求头重建：回到已配置 AFP 源时恢复认证，CDN 始终剔除认证。
      const headers = { ...(currentOptions.headers ?? {}) };
      if (!trustedOrigins.has(currentOrigin)) {
        delete headers.authorization;
        delete headers.Authorization;
      }
      const response = await requestOnce(currentUrl, { ...currentOptions, headers });
      const nextUrl = followRedirects ? redirectLocation(response, currentUrl) : null;
      if (!nextUrl) return { response, origin: currentOrigin };
      // 跳转响应不再使用；先释放其流，再检查目标域名，避免失败时留下未消费连接。
      await response.body?.cancel();
      if (redirectCount >= maxRedirects) throw new Error('preview redirect limit exceeded');
      // CDN 的后续跳转不能扩张白名单，AFP 身份凭据仍只发送到官方接口。
      if (autoDiscoverCdnHosts && trustedOrigins.has(currentOrigin)) {
        discoverCloudFrontHost(nextUrl, previewHosts);
      }
      currentUrl = isAllowedPreviewUrl(nextUrl, previewHosts, trustedOrigins).toString();
    }
  }

  async function lookup(photoId, guid) {
    const read = async isUno => {
      const payload = await httpClient.retryOperation(async requestOnce => {
        const { response } = await request(requestOnce, farEndpoint, {
          method: 'POST',
          headers: previewHeaders(accessToken),
          body: JSON.stringify({
            operationName: 'getPhotosByIds',
            variables: { ids: [isUno ? String(photoId) : guid], input: { isUno } },
            query: PHOTO_PREVIEW_QUERY,
          }),
        });
        return readAfpJson(response, 'getPhotosByIds', httpClient);
      });
      return payload?.data?.docs;
    };
    let docs = await read(true);
    let photo = Array.isArray(docs) ? docs.find(item => item?.id === String(photoId)) : undefined;
    // 部分 AFP UNO 无法反查；GUID 只能补查明确空结果，且必须核对同一张图片的双重身份。
    if (Array.isArray(docs) && docs.length === 0 && guid) {
      docs = await read(false);
      photo = Array.isArray(docs) ? docs.find(item => item?.id === String(photoId) && item?.guid === guid) : undefined;
    }
    if (!photo) throw new Error('requested photo mockup is unavailable');
    return photo;
  }

  async function mediaFailure(response, origin) {
    let expired = false;
    if (response.status === 403 && !trustedOrigins.has(origin)) {
      try {
        // 只检查有界的固定媒体错误；拒绝正文和签名引用不进入日志或页面。
        const text = await httpClient.readResponseText(response, Math.min(maxResponseBytes, 4096));
        expired = /<Code>\s*(?:RequestExpired|ExpiredToken)\s*<\/Code>/.test(text)
          || /<Code>\s*AccessDenied\s*<\/Code>/.test(text) && /<Message>\s*Request has expired\s*<\/Message>/.test(text);
      } catch (bodyError) { /* 无效或超限错误正文不能触发媒体恢复。 */ }
    } else await response.body?.cancel();
    const error = new Error(`mockup download failed with HTTP ${response.status}`);
    // 仅 AFP 源的明确 401 进入现有一次认证恢复；CDN 拒绝不是 AFP 凭据失效。
    if (response.status === 401 && trustedOrigins.has(origin)) {
      error.afpFailure = { protocol: 'http', httpStatus: 401, category: 'authentication' };
    }
    if (expired) error.code = 'preview-media-expired';
    return error;
  }

  return {
    /** Read a Mockup raster, with one identity-checked GUID fallback and one expired-media refresh.
     * @param {string} photoId Canonical AFP UNO, preserved without decoding.
     * @param {object} [options] Optional GUID from photo metadata; absence uses UNO only.
     * @returns {Promise<object>} Raster bytes and declared content type, without media URLs.
     */
    async getPreviewBytes(photoId, { guid } = {}) {
      if (guid !== undefined && (typeof guid !== 'string' || !guid.trim() || guid.length > 256 || /[\u0000-\u001f\u007f]/.test(guid))) throw new Error('Invalid AFP photo GUID');
      for (let refresh = 0; ; refresh++) {
        const photo = await lookup(photoId, guid);
        const reference = findMockupReference(photo);
        const previewHosts = new Set(allowedHosts);
        if (autoDiscoverCdnHosts) discoverCloudFrontHost(reference, previewHosts);
        const mediaReference = previewUrl(reference, apicoreEndpoint, [...previewHosts], farEndpoint);
        // 传输重试复用 metadata；只有明确过期才重新解析一次媒体入口。
        try {
          return await httpClient.retryOperation(async requestOnce => {
            const { response: mediaResponse, origin } = await request(requestOnce, mediaReference, {
              method: 'GET',
              headers: previewHeaders(accessToken, { accept: 'image/jpeg,image/png,image/webp,image/gif', contentType: null }),
            }, { followRedirects: true, previewHosts });
            if (!mediaResponse.ok) throw await mediaFailure(mediaResponse, origin);
            return {
              bytes: await httpClient.readResponseBytes(mediaResponse),
              contentType: mediaResponse.headers.get('content-type')?.split(';')[0] || 'application/octet-stream',
            };
          });
        } catch (error) {
          if (refresh !== 0 || error.code !== 'preview-media-expired') throw error;
        }
      }
    },
  };
}
