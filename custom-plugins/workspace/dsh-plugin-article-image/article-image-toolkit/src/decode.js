/** Charset negotiation for unlike-UTF-8 pages: header, BOM, meta tag, then byte evidence. */
import { failure } from './contracts.js'

const BOM = [
  { bytes: [0xef, 0xbb, 0xbf], charset: 'utf-8' },
  { bytes: [0xff, 0xfe], charset: 'utf-16le' },
  { bytes: [0xfe, 0xff], charset: 'utf-16be' },
]

// 同一编码的多种写法归一到一个标签，TextDecoder 只认规范名（gbk → gb18030 是超集）。
const ALIASES = new Map([
  ['utf8', 'utf-8'], ['unicode-1-1-utf-8', 'utf-8'],
  ['latin1', 'windows-1252'], ['iso-8859-1', 'windows-1252'], ['iso8859-1', 'windows-1252'], ['ascii', 'windows-1252'], ['us-ascii', 'windows-1252'],
  ['gb2312', 'gb18030'], ['gbk', 'gb18030'], ['x-gbk', 'gb18030'], ['cp936', 'gb18030'],
  ['big5-hkscs', 'big5'], ['cn-big5', 'big5'], ['cp950', 'big5'],
  ['shift-jis', 'shift_jis'], ['sjis', 'shift_jis'], ['x-sjis', 'shift_jis'], ['ms_kanji', 'shift_jis'], ['windows-31j', 'shift_jis'],
  ['euc-kr', 'euc-kr'], ['ks_c_5601-1987', 'euc-kr'], ['cp949', 'euc-kr'],
])

/** Normalize one charset label to a decoder-supported name. @param {string|undefined} label Declared charset. @returns {string|null} Canonical label or null. */
export function normalizeCharset(label) {
  const value = String(label ?? '').trim().toLowerCase().replace(/^["']|["']$/g, '')
  if (!value) return null
  const candidate = ALIASES.get(value) ?? value
  try { new TextDecoder(candidate); return candidate } catch { return null }
}

/** Read the charset parameter of a Content-Type header. @param {string|undefined} value Header value. @returns {string|null} Canonical charset. */
export function charsetFromContentType(value) {
  const match = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(String(value ?? ''))
  return match ? normalizeCharset(match[1]) : null
}

/** Read a byte-order mark. @param {Uint8Array} bytes Response body. @returns {object|null} Charset and BOM length. */
export function charsetFromBom(bytes) {
  for (const entry of BOM) {
    if (entry.bytes.every((byte, index) => bytes[index] === byte)) return { charset: entry.charset, length: entry.bytes.length }
  }
  return null
}

/** Read a meta charset declaration from the document head bytes. @param {Uint8Array} bytes Response body. @returns {string|null} Canonical charset. */
export function charsetFromMeta(bytes) {
  // 头部声明一定是 ASCII；按 latin1 读取不会因为正文编码而错位。
  const head = Buffer.from(bytes.subarray(0, 8192)).toString('latin1')
  const direct = /<meta[^>]+charset\s*=\s*["']?\s*([\w:.-]+)/i.exec(head)
  if (direct) { const charset = normalizeCharset(direct[1]); if (charset) return charset }
  const httpEquiv = /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w:.-]+)/i.exec(head)
  return httpEquiv ? normalizeCharset(httpEquiv[1]) : null
}

// 不用 /g：逐字符 test 时 lastIndex 会跨调用残留，CJK 计数会交替失效。
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/u

/** Score a decoded sample by CJK density minus decoding damage. @param {string} text Candidate decoding. @returns {number} Score. */
function score(text) {
  let cjk = 0, damage = 0
  for (const character of text) {
    if (CJK.test(character)) cjk++
    else if (character === '\ufffd') damage += 4
    else if (character < ' ' && !'\t\n\r'.includes(character)) damage += 2
  }
  return cjk - damage
}

/**
 * Decode a response body, choosing the charset in specificity order.
 * The byte-evidence pass only runs when nothing declared an encoding and UTF-8 fails,
 * so a correctly served page is never re-scored.
 * @param {Uint8Array} bytes Response body.
 * @param {string|undefined} contentType Content-Type header.
 * @returns {{text: string, charset: string, source: string}} Decoded text, charset and encoding source.
 */
export function decodeBody(bytes, contentType) {
  const header = charsetFromContentType(contentType)
  const bom = charsetFromBom(bytes)
  if (bom) return { text: decodeWith(bytes, bom.charset, 0), charset: bom.charset, source: 'bom' }
  if (header) return { text: decodeWith(bytes, header, 0), charset: header, source: 'header' }
  const meta = charsetFromMeta(bytes)
  if (meta) return { text: decodeWith(bytes, meta, 0), charset: meta, source: 'meta' }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), charset: 'utf-8', source: 'utf-8' }
  } catch (error) {
    void error
  }
  const sample = bytes.subarray(0, 65536)
  let best = null
  // 声明缺失时的候选集固定且有序，评分相同取靠前者，结果可重现。
  for (const charset of ['gb18030', 'big5', 'shift_jis', 'euc-kr', 'windows-1252']) {
    const text = decodeWith(sample, charset, 0)
    const value = score(text)
    if (!best || value > best.score) best = { charset, score: value }
  }
  if (!best || best.score <= 0) return { text: decodeWith(bytes, 'windows-1252', 0), charset: 'windows-1252', source: 'fallback' }
  return { text: decodeWith(bytes, best.charset, 0), charset: best.charset, source: 'heuristic' }
}

/** Decode with one charset after skipping any byte-order mark. @param {Uint8Array} bytes Response body. @param {string} charset Canonical label. @param {number} offset Bytes to skip. @returns {string} Decoded text. */
function decodeWith(bytes, charset, offset) {
  try { return new TextDecoder(charset, { fatal: false }).decode(bytes.subarray(offset)) }
  catch (error) { void error; throw failure('article-unsupported') }
}
