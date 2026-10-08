import { photoResultEnvelope } from './afp-conversation-records.js'
const reads = new Set(['afp_photo_search_start', 'afp_photo_search', 'afp_photo_details', 'afp_collection_items', 'afp_result_page'])

/** Read only the active Turn's successful AFP metadata and report identities from its durable log.
 * @param {object} session Owning DSH Session.
 * @param {object} records Profile-owned complete safe result storage.
 * @returns {Promise<object>} Candidate metadata and report IDs; earlier Turns and failed reads are excluded.
 */
export async function currentPhotoEvidence(session, records) {
  const events = session.snapshotEvents(), calls = new Map(), photos = new Map(), reports = new Set()
  const start = events.findLastIndex(event => event.type === 'turn/start')
  if (start < 0) return { photos, reports }
  const turn = events[start].data.turn
  async function result(name, message, callId, meta) {
    if (message.isError || (!reads.has(name) && name !== 'afp_report')) return
    let value = photoResultEnvelope(message, meta)
    if (value?.resultRef && records && meta?.afp?.complete !== true) value = await records.read({ sessionId: session.id, turn, callId }, value.resultRef)
    if (name === 'afp_report') { if (typeof value?.runId === 'string') reports.add(value.runId); return }
    for (const photo of value?.found === true ? [value.photo] : Array.isArray(value?.items) ? value.items : []) {
      if (photo && typeof photo.id === 'string') photos.set(photo.id, photo)
    }
  }
  for (const event of events.slice(start + 1)) {
    const data = event.data
    if (event.type === 'tool/call' && data.turn === turn) calls.set(data.callId, data.name)
    if (event.type === 'tool/result' && data.turn === turn) await result(calls.get(data.message.toolCallId), data.message, data.message.toolCallId, data.meta)
    // PTC 子调用没有 turn 字段，必须以当前轮的根调用身份确定归属。
    if (event.type === 'tool/ptc-dispatch' && calls.has(data.rootCallId)) await result(data.name, data, data.subCallId)
  }
  return { photos, reports }
}

/** Resolve an explicit final selection without AFP requests or mutation.
 * @param {object} args IDs, criteria and optional saved visual run.
 * @param {object} session Owning Session; only its active Turn contributes metadata evidence.
 * @param {object} service AFP profile service owning saved visual runs.
 * @returns {Promise<object>} Ordered deduplicated photos and the actual screening basis.
 */
export async function selectFinalPhotos(args, session, service) {
  const { photos, reports } = await currentPhotoEvidence(session, service.conversationRecords)
  const ids = [...new Set(args.photoIds)]
  if (args.basis === 'metadata' && args.runId !== null) throw new Error('AFP metadata selection requires null runId')
  if (args.basis === 'visual' && !args.runId) throw new Error('AFP visual selection requires a runId')
  if (args.runId) {
    if (!reports.has(args.runId)) throw new Error('AFP visual report lacks current turn evidence')
    const run = await service.store.readRun(args.runId)
    const kept = new Set(run.decisions.filter(item => item.keep === true).map(item => item.id))
    if (ids.some(id => !kept.has(id))) throw new Error('AFP selection is not visually accepted')
    for (const group of Object.values(run.groups)) for (const photo of group.candidates) {
      if (kept.has(photo.id)) photos.set(photo.id, photo)
    }
  }
  if (ids.some(id => !photos.has(id))) throw new Error('AFP selected photos lack read evidence')
  return { photos: ids.map(id => photos.get(id)), selection: {
    basis: args.runId ? 'visual' : 'metadata', criteria: args.criteria, ...(args.runId ? { runId: args.runId } : {}),
  } }
}
