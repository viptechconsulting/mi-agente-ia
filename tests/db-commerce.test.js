import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { applyCommerceSchema } from '../db-commerce.js'

describe('db-commerce schema', () => {
  let db

  before(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    // Create base companies table (mirrors db.js)
    db.exec(`
      CREATE TABLE IF NOT EXISTS companies (
        id TEXT PRIMARY KEY,
        name TEXT,
        slug TEXT UNIQUE,
        active INTEGER DEFAULT 1,
        created_at INTEGER,
        config TEXT
      );
    `)
    applyCommerceSchema(db)
  })

  test('adds commerce_pro_enabled column to companies', () => {
    const info = db.prepare("PRAGMA table_info(companies)").all()
    const cols = info.map(c => c.name)
    assert.ok(cols.includes('commerce_pro_enabled'), 'missing commerce_pro_enabled')
    assert.ok(cols.includes('commerce_pro_status'), 'missing commerce_pro_status')
    assert.ok(cols.includes('commerce_pro_source'), 'missing commerce_pro_source')
    assert.ok(cols.includes('stripe_customer_id'), 'missing stripe_customer_id')
    assert.ok(cols.includes('stripe_subscription_id'), 'missing stripe_subscription_id')
    assert.ok(cols.includes('stripe_checkout_session_id'), 'missing stripe_checkout_session_id')
    assert.ok(cols.includes('discovery_call_status'), 'missing discovery_call_status')
    assert.ok(cols.includes('onboarding_status'), 'missing onboarding_status')
  })

  test('creates commerce_stores table', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
    assert.ok(tables.includes('commerce_stores'), 'missing commerce_stores')
  })

  test('creates commerce_products table with allow_backorder', () => {
    const info = db.prepare("PRAGMA table_info(commerce_products)").all()
    const cols = info.map(c => c.name)
    assert.ok(cols.includes('allow_backorder'), 'missing allow_backorder')
    assert.ok(cols.includes('product_url'), 'missing product_url')
    assert.ok(cols.includes('stock_status'), 'missing stock_status')
  })

  test('creates commerce_product_relations table', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
    assert.ok(tables.includes('commerce_product_relations'))
  })

  test('creates commerce_conversations table with contact_id', () => {
    const info = db.prepare("PRAGMA table_info(commerce_conversations)").all()
    const cols = info.map(c => c.name)
    assert.ok(cols.includes('contact_id'), 'missing contact_id')
    assert.ok(cols.includes('purchase_detected'), 'missing purchase_detected')
    assert.ok(cols.includes('recovery_email_sent'), 'missing recovery_email_sent')
  })

  test('creates commerce_coupons table', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
    assert.ok(tables.includes('commerce_coupons'))
  })

  test('applyCommerceSchema is idempotent (safe to run twice)', () => {
    assert.doesNotThrow(() => applyCommerceSchema(db))
  })

  test('commerce_pro_enabled defaults to 0', () => {
    db.prepare("INSERT INTO companies (id, name, slug, active, created_at) VALUES ('test1','Test','test1',1,1)").run()
    const row = db.prepare("SELECT commerce_pro_enabled, commerce_pro_status, discovery_call_status, onboarding_status FROM companies WHERE id='test1'").get()
    assert.equal(row.commerce_pro_enabled, 0)
    assert.equal(row.commerce_pro_status, 'inactive')
    assert.equal(row.discovery_call_status, 'not_required')
    assert.equal(row.onboarding_status, 'not_started')
  })
})
