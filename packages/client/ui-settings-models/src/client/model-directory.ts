/** Model directory projection; full configuration records remain intact for editing. */
import type { LlmDiscoveredModel, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { modelDrafts, type DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import type { ProviderRow } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import { modelReasoningOptions, type ModelReasoningOptions } from './model-reasoning.ts'

/** A provider's effective catalog and its editable records. */
export interface ModelDirectoryGroup {
  row: ProviderRow
  models: DeepSeekModelDraft[]
  metadata: ReadonlyMap<string, LlmDiscoveredModel>
  profile: unknown
  editable: boolean
  reasoning: ModelReasoningOptions
}

/**
 * Resolve configured arrays before installed defaults without flattening hidden model fields.
 * @param rows - joined provider rows.
 * @param namespaces - current settings layers.
 * @param schema - settings path and schema operations.
 * @returns effective catalogs in provider order.
 */
export function modelDirectory(
  rows: readonly ProviderRow[], namespaces: ReadonlyMap<string, SettingsNamespaceView>, schema: SettingsSchemaOperations,
): ModelDirectoryGroup[] {
  return rows.filter(row => row.configured).map((row) => {
    const namespace = namespaces.get(row.entry.settingsNs)
    const profile = namespace === undefined ? undefined : schema.getPath(namespace.value, row.entry.settingsPath)
    const configured = schema.getPath(profile, ['models'])
    const defaults: unknown = namespace === undefined ? undefined
      : schema.nodeAtPath(schema.rehydrate(namespace.schema), [...row.entry.settingsPath, 'models'])?.meta.default
    const records = modelDrafts(configured ?? defaults)
    const catalog = row.catalogModels ?? []
    // pi-ai 的空数组继承内置目录；只写入 ID 即可继续继承模型的能力与协议。
    const models = records.length > 0 || row.entry.settingsNs === 'llm-deepseek'
      ? records : catalog.map(model => ({ id: model.id, ...model.name === undefined ? {} : { name: model.name } }))
    return {
      row, models, profile, metadata: new Map(catalog.map(model => [model.id, model])),
      reasoning: namespace === undefined ? { levels: [], formats: [] }
        : modelReasoningOptions(namespace, schema, row.entry.settingsPath, profile),
      editable: namespace !== undefined && ['llm-deepseek', 'llm-pi-ai'].includes(namespace.ns)
        && (records.length > 0 || namespace.ns === 'llm-deepseek' || row.entry.declared === true || row.catalogModels !== undefined),
    }
  })
}
