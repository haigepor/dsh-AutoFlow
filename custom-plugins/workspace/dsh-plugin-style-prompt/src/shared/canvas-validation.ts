/** Incomplete drafts remain editable; execution requires the selected ancestors' actual inputs. */
import { executionOrder, type CanvasDocument, type NodeId } from './canvas.ts'

export type CanvasIssueKind = 'images' | 'model' | 'analysis' | 'rules' | 'brief' | 'english' | 'style' | 'prompt' | 'output' | 'variant'
export type CanvasField = 'images' | 'model' | 'dimensions' | 'rules' | 'brief.zh' | 'changes.zh' | 'brief.en' | 'changes.en' | 'prompt' | 'variant' | 'output'
export interface CanvasIssue { nodeId: NodeId; kind: CanvasIssueKind; field: CanvasField }

/** @param document Editable graph. @param targets Requested execution targets. @returns Actionable missing inputs in dependency order. */
export function canvasInputIssues(document: CanvasDocument, targets: readonly NodeId[]): CanvasIssue[] {
  const issues: CanvasIssue[] = []
  const has = (id: NodeId, handle: string) => document.edges.some(edge => edge.target === id && edge.targetHandle === handle)
  for (const node of executionOrder(document, targets)) {
    const issue = (kind: CanvasIssueKind, field: CanvasField = kind === 'analysis' ? 'dimensions' : kind === 'style' ? 'rules' : kind === 'english' || kind === 'brief' ? 'brief.zh' : kind) => issues.push({ nodeId: node.id, kind, field })
    switch (node.kind) {
      case 'reference': if (!node.assetIds.length) issue('images'); break
      case 'analysis': if (!node.historyTaskId) { if (!node.route) issue('model'); if (!has(node.id, 'images')) issue('images'); if (!node.dimensions.length) issue('analysis') }; break
      case 'rules': if (!has(node.id, 'analysis')) issue('analysis'); if (node.selectedRuleIds?.length === 0) issue('rules'); break
      case 'brief': if (!node.brief.zh.trim()) issue('brief', 'brief.zh'); if (!node.changes.zh.trim()) issue('brief', 'changes.zh'); break
      case 'prompt': {
        if (node.historyTaskId) break
        if (node.mode === 'model' && !node.route) issue('model')
        if (!has(node.id, 'style')) issue('style')
        const edge = document.edges.find(edge => edge.target === node.id && edge.targetHandle === 'brief'), brief = document.nodes.find(node => node.id === edge?.source)
        if (brief?.kind !== 'brief') issue('brief')
        else if (node.mode === 'quick') {
          if (!brief.brief.en.trim()) issues.push({ nodeId: brief.id, kind: 'english', field: 'brief.en' })
          if (!brief.changes.en.trim()) issues.push({ nodeId: brief.id, kind: 'english', field: 'changes.en' })
        }
        break
      }
      case 'image': {
        if (!node.route) issue('model')
        if (!has(node.id, 'prompt') && !node.prompt.trim()) issue('prompt')
        const edge = document.edges.find(edge => edge.target === node.id && edge.targetHandle === 'prompt'), source = document.nodes.find(node => node.id === edge?.source)
        if (source?.kind === 'prompt' && source.mode === 'quick' && node.variant > 0) issue('variant')
        break
      }
      case 'output': if (!has(node.id, 'images') && !has(node.id, 'prompt')) issue('output'); break
    }
  }
  return issues
}
