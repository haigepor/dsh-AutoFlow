/** Registered model calls use native attachment projection and preserve the exact auxiliary request before dispatch. */
import { createHash } from 'node:crypto'
import { AttachmentId, type AttachmentStore, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { BlockAssembler, LlmError, type LlmRuntime, type ContentBlock, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { StylePromptError, type Reference, type Route, type CallRecord, type Models } from '../shared/model.ts'
import type { Config } from './config.ts'

/** Services resolved from the active DSH profile, without a private API endpoint or credential store. */
export interface ModelDependencies {
  llm: Pick<LlmRuntime, 'prepareCall' | 'listProviders' | 'listModels' | 'resolveModelInfo'>
  attachments: Pick<AttachmentStore, 'saveImages' | 'readImage'>
}

/** @param reference Persisted attachment metadata. @returns Native branded reference. */
export function nativeRef(reference: Reference): ImageAttachmentRef {
  const { name, originalDimensions, ...fields } = reference.attachment
  return { ...fields, attachmentId: AttachmentId(fields.attachmentId), ...(name === undefined ? {} : { name }), ...(originalDimensions === undefined ? {} : { originalDimensions }) }
}

/** @param dependencies Current model registry. @param signal Read lifetime. @returns Image-capable routes and separately reported unavailable providers. */
export async function listModels(dependencies: ModelDependencies, signal: AbortSignal): Promise<Models> {
  const results = await Promise.all(dependencies.llm.listProviders().map(async provider => {
    try {
      const models = await dependencies.llm.listModels(provider.id)
      const resolved = await Promise.all(models.map(async model => ({ model, info: await dependencies.llm.resolveModelInfo(provider.id, model.id, signal) })))
      signal.throwIfAborted()
      return { models: resolved.filter(({ info }) => info.inputModalities?.includes('image')).map(({ model }) => ({ provider: provider.id, providerName: provider.name, id: model.id, name: model.name })), unavailable: [] }
    } catch (error) {
      if (signal.aborted) throw error
      // 单个供应商失败不隐藏其他可用模型，也不把上游地址或凭据返回界面。
      return { models: [], unavailable: [provider.name] }
    }
  }))
  return { models: results.flatMap(value => value.models), unavailable: results.flatMap(value => value.unavailable) }
}

/** One bound dispatch; retries are always an explicit new task, never hidden extra API calls. */
export class NativeModel {
  constructor(private readonly dependencies: ModelDependencies, private readonly config: Config) {}

  /** @param route Selected configured model. @param signal Admission lifetime. @returns Completion if image input is declared. */
  async preflight(route: Route, signal: AbortSignal): Promise<void> {
    try {
      const prepared = await this.dependencies.llm.prepareCall({ ...route, maxTokens: this.config.maxOutputTokens, temperature: this.config.temperature }, signal)
      if (!prepared.inputModalities?.includes('image')) throw new StylePromptError('capability-unavailable')
    } catch (error) {
      if (error instanceof LlmError) throw new StylePromptError('capability-unavailable')
      throw error
    }
  }

  /** @param input Exact auxiliary prompt. @param persist Persists the request before I/O and terminal metadata before return. @param signal Task deadline and cancellation. @returns Parsed model JSON. */
  async call(input: { route: Route; system: string; inputText: string; references: Reference[]; templateVersion: string }, persist: (call: CallRecord) => Promise<void>, signal: AbortSignal): Promise<unknown> {
    const prepared = await this.dependencies.llm.prepareCall({ ...input.route, maxTokens: this.config.maxOutputTokens, temperature: this.config.temperature }, signal)
    if (input.references.length && !prepared.inputModalities?.includes('image')) throw new StylePromptError('capability-unavailable')
    const content: ContentBlock[] = [{ type: 'text', text: input.inputText }]
    for (const ref of input.references) {
      const image = await this.dependencies.attachments.readImage(nativeRef(ref), signal)
      if (createHash('sha256').update(image.data).digest('hex') !== ref.sha256) throw new StylePromptError('invalid-input')
      content.push({ type: 'text', text: JSON.stringify({ referenceId: ref.id, name: ref.name, sha256: ref.sha256 }) }, { type: 'image', attachment: image.ref })
    }
    const call: CallRecord = { templateVersion: input.templateVersion, config: z.json().parse(prepared.config), system: input.system, inputText: input.inputText, references: structuredClone(input.references), startedAt: new Date().toISOString(), finish: null, usage: null }
    await persist(call)
    signal.throwIfAborted()
    const assembler = new BlockAssembler()
    let bytes = 0, finished = false, usage: TokenUsage | undefined
    for await (const chunk of prepared.stream({ ...prepared.config, system: input.system, messages: [{ role: 'user', content }], signal })) {
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        bytes += Buffer.byteLength(chunk.text)
        if (bytes > this.config.maxResponseBytes) throw new StylePromptError('invalid-output')
      }
      if (chunk.type === 'finish') finished = true
      if (chunk.type === 'usage') usage = chunk.usage
      assembler.push(chunk)
    }
    signal.throwIfAborted()
    const finish = assembler.finish
    await persist({ ...call, finish: finished ? z.json().parse(finish) : null, usage: usage ? z.json().parse(usage) : null })
    if (!finished || finish.kind === 'max-tokens' || finish.kind !== 'stop') throw new StylePromptError(finish.kind === 'error' ? 'model-error' : 'invalid-output')
    const output = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('').trim()
    // 某些兼容服务仍返回 JSON 围栏；只移除完整单层围栏，绝不补写缺失字段。
    const json = output.startsWith('```json\n') && output.endsWith('\n```') ? output.slice(8, -4) : output
    try { return JSON.parse(json) } catch (error) { throw new StylePromptError('invalid-output') }
  }
}
