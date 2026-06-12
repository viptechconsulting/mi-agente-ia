import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { generateCouponCode, buildCouponDbRecord } from '../services/coupons.js'
import { buildRecoveryEmail, getEligibleConversations } from '../services/recovery.js'
import Database from 'better-sqlite3'
import { applyCommerceSchema } from '../db-commerce.js'

describe('coupons service', () => {
  test('generateCouponCode with name', () => {
    const code = generateCouponCode('Maria Lopez')
    assert.ok(code.startsWith('LYNKRO-MARIA-'), `expected LYNKRO-MARIA-xxx got ${code}`)
    assert.ok(/^LYNKRO-[A-Z]+-[A-Z0-9]{4}$/.test(code), `format wrong: ${code}`)
  })

  test('generateCouponCode without name', () => {
    const code = generateCouponCode(null)
    assert.ok(code.startsWith('LYNKRO-'), `expected LYNKRO- prefix got ${code}`)
    assert.ok(/^LYNKRO-[A-Z0-9]{8}$/.test(code), `no-name format wrong: ${code}`)
  })

  test('generateCouponCode strips non-alpha from name', () => {
    const code = generateCouponCode('José 123')
    assert.ok(/^LYNKRO-[A-Z]+-[A-Z0-9]{4}$/.test(code))
  })

  test('buildCouponDbRecord returns correct structure', () => {
    const rec = buildCouponDbRecord('acc-1', 'store-1', 'woocommerce', 'LYNKRO-TEST-ABCD', {
      recovery_coupon_discount_type: 'percent',
      recovery_coupon_discount_value: 10,
      recovery_coupon_expiration_hours: 48,
      recovery_coupon_minimum_order_amount: null,
      recovery_coupon_usage_limit: 1
    })
    assert.strictEqual(rec.coupon_code, 'LYNKRO-TEST-ABCD')
    assert.strictEqual(rec.discount_type, 'percent')
    assert.strictEqual(rec.discount_value, 10)
    assert.strictEqual(rec.usage_limit, 1)
    assert.ok(rec.expires_at > Date.now())
    assert.strictEqual(rec.status, 'created')
  })
})

describe('recovery service', () => {
  test('buildRecoveryEmail returns subject and html', () => {
    const email = buildRecoveryEmail({
      leadName: 'Ana',
      products: [{ title: 'Blue T-Shirt', price: 25, currency: 'USD', product_url: 'https://test.com/blue' }],
      couponCode: 'LYNKRO-ANA-TEST',
      expirationDate: '20/06/2026',
      storeUrl: 'https://mystore.com'
    })
    assert.ok(email.subject.includes('Ana'))
    assert.ok(email.html.includes('LYNKRO-ANA-TEST'))
    assert.ok(email.html.includes('Blue T-Shirt'))
    assert.ok(email.html.includes('https://test.com/blue'))
    assert.ok(typeof email.text === 'string')
  })

  test('buildRecoveryEmail without coupon omits coupon block', () => {
    const email = buildRecoveryEmail({
      leadName: 'Juan',
      products: [{ title: 'Jeans', price: 50, currency: 'USD', product_url: 'https://test.com/jeans' }],
      couponCode: null,
      expirationDate: null,
      storeUrl: 'https://mystore.com'
    })
    assert.ok(!email.html.includes('código'))
    assert.ok(email.html.includes('Jeans'))
  })

  test('getEligibleConversations returns idle conversations', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY, company_id TEXT, lead_email TEXT, lead_name TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE commerce_conversations (id TEXT PRIMARY KEY, account_id TEXT, session_id TEXT, contact_id TEXT, products_discussed TEXT, purchase_detected INTEGER DEFAULT 0, recovery_email_sent INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE companies (id TEXT PRIMARY KEY, name TEXT, slug TEXT, active INTEGER DEFAULT 1, config TEXT DEFAULT '{}', created_at INTEGER, expires_at INTEGER, commerce_pro_enabled INTEGER DEFAULT 1, commerce_pro_status TEXT DEFAULT 'active', commerce_pro_source TEXT, stripe_customer_id TEXT, stripe_subscription_id TEXT, stripe_checkout_session_id TEXT, discovery_call_status TEXT DEFAULT 'not_required', onboarding_status TEXT DEFAULT 'not_started');
    `)
    const twoHoursAgo = Date.now() - 2 * 3600_000
    db.prepare("INSERT INTO companies (id, name, slug) VALUES ('acc', 'Test', 'test')").run()
    db.prepare("INSERT INTO conversations (id, company_id, lead_email, created_at, updated_at) VALUES ('conv1', 'acc', 'user@test.com', ?, ?)").run(twoHoursAgo, twoHoursAgo)
    db.prepare("INSERT INTO commerce_conversations (id, account_id, session_id, contact_id, products_discussed, purchase_detected, recovery_email_sent, created_at, updated_at) VALUES ('cc1', 'acc', 'conv1', 'user@test.com', '[\"p1\"]', 0, 0, ?, ?)").run(twoHoursAgo, twoHoursAgo)
    const eligible = getEligibleConversations(db)
    assert.ok(Array.isArray(eligible))
    assert.ok(eligible.length >= 1)
    assert.strictEqual(eligible[0].contact_id, 'user@test.com')
    db.close()
  })

  test('getEligibleConversations excludes already-sent', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY, company_id TEXT, lead_email TEXT, lead_name TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE commerce_conversations (id TEXT PRIMARY KEY, account_id TEXT, session_id TEXT, contact_id TEXT, products_discussed TEXT, purchase_detected INTEGER DEFAULT 0, recovery_email_sent INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE companies (id TEXT PRIMARY KEY, name TEXT, slug TEXT, active INTEGER DEFAULT 1, config TEXT DEFAULT '{}', created_at INTEGER, expires_at INTEGER, commerce_pro_enabled INTEGER DEFAULT 1, commerce_pro_status TEXT DEFAULT 'active', commerce_pro_source TEXT, stripe_customer_id TEXT, stripe_subscription_id TEXT, stripe_checkout_session_id TEXT, discovery_call_status TEXT DEFAULT 'not_required', onboarding_status TEXT DEFAULT 'not_started');
    `)
    const twoHoursAgo = Date.now() - 2 * 3600_000
    db.prepare("INSERT INTO companies (id, name, slug) VALUES ('acc', 'Test', 'test')").run()
    db.prepare("INSERT INTO conversations (id, company_id, lead_email, created_at, updated_at) VALUES ('c1', 'acc', 'user@test.com', ?, ?)").run(twoHoursAgo, twoHoursAgo)
    db.prepare("INSERT INTO commerce_conversations (id, account_id, session_id, contact_id, products_discussed, purchase_detected, recovery_email_sent, created_at, updated_at) VALUES ('cc1', 'acc', 'c1', 'user@test.com', '[\"p1\"]', 0, 1, ?, ?)").run(twoHoursAgo, twoHoursAgo)
    const eligible = getEligibleConversations(db)
    assert.strictEqual(eligible.length, 0)
    db.close()
  })
})
