# Lynkro Commerce Pro — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Shopify and WooCommerce store connection, paginated product sync (with FTS5 indexing), real-time product webhooks, and order webhooks for purchase detection.

**Architecture:** Three new modules — `services/shopify.js`, `services/woocommerce.js`, and `routes/commerce.js`. Store credentials encrypted with AES-256-GCM before saving to SQLite. Sync logic is shared via a `syncProductsToDb(db, accountId, storeId, products)` helper. All commerce endpoints protected by `requireCommercePro`.

**Tech Stack:** Node.js ESM, Express, better-sqlite3, built-in `crypto` (AES-256-GCM), node:test

**Spec:** `docs/superpowers/specs/2026-06-12-lynkro-commerce-pro-design.md` — Sections 7, 11, 12, 13

**Phase 1 baseline tag:** `phase1-commerce-pro`

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Modify | `db-commerce.js` | Add `encryptCredential` / `decryptCredential` helpers |
| Create | `services/shopify.js` | Fetch + normalize Shopify products; HMAC verification |
| Create | `services/woocommerce.js` | Fetch + normalize WooCommerce products; signature verification |
| Create | `routes/commerce.js` | All `/api/commerce/*` endpoints |
| Modify | `server.js` | Mount `commerceRouter` |
| Modify | `.env.example` | Add `ENCRYPTION_KEY`, `SHOPIFY_WEBHOOK_SECRET`, `WOOCOMMERCE_WEBHOOK_SECRET` |
| Create | `tests/commerce.test.js` | Tests for crypto helpers, normalizers, commerce routes |

---

## Task 1: Encryption helpers in db-commerce.js

**Files:**
- Modify: `db-commerce.js`
- Create: `tests/commerce.test.js` (first tests)

- [ ] **Step 1: Write failing tests**

Create `tests/commerce.test.js`:

```js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

describe('credential encryption', () => {
  before(() => {
    // Use a test key — 32 bytes hex
    process.env.ENCRYPTION_KEY = 'a'.repeat(64)
  })

  test('encryptCredential returns base64 string', async () => {
    const { encryptCredential } = await import('../db-commerce.js')
    const result = encryptCredential('my-secret-token')
    assert.equal(typeof result, 'string')
    assert.ok(result.length > 20)
  })

  test('decryptCredential round-trips correctly', async () => {
    const { encryptCredential, decryptCredential } = await import('../db-commerce.js')
    const plain = 'shopify-access-token-abc123'
    const cipher = encryptCredential(plain)
    const decoded = decryptCredential(cipher)
    assert.equal(decoded, plain)
  })

  test('encryptCredential returns null when ENCRYPTION_KEY not set', async () => {
    const saved = process.env.ENCRYPTION_KEY
    delete process.env.ENCRYPTION_KEY
    const { encryptCredential } = await import('../db-commerce.js')
    const result = encryptCredential('secret')
    assert.equal(result, null)
    process.env.ENCRYPTION_KEY = saved
  })

  test('decryptCredential returns null on invalid ciphertext', async () => {
    const { decryptCredential } = await import('../db-commerce.js')
    const result = decryptCredential('not-valid-base64-gcm')
    assert.equal(result, null)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd /root/mi-agente-ia
npm test 2>&1 | tail -8
```

Expected: 4 new failures (`encryptCredential is not a function`). 21 existing tests still pass.

- [ ] **Step 3: Add encryption helpers to db-commerce.js**

Append at the bottom of `db-commerce.js` (after `setCommercePro`):

```js
// ── AES-256-GCM credential encryption ───────────────────────────────────────
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export function encryptCredential(plaintext) {
  try {
    const key = process.env.ENCRYPTION_KEY
    if (!key) return null
    const keyBuf = Buffer.from(key, 'hex')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', keyBuf, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    // Format: iv(12) + tag(16) + ciphertext, base64-encoded
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /root/mi-agente-ia
npm test 2>&1 | tail -8
```

Expected: 25 total tests, 25 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
cd /root/mi-agente-ia
git add db-commerce.js tests/commerce.test.js
git commit -m "feat: add AES-256-GCM credential encryption to db-commerce.js"
```

---

## Task 2: Shopify service

**Files:**
- Create: `services/shopify.js`
- Modify: `tests/commerce.test.js` (add normalizer tests)

- [ ] **Step 1: Append normalizer tests to `tests/commerce.test.js`**

```js

