/** Shared settings catalog invalidated by native model and credential events. */
import { visionModelsSchema, type VisionModels, type VisionModel } from '../shared/vision-models.ts'
import type { ConfigurationView } from './contract.ts'

/** Lifecycle read by the settings region independently of gallery progress. */
export interface VisionModelState { value: VisionModels | null; status: 'idle' | 'loading' | 'ready' | 'error' }

/** @param model Exact registered provider/model. @returns Collision-free menu identity. */
export function visionModelKey(model: Pick<VisionModel, 'provider' | 'id'>): string { return JSON.stringify([model.provider, model.id]) }

/** @param vision Existing plugin controls. @param key User-selected menu identity. @param catalog Current project models. @returns Native selection without duplicate connection or reasoning overrides. */
export function managedVision(vision: ConfigurationView['vision'], key: string, catalog: VisionModels): Omit<ConfigurationView['vision'], 'backend' | 'provider' | 'supportsStreaming' | 'reasoningEffort' | 'useModelDefaults'> & { backend: 'native'; provider: string; supportsStreaming: true; reasoningEffort: null; useModelDefaults: true } {
  const model = catalog.models.find(item => visionModelKey(item) === key)
  if (!model) throw new Error('model-unavailable')
  return { ...vision, backend: 'native', provider: model.provider, model: model.id, endpoint: '', credentialRef: '', localOrigin: '', vendorVersion: null,
    supportsMultipleImages: true, supportsJson: true, supportsStreaming: true, reasoningEffort: null, useModelDefaults: true }
}

/** @param read Authenticated catalog read. @returns One cached observable catalog shared by workspace entries. */
export function createVisionModelDirectory(read: () => Promise<unknown>) {
  let state: VisionModelState = { value: null, status: 'idle' }, generation = 0, disposed = false, inflight: Promise<void> | undefined
  const listeners = new Set<() => void>()
  const publish = (next: VisionModelState) => { state = next; for (const listener of listeners) listener() }
  function load(): Promise<void> {
    if (disposed || state.status === 'ready') return Promise.resolve()
    if (inflight) return inflight
    const current = generation
    publish({ ...state, status: 'loading' })
    const work = read().then(value => {
      const parsed = visionModelsSchema.parse(value)
      if (!disposed && current === generation) publish({ value: parsed, status: 'ready' })
    }).catch(error => {
      // 失败保留当前标签供识别，但禁止保存过期选择；重试使用同一只读接口。
      if (!disposed && current === generation) publish({ ...state, status: 'error' })
    }).finally(() => { if (current === generation && inflight === work) inflight = undefined })
    inflight = work
    return work
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    load,
    invalidate() { const loaded = state.status !== 'idle'; generation++; inflight = undefined; publish({ ...state, status: 'idle' }); if (loaded) void load() },
    reset() { generation++; inflight = undefined; publish({ value: null, status: 'idle' }) },
    dispose() { disposed = true; generation++; listeners.clear() },
  }
}
