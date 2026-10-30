/** Read the same registered providers and resolved capabilities used by native model settings. */
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { VisionModels } from '../shared/vision-models.ts'
import { CuratorError } from '../shared/errors.ts'

type Registry = Pick<LlmRuntime, 'listProviders' | 'listModels' | 'resolveModelInfo'>

/** @param llm Current profile registry. @param signal Read lifetime. @returns Image-capable configured routes and isolated provider failures without secrets. */
export async function listVisionModels(llm: Registry, signal: AbortSignal): Promise<VisionModels> {
  const results = await Promise.all(llm.listProviders().map(async provider => {
    try {
      signal.throwIfAborted()
      const models = await llm.listModels(provider.id)
      const resolved = await Promise.all(models.map(async model => ({ model, info: await llm.resolveModelInfo(provider.id, model.id, signal) })))
      signal.throwIfAborted()
      return { models: resolved.filter(({ info }) => info.inputModalities?.includes('image')).map(({ model, info }) => ({ provider: provider.id, providerName: provider.name, id: model.id, name: model.name, ...(info.context ? { contextWindow: info.context.contextWindow } : {}), ...(info.defaultMaxTokens ? { maxOutputTokens: info.defaultMaxTokens } : {}) })), unavailable: [] }
    } catch (error) {
      // 单个供应商故障不隐藏其他模型；上游错误可能含地址或凭据，不返回原文。
      if (signal.aborted) throw error
      return { models: [], unavailable: [{ provider: provider.id, name: provider.name }] }
    }
  }))
  return { models: results.flatMap(result => result.models), unavailable: results.flatMap(result => result.unavailable) }
}

/** @param llm Current profile registry. @param provider Configured route. @param model Advertised image model. @param signal Save lifetime. @returns Completion when a new selection remains available. */
export async function requireVisionModel(llm: Registry | undefined, provider: string | undefined, model: string, signal: AbortSignal): Promise<void> {
  if (!llm || !provider || !llm.listProviders().some(item => item.id === provider)) throw new CuratorError('configuration-required', 'vision-model', 'The selected model provider is no longer available.', { suggestedAction: 'Select an image-capable model from project settings.' })
  const models = await llm.listModels(provider)
  if (!models.some(item => item.id === model) || !(await llm.resolveModelInfo(provider, model, signal)).inputModalities?.includes('image')) throw new CuratorError('configuration-required', 'vision-model', 'The selected model is unavailable or does not support image input.', { suggestedAction: 'Select an image-capable model from project settings.' })
}
