/** Copy owned by the image card and its session gallery. */
export const en = {
  title: 'Image generation', preparing: 'Preparing image', queued: 'Queued', generating: 'Generating image', succeeded: 'Image generated',
  generationRequest: 'Image generation request', inspectRequest: 'Inspect image generation request',
  failed: 'Image generation failed', cancelled: 'Generation cancelled', unknown: 'Result needs confirmation', estimated: 'Est.',
  elapsed: '{seconds} s', unavailable: 'Task status is temporarily unavailable', reconnecting: 'Connection interrupted; retrying',
  image: 'Generated image', openImage: 'Preview generated image', previewTitle: 'Image preview', close: 'Close image preview',
  sessionImages: 'Images in this conversation', previous: 'Previous image', next: 'Next image', download: 'Download original',
  retryImage: 'Reload image', imageFailed: 'Image could not be loaded', loadingImage: 'Loading image', counter: '{index} / {total}',
  partial: 'Some images were saved; the task did not fully complete', creditsDisabled: 'Enable image credits for a subscription account',
  pendingUnknown: 'Check this task before submitting it again', readResult: 'Image task result', viewImages: 'View images',
  phraseImagine: 'Bringing your idea into view', phraseInspiration: 'Letting inspiration take shape',
  phraseDescribe: 'Creating the scene you described', phraseDraw: 'Turning your idea into an image',
  phraseWait: 'Your image is taking shape', phrasePatience: 'A good image takes a little patience',
} as const
export const zh: Record<keyof typeof en, string> = {
  title: '图片生成', preparing: '正在准备图片', queued: '排队中', generating: '正在生成图片', succeeded: '图片已生成',
  generationRequest: '图片生成请求', inspectRequest: '查看图片生成调用详情',
  failed: '图片生成失败', cancelled: '已取消生成', unknown: '生成结果待确认', estimated: '预计',
  elapsed: '{seconds} 秒', unavailable: '暂时无法读取任务状态', reconnecting: '连接暂时中断，正在重试',
  image: '生成的图片', openImage: '预览生成图片', previewTitle: '图片预览', close: '关闭图片预览',
  sessionImages: '本会话图片', previous: '上一张图片', next: '下一张图片', download: '下载原图',
  retryImage: '重新加载图片', imageFailed: '图片暂时无法加载', loadingImage: '正在加载图片', counter: '{index} / {total}',
  partial: '部分图片已保存，任务未全部完成', creditsDisabled: '请为订阅账号启用生图积分',
  pendingUnknown: '请先确认这个任务的结果，再决定是否重新提交', readResult: '图片任务结果', viewImages: '查看图片',
  phraseImagine: '正在描绘你的想象', phraseInspiration: '让灵感逐渐成形',
  phraseDescribe: '正在生成你描述的画面', phraseDraw: '正在把想法绘成图像',
  phraseWait: '画面正在生成，请稍候', phrasePatience: '好的画面，需要一点耐心',
}
export type ImageCopyKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { codexImages: ImageCopyKey }
}
