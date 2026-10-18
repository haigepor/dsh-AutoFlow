/** Versioned rich article records. Source strings are data and never executable markup. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const id = z.string().regex(/^[a-f0-9]{32}$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const text = z.string().max(500000)
const safeUrl = z.string().max(16384).url().refine(value => {
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
})
const inline = z.array(z.object({ text, bold: z.boolean().optional(), italic: z.boolean().optional(), href: safeUrl.optional() }).strict()).max(50000)
const list = z.lazy(() => z.object({ ordered: z.boolean(), items: z.array(z.object({ inline, children: z.array(list).max(100) }).strict()).max(10000) }).strict())
const block = z.discriminatedUnion('type', [
  z.object({ id: z.string().regex(/^b[1-9]\d*$/), type: z.literal('heading'), level: z.number().int().min(1).max(6), inline }).strict(),
  z.object({ id: z.string().regex(/^b[1-9]\d*$/), type: z.enum(['paragraph', 'quote']), inline }).strict(),
  z.object({ id: z.string().regex(/^b[1-9]\d*$/), type: z.literal('list'), ordered: z.boolean(), items: z.array(z.object({ inline, children: z.array(list).max(100) }).strict()).max(10000) }).strict(),
  z.object({ id: z.string().regex(/^b[1-9]\d*$/), type: z.literal('table'), rows: z.array(z.object({ cells: z.array(z.object({ inline, header: z.boolean(), rowSpan: z.number().int().positive().max(1000), colSpan: z.number().int().positive().max(1000) }).strict()).max(1000) }).strict()).max(10000) }).strict(),
  z.object({ id: z.string().regex(/^b[1-9]\d*$/), type: z.literal('figure'), assetId: id, alt: text, caption: text, credit: text }).strict(),
])

/** Immutable image metadata; each occurrence retains its own text in a figure block. */
export const assetSchema = z.object({ id, status: z.enum(['ready', 'failed']), sourceUrl: safeUrl, contentHash: hash.nullable(),
  mime: z.string().max(100).nullable(), width: z.number().int().positive().nullable(), height: z.number().int().positive().nullable(),
  byteLength: z.number().int().nonnegative(), positions: z.array(z.string().regex(/^b[1-9]\d*$/)).min(1),
  alt: text, caption: text, credit: text, error: z.string().max(100).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'ready' && (!value.contentHash || !value.mime || !value.width || !value.height || value.byteLength === 0 || value.error)) ctx.addIssue({ code: 'custom', message: 'Ready assets require verified bytes and dimensions' })
  if (value.status === 'failed' && !value.error) ctx.addIssue({ code: 'custom', message: 'Failed assets require an error' })
})

/** Validated snapshot accepted at persistence and tool boundaries. */
export const snapshotSchema = z.object({ schemaVersion: z.literal(2), id, title: z.string().max(2000), requestedUrl: safeUrl, url: safeUrl,
  language: z.string().max(100), capturedAt: z.string().datetime(), sourceHash: hash, extractorVersion: z.string().max(100),
  blocks: z.array(block).min(1).max(100000), assets: z.array(assetSchema).max(1000),
  pages: z.array(z.object({ url: safeUrl, blockIds: z.array(z.string().regex(/^b[1-9]\d*$/)).max(100000) }).strict()).max(100).optional(),
  quality: z.object({ status: z.enum(['passed', 'needs-review', 'partial', 'failed']), reasons: z.array(z.string().max(100)).max(1000), checks: z.array(z.string().max(100)).max(100).optional(), adapter: z.string().max(100).optional() }).strict(),
}).strict().superRefine((value, ctx) => {
  const ids = new Set(value.blocks.map(item => item.id)), assets = new Map(value.assets.map(item => [item.id, item]))
  if (ids.size !== value.blocks.length || assets.size !== value.assets.length) ctx.addIssue({ code: 'custom', message: 'Duplicate block or asset ids' })
  for (const item of value.blocks) if (item.type === 'figure' && !assets.get(item.assetId)?.positions.includes(item.id)) ctx.addIssue({ code: 'custom', message: 'Figure asset relationship is missing' })
  for (const asset of value.assets) for (const position of asset.positions) if (!value.blocks.some(item => item.id === position && item.type === 'figure' && item.assetId === asset.id)) ctx.addIssue({ code: 'custom', message: 'Asset occurrence is missing' })
  if (value.quality.status === 'passed' && (value.quality.reasons.length || value.assets.some(item => item.status !== 'ready'))) ctx.addIssue({ code: 'custom', message: 'Passed captures cannot contain unresolved content' })
})

function inlineText(values) { return values.map(value => value.text).join('') }
function listText(items) { return items.map(item => [inlineText(item.inline), ...item.children.map(child => listText(child.items))].filter(Boolean).join('\n')).join('\n') }

/** Read the textual projection of one block without flattening the stored record. @param {object} block Rich block. @returns {string} Visible text. */
export function textOfBlock(block) {
  switch (block.type) {
    case 'heading': case 'paragraph': case 'quote': return inlineText(block.inline)
    case 'list': return listText(block.items)
    case 'table': return block.rows.map(row => row.cells.map(cell => inlineText(cell.inline)).join(' | ')).join('\n')
    case 'figure': return [block.alt, block.caption, block.credit].filter(Boolean).join('\n')
    default: throw new Error('article-block-type')
  }
}

/** Project rich blocks for legacy read-only paragraph consumers. @param {object[]} blocks Ordered rich blocks. @returns {object[]} Numbered text paragraphs. */
export function blocksToParagraphs(blocks) { return blocks.map(block => ({ id: Number(block.id.slice(1)), text: textOfBlock(block) })).filter(value => value.text) }

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, field]) => [key, canonical(field)]))
  return value
}

/** Hash semantic content and image bytes; timestamps, signed image URLs and storage paths are excluded. @param {object} snapshot Snapshot candidate. @returns {string} SHA-256. */
export function hashSnapshot(snapshot) {
  const assets = new Map(snapshot.assets.map(asset => [asset.id, asset]))
  const blocks = snapshot.blocks.map(({ id: blockId, ...value }) => {
    void blockId
    if (value.type !== 'figure') return value
    const { assetId, ...figure } = value, asset = assets.get(assetId)
    return { ...figure, contentHash: asset?.contentHash ?? null, error: asset?.error ?? null }
  })
  return createHash('sha256').update(JSON.stringify(canonical({ title: snapshot.title, language: snapshot.language, blocks }))).digest('hex')
}
