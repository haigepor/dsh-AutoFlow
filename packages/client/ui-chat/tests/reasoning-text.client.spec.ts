import { describe, expect, it } from 'vitest'
import { reasoningText } from '../src/client/reasoning-text.ts'

describe('reasoning display text', () => {
  it.each([
    '',
    'Ordinary reasoning',
    '普通思考正文',
    '\n  Original text  \n',
    '<note>Original text</note>',
    '<signatureless>Original text</signatureless>',
    'Reasoning mentions <signature>metadata.payload</signature>',
    ' <signature>metadata.payload</signature>\nOriginal text',
  ])('preserves ordinary reasoning %j', (text) => {
    expect(reasoningText(text)).toBe(text)
  })

  it.each([
    '<', '<sig', '<signature', '<signature>',
    '<signature>metadata.payload', '<signature>metadata.payload</sign',
    '<signature>metadata.payload</signature>',
    '<signature>metadata.payload</signature>\r\n\n',
  ])('waits for displayable text while receiving %j', (text) => {
    expect(reasoningText(text)).toBe('')
  })

  it.each([
    ['<signature>metadata.payload</signature>Visible thought', 'Visible thought'],
    ['<signature>metadata.payload</signature>\n\nVisible thought\n\nDetails', 'Visible thought\n\nDetails'],
    ['<signature>metadata.payload</signature>\r\n\r\n普通思考正文  \r\n', '普通思考正文  \r\n'],
    ['<signature>metadata.payload</signature>\n\r\n\n  Original text  \n', '  Original text  \n'],
    ['<signature>metadata.payload</signature>\rOriginal text', '\rOriginal text'],
  ])('preserves the reasoning after a leading signature in %j', (text, expected) => {
    expect(reasoningText(text)).toBe(expected)
  })
})
