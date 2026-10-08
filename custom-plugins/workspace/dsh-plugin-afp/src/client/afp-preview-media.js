const rasterTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

/** Resolve only the authenticated same-origin preview route.
 * @param {string} path Host-provided relative preview path.
 * @param {string} baseURI Current document URL.
 * @returns {string|null} Validated proxy URL or null.
 */
export function previewSource(path, baseURI) {
  if (typeof path !== 'string' || !path.startsWith('api/afp/preview?photoId=')) return null
  try {
    const url = new URL(path, baseURI), expected = new URL('api/afp/preview', baseURI)
    if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash
      || [...url.searchParams.keys()].some(key => key !== 'photoId') || url.searchParams.getAll('photoId').length !== 1
      || !url.searchParams.get('photoId')) return null
    return url.href
  } catch (error) { return null }
}

/** Fetch a protected raster preview; diagnostics contain only fixed codes and a validated hostname.
 * @param {string} src Validated same-origin proxy URL.
 * @param {AbortSignal} signal Component request lifetime.
 * @param {Function} [fetchImpl] Browser transport or test fixture.
 * @returns {Promise<Blob>} Raster bytes for a temporary object URL.
 */
export async function readPreviewMedia(src, signal, fetchImpl = globalThis.fetch) {
  let response
  try { response = await fetchImpl(src, { signal, credentials: 'same-origin' }) }
  catch (error) {
    signal.throwIfAborted()
    throw Object.assign(new Error('Preview unavailable'), { code: 'preview-unavailable', host: null, retryable: error instanceof TypeError })
  }
  if (!response.ok) {
    let diagnostic
    try { diagnostic = await response.json() } catch (error) { /* 网关文本错误使用统一提示，不显示原始响应。 */ }
    const blocked = diagnostic?.code === 'preview-host-blocked' && typeof diagnostic.host === 'string' && /^[a-z0-9.-]+$/.test(diagnostic.host)
    const retryable = !blocked && diagnostic?.code !== 'preview-host-blocked' && diagnostic?.code !== 'unsupported-image'
      && (typeof diagnostic?.retryable === 'boolean' ? diagnostic.retryable
        : diagnostic?.code !== 'preview-unavailable' && [408, 429, 500, 502, 503, 504].includes(response.status))
    throw Object.assign(new Error('Preview unavailable'), { code: blocked ? 'preview-host-blocked' : 'preview-unavailable', host: blocked ? diagnostic.host : null, retryable })
  }
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  if (!rasterTypes.has(type)) throw Object.assign(new Error('Preview unavailable'), { retryable: false })
  try { return await response.blob() }
  catch (error) {
    signal.throwIfAborted()
    throw Object.assign(new Error('Preview unavailable'), { retryable: error instanceof TypeError })
  }
}
