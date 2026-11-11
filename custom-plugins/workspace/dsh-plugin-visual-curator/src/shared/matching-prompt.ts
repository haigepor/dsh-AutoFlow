/** Executable matching prose is derived from current selections, never speculative historical summaries. */
import type { ModelProfile } from './model.ts'

/** @param options Frozen enabled choices and their original strengths. @param groups Alternative style branches. @returns Readable candidate instructions containing only active rules; raw model prose remains in the analysis record. */
export function matchingPromptFromRules(options: ModelProfile['options'], groups: ModelProfile['groups']): string {
  const enabled = options.filter(option => option.enabled && option.rule.strength !== 'reference-only')
  const describe = (option: typeof enabled[number]) => {
    const rule = option.rule
    const condition = Object.keys(rule.condition).length ? `；适用条件：${JSON.stringify(rule.condition)}` : ''
    const exceptions = rule.exceptions.length ? `；例外：${JSON.stringify(rule.exceptions)}` : ''
    return `- ${rule.strength === 'required' ? '硬性要求' : '偏好，不单项强制'}（${rule.dimension} / ${rule.stage}）：${rule.statement}${condition}${exceptions}`
  }
  const shared = enabled.filter(option => option.groupId === null)
  const lines = ['依据本次实际任务确认主体、用途与规则适用条件；参考图里的品牌、人数、天气等偶然内容不自动成为要求。', '仅检查下列已启用规则，保留其原强度。按冻结的风格覆盖策略评估偏好，不以偏好抵消硬性要求；证据不足时保留未知并复核。', ...shared.map(describe)]
  for (const group of groups) {
    const members = enabled.filter(option => option.groupId === group.groupId)
    if (members.length) lines.push(`替代风格组：${group.name || group.groupId}。只检查实际适用分支，不要求同时符合其他替代组。`, ...members.map(describe))
  }
  if (!enabled.length) lines.push('当前没有已启用的匹配规则，不能据此宣称候选符合风格。')
  lines.push('禁用项、未定角色、仅参考项及推测的反例原因不作为排除条件。检查实际图像，不以检索文字或模拟图代替像素证据。')
  return lines.join('\n')
}
