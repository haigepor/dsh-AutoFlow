import test from 'node:test'
import assert from 'node:assert/strict'
import { createAfpPreviewClient } from '../src/vendor/auto-afp-img/afp-preview-client.mjs'
import { resolveConfig } from '../config-schema.js'

const cdn = 'dysf9nfdw7aab.cloudfront.net'
const image = () => new Response(new Uint8Array([255, 216, 255]), { headers: { 'content-type': 'image/jpeg' } })
const metadata = href => Response.json({ data: { docs: [{ id: 'photo', mockup: [{ href, role: 'Mockup' }] }] } })

test('automatically admits CloudFront supplied by the AFP media redirect without forwarding credentials', async () => {
  const calls = []
  const client = createAfpPreviewClient({ accessToken: 'private-fixture', retries: 0, autoDiscoverCdnHosts: true,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (calls.length === 1) return metadata('mockup-id')
      if (calls.length === 2) return new Response(null, { status: 302, headers: { location: `https://${cdn}/image?signature=private` } })
      return image()
    } })
  const result = await client.getPreviewBytes('photo')
  assert.equal(calls.length, 3)
  assert.equal(new URL(calls[2].url).hostname, cdn)
  assert.equal(calls[2].init.headers.authorization, undefined)
  assert.doesNotMatch(JSON.stringify(result), /signature|private-fixture/)
})

test('uses the matched photo Mockup reference to discover CloudFront and keeps the policy configurable', async () => {
  assert.equal(resolveConfig().previewAutoCdnHosts, true)
  assert.throws(() => resolveConfig({ previewAutoCdnHosts: 'true' }), /previewAutoCdnHosts/)
  for (const autoDiscoverCdnHosts of [false, true]) {
    let calls = 0
    const client = createAfpPreviewClient({ accessToken: 'fixture', retries: 0, autoDiscoverCdnHosts,
      fetchImpl: async (_url, init) => {
        calls++
        if (calls === 1) return metadata(`https://${cdn}/image`)
        assert.equal(init.headers.authorization, undefined)
        return image()
      } })
    if (autoDiscoverCdnHosts) await client.getPreviewBytes('photo')
    else await assert.rejects(client.getPreviewBytes('photo'), error => error.code === 'preview-host-blocked')
    assert.equal(calls, autoDiscoverCdnHosts ? 2 : 1)
  }
})

test('does not learn domains from CDN redirects or unrelated metadata and rejects lookalikes and internal hosts', async () => {
  for (const destination of ['https://cdn.example.test/image', 'https://dabcdefghi.cloudfront.net.attacker.test/image',
    'https://127.0.0.1/image', 'https://localhost/image', `http://${cdn}/image`, `https://user:pass@${cdn}/image`,
    `https://${cdn}:8443/image`]) {
    let calls = 0
    const client = createAfpPreviewClient({ accessToken: 'fixture', retries: 0, autoDiscoverCdnHosts: true,
      fetchImpl: async () => { calls++; return metadata(destination) } })
    await assert.rejects(client.getPreviewBytes('photo'))
    assert.equal(calls, 1)
  }
  let calls = 0
  const client = createAfpPreviewClient({ accessToken: 'fixture', retries: 0, autoDiscoverCdnHosts: true,
    fetchImpl: async () => {
      calls++
      if (calls === 1) return metadata(`https://${cdn}/image`)
      return new Response(null, { status: 302, headers: { location: 'https://danother123.cloudfront.net/image' } })
    } })
  await assert.rejects(client.getPreviewBytes('photo'), error => error.code === 'preview-host-blocked')
  assert.equal(calls, 2)
})
