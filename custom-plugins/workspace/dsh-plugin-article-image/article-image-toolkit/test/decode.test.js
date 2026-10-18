/** Charset negotiation: declared encodings win, byte evidence only decides when nothing declared one. */
import { describe, expect, it } from 'vitest'
import { normalizeCharset, charsetFromContentType, charsetFromBom, charsetFromMeta, decodeBody } from '../src/decode.js'

const bytes = text => Buffer.from(text, 'utf8')
// GBK 字节序列（“这是一篇中文文章”）：D5E2 CAC7 D2BB C6AA D6D0 CEC4 CEC4 D5C2。
const GBK_PHRASE = [0xd5, 0xe2, 0xca, 0xc7, 0xd2, 0xbb, 0xc6, 0xaa, 0xd6, 0xd0, 0xce, 0xc4, 0xce, 0xc4, 0xd5, 0xc2]

describe('charset labels', () => {
  it('maps common aliases onto decoder-supported names', () => {
    expect(normalizeCharset('GBK')).toBe('gb18030')
    expect(normalizeCharset('gb2312')).toBe('gb18030')
    expect(normalizeCharset('latin1')).toBe('windows-1252')
    expect(normalizeCharset('ISO-8859-1')).toBe('windows-1252')
    expect(normalizeCharset('SJIS')).toBe('shift_jis')
    expect(normalizeCharset('utf8')).toBe('utf-8')
    expect(normalizeCharset('"UTF-8"')).toBe('utf-8')
  })

  it('rejects an unknown label instead of passing it to the decoder', () => {
    expect(normalizeCharset('x-not-a-charset')).toBeNull()
    expect(normalizeCharset('')).toBeNull()
    expect(normalizeCharset(undefined)).toBeNull()
  })

  it('reads the charset parameter out of a Content-Type header', () => {
    expect(charsetFromContentType('text/html; charset=GBK')).toBe('gb18030')
    expect(charsetFromContentType('text/html;charset="big5"')).toBe('big5')
    expect(charsetFromContentType('text/html; charset=x-unknown')).toBeNull()
    expect(charsetFromContentType('text/html')).toBeNull()
    expect(charsetFromContentType(undefined)).toBeNull()
  })
})

describe('byte-level declarations', () => {
  it('detects a byte-order mark before anything else', () => {
    expect(charsetFromBom(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toEqual({ charset: 'utf-8', length: 3 })
    expect(charsetFromBom(Buffer.from([0xff, 0xfe, 0x61, 0x00]))).toEqual({ charset: 'utf-16le', length: 2 })
    expect(charsetFromBom(Buffer.from([0xfe, 0xff, 0x00, 0x61]))).toEqual({ charset: 'utf-16be', length: 2 })
    expect(charsetFromBom(bytes('<html>'))).toBeNull()
  })

  it('reads both meta charset forms', () => {
    expect(charsetFromMeta(bytes('<html><head><meta charset="gbk"></head>'))).toBe('gb18030')
    expect(charsetFromMeta(bytes('<meta http-equiv="Content-Type" content="text/html; charset=big5">'))).toBe('big5')
    expect(charsetFromMeta(bytes('<!doctype html><html><body>no declaration'))).toBeNull()
  })

  it('finds a declaration that follows multibyte bytes in the head', () => {
    // 声明前已有 GBK 字节：按 latin1 读头段才能让声明本身保持可识别。
    const head = Buffer.concat([Buffer.from('<html><head><!--', 'latin1'), Buffer.from(GBK_PHRASE), Buffer.from('--><meta charset="gbk"></head>', 'latin1')])
    expect(charsetFromMeta(head)).toBe('gb18030')
  })
})

describe('decodeBody', () => {
  it('decodes a GBK page through its meta declaration', () => {
    const page = Buffer.concat([Buffer.from('<html><head><meta charset="gbk"></head><body><p>', 'latin1'), Buffer.from(GBK_PHRASE), Buffer.from('</p></body></html>', 'latin1')])
    const result = decodeBody(page, 'text/html')
    expect(result).toMatchObject({ charset: 'gb18030', source: 'meta' })
    expect(result.text).toContain('这是一篇中文文章')
    expect(result.text).not.toContain('\ufffd')
  })

  it('honors the header even when the page declares something else', () => {
    const page = Buffer.concat([Buffer.from('<meta charset="utf-8"><p>', 'latin1'), Buffer.from(GBK_PHRASE), Buffer.from('</p>', 'latin1')])
    const result = decodeBody(page, 'text/html; charset=gbk')
    expect(result).toMatchObject({ charset: 'gb18030', source: 'header' })
    expect(result.text).toContain('这是')
  })

  it('strips the byte-order mark and reports it as the deciding source', () => {
    const result = decodeBody(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes('<p>ok</p>')]), 'text/html; charset=windows-1252')
    expect(result.source).toBe('bom')
    expect(result.charset).toBe('utf-8')
    expect(result.text.startsWith('<p>')).toBe(true)
  })

  it('keeps valid UTF-8 as UTF-8 without scoring candidates', () => {
    const result = decodeBody(bytes('<html><body><p>中文内容</p></body></html>'), 'text/html')
    expect(result).toMatchObject({ charset: 'utf-8', source: 'utf-8' })
  })

  it('infers an undeclared CJK encoding from byte evidence', () => {
    const page = Buffer.concat([Buffer.from('<html><body><p>', 'latin1'), Buffer.from(Array.from({ length: 40 }, () => GBK_PHRASE).flat()), Buffer.from('</p></body></html>', 'latin1')])
    const result = decodeBody(page, 'text/html')
    expect(result.charset).toBe('gb18030')
    expect(result.source).toBe('heuristic')
    expect(result.text).toContain('这是一篇中文文章')
  })

  it('falls back to windows-1252 when no candidate yields real text', () => {
    const result = decodeBody(Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd]), 'application/octet-stream')
    expect(result).toMatchObject({ charset: 'windows-1252', source: 'fallback' })
  })

  it('does not corrupt a page whose declaration names an unsupported charset', () => {
    // 未知声明被丢弃后走 UTF-8 快路径，正文仍可读。
    const result = decodeBody(bytes('<p>中文内容</p>'), 'text/html; charset=x-user-defined')
    expect(result.text).toContain('中文内容')
    expect(result.charset).toBe('utf-8')
  })
})
