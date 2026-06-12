// routes/commerce.js
import express from 'express'
import { db } from '../db.js'
import { requireAdmin, withCompany } from '../middleware/auth.js'
import { requireCommercePro } from '../middleware/commerce.js'
import { encryptCredential, decryptCredential } from '../db-commerce.js'
import { fetchShopifyProducts, normalizeShopifyProduct, verifyShopifyWebhook } from '../services/shopify.js'
import { fetchWooProducts, normalizeWooProduct, verifyWooWebhook } from '../services/woocommerce.js'

export const commerceRouter = express.Router()

// All authenticated commerce routes require admin + company + Commerce Pro
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

  const ftsDelete = db.prepare('DELETE FROM commerce_products_fts WHERE product_id = ?')
  const ftsInsert = db.prepare(`
    INSERT INTO commerce_products_fts (product_id, account_id, title, description, category, tags)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  const syncMany = db.transaction((prods) => {
    const ids = []
    for (const p of prods) {
      const id = `${accountId}_${storeId}_${p.platform_product_id}`
      upsert.run(
        id, accountId, storeId, p.platform_product_id, p.platform_variant_id || '',
        p.title || '', p.description || '', p.short_description || '',
        p.price ?? 0, p.compare_at_price ?? null,
        p.currency || 'USD', p.sku || '', p.stock_status || 'instock',
        p.inventory_quantity ?? null, p.product_url || '', p.image_url || '',
        p.brand || '', p.category || '',
        p.tags || '[]', p.attributes || '{}',
        p.allow_backorder ?? 0, now, now, now
      )
      ftsDelete.run(id)
      ftsInsert.run(id, accountId, p.title || '', p.description || '', p.category || '', p.tags || '')
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

// ── Exported sync function (used by scheduler) ────────────────────────────────
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
    db.prepare("UPDATE commerce_stores SET sync_status='idle', last_sync_at=? WHERE id=?").run(Date.now(), storeId)
    console.log(`[commerce] sync done: ${count} products for store ${storeId}`)
    return { count }
  } catch (err) {
    db.prepare("UPDATE commerce_stores SET sync_status='error' WHERE id=?").run(storeId)
    throw err
  }
}

// ── POST /api/commerce/stores/connect-shopify ─────────────────────────────────
commerceRouter.post('/stores/connect-shopify', async (req, res) => {
  try {
    const { store_url, access_token } = req.body || {}
    if (!store_url || !access_token) {
      return res.status(400).json({ error: 'store_url y access_token requeridos' })
    }
    const encrypted = encryptCredential(access_token)
    if (!encrypted) return res.status(500).json({ error: 'ENCRYPTION_KEY no configurado' })

    const accountId = req.company.id
    const id = `${accountId}_shopify_${Date.now()}`
    const now = Date.now()
    const url = store_url.replace(/\/$/, '')
    db.prepare(`
      INSERT INTO commerce_stores (id, account_id, platform, store_url, access_token_encrypted, sync_status, created_at, updated_at)
      VALUES (?, ?, 'shopify', ?, ?, 'idle', ?, ?)
    `).run(id, accountId, url, encrypted, now, now)

    res.json({ ok: true, store_id: id })

    syncStore(id, accountId, 'shopify', url, access_token, null, null)
      .catch(err => console.error('[commerce] initial shopify sync error:', err.message))
  } catch (err) {
    console.error('[commerce] connect-shopify:', err)
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
    const encKey = encryptCredential(consumer_key)
    const encSecret = encryptCredential(consumer_secret)
    if (!encKey || !encSecret) return res.status(500).json({ error: 'ENCRYPTION_KEY no configurado' })

    const accountId = req.company.id
    const id = `${accountId}_woocommerce_${Date.now()}`
    const now = Date.now()
    const url = store_url.replace(/\/$/, '')
    db.prepare(`
      INSERT INTO commerce_stores (id, account_id, platform, store_url, consumer_key_encrypted, consumer_secret_encrypted, sync_status, created_at, updated_at)
      VALUES (?, ?, 'woocommerce', ?, ?, ?, 'idle', ?, ?)
    `).run(id, accountId, url, encKey, encSecret, now, now)

    res.json({ ok: true, store_id: id })

    syncStore(id, accountId, 'woocommerce', url, null, consumer_key, consumer_secret)
      .catch(err => console.error('[commerce] initial woocommerce sync error:', err.message))
  } catch (err) {
    console.error('[commerce] connect-woocommerce:', err)
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
      .catch(err => console.error('[commerce] sync error:', err.message))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
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
  `).run(id, req.company.id, source_product_id, target_product_id, relation_type, priority, reason ?? null, now, now)
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

// ── Platform webhooks (separate router, no auth middleware) ───────────────────
export const webhookRouter = express.Router()

webhookRouter.post('/shopify',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const hmac = req.headers['x-shopify-hmac-sha256'] || ''
    if (!verifyShopifyWebhook(req.body, hmac, process.env.SHOPIFY_WEBHOOK_SECRET || '')) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    try {
      const payload = JSON.parse(req.body.toString())
      const shopDomain = req.headers['x-shopify-shop-domain'] || ''
      const store = db.prepare("SELECT * FROM commerce_stores WHERE store_url LIKE ? AND platform='shopify'")
        .get(`%${shopDomain}%`)
      if (store) {
        const normalized = normalizeShopifyProduct(payload, store.store_url, store.id)
        syncProductsToDb(store.account_id, store.id, [normalized])
      }
    } catch (err) {
      console.error('[webhook] shopify product error:', err.message)
    }
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
    try {
      const payload = JSON.parse(req.body.toString())
      const topic = req.headers['x-wc-webhook-topic'] || ''
      if (topic.includes('deleted')) {
        db.prepare("UPDATE commerce_products SET is_active=0, updated_at=? WHERE platform_product_id=?")
          .run(Date.now(), String(payload.id))
      } else {
        const store = db.prepare("SELECT * FROM commerce_stores WHERE platform='woocommerce' AND account_id IN (SELECT account_id FROM commerce_products WHERE platform_product_id=? LIMIT 1)")
          .get(String(payload.id))
        if (store) {
          const normalized = normalizeWooProduct(payload, store.id)
          syncProductsToDb(store.account_id, store.id, [normalized])
        }
      }
    } catch (err) {
      console.error('[webhook] woocommerce product error:', err.message)
    }
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
    try {
      const order = JSON.parse(req.body.toString())
      if (order.email) {
        db.prepare(`
          UPDATE commerce_conversations SET purchase_detected=1, updated_at=?
          WHERE contact_id=? AND purchase_detected=0
        `).run(Date.now(), order.email)
      }
    } catch (err) {
      console.error('[webhook] shopify-order error:', err.message)
    }
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
    try {
      const order = JSON.parse(req.body.toString())
      const email = order.billing?.email
      if (email) {
        db.prepare(`
          UPDATE commerce_conversations SET purchase_detected=1, updated_at=?
          WHERE contact_id=? AND purchase_detected=0
        `).run(Date.now(), email)
      }
    } catch (err) {
      console.error('[webhook] woocommerce-order error:', err.message)
    }
    res.json({ ok: true })
  }
)
