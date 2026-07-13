import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const softAlter = (db, sql) => { try { db.exec(sql); } catch {} }

export function applyCommerceSchema(db) {
  // ── Extend companies ────────────────────────────────────────────────────────
  softAlter(db, 'ALTER TABLE companies ADD COLUMN commerce_pro_enabled INTEGER DEFAULT 0')
  softAlter(db, "ALTER TABLE companies ADD COLUMN commerce_pro_status TEXT DEFAULT 'inactive'")
  softAlter(db, 'ALTER TABLE companies ADD COLUMN commerce_pro_source TEXT')
  softAlter(db, 'ALTER TABLE companies ADD COLUMN stripe_customer_id TEXT')
  softAlter(db, 'ALTER TABLE companies ADD COLUMN stripe_subscription_id TEXT')
  softAlter(db, 'ALTER TABLE companies ADD COLUMN stripe_checkout_session_id TEXT')
  softAlter(db, "ALTER TABLE companies ADD COLUMN discovery_call_status TEXT DEFAULT 'not_required'")
  softAlter(db, "ALTER TABLE companies ADD COLUMN onboarding_status TEXT DEFAULT 'not_started'")
  softAlter(db, 'ALTER TABLE commerce_stores ADD COLUMN api_key_encrypted TEXT')

  // ── commerce_stores ─────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS commerce_stores (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      store_url TEXT NOT NULL,
      access_token_encrypted TEXT,
      consumer_key_encrypted TEXT,
      consumer_secret_encrypted TEXT,
      sync_status TEXT DEFAULT 'idle',
      last_sync_at INTEGER,
      created_at INTEGER,
      updated_at INTEGER,
      FOREIGN KEY(account_id) REFERENCES companies(id)
    );
  `)

  // ── commerce_products ───────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS commerce_products (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      platform_product_id TEXT,
      platform_variant_id TEXT,
      title TEXT,
      description TEXT,
      short_description TEXT,
      price REAL,
      compare_at_price REAL,
      currency TEXT DEFAULT 'USD',
      sku TEXT,
      stock_status TEXT DEFAULT 'instock',
      inventory_quantity INTEGER,
      product_url TEXT,
      image_url TEXT,
      brand TEXT,
      category TEXT,
      tags TEXT,
      attributes TEXT,
      allow_backorder INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      last_synced_at INTEGER,
      created_at INTEGER,
      updated_at INTEGER,
      FOREIGN KEY(account_id) REFERENCES companies(id),
      FOREIGN KEY(store_id) REFERENCES commerce_stores(id)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS commerce_products_fts USING fts5(
      product_id UNINDEXED,
      account_id UNINDEXED,
      title,
      description,
      category,
      tags,
      tokenize='unicode61 remove_diacritics 2'
    );
  `)

  // ── commerce_product_relations ──────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS commerce_product_relations (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      source_product_id TEXT NOT NULL,
      target_product_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      reason TEXT,
      created_by TEXT DEFAULT 'admin',
      created_at INTEGER,
      updated_at INTEGER
    );
  `)

  // ── commerce_conversations ──────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS commerce_conversations (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      session_id TEXT,
      contact_id TEXT,
      channel TEXT,
      purchase_detected INTEGER DEFAULT 0,
      products_discussed TEXT,
      cart_url TEXT,
      checkout_url TEXT,
      recovery_email_sent INTEGER DEFAULT 0,
      recovery_coupon_code TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
  `)

  // ── commerce_coupons ────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS commerce_coupons (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      store_id TEXT,
      platform_coupon_id TEXT,
      coupon_code TEXT NOT NULL,
      discount_type TEXT,
      discount_value REAL,
      expires_at INTEGER,
      minimum_order_amount REAL,
      usage_limit INTEGER DEFAULT 1,
      contact_id TEXT,
      conversation_id TEXT,
      status TEXT DEFAULT 'created',
      created_at INTEGER,
      updated_at INTEGER
    );
  `)
}

// ── Commerce Pro company helpers ─────────────────────────────────────────────

export function getCommercePro(db, companyId) {
  return db.prepare(`
    SELECT commerce_pro_enabled, commerce_pro_status, commerce_pro_source,
           stripe_customer_id, stripe_subscription_id, stripe_checkout_session_id,
           discovery_call_status, onboarding_status
    FROM companies WHERE id = ?
  `).get(companyId)
}

export function setCommercePro(db, companyId, fields) {
  const allowed = [
    'commerce_pro_enabled', 'commerce_pro_status', 'commerce_pro_source',
    'stripe_customer_id', 'stripe_subscription_id', 'stripe_checkout_session_id',
    'discovery_call_status', 'onboarding_status'
  ]
  const keys = Object.keys(fields).filter(k => allowed.includes(k))
  if (!keys.length) return
  const setClauses = keys.map(k => `${k} = ?`).join(', ')
  const values = keys.map(k => fields[k])
  db.prepare(`UPDATE companies SET ${setClauses} WHERE id = ?`).run(...values, companyId)
}

// ── AES-256-GCM credential encryption ───────────────────────────────────────

export function encryptCredential(plaintext) {
  try {
    const key = process.env.ENCRYPTION_KEY
    if (!key) return null
    const keyBuf = Buffer.from(key, 'hex')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', keyBuf, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, tag, encrypted]).toString('base64')
  } catch { return null }
}

export function decryptCredential(ciphertext) {
  try {
    const key = process.env.ENCRYPTION_KEY
    if (!key || !ciphertext) return null
    const buf = Buffer.from(ciphertext, 'base64')
    const iv = buf.slice(0, 12)
    const tag = buf.slice(12, 28)
    const encrypted = buf.slice(28)
    const keyBuf = Buffer.from(key, 'hex')
    const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv)
    decipher.setAuthTag(tag)
    return decipher.update(encrypted) + decipher.final('utf8')
  } catch { return null }
}
