/** Publisher template selection shared by static verification, rendering and rich extraction. */

/** Match the exact host and optional literal pathname prefixes; omission retains whole-host scope. @param {object} adapter Validated publisher settings. @param {string} input Current controlled URL. @returns {boolean} Whether this template applies to the current page. */
export function matchesCaptureAdapter(adapter, input) {
  const url = new URL(input)
  return adapter.hosts.some(host => host.toLowerCase() === url.hostname.toLowerCase()) && (!adapter.pathPrefixes || adapter.pathPrefixes.some(prefix => url.pathname.startsWith(prefix)))
}
