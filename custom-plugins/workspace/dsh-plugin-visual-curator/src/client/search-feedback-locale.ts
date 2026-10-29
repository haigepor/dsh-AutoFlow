/** Search feedback copy uses the existing typed locale dictionary. */
export const feedbackEn = {
  taskLookupFailed: 'Source details could not be retrieved',
  taskReadProgress: 'Read task progress', taskReading: 'Reading saved progress', taskLive: 'Live task data', taskSaved: 'Saved task data',
  taskReadFailed: 'Progress could not be refreshed. Confirmed results are kept.', taskRefresh: 'Refresh progress',
  taskRejected: 'Not matched', taskProcessing: 'In review', taskUnavailable: 'Original unavailable', taskDiagnostics: 'Candidate diagnostics',
  taskTechnical: 'Technical failures', taskSourceRestricted: 'This source does not provide a deliverable original for this image',
  taskSourceMissing: 'The source returned no original image', taskDownloadFailed: 'Original download failed', taskImportFailed: 'Image import failed', taskReviewFailed: 'Visual review could not complete',
  taskLegacyWarning: 'Saved warnings', taskNoFinal: 'No final selections yet. Check pending reviews and other candidates.',
  taskNoPending: 'No unfinished images are retained', taskNoSource: 'No source images are retained', taskNoReview: 'No images are waiting for a review decision', taskNoRejected: 'No images have been marked as not matched',
  taskNoTechnical: 'No imported images have a technical failure. Source diagnostics are listed above.', taskNoProcessing: 'No imported images are currently being reviewed',
  taskDeliveryPending: 'No delivery receipt yet; an output directory is not available', taskDeliveryReady: 'Saved to Workspace',
  taskRawDetails: 'Call details', taskPreview: 'Candidate previews',
  taskStageRetrieving: 'Retrieving originals', taskStageScreening: 'Screening images', taskStageReviewing: 'Final review', taskStageCropping: 'Rendering crops', taskStageExporting: 'Saving results',
}
export const feedbackZh: typeof feedbackEn = {
  taskLookupFailed: '暂时无法获取图库来源信息',
  taskReadProgress: '读取任务进度', taskReading: '正在读取已保存进度', taskLive: '实时任务数据', taskSaved: '已保存任务数据',
  taskReadFailed: '暂时无法刷新进度，已确认结果仍保留', taskRefresh: '刷新进度',
  taskRejected: '不符合风格', taskProcessing: '复核中', taskUnavailable: '原图不可用', taskDiagnostics: '候选处理情况',
  taskTechnical: '技术失败', taskSourceRestricted: '图库未提供这张图片的可交付原图',
  taskSourceMissing: '图库没有返回原图', taskDownloadFailed: '原图下载失败', taskImportFailed: '图片导入失败', taskReviewFailed: '视觉检查未能完成',
  taskLegacyWarning: '已保存警告', taskNoFinal: '暂无最终入选，可查看待复核和其他候选',
  taskNoPending: '暂无未处理的图片', taskNoSource: '暂无保留的裁剪源图', taskNoReview: '暂无需要人工判断的图片', taskNoRejected: '暂无判定为不符合风格的图片',
  taskNoTechnical: '已导入图片暂无技术失败，来源问题见上方处理情况', taskNoProcessing: '当前没有正在复核的已导入图片',
  taskDeliveryPending: '尚无交付回执，暂未提供输出目录', taskDeliveryReady: '已保存到工作区',
  taskRawDetails: '调用详情', taskPreview: '候选预览',
  taskStageRetrieving: '获取原图', taskStageScreening: '初筛图片', taskStageReviewing: '最终复核', taskStageCropping: '生成裁剪', taskStageExporting: '保存结果',
}

export const taskStageKeys = { retrieving: 'taskStageRetrieving', screening: 'taskStageScreening', reviewing: 'taskStageReviewing', cropping: 'taskStageCropping', exporting: 'taskStageExporting' } as const
