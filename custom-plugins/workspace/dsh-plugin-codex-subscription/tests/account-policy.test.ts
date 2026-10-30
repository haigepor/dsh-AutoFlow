/** Keyless wire boundaries for quota gates and safe retry/auth failure details. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAccountUsage, quotaBlocks } from '../src/host/accounts/quota.ts'
import { accountRefusal, failureDetails, retryAtOf } from '../src/host/accounts/failures.ts'

test('Team usage keeps both allowance windows when the upstream credit balance is null', () => {
  const now = 1800000000000
  const usage = parseAccountUsage({ plan_type: 'team',
    rate_limit: { allowed: true, primary_window: { used_percent: 28, limit_window_seconds: 18000, reset_after_seconds: 120 },
      secondary_window: { used_percent: 64, limit_window_seconds: 604800, reset_after_seconds: 3600 } },
    credits: { has_credits: true, unlimited: false, balance: null, overage_limit_reached: false },
    spend_control: null, rate_limit_reached_type: { type: null }, rate_limit_reset_credits: null,
  }, now)
  assert.equal(usage.status, 'ready')
  assert.deepEqual(usage.primary, { usedPercent: 28, windowSeconds: 18000, resetAt: now + 120000 })
  assert.deepEqual(usage.secondary, { usedPercent: 64, windowSeconds: 604800, resetAt: now + 3600000 })
  assert.deepEqual(usage.credits, { hasCredits: true, unlimited: false, overageLimitReached: false, usable: true })
  assert.equal(usage.limitReason, undefined)
  assert.equal(quotaBlocks(usage, false, now), false)
  const spent = parseAccountUsage({ rate_limit: { allowed: false, primary_window: { used_percent: 100, reset_after_seconds: 120 } },
    credits: null, spend_control: { reached: true }, rate_limit_reached_type: null }, now)
  assert.equal(quotaBlocks(spent, false, now), true)
})

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

test('Plus, Pro, Business and reserve plans preserve reported windows with empty balances and leave unknown allowance unknown', () => {
  const now = 1800000000000
  for (const plan of ['plus', 'pro', 'business', 'team', 'self_serve_business_prolite']) {
    for (const balance of [null, '', undefined]) {
      const usage = parseAccountUsage({ plan_type: plan, credits: { has_credits: true, balance },
        rate_limit: { primary_window: { used_percent: 17, limit_window_seconds: 18000, reset_after_seconds: 120 },
          secondary_window: { used_percent: 61, limit_window_seconds: 604800, reset_after_seconds: 3600 } } }, now)
      assert.equal(usage.plan, plan)
      assert.deepEqual(usage.primary, { usedPercent: 17, windowSeconds: 18000, resetAt: now + 120000 }, plan)
      assert.deepEqual(usage.secondary, { usedPercent: 61, windowSeconds: 604800, resetAt: now + 3600000 }, plan)
      assert.equal(quotaBlocks(usage, false, now), false, plan)
    }
    const unknown = parseAccountUsage({ plan_type: plan, rate_limit: { primary_window: null, secondary_window: null }, credits: null }, now)
    assert.equal(unknown.primary, undefined, plan); assert.equal(unknown.secondary, undefined, plan)
    assert.equal(unknown.credits, undefined, plan); assert.equal(unknown.held, false, plan)
    assert.equal(quotaBlocks(unknown, false, now), false, plan)
  }
})

test('allowed and credit flags take precedence over spend and workspace limits without bypassing an owner-disabled full window', () => {
  const now = 1800000000000
  for (const plan of ['plus', 'pro', 'business', 'team', 'self_serve_business_prolite']) {
    for (const [allowed, has, unlimited, held] of [
      [undefined, false, false, false], [true, false, false, false], [false, true, false, false],
      [false, false, true, false], [false, false, false, true], [null, false, false, false],
    ] as const) {
      const usage = parseAccountUsage({ plan_type: plan,
        credits: { has_credits: has, unlimited, balance: null, overage_limit_reached: true }, spend_control: { reached: true },
        rate_limit_reached_type: { type: 'workspace_owner_usage_limit_reached' },
        rate_limit: { allowed, primary_window: { used_percent: 17, reset_after_seconds: 120 }, secondary_window: { used_percent: 100, reset_after_seconds: 3600 } } }, now)
      const label = `${plan}/allowed=${allowed}/has=${has}/unlimited=${unlimited}`
      assert.equal(usage.held, held, label); assert.equal(quotaBlocks(usage, true, now), held, label)
      assert.equal(quotaBlocks(usage, false, now), true, label)
    }
  }
})

test('workspace overage requires a known open organization limit and excludes both reserve plans', () => {
  const now = 1800000000000
  for (const [plan, overageReached, held] of [
    ['business', false, false], ['Business', false, false], ['self_serve_business_usage_based', false, false],
    ['team', false, true], ['self_serve_business_prolite', false, true], ['plus', false, true], ['pro', false, true],
    ['business', true, true], ['business', undefined, true], ['business', null, true],
  ] as const) {
    const usage = parseAccountUsage({ plan_type: plan, credits: { has_credits: false, unlimited: false, overage_limit_reached: overageReached },
      spend_control: null, rate_limit_reached_type: { type: null },
      rate_limit: { allowed: false, primary_window: { used_percent: 100, reset_after_seconds: 3600 } } }, now)
    const label = `${plan}/overageReached=${overageReached}`
    assert.equal(usage.held, held, label); assert.equal(quotaBlocks(usage, true, now), held, label)
    assert.equal(usage.primary?.usedPercent, 100, label)
    assert.equal(quotaBlocks(usage, false, now), true, label)
  }
})

test('credit usability distinguishes spent numeric balances from unknown balances without changing the held gate', () => {
  const now = 1800000000000
  for (const [label, credits, usable] of [
    ['positive string', { has_credits: true, balance: ' 12.5 ' }, true],
    ['positive number', { has_credits: true, balance: 12.5 }, true],
    ['zero string', { has_credits: true, balance: '0' }, false],
    ['zero number', { has_credits: true, balance: 0 }, false],
    ['negative balance', { has_credits: true, balance: '-1' }, false],
    ['null balance', { has_credits: true, balance: null }, true],
    ['missing balance', { has_credits: true }, true],
    ['empty balance', { has_credits: true, balance: '' }, true],
    ['blank balance', { has_credits: true, balance: '   ' }, true],
    ['unreadable balance', { has_credits: true, balance: 'not-reported' }, true],
    ['unlimited overrides balance and has', { has_credits: false, unlimited: true, balance: '0' }, true],
    ['has false overrides positive balance', { has_credits: false, balance: '12.5' }, false],
    ['has unknown with positive balance', { balance: '12.5' }, false],
  ] as const) {
    for (const plan of ['plus', 'pro', 'business', 'team', 'self_serve_business_prolite']) {
      const usage = parseAccountUsage({ plan_type: plan, credits,
        rate_limit: { allowed: false, primary_window: { used_percent: 100, reset_after_seconds: 3600 } } }, now)
      assert.equal(usage.credits?.usable, usable, `${plan}/${label}`)
      const held = !('has_credits' in credits && credits.has_credits) && !('unlimited' in credits && credits.unlimited)
      assert.equal(usage.held, held, `${plan}/${label}`)
      assert.equal(quotaBlocks(usage, true, now), held, `${plan}/${label}`)
      assert.equal(quotaBlocks(usage, false, now), true, `${plan}/${label}`)
    }
  }
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
