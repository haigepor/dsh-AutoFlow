const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

export const HTTP_RETRYABLE_STATUS_CODES = Object.freeze([...RETRYABLE_STATUS_CODES]);

function numericHeader(response, name) {
  const value = Number(response?.headers?.get?.(name));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function retryAfterMs(response, fallbackMs) {
  const value = String(response?.headers?.get?.('retry-after') ?? '').trim();
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 60_000));
  return fallbackMs;
}

function errorCategory(error) {
  if (error?.name === 'AbortError' || /timed out/i.test(String(error?.message ?? ''))) return 'timeout';
  if (/response exceeded/i.test(String(error?.message ?? ''))) return 'response-too-large';
  if (error?.name === 'TypeError' || /fetch|network|connection|socket|econn|enotfound|reset/i.test(String(error?.message ?? ''))) {
    return 'network';
  }
  return 'unknown';
}

function logEvent(logger, event) {
  if (typeof logger !== 'function') return;
  logger({
    endpointCategory: event.endpointCategory,
    status: event.status ?? null,
    retryCount: event.retryCount,
    errorCategory: event.errorCategory ?? null,
  });
}

/**
 * 读取受限响应体。调用方必须通过本函数读取 JSON/字节，避免 chunked 响应绕过大小上限。
 */
export async function readResponseBytes(response, maxResponseBytes = 10 * 1024 * 1024, timeoutMs = null) {
  if (!response || typeof response.arrayBuffer !== 'function') throw new Error('HTTP response is required');
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1) throw new Error('maxResponseBytes must be a positive integer');
  if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs < 1)) throw new Error('timeoutMs must be a positive integer');
  const contentLength = numericHeader(response, 'content-length');
  if (contentLength !== null && contentLength > maxResponseBytes) {
    await response.body?.cancel?.();
    throw new Error(`HTTP response exceeded ${maxResponseBytes} bytes`);
  }

  let activeReader = null;
  const readBody = async () => {
    if (!response.body?.getReader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxResponseBytes) throw new Error(`HTTP response exceeded ${maxResponseBytes} bytes`);
      return bytes;
    }
    activeReader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await activeReader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        total += chunk.byteLength;
        if (total > maxResponseBytes) {
          await activeReader.cancel();
          throw new Error(`HTTP response exceeded ${maxResponseBytes} bytes`);
        }
        chunks.push(chunk);
      }
    } finally {
      activeReader.releaseLock?.();
      activeReader = null;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  };

  if (timeoutMs === null) return readBody();
  let timer;
  let timedOut = false;
  const bodyPromise = readBody();
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`HTTP response body timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([bodyPromise, timeoutPromise]);
  } catch (error) {
    if (timedOut) {
      bodyPromise.catch(() => {});
      try {
        const cancelPromise = activeReader?.cancel?.();
        cancelPromise?.catch?.(() => {});
      } catch {
        // 取消流只做 best-effort；超时错误不能再被失控的 cancel promise 拖住。
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function readResponseText(response, maxResponseBytes, timeoutMs = null) {
  const bytes = await readResponseBytes(response, maxResponseBytes, timeoutMs);
  return new TextDecoder().decode(bytes);
}

export async function readResponseJson(response, maxResponseBytes, timeoutMs = null) {
  const text = await readResponseText(response, maxResponseBytes, timeoutMs);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 统一 HTTP 请求：超时、AbortController、网络/状态重试、Retry-After 与响应体上限集中处理。
 * 日志回调只接收 endpoint 类别、状态码、错误类别和重试次数，不接触 URL、请求头或请求体。
 */
export function createHttpClient({
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
  retries = 2,
  maxResponseBytes = 10 * 1024 * 1024,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  logger,
  endpointCategory = 'http',
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('timeoutMs must be a positive integer');
  if (!Number.isInteger(retries) || retries < 0) throw new Error('retries must be a non-negative integer');
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1) throw new Error('maxResponseBytes must be a positive integer');
  if (typeof sleep !== 'function') throw new Error('sleep must be a function');

  async function request(url, options = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      let timer;
      const timeoutError = new Error(`HTTP request timed out after ${timeoutMs}ms`);
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
      });
      let response;
      try {
        response = await Promise.race([
          fetchImpl(url, { ...options, signal: controller.signal }),
          timeoutPromise,
        ]);
        const contentLength = numericHeader(response, 'content-length');
        if (contentLength !== null && contentLength > maxResponseBytes) {
          await response.body?.cancel?.();
          throw new Error(`HTTP response exceeded ${maxResponseBytes} bytes`);
        }
        if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < retries) {
          await response.body?.cancel?.();
          const delay = retryAfterMs(response, Math.min(30_000, 250 * (2 ** attempt)));
          logEvent(logger, { endpointCategory, status: response.status, retryCount: attempt + 1 });
          await sleep(delay);
          continue;
        }
        logEvent(logger, { endpointCategory, status: response.status, retryCount: attempt });
        return response;
      } catch (error) {
        lastError = error;
        const retryable = errorCategory(error) === 'network' || errorCategory(error) === 'timeout';
        if (!retryable || attempt >= retries) {
          logEvent(logger, { endpointCategory, retryCount: attempt, errorCategory: errorCategory(error) });
          throw error;
        }
        logEvent(logger, { endpointCategory, retryCount: attempt + 1, errorCategory: errorCategory(error) });
        await sleep(Math.min(30_000, 250 * (2 ** attempt)));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new Error('HTTP request failed');
  }

  /** 对请求成功后读取响应体等后续阶段做有限重试。 */
  async function retryOperation(operation) {
    if (typeof operation !== 'function') throw new Error('operation must be a function');
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const retryable = errorCategory(error) === 'network' || errorCategory(error) === 'timeout';
        if (!retryable || attempt >= retries) {
          logEvent(logger, { endpointCategory, retryCount: attempt, errorCategory: errorCategory(error) });
          throw error;
        }
        logEvent(logger, { endpointCategory, retryCount: attempt + 1, errorCategory: errorCategory(error) });
        await sleep(Math.min(30_000, 250 * (2 ** attempt)));
      }
    }
    throw lastError ?? new Error('HTTP operation failed');
  }

  return Object.freeze({
    request,
    retryOperation,
    readResponseBytes: (response, responseMaxBytes = maxResponseBytes) => readResponseBytes(response, responseMaxBytes, timeoutMs),
    readResponseText: (response, responseMaxBytes = maxResponseBytes) => readResponseText(response, responseMaxBytes, timeoutMs),
    readResponseJson: (response, responseMaxBytes = maxResponseBytes) => readResponseJson(response, responseMaxBytes, timeoutMs),
  });
}
