/** Dataset organization copy distinguishes model suggestions, frozen versions and export attempts. */
export const datasetEn = {
  analysisObservationReady: 'The model organized and saved an observation package. Review the available evidence before enabling matching rules.',
  datasetMatchingRules: 'Matching rules', datasetStyleGroups: 'Style groups', datasetPositiveLabel: 'Positive', datasetNegativeLabel: 'Negative', datasetRulesLabel: 'Rules', datasetReorganized: 'Reorganized', datasetObservationHint: 'Saved observations · not a search standard', datasetAutoHint: 'Every completed analysis automatically organizes and saves a dataset. Partial observations are saved until the complete style is ready.',
  datasetOrganize: 'Organize with model', datasetOrganizeHint: 'The model organizes positive and negative references, explains mismatches and saves a complete package. Existing versions are retained.',
  datasetVersions: 'Saved versions', datasetHistory: 'Version history', datasetShowHistory: 'Show history', datasetHideHistory: 'Hide history',
  datasetReferenceNotes: 'Reference notes', datasetRequiredReview: 'Unconfirmed required rules', datasetSameContent: 'Exports with identical content',
  datasetComparedWith: 'Compared with', datasetNotesOnly: 'Only reference guidance changed; matching rules are unchanged', datasetAddedPositive: 'Positive references added', datasetAddedNegative: 'Negative references added', datasetRemoved: 'References removed', datasetRulesAdded: 'Matching rules added', datasetRulesRemoved: 'Matching rules removed',
  datasetRejectionReasons: 'Mismatch reasons', datasetModelReason: 'Model suggestion · unconfirmed', datasetHumanReason: 'Human explanation', datasetReasonMissing: 'No mismatch reason has been saved. Organize with the model to suggest reasons.',
  datasetImportedRole: 'Original import role', datasetDimensionJudgments: 'Human dimension judgments', datasetNotApplicable: 'Not applicable', datasetCounterCount: 'Counterexamples', datasetCondition: 'Applies when', datasetSingleExample: 'Single-example support',
}

/** Chinese copy uses the same dataset messages as the English dictionary. */
export const datasetZh: typeof datasetEn = {
  analysisObservationReady: '模型已整理并保存观察数据包，可补充参考或检查规则依据后再启用匹配规则',
  datasetMatchingRules: '匹配规则', datasetStyleGroups: '风格组', datasetPositiveLabel: '正例', datasetNegativeLabel: '反例', datasetRulesLabel: '规则', datasetReorganized: '重新整理', datasetObservationHint: '已保存图片观察，尚不作为找图标准', datasetAutoHint: '每次分析完成后自动整理并保存数据集；资料尚未齐全时先保存观察包，补齐后自动生成完整风格包',
  datasetOrganize: '模型整理生成', datasetOrganizeHint: '模型自动整理正反例、分析不匹配原因并保存完整参考包，已有版本保留',
  datasetVersions: '已保存版本', datasetHistory: '版本历史', datasetShowHistory: '展开历史版本', datasetHideHistory: '收起历史版本',
  datasetReferenceNotes: '参考说明', datasetRequiredReview: '待确认硬规则', datasetSameContent: '相同内容的导出记录',
  datasetComparedWith: '相比', datasetNotesOnly: '仅调整参考说明，匹配规则未变', datasetAddedPositive: '新增正例', datasetAddedNegative: '新增反例', datasetRemoved: '移除参考', datasetRulesAdded: '新增匹配规则', datasetRulesRemoved: '移除匹配规则',
  datasetRejectionReasons: '不匹配原因', datasetModelReason: '模型建议 · 待确认', datasetHumanReason: '人工说明', datasetReasonMissing: '尚未保存不匹配原因，可通过模型整理生成原因建议',
  datasetImportedRole: '原始导入角色', datasetDimensionJudgments: '人工维度判断', datasetNotApplicable: '不适用', datasetCounterCount: '反例依据', datasetCondition: '适用条件', datasetSingleExample: '单例支持',
}