describe('shopify normalizer', () => {
  test('normalizeShopifyProduct maps fields correctly', async () => {
    const { normalizeShopifyProduct } = await import('../services/shopify.js')
    const product = {
      id: 123,
      variants: [{ id: 456, price: '29.99', compare_at_price: '39.99', sku: 'SKU1', inventory_quantity: 10 }],
      title: 'Test Product',
      body_html: '<p>Description</p>',
      vendor: 'Acme',
      product_type: 'Shirts',
      tags: 'cotton,blue',
      handle: 'test-product',
      images: [{ src: 'https://img.com/test.jpg' }]
    }
    const result = normalizeShopifyProduct(product, 'https://mystore.myshopify.com', 'store_id_1')
    assert.equal(result.platform_product_id, '123')
    assert.equal(result.platform_variant_id, '456')
    assert.equal(result.title, 'Test Product')
    assert.equal(result.price, 29.99)
    assert.equal(result.compare_at_price, 39.99)
    assert.equal(result.sku, 'SKU1')
    assert.equal(result.inventory_quantity, 10)
    assert.equal(result.stock_status, 'instock')
    assert.equal(result.brand, 'Acme')
    assert.equal(result.category, 'Shirts')
    assert.ok(result.product_url.includes('test-product'))
    assert.equal(result.image_url, 'https://img.com/test.jpg')
    assert.equal(result.store_id, 'store_id_1')
  })

  test('normalizeShopifyProduct sets outofstock when quantity is 0', async () => {
    const { normalizeShopifyProduct } = await import('../services/shopify.js')
    const product = {
      id: 789, variants: [{ id: 1, price: '10', inventory_quantity: 0 }],
      title: 'OOS Product', body_html: '', vendor: '', product_type: '', tags: '', handle: 'oos', images: []
    }
    const result = normalizeShopifyProduct(product, 'https://mystore.myshopify.com', 's1')
    assert.equal(result.stock_status, 'outofstock')
  })

  test('verifyShopifyWebhook returns true for correct HMAC', async () => {
    const { verifyShopifyWebhook } = await import('../services/shopify.js')
    const crypto = await import('node:crypto')
    const secret = 'test-secret'
    const body = Buffer.from('{"id":1}')
    const hmac = crypto.createHmac('sha256', secret).update(body).digest('base64')
    assert.equal(verifyShopifyWebhook(body, hmac, secret), true)
  })

  test('verifyShopifyWebhook returns false for wrong HMAC', async () => {
    const { verifyShopifyWebhook } = await import('../services/shopify.js')
    assert.equal(verifyShopifyWebhook(Buffer.from('payload'), 'wrong', 'secret'), false)
  })
})
```

- [ ] **Step 2: Run tests to verify new ones fail**

```bash
cd /root/mi-agente-ia
npm test 2>&1 | tail -8
```

Expected: 4 new failures for `services/shopify.js`.

- [ ] **Step 3: Create `services/shopify.js`**

```js
// services/shopify.js
import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifyShopifyWebhook(rawBody, hmacHeader, secret) {
  try {
    const expected = createHmac('sha256', secret).update(rawBody).digest('base64')
    const a = Buffer.from(hmacHeader || '', 'base64')
    const b = Buffer.from(expected, 'base64')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch { return false }
}

export function normalizeShopifyProduct(product, storeUrl, storeId) {
  const variant = product.variants?.[0] || {}
  const qty = variant.inventory_quantity ?? 0
  const stock_status = qty > 0 ? 'instock' : 'outofstock'
  return {
    store_id: storeId,
    platform_product_id: String(product.id),
    platform_variant_id: String(variant.id || ''),
    title: product.title || '',
    description: (product.body_html || '').replace(/<[^>]+>/g, '').trim(),
    short_description: '',
    price: parseFloat(variant.price || 0),
    compare_at_price: variant.compare_at_price ? parseFloat(variant.compare_at_price) : null,
    currency: 'USD',
    sku: variant.sku || '',
    stock_status,
    inventory_quantity: qty,
    product_url: `${storeUrl}/products/${product.handle}`,
    image_url: product.images?.[0]?.src || '',
    brand: product.vendor || '',
    category: product.product_type || '',
    tags: JSON.stringify((product.tags || '').split(',').map(t => t.trim()).filter(Boolean)),
    attributes: JSON.stringify({}),
    allow_backorder: 0,
    is_active: 1
  }
}

/**
 * Fetch all products from a Shopify store using cursor-based pagination.
 * @returns {Promise<Array>} normalized product objects
 */
export async function fetchShopifyProducts(storeUrl, accessToken, storeId) {
  const products = []
  let url = `${storeUrl}/admin/api/2024-01/products.json?limit=250&fields=id,title,body_html,vendor,product_type,handle,tags,images,variants`
  let pageInfo = null

  while (url) {
    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': accessToken }
    })
    if (!res.ok) throw new Error(`Shopify API error: ${res.status} ${await res.text()}`)
    const data = await res.json()
    for (const p of data.products || []) {
      products.push(normalizeShopifyProduct(p, storeUrl, storeId))
    }

    // Parse Link header for next page
    const link = res.headers.get('link') || ''
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/)
    url = nextMatch ? nextMatch[1] : null
  }

  return products
}
```

- [ ] **Step 4: Run all tests**

```bash
cd /root/mi-agente-ia
npm test 2>&1 | tail -8
```

Expected: 29 tests, 29 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
cd /root/mi-agente-ia
git add services/shopify.js tests/commerce.test.js
git commit -m "feat: add Shopify service (product fetch, normalize, webhook verify)"
```

