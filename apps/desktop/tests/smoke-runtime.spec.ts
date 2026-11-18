/** Behavioral checks for the packaged Office smoke probes. */

import { once } from 'node:events'
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { assertOfficeSkillsLoadable, smokeOfficeOperations } from '../scripts/smoke-runtime.ts'

const loadedSkills = [
  { name: 'office', bytes: 772 },
  { name: 'office-docx', bytes: 4543 },
  { name: 'office-pptx', bytes: 5167 },
  { name: 'office-xlsx', bytes: 5611 },
]

describe('assertOfficeSkillsLoadable', () => {
  it('accepts all four Office skills with nonempty bodies and no path', () => {
    expect(() => { assertOfficeSkillsLoadable(loadedSkills) }).not.toThrow()
  })

  it('rejects an unlisted or empty Office skill and reports every result', () => {
    const results = loadedSkills.map(skill => skill.name === 'office-docx' ? { ...skill, bytes: 0 } : skill)
    expect(() => { assertOfficeSkillsLoadable(results) }).toThrow(
      `desktop runtime: packaged Office skills are not loadable: ${JSON.stringify(results)}`,
    )
  })

  it('rejects results missing a bundled Office skill', () => {
    const results = loadedSkills.filter(skill => skill.name !== 'office-xlsx')
    expect(() => { assertOfficeSkillsLoadable(results) }).toThrow(
      `desktop runtime: packaged Office skills are not loadable: ${JSON.stringify(results)}`,
    )
  })

  it('ignores empty results for skills outside the bundled Office set', () => {
    expect(() => { assertOfficeSkillsLoadable([...loadedSkills, { name: 'other', bytes: 0 }]) }).not.toThrow()
  })
})

it.each([
  { name: 'valid Office outputs', broken: false },
  { name: 'XLSX render and ODS output failures', broken: true },
])('checks every Office operation with $name', async ({ broken }) => {
  const paths: string[] = []
  const server = createServer((request, response) => {
    const path = request.url ?? ''
    paths.push(path)
    if (broken && path === '/desktop-smoke-office/xlsx/render-images') {
      response.statusCode = 500
      response.end('LibreOffice image rendering timed out')
    } else if (broken && path === '/desktop-smoke-office/xlsx/to-ods') {
      response.end('invalid ODS output')
    } else if (path.endsWith('/to-pdf')) {
      response.end('%PDF-1.7\n%%EOF\n')
    } else if (path.endsWith('/render-images')) {
      response.end('["89504e470d0a1a0a"]')
    } else {
      response.end(Buffer.from('504b0304', 'hex'))
    }
  })
  try {
    const listening = once(server, 'listening')
    server.listen(0, '127.0.0.1')
    await listening
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Office fixture requires a TCP listener')
    const smoke = smokeOfficeOperations(`http://127.0.0.1:${address.port}`, '', 5_000)
    if (broken) {
      await expect(smoke).rejects.toMatchObject({
        name: 'AggregateError',
        errors: [
          { message: expect.stringContaining('Office xlsx/render-images failed'), cause: { message: expect.stringContaining('LibreOffice image rendering timed out') } },
          { message: expect.stringContaining('Office xlsx/to-ods failed'), cause: { message: 'invalid Office ZIP signature' } },
        ],
      })
    } else {
      await expect(smoke).resolves.toBeUndefined()
    }
    expect(paths).toEqual([
      '/desktop-smoke-office/docx/to-pdf',
      '/desktop-smoke-office/xlsx/to-pdf',
      '/desktop-smoke-office/pptx/to-pdf',
      '/desktop-smoke-office/docx/render-images',
      '/desktop-smoke-office/docx/to-odt',
      '/desktop-smoke-office/xlsx/render-images',
      '/desktop-smoke-office/xlsx/to-ods',
      '/desktop-smoke-office/xlsx/recalculate',
      '/desktop-smoke-office/pptx/render-images',
      '/desktop-smoke-office/pptx/to-odp',
    ])
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    })
  }
})

it.each([
  { name: 'recovers an explicit timeout when the new output is valid', retry: true, firstStatus: 504, secondStatus: 200, secondBody: 'zip', expectedCalls: 2, failure: '' },
  { name: 'still rejects an invalid output after recovery', retry: true, firstStatus: 504, secondStatus: 200, secondBody: 'invalid', expectedCalls: 2, failure: 'invalid Office ZIP signature' },
  { name: 'fails the pass when the recovery attempt times out', retry: true, firstStatus: 504, secondStatus: 504, secondBody: 'timeout', expectedCalls: 2, failure: 'HTTP 504 timeout' },
  { name: 'keeps a timeout outside the recovery lane fatal', retry: false, firstStatus: 504, secondStatus: 200, secondBody: 'zip', expectedCalls: 1, failure: 'HTTP 504 LibreOffice conversion timed out.' },
  { name: 'never retries a different server failure with timeout-like text', retry: true, firstStatus: 500, secondStatus: 200, secondBody: 'zip', expectedCalls: 1, failure: 'HTTP 500 LibreOffice conversion timed out.' },
  { name: 'fails another operation once the pass has used its recovery attempt', retry: true, firstStatus: 504, secondStatus: 200, secondBody: 'zip', expectedCalls: 2, failure: 'HTTP 504 later timeout', laterTimeout: true },
])('$name', async ({ retry, firstStatus, secondStatus, secondBody, expectedCalls, failure, laterTimeout }) => {
  let recalculateCalls = 0
  let odpCalls = 0
  const server = createServer((request, response) => {
    const path = request.url ?? ''
    if (path === '/desktop-smoke-office/xlsx/recalculate') {
      if (++recalculateCalls === 1) {
        response.statusCode = firstStatus
        response.end('LibreOffice conversion timed out.')
      } else {
        response.statusCode = secondStatus
        response.end(secondBody === 'zip' ? Buffer.from('504b0304', 'hex') : secondBody)
      }
    } else if (laterTimeout && path === '/desktop-smoke-office/pptx/to-odp' && ++odpCalls === 1) {
      response.statusCode = 504
      response.end('later timeout')
    } else if (path.endsWith('/to-pdf')) {
      response.end('%PDF-1.7\n%%EOF\n')
    } else if (path.endsWith('/render-images')) {
      response.end('["89504e470d0a1a0a"]')
    } else {
      response.end(Buffer.from('504b0304', 'hex'))
    }
  })
  try {
    const listening = once(server, 'listening')
    server.listen(0, '127.0.0.1')
    await listening
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Office fixture requires a TCP listener')
    const smoke = smokeOfficeOperations(`http://127.0.0.1:${address.port}`, '', 5_000, retry)
    if (failure) {
      await expect(smoke).rejects.toMatchObject({
        name: 'AggregateError',
        errors: [{ message: expect.stringContaining(laterTimeout ? 'Office pptx/to-odp failed' : 'Office xlsx/recalculate failed'), cause: { message: failure } }],
      })
    } else {
      await expect(smoke).resolves.toBeUndefined()
    }
    expect(recalculateCalls).toBe(expectedCalls)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    })
  }
})
