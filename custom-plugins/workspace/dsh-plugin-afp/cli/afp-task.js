/** DSH-managed adapter, with no standalone application or package bin.
 * @param {object} service Active profile AFP service.
 * @param {object} request Operation and serialized arguments.
 * @param {AbortSignal} signal Admission cancellation.
 * @returns {Promise<object>} The same result consumed by the workbench.
 */
export function runAfpTask(service, request, signal) { return service.pageAction(request, signal) }