---

## Task 3: WooCommerce service

**Files:**
- Create: `services/woocommerce.js`
- Modify: `tests/commerce.test.js` (add WooCommerce tests)

- [ ] **Step 1: Append WooCommerce tests to `tests/commerce.test.js`**

```js

describe('woocommerce normalizer', () => {
  test('normalizeWooProduct maps fields correctly', async () => {
    const { normalizeWooProduct } = await import('../services/woocommerce.js')
    const product = {
      id: 42,
      name: 'WC Product',
      description: '<p>Desc</p>',
      short_description: 'Short',
      regular_price: '49.99',
      sale_price: '39.99',
      sku: 'WC-SKU',
      stock_status: 'instock',
      stock_quantity: 5,
      permalink: 'https://mysite.com/product/wc-product',
      images: [{ src: 'https://img.com/wc.jpg' }],
      categories: [{ name: 'Tops' }],
      tags: [{ name: 'sale' }, { name: 'cotton' }],
      attributes: [],
      manage_stock: true,
      backorders: 'no'
    }
    const result = normalizeWooProduct(product, 'store_id_2')
    assert.equal(result.platform_product_id, '42')
    assert.equal(result.title, 'WC Product')
    assert.equal(result.price, 39.99)
    assert.equal(result.compare_at_price, 49.99)
    assert.equal(result.sku, 'WC-SKU')
    assert.equal(result.stock_status, 'instock')
    assert.equal(result.category, 'Tops')
    assert.equal(result.image_url, 'https://img.com/wc.jpg')
    assert.equal(result.store_id, 'store_id_2')
    assert.equal(result.allow_backorder, 0)
  })

  test('normalizeWooProduct sets allow_backorder when backorders=yes', async () => {
    const { normalizeWooProduct } = await import('../services/woocommerce.js')
    const p = {
      id: 1, name: 'P', description: '', short_description: '', regular_price: '10',
      sale_price: '', sku: '', stock_status: 'onbackorder', stock_quantity: 0,
      permalink: 'https://site.com/p', images: [], categories: [], tags: [],
      attributes: [], manage_stock: false, backorders: 'yes'
    }
    const result = normalizeWooProduct(p, 's1')
    assert.equal(result.allow_backorder, 1)
    assert.equal(result.stock_status, 'backorder')
  })

  test('verifyWooWebhook returns true for correct signature', async () => {
    const { verifyWooWebhook } = await import('../services/woocommerce.js')
    const crypto = await import('node:crypto')
    const secret = 'woo-secret'
    const body = Buffer.from('{"id":1}')
    const sig = crypto.createHmac('sha256', secret).update(body).digest('base64')
    assert.equal(verifyWooWebhook(body, sig, secret), true)
  })
})
```

- [ ] **Step 2: Run tests to verify new ones fail**

```bash
cd /root/mi-agente-ia
npm test 2>&1 | tail -8
```

Expected: 3 new failures for `services/woocommerce.js`.

- [ ] **Step 3: Create `services/woocommerce.js`**

```js
// services/woocommerce.js
import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifyWooWebhook(rawBody, signatureHeader, secret) {
  try {
    const expected = createHmac('sha256', secret).update(rawBody).digest('base64')
    const a = Buffer.from(signatureHeader || '', 'base64')
    const b = Buffer.from(expected, 'base64')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch { return false }
}

export function normalizeWooProduct(product, storeId) {
  const price = parseFloat(product.sale_price || product.regular_price || 0)
  const compare = product.sale_price && product.regular_price
    ? parseFloat(product.regular_price)
    : null
  const backorder = product.backorders === 'yes' || product.backorders === 'notify'
  const stock_status = product.stock_status === 'onbackorder' ? 'backorder'
    : product.stock_status === 'instock' ? 'instock'
    : 'outofstock'

  return {
    store_id: storeId,
    platform_product_id: String(product.id),
    platform_variant_id: '',
    title: product.name || '',
    description: (product.description || '').replace(/<[^>]+>/g, '').trim(),
    short_description: (product.short_description || '').replace(/<[^>]+>/g, '').trim(),
    price,
    compare_at_price: compare,
    currency: 'USD',
    sku: product.sku || '',
    stock_status,
    inventory_quantity: product.stock_quantity ?? null,
    product_url: product.permalink || '',
    image_url: product.images?.[0]?.src || '',
    brand: '',
    category: product.categories?.[0]?.name || '',
    tags: JSON.stringify((product.tags || []).map(t => t.name)),
    attributes: JSON.stringify((product.attributes || []).reduce((acc, a) => {
      acc[a.name] = a.options; return acc
    }, {})),
    allow_backorder: backorder ? 1 : 0,
    is_active: 1
  }
}

/**
 * Fetch all products from a WooCommerce store using page-based pagination.
 * Uses Basic Auth (consumer_key:consumer_secret).
 * @returns {Promise<Array>} normalized product objects
 */
export async function fetchWooProducts(storeUrl, consumerKey, consumerSecret, storeId) {
  const products = []
  let page = 1
  const PER_PAGE = 100
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')

  while (true) {
    const url = `${storeUrl}/wp-json/wc/v3/products?per_page=${PER_PAGE}&page=${page}&status=publish`
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } })
    if (!res.ok) throw new Error(`WooCommerce API error: ${res.status} ${await res.text()}`)
    const data = await res.json()
    if (!data.length) break
    for (const p of data) {
      products.push(normalizeWooProduct(p, storeId))
    }
    if (data.length < PER_PAGE) break
    page++
  }

  return products
}
```

