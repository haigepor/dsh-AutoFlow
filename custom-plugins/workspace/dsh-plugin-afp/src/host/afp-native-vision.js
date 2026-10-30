import { parseVisionJson } from '../vendor/auto-afp-img/openai-compatible-vision.mjs'

/** Project active, image-capable model routes; partial discovery never enables a guessed legacy route.
 * @param {object} llm Profile-owned LLM service; absence leaves selection unavailable.
 * @param {object} config Resolved AFP deployment settings.
 * @returns {Promise<object>} Secret-free choices, exact selection and availability.
 */
export async function nativeVisionInformation(llm, config) {
  if (!llm) return { models: [], unavailableProviders: [], selected: null, state: 'unavailable' }
  const providers = llm.listProviders()
  const results = await Promise.allSettled(providers.map(provider => llm.listModels(provider.id)))
  const models = [], unavailableProviders = []
  for (let index = 0; index < providers.length; index++) {
    const provider = providers[index], result = results[index]
    if (result.status === 'rejected') { unavailableProviders.push(provider.id); continue }
    for (const model of result.value) if (model.inputModalities?.includes('image')) {
      models.push({ provider: provider.id, providerName: provider.name, id: model.id, name: model.name })
    }
  }
  // 旧的 reasoningModel 曾覆盖 visionModel；仅唯一匹配时保留原有效模型，绝不复用旧接口或密钥。
  const modelId = config.visionProvider ? config.visionModel : config.reasoningModel || config.visionModel
  const matches = models.filter(model => model.id === modelId && (!config.visionProvider || model.provider === config.visionProvider))
  const chosen = matches.length === 1 && (config.visionProvider || !unavailableProviders.length) ? matches[0] : null
  return { models, unavailableProviders, selected: chosen ? { provider: chosen.provider, model: chosen.id } : null,
    state: chosen ? 'ready' : 'selection-required' }
}

function selectionRequired() { return new Error('Select an available image model from Settings in the AFP configuration') }

/** Dispatch AFP pixels through the profile adapter and its authentication, protocol and default controls.
 * @param {object} dependencies LLM, attachment service, resolved config and owning task signal.
 * @returns {Promise<object>} Vision classifier; it owns no automatic paid-request retry.
 */
export async function createNativeVisionClient({ llm, attachments, config, signal }) {
  signal.throwIfAborted()
  const information = await nativeVisionInformation(llm, config)
  signal.throwIfAborted()
  if (information.state !== 'ready' || !attachments) throw selectionRequired()
  const route = information.selected
  const prepare = async callSignal => {
    callSignal.throwIfAborted()
    const models = await llm.listModels(route.provider)
    if (!models.some(model => model.id === route.model && model.inputModalities?.includes('image'))) throw selectionRequired()
    const call = await llm.prepareCall(route, callSignal)
    if (!call.inputModalities?.includes('image')) throw selectionRequired()
    callSignal.throwIfAborted()
    return call
  }
  // 在 AFP 认证和大规模检索前检查当前适配器；每次判断仍重新绑定其最新配置。
  await prepare(signal)
  return { route,
    async classify({ prompt, bytes, contentType, onRequest }) {
      const callSignal = AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)])
      const call = await prepare(callSignal)
      const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase()
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mediaType) || !bytes?.byteLength || bytes.byteLength > config.maxPreviewBytes) {
        throw new Error('AFP vision preview has an unsupported type or size')
      }
      const [attachment] = await attachments.saveImages([{ data: bytes, mediaType, name: 'AFP preview' }])
      callSignal.throwIfAborted()
      const options = { ...call.config, messages: [{ role: 'user', content: [
        { type: 'text', text: prompt }, { type: 'image', attachment },
      ] }], signal: callSignal }
      // 模型可见的提示词、已归一化附件和实际参数由运行记录保存后才允许发送。
      await onRequest?.({ config: call.config, prompt, attachment })
      callSignal.throwIfAborted()
      let output = '', outputBytes = 0, finish
      for await (const chunk of call.stream(options)) {
        callSignal.throwIfAborted()
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
          outputBytes += Buffer.byteLength(chunk.text)
          if (outputBytes > config.maxResponseBytes) throw new Error('AFP vision response exceeds its byte limit')
          if (chunk.type === 'text-delta') output += chunk.text
        } else if (chunk.type === 'finish') finish = chunk.reason
      }
      callSignal.throwIfAborted()
      if (finish?.kind !== 'stop') {
        const error = new Error('AFP vision request did not complete')
        // 只投影状态码；供应商消息可能包含私密地址、响应正文或凭据。
        if (finish?.kind === 'error' || finish?.kind === 'aborted') error.httpStatus = finish.failure.status
        throw error
      }
      return parseVisionJson(output)
    },
  }
}
