/** Keyless wire boundaries for quota gates and safe retry/auth failure details. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAccountUsage, quotaBlocks } from '../src/host/accounts/quota.ts'
import { accountRefusal, failureDetails, retryAtOf } from '../src/host/accounts/failures.ts'

test('upstream held states respect credits and workspace overage while owner policy protects spent windows', () => {
  const now = 1800000000000
  for (const [plan, credits, spend, reason, held] of [
    ['plus', { has_credits: false }, false, 'rate_limit_reached', true],
    ['pro', { has_credits: true, balance: '0' }, true, 'rate_limit_reached', false],
    ['pro', { unlimited: true }, false, 'rate_limit_reached', false],
    ['business', { has_credits: false, overage_limit_reached: false }, false, 'rate_limit_reached', false],
    ['business', { has_credits: false, overage_limit_reached: false }, true, 'rate_limit_reached', true],
    ['business', { has_credits: false, overage_limit_reached: false }, false, 'workspace_owner_usage_limit_reached', true],
    ['team', { has_credits: false, overage_limit_reached: false }, false, 'rate_limit_reached', true],
  ] as const) {
    const usage = parseAccountUsage({ plan_type: plan, credits, spend_control: { reached: spend }, rate_limit_reached_type: { type: reason },
      rate_limit: { allowed: false, primary_window: { used_percent: 100, reset_after_seconds: 3600 } } }, now)
    assert.equal(usage.held, held, `${plan}/${JSON.stringify(credits)}/${reason}`)
    assert.equal(quotaBlocks(usage, true, now), held)
    assert.equal(quotaBlocks({ ...usage, status: 'error', freshness: 'stale' }, false, now), true)
  }
  const percentOnly = parseAccountUsage({ rate_limit: { primary_window: { used_percent: 100, reset_after_seconds: 10 } } }, now)
  assert.equal(quotaBlocks(percentOnly, true, now), false)
  assert.equal(quotaBlocks(percentOnly, false, now + 10001), false)
  assert.equal(quotaBlocks(undefined, false, now), false)
  assert.throws(() => parseAccountUsage({ rate_limit: { primary_window: { used_percent: '100' } } }, now))
})

test('Retry-After accepts seconds and HTTP dates, rejects invalid hints, and never exposes raw bodies or unsafe headers', async () => {
  const now = 1800000000000, date = new Date(now + 120000).toUTCString()
  assert.equal(retryAtOf('120', now), now + 120000); assert.equal(retryAtOf(date, now), now + 120000)
  for (const hint of ['', 'invalid', 'NaN', '-20', '0', '9'.repeat(512), new Date(now - 1000).toUTCString()]) assert.equal(retryAtOf(hint, now), undefined)
  const failure = await accountRefusal(Response.json({ error: { code: 'rate_limit_exceeded', message: 'private token=fixture-secret' } }, { status: 429,
    headers: { 'retry-after': date, 'x-request-id': 'req_safe' } }), now, new AbortController().signal)
  assert.deepEqual(failure.details, { retryAt: now + 120000, requestId: 'req_safe', upstreamCode: 'rate_limit_exceeded' })
  assert.equal(failure.message.includes('fixture-secret'), false)
  const denied = await failureDetails(Response.json({ error: 'refresh_token_invalidated', error_description: 'private' }, { status: 400, headers: { 'x-request-id': 'https://private/?token=secret' } }), now, new AbortController().signal)
  assert.deepEqual(denied, { authCode: 'REFRESH_TOKEN_INVALIDATED' })
  const malformed = await accountRefusal(new Response('not JSON', { status: 402, headers: { 'retry-after': '30' } }), now, new AbortController().signal)
  assert.equal(malformed.status, 402); assert.equal(malformed.details.retryAt, now + 30000)
})