- [ ] **Step 4: Run all tests**

```bash
cd /root/mi-agente-ia
npm test 2>&1 | tail -8
```

Expected: 32 tests, 32 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
cd /root/mi-agente-ia
git add services/woocommerce.js tests/commerce.test.js
git commit -m "feat: add WooCommerce service (product fetch, normalize, webhook verify)"
```

---

## Task 4: Commerce routes

**Files:**
- Create: `routes/commerce.js`

This file provides all `/api/commerce/*` endpoints. All routes require `requireCommercePro` (from `middleware/commerce.js`). Uses `encryptCredential` / `decryptCredential` from `db-commerce.js`.

- [ ] **Step 1: Create `routes/commerce.js`**

```js
// routes/commerce.js
import express from 'express'
import { db } from '../db.js'
import { requireAdmin, withCompany } from '../middleware/auth.js'
import { requireCommercePro } from '../middleware/commerce.js'
import {
  setCommercePro, encryptCredential, decryptCredential
} from '../db-commerce.js'
import { fetchShopifyProducts, verifyShopifyWebhook } from '../services/shopify.js'
import { fetchWooProducts, verifyWooWebhook } from '../services/woocommerce.js'

export const commerceRouter = express.Router()

// All commerce routes require admin + company resolution + Commerce Pro gate
commerceRouter.use(requireAdmin, withCompany, requireCommercePro)

// ── Sync helper ───────────────────────────────────────────────────────────────

function syncProductsToDb(accountId, storeId, products) {
  const now = Date.now()
  const upsert = db.prepare(`
    INSERT INTO commerce_products (
      id, account_id, store_id, platform_product_id, platform_variant_id,
      title, description, short_description, price, compare_at_price,
      currency, sku, stock_status, inventory_quantity, product_url,
      image_url, brand, category, tags, attributes, allow_backorder,
      is_active, last_synced_at, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, description=excluded.description,
      short_description=excluded.short_description,
      price=excluded.price, compare_at_price=excluded.compare_at_price,
      sku=excluded.sku, stock_status=excluded.stock_status,
      inventory_quantity=excluded.inventory_quantity,
      product_url=excluded.product_url, image_url=excluded.image_url,
      brand=excluded.brand, category=excluded.category,
      tags=excluded.tags, attributes=excluded.attributes,
      allow_backorder=excluded.allow_backorder,
      is_active=1, last_synced_at=excluded.last_synced_at, updated_at=excluded.updated_at
  `)

  const ftsDelete = db.prepare(`DELETE FROM commerce_products_fts WHERE product_id = ?`)
  const ftsInsert = db.prepare(`
    INSERT INTO commerce_products_fts (product_id, account_id, title, description, category, tags)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  const syncMany = db.transaction((products) => {
    const ids = []
    for (const p of products) {
      const id = `${accountId}_${p.store_id}_${p.platform_product_id}`
      upsert.run(
        id, accountId, p.store_id, p.platform_product_id, p.platform_variant_id,
        p.title, p.description, p.short_description, p.price, p.compare_at_price,
        p.currency || 'USD', p.sku, p.stock_status, p.inventory_quantity,
        p.product_url, p.image_url, p.brand, p.category, p.tags, p.attributes,
        p.allow_backorder || 0, now, now, now
      )
      ftsDelete.run(id)
      ftsInsert.run(id, accountId, p.title, p.description, p.category, p.tags)
      ids.push(id)
    }
    return ids
  })

  const syncedIds = syncMany(products)

  // Mark products not in this sync as inactive
  if (syncedIds.length > 0) {
    const placeholders = syncedIds.map(() => '?').join(',')
    db.prepare(`
      UPDATE commerce_products SET is_active = 0, updated_at = ?
      WHERE account_id = ? AND store_id = ? AND id NOT IN (${placeholders})
    `).run(now, accountId, storeId, ...syncedIds)
  }

  return syncedIds.length
}

// ── POST /api/commerce/stores/connect-shopify ─────────────────────────────────
commerceRouter.post('/stores/connect-shopify', async (req, res) => {
  try {
    const { store_url, access_token } = req.body || {}
    if (!store_url || !access_token) {
      return res.status(400).json({ error: 'store_url y access_token requeridos' })
    }
    const accountId = req.company.id
    const encrypted = encryptCredential(access_token)
    if (!encrypted) {
      return res.status(500).json({ error: 'ENCRYPTION_KEY no configurado' })
    }
    const id = `${accountId}_shopify_${Date.now()}`
    const now = Date.now()
    db.prepare(`
      INSERT INTO commerce_stores (id, account_id, platform, store_url, access_token_encrypted, sync_status, created_at, updated_at)
      VALUES (?, ?, 'shopify', ?, ?, 'idle', ?, ?)
      ON CONFLICT(id) DO UPDATE SET store_url=excluded.store_url, access_token_encrypted=excluded.access_token_encrypted, updated_at=excluded.updated_at
    `).run(id, accountId, store_url.replace(/\/$/, ''), encrypted, now, now)

    res.json({ ok: true, store_id: id })

    // Trigger immediate background sync
    syncStore(id, accountId, 'shopify', store_url.replace(/\/$/, ''), access_token, null, null)
      .catch(err => console.error('[commerce] initial sync error:', err))
  } catch (err) {
    console.error('[commerce] connect-shopify error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ── POST /api/commerce/stores/connect-woocommerce ────────────────────────────
commerceRouter.post('/stores/connect-woocommerce', async (req, res) => {
  try {
    const { store_url, consumer_key, consumer_secret } = req.body || {}
    if (!store_url || !consumer_key || !consumer_secret) {
      return res.status(400).json({ error: 'store_url, consumer_key y consumer_secret requeridos' })
    }
    const accountId = req.company.id
    const encKey = encryptCredential(consumer_key)
    const encSecret = encryptCredential(consumer_secret)
    if (!encKey || !encSecret) {
      return res.status(500).json({ error: 'ENCRYPTION_KEY no configurado' })
    }
    const id = `${accountId}_woocommerce_${Date.now()}`
    const now = Date.now()
    db.prepare(`
      INSERT INTO commerce_stores (id, account_id, platform, store_url, consumer_key_encrypted, consumer_secret_encrypted, sync_status, created_at, updated_at)
      VALUES (?, ?, 'woocommerce', ?, ?, ?, 'idle', ?, ?)
      ON CONFLICT(id) DO UPDATE SET store_url=excluded.store_url, consumer_key_encrypted=excluded.consumer_key_encrypted, consumer_secret_encrypted=excluded.consumer_secret_encrypted, updated_at=excluded.updated_at
    `).run(id, accountId, store_url.replace(/\/$/, ''), encKey, encSecret, now, now)

    res.json({ ok: true, store_id: id })

    // Trigger immediate background sync
    syncStore(id, accountId, 'woocommerce', store_url.replace(/\/$/, ''), null, consumer_key, consumer_secret)
      .catch(err => console.error('[commerce] initial sync error:', err))
  } catch (err) {
    console.error('[commerce] connect-woocommerce error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Shared sync function (used by routes + scheduler) ────────────────────────
export async function syncStore(storeId, accountId, platform, storeUrl, accessToken, consumerKey, consumerSecret) {
  db.prepare("UPDATE commerce_stores SET sync_status='syncing' WHERE id=?").run(storeId)
  try {
    let products
    if (platform === 'shopify') {
      products = await fetchShopifyProducts(storeUrl, accessToken, storeId)
    } else {
      products = await fetchWooProducts(storeUrl, consumerKey, consumerSecret, storeId)
    }
    const count = syncProductsToDb(accountId, storeId, products)
    const now = Date.now()
    db.prepare("UPDATE commerce_stores SET sync_status='idle', last_sync_at=? WHERE id=?").run(now, storeId)
    console.log(`[commerce] sync done: ${count} products for store ${storeId}`)
    return { count }
  } catch (err) {
    db.prepare("UPDATE commerce_stores SET sync_status='error' WHERE id=?").run(storeId)
    throw err
  }
}

// ── POST /api/commerce/stores/:storeId/sync ───────────────────────────────────
commerceRouter.post('/stores/:storeId/sync', async (req, res) => {
  try {
    const store = db.prepare('SELECT * FROM commerce_stores WHERE id=? AND account_id=?')
      .get(req.params.storeId, req.company.id)
    if (!store) return res.status(404).json({ error: 'Tienda no encontrada' })

    const accessToken = store.access_token_encrypted ? decryptCredential(store.access_token_encrypted) : null
    const consumerKey = store.consumer_key_encrypted ? decryptCredential(store.consumer_key_encrypted) : null
    const consumerSecret = store.consumer_secret_encrypted ? decryptCredential(store.consumer_secret_encrypted) : null

    res.json({ ok: true, message: 'Sync iniciado' })

    syncStore(store.id, req.company.id, store.platform, store.store_url, accessToken, consumerKey, consumerSecret)
      .catch(err => console.error('[commerce] sync error:', err))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/commerce/stores ──────────────────────────────────────────────────
commerceRouter.get('/stores', (req, res) => {
  const stores = db.prepare(`
    SELECT id, platform, store_url, sync_status, last_sync_at, created_at,
           (SELECT COUNT(*) FROM commerce_products WHERE store_id = commerce_stores.id AND is_active = 1) as product_count
    FROM commerce_stores WHERE account_id = ?
  `).all(req.company.id)
  res.json(stores)
})

// ── GET /api/commerce/products ────────────────────────────────────────────────
commerceRouter.get('/products', (req, res) => {
  const { q, limit = 20, offset = 0 } = req.query
  let products
  if (q) {
    products = db.prepare(`
      SELECT p.* FROM commerce_products p
      JOIN commerce_products_fts fts ON fts.product_id = p.id
      WHERE fts MATCH ? AND p.account_id = ? AND p.is_active = 1
      ORDER BY rank LIMIT ? OFFSET ?
    `).all(`${q}*`, req.company.id, Number(limit), Number(offset))
  } else {
    products = db.prepare(`
      SELECT * FROM commerce_products
      WHERE account_id = ? AND is_active = 1
      ORDER BY title LIMIT ? OFFSET ?
    `).all(req.company.id, Number(limit), Number(offset))
  }
  res.json(products)
})

// ── GET /api/commerce/products/:id ───────────────────────────────────────────
commerceRouter.get('/products/:id', (req, res) => {
  const product = db.prepare('SELECT * FROM commerce_products WHERE id=? AND account_id=?')
    .get(req.params.id, req.company.id)
  if (!product) return res.status(404).json({ error: 'Producto no encontrado' })
  res.json(product)
})

// ── Product relations CRUD ────────────────────────────────────────────────────

commerceRouter.get('/product-relations', (req, res) => {
  res.json(db.prepare('SELECT * FROM commerce_product_relations WHERE account_id=? ORDER BY priority DESC').all(req.company.id))
})

commerceRouter.post('/product-relations', (req, res) => {
  const { source_product_id, target_product_id, relation_type, priority = 0, reason } = req.body || {}
  if (!source_product_id || !target_product_id || !relation_type) {
    return res.status(400).json({ error: 'source_product_id, target_product_id, relation_type requeridos' })
  }
  const id = `rel_${req.company.id}_${Date.now()}`
  const now = Date.now()
  db.prepare(`
    INSERT INTO commerce_product_relations (id, account_id, source_product_id, target_product_id, relation_type, priority, reason, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'admin', ?, ?)
  `).run(id, req.company.id, source_product_id, target_product_id, relation_type, priority, reason || null, now, now)
  res.json({ ok: true, id })
})

commerceRouter.put('/product-relations/:id', (req, res) => {
  const { priority, reason, relation_type } = req.body || {}
  db.prepare(`
    UPDATE commerce_product_relations SET priority=?, reason=?, relation_type=?, updated_at=?
    WHERE id=? AND account_id=?
  `).run(priority ?? 0, reason ?? null, relation_type, Date.now(), req.params.id, req.company.id)
  res.json({ ok: true })
})

commerceRouter.delete('/product-relations/:id', (req, res) => {
  db.prepare('DELETE FROM commerce_product_relations WHERE id=? AND account_id=?')
    .run(req.params.id, req.company.id)
  res.json({ ok: true })
})

// ── Platform webhooks (raw body, no auth needed — verified by signature) ─────
// IMPORTANT: Override the requireCommercePro middleware for webhook routes
// These are mounted separately in server.js BEFORE the requireCommercePro middleware
export const webhookRouter = express.Router()

webhookRouter.post('/shopify',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const hmac = req.headers['x-shopify-hmac-sha256'] || ''
    if (!verifyShopifyWebhook(req.body, hmac, process.env.SHOPIFY_WEBHOOK_SECRET || '')) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    const payload = JSON.parse(req.body.toString())
    handleShopifyProductWebhook(payload, req.headers['x-shopify-shop-domain'])
    res.json({ ok: true })
  }
)

webhookRouter.post('/woocommerce',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const sig = req.headers['x-wc-webhook-signature'] || ''
    if (!verifyWooWebhook(req.body, sig, process.env.WOOCOMMERCE_WEBHOOK_SECRET || '')) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    const payload = JSON.parse(req.body.toString())
    const topic = req.headers['x-wc-webhook-topic'] || ''
    handleWooProductWebhook(payload, topic)
    res.json({ ok: true })
  }
)

webhookRouter.post('/shopify-order',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const hmac = req.headers['x-shopify-hmac-sha256'] || ''
    if (!verifyShopifyWebhook(req.body, hmac, process.env.SHOPIFY_WEBHOOK_SECRET || '')) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    const order = JSON.parse(req.body.toString())
    markPurchaseDetected(order.email, req.headers['x-shopify-shop-domain'])
    res.json({ ok: true })
  }
)

webhookRouter.post('/woocommerce-order',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const sig = req.headers['x-wc-webhook-signature'] || ''
    if (!verifyWooWebhook(req.body, sig, process.env.WOOCOMMERCE_WEBHOOK_SECRET || '')) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    const order = JSON.parse(req.body.toString())
    markPurchaseDetected(order.billing?.email)
    res.json({ ok: true })
  }
)

// ── Webhook handlers ──────────────────────────────────────────────────────────

function handleShopifyProductWebhook(product, shopDomain) {
  // Find store by shop domain
  const store = db.prepare("SELECT * FROM commerce_stores WHERE store_url LIKE ? AND platform='shopify'")
    .get(`%${shopDomain}%`)
  if (!store) return

  const { normalizeShopifyProduct } = require('../services/shopify.js') // dynamic to avoid circular
  const normalized = normalizeShopifyProduct(product, store.store_url, store.id)
  syncProductsToDb(store.account_id, store.id, [normalized])
}

function handleWooProductWebhook(product, topic) {
  if (topic.includes('deleted')) {
    // Mark as inactive
    db.prepare("UPDATE commerce_products SET is_active=0 WHERE platform_product_id=?")
      .run(String(product.id))
    return
  }
  const store = db.prepare("SELECT * FROM commerce_stores WHERE platform='woocommerce' AND account_id IN (SELECT account_id FROM commerce_products WHERE platform_product_id=? LIMIT 1)")
    .get(String(product.id))
  if (!store) return
  const { normalizeWooProduct } = require('../services/woocommerce.js')
  const normalized = normalizeWooProduct(product, store.id)
  syncProductsToDb(store.account_id, store.id, [normalized])
}

function markPurchaseDetected(email, shopDomain) {
  if (!email) return
  db.prepare(`
    UPDATE commerce_conversations SET purchase_detected=1, updated_at=?
    WHERE account_id IN (
      SELECT id FROM companies WHERE JSON_EXTRACT(config,'$.ownerEmail') != ?
    ) AND contact_id = ? AND purchase_detected = 0
  `).run(Date.now(), email, email)
}
```

- [ ] **Step 2: Verify syntax**

```bash
cd /root/mi-agente-ia
node --input-type=module --eval "import './routes/commerce.js'" 2>&1 | head -10
```

Note: There will be import errors for `require()` calls in webhook handlers since this is ESM. Fix by using dynamic `await import()` instead, or just restructure to avoid the circular issue. The webhook handlers use `require()` which won't work in ESM — replace with static imports at the top (they're not circular since shopify.js and woocommerce.js don't import commerce.js).

Fix the webhook handlers to use the already-imported `normalizeShopifyProduct` and `normalizeWooProduct` from the top of the file. Remove the `require()` calls and use the imported functions directly.

- [ ] **Step 3: Run all tests**

```bash
cd /root/mi-agente-ia
npm test 2>&1 | tail -8
```

Expected: 32 tests, 32 pass, 0 fail. (commerce routes have no unit tests here)

- [ ] **Step 4: Commit**

```bash
cd /root/mi-agente-ia
git add routes/commerce.js
git commit -m "feat: add commerce routes (store connect, product sync, webhooks)"
```

---

## Task 5: Wire commerce router in server.js + update .env.example

**Files:**
- Modify: `server.js`
- Modify: `.env.example`

- [ ] **Step 1: Read current `server.js`**

Read `/root/mi-agente-ia/server.js` to see where to add the import and mount.

- [ ] **Step 2: Update server.js**

Add the import at the top (with the other router imports):
```js
import { commerceRouter, webhookRouter } from './routes/commerce.js'
```

Mount the routers AFTER the billing router and BEFORE the admin/chat routers:
```js
// Webhook router needs raw body — mount before express.json() parsing affects it
// (The routes themselves use express.raw() so ordering here is fine)
app.use('/api/commerce/webhooks', webhookRouter)
app.use('/api/commerce', commerceRouter)
```

- [ ] **Step 3: Update `.env.example`**

Uncomment/update the Phase 2 variables section:

Find this in .env.example:
```
# ── Phase 2 (future): Platform webhooks ──────────────────────────────────────
# SHOPIFY_WEBHOOK_SECRET=
# WOOCOMMERCE_WEBHOOK_SECRET=
```

Replace with:
```
# ── Phase 2: Store credentials encryption ────────────────────────────────────
ENCRYPTION_KEY=                 # 32-byte key as 64-char hex string (generate: openssl rand -hex 32)

# ── Phase 2: Platform webhooks ────────────────────────────────────────────────
SHOPIFY_WEBHOOK_SECRET=
WOOCOMMERCE_WEBHOOK_SECRET=
```

- [ ] **Step 4: Boot server and smoke test**

```bash
cd /root/mi-agente-ia
node server.js &
sleep 3
curl -s http://localhost:3100/api/config/public | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK slug:', d.get('slug'))"
kill %1 2>/dev/null
```

Expected: `OK slug: default`

- [ ] **Step 5: Run all tests**

```bash
cd /root/mi-agente-ia
npm test 2>&1 | tail -8
```

Expected: 32 tests, 32 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
cd /root/mi-agente-ia
git add server.js .env.example
git commit -m "feat: mount commerce router; update .env.example for Phase 2"
```

---

## Task 6: Sync scheduler

**Files:**
- Create: `jobs/sync-scheduler.js`

- [ ] **Step 1: Create `jobs/` directory**

```bash
mkdir -p /root/mi-agente-ia/jobs
```

- [ ] **Step 2: Create `jobs/sync-scheduler.js`**

```js
// jobs/sync-scheduler.js
// Runs a full catalog sync for all active Commerce Pro stores every 6 hours.
// Imported by server.js at startup — setInterval starts automatically on import.

import { db } from '../db.js'
import { decryptCredential } from '../db-commerce.js'
import { syncStore } from '../routes/commerce.js'

const SIX_HOURS = 6 * 60 * 60 * 1000

async function runScheduledSync() {
  const stores = db.prepare(`
    SELECT s.*, c.id as company_id
    FROM commerce_stores s
    JOIN companies c ON c.id = s.account_id
    WHERE c.commerce_pro_status = 'active' AND c.commerce_pro_enabled = 1
    ORDER BY s.last_sync_at ASC NULLS FIRST
  `).all()

  if (!stores.length) {
    console.log('[sync-scheduler] No active stores to sync')
    return
  }

  console.log(`[sync-scheduler] Starting sync for ${stores.length} store(s)`)

  for (const store of stores) {
    try {
      const accessToken = store.access_token_encrypted ? decryptCredential(store.access_token_encrypted) : null
      const consumerKey = store.consumer_key_encrypted ? decryptCredential(store.consumer_key_encrypted) : null
      const consumerSecret = store.consumer_secret_encrypted ? decryptCredential(store.consumer_secret_encrypted) : null

      const result = await syncStore(
        store.id, store.account_id, store.platform,
        store.store_url, accessToken, consumerKey, consumerSecret
      )
      console.log(`[sync-scheduler] Store ${store.id}: ${result.count} products synced`)
    } catch (err) {
      console.error(`[sync-scheduler] Error syncing store ${store.id}:`, err.message)
    }
  }
}

// Start the 6-hour interval
setInterval(runScheduledSync, SIX_HOURS)
console.log('[sync-scheduler] Catalog sync scheduler started (every 6 hours)')
```

- [ ] **Step 3: Import scheduler in server.js**

Add this import to server.js (after the router imports):
```js
import './jobs/sync-scheduler.js'
```

- [ ] **Step 4: Boot server and verify scheduler starts**

```bash
cd /root/mi-agente-ia
node server.js &
sleep 3
curl -s http://localhost:3100/api/config/public | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK:', d.get('slug'))"
kill %1 2>/dev/null
```

Expected: Server starts, logs `[sync-scheduler] Catalog sync scheduler started (every 6 hours)`.

- [ ] **Step 5: Run all tests**

```bash
cd /root/mi-agente-ia
npm test 2>&1 | tail -8
```

Expected: 32 tests pass.

- [ ] **Step 6: Commit**

```bash
cd /root/mi-agente-ia
git add jobs/sync-scheduler.js server.js
git commit -m "feat: add 6-hour catalog sync scheduler"
```

---

## Task 7: Final integration test + tag

- [ ] **Step 1: Run full test suite**

```bash
cd /root/mi-agente-ia
npm test 2>&1
```

Expected: 32 tests, 32 pass, 0 fail.

- [ ] **Step 2: Smoke test**

```bash
cd /root/mi-agente-ia
node server.js &
sleep 3
curl -s http://localhost:3100/api/config/public | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK slug:', d.get('slug'))"
kill %1 2>/dev/null
```

- [ ] **Step 3: Tag Phase 2**

```bash
cd /root/mi-agente-ia
git tag phase2-commerce-pro
git log --oneline -8
```

---

## Self-Review Notes

**Spec coverage:**

| Spec section | Covered by task |
|---|---|
| Credential encryption (AES-256-GCM) | Task 1 |
| Shopify product fetch + normalize | Task 2 |
| WooCommerce product fetch + normalize | Task 3 |
| Store connection endpoints | Task 4 |
| FTS5 sync (UPSERT + index) | Task 4 (syncProductsToDb) |
| Paginated sync trigger | Task 4 |
| Product relations CRUD | Task 4 |
| Platform webhooks (product + order) | Task 4 |
| Commerce router mounting | Task 5 |
| 6-hour sync scheduler | Task 6 |
| ENCRYPTION_KEY + webhook secrets in .env.example | Task 5 |

**Critical dependencies:**
- `syncStore()` is exported from `routes/commerce.js` and imported by `jobs/sync-scheduler.js` — must be a named export
- Webhook routes use `express.raw()` — must be mounted in correct order in server.js
- `encryptCredential` / `decryptCredential` are ESM top-level imports in commerce.js — no circular dependency
