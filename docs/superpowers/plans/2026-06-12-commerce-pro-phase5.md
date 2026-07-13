# Lynkro Commerce Pro — Phase 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin dashboard — expose analytics, store management (disconnect + sync), product relations editor, and recovery settings in `admin.html`. Wire the `GET /api/commerce/analytics` endpoint, add `DELETE /api/commerce/stores/:storeId` and `PUT /api/commerce/config` endpoints.

**Architecture:** Backend additions to `routes/commerce.js` (3 new routes). Frontend additions to `public/admin.html` — new sub-sections inside the existing `#tab-billing` Commerce Pro tab, visible only when `commerce_pro_status === 'active'`.

**Tech Stack:** Node.js ESM, SQLite json_each, vanilla JS (no framework, matches existing admin.html pattern)

**Spec:** `docs/superpowers/specs/2026-06-12-lynkro-commerce-pro-design.md` — Sections 10, 11

**Phase 4 baseline tag:** `phase4-commerce-pro`

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Modify | `routes/commerce.js` | Add analytics, store-disconnect, config-save endpoints |
| Modify | `public/admin.html` | Add stores, relations, recovery settings, analytics sections |
| Modify | `tests/commerce.test.js` | Add analytics endpoint tests |

---

## Task 1: Backend — analytics, store disconnect, commerce config

**Files:**
- Modify: `routes/commerce.js`
- Modify: `tests/commerce.test.js`

### New endpoints

**`GET /api/commerce/analytics`**

Returns metrics computed from SQLite. All behind `requireAdmin + withCompany + requireCommercePro`.

```js
// Analytics query logic
const accountId = req.company.id

// Conversations with at least one product
const convCount = db.prepare(`
  SELECT COUNT(*) as c FROM commerce_conversations
  WHERE account_id = ? AND products_discussed IS NOT NULL AND products_discussed != '[]'
`).get(accountId).c

// Top 5 products by mention count (json_each explodes JSON arrays)
const topProducts = db.prepare(`
  SELECT p.title, p.stock_status, COUNT(*) as count
  FROM commerce_conversations cc, json_each(cc.products_discussed) je
  JOIN commerce_products p ON p.id = je.value
  WHERE cc.account_id = ?
  GROUP BY je.value
  ORDER BY count DESC
  LIMIT 5
`).all(accountId)

// Recovery stats
const emailsSent = db.prepare(`SELECT COUNT(*) as c FROM commerce_conversations WHERE account_id = ? AND recovery_email_sent = 1`).get(accountId).c
const emailsConverted = db.prepare(`SELECT COUNT(*) as c FROM commerce_conversations WHERE account_id = ? AND recovery_email_sent = 1 AND purchase_detected = 1`).get(accountId).c
const conversionRate = emailsSent > 0 ? `${Math.round((emailsConverted / emailsSent) * 100)}%` : '—'

res.json({
  products_discussed: convCount,
  top_products: topProducts,
  out_of_stock_requests: 0,   // future: track per conversation
  alternatives_shown: 0,      // future: track per conversation
  upsell_shown: 0,            // future: track per conversation
  recovery_emails_sent: emailsSent,
  recovery_emails_converted: emailsConverted,
  conversion_rate: conversionRate,
  revenue_attributed: 0       // future: track order value
})
```

**`DELETE /api/commerce/stores/:storeId`**

```js
commerceRouter.delete('/stores/:storeId', (req, res) => {
  const { storeId } = req.params
  const store = db.prepare('SELECT id FROM commerce_stores WHERE id = ? AND account_id = ?').get(storeId, req.company.id)
  if (!store) return res.status(404).json({ error: 'Tienda no encontrada' })
  // Mark products inactive
  db.prepare("UPDATE commerce_products SET is_active = 0 WHERE store_id = ?").run(storeId)
  db.prepare("DELETE FROM commerce_stores WHERE id = ?").run(storeId)
  res.json({ ok: true })
})
```

**`PUT /api/commerce/config`**

Saves `config.commerce` recovery settings to the company config JSON blob.

```js
commerceRouter.put('/config', (req, res) => {
  const allowed = [
    'recovery_coupon_enabled', 'recovery_coupon_discount_type', 'recovery_coupon_discount_value',
    'recovery_coupon_expiration_hours', 'recovery_coupon_minimum_order_amount',
    'recovery_coupon_usage_limit', 'recovery_delay_minutes'
  ]
  const incoming = req.body || {}
  const company = db.prepare('SELECT config FROM companies WHERE id = ?').get(req.company.id)
  const cfg = JSON.parse(company.config || '{}')
  const commerce = cfg.commerce || {}
  for (const key of allowed) {
    if (key in incoming) commerce[key] = incoming[key]
  }
  cfg.commerce = commerce
  db.prepare('UPDATE companies SET config = ? WHERE id = ?').run(JSON.stringify(cfg), req.company.id)
  res.json({ ok: true })
})
```

### Steps

- [ ] **Step 1: Add tests to `tests/commerce.test.js`**

Add these imports at the top of the file (only if not already imported):
```js
// These should already exist, just verify:
// import Database from 'better-sqlite3'
// import { applyCommerceSchema } from '../db-commerce.js'
```

Append a new describe block:

```js
describe('commerce analytics endpoint logic', () => {
  let db
  const accountId = 'analytics-test'

  before(() => {
    db = new Database(':memory:')
    db.exec(`CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY, name TEXT, slug TEXT, active INTEGER DEFAULT 1,
      config TEXT DEFAULT '{}', created_at INTEGER, expires_at INTEGER,
      commerce_pro_enabled INTEGER DEFAULT 0, commerce_pro_status TEXT DEFAULT 'inactive',
      commerce_pro_source TEXT, stripe_customer_id TEXT, stripe_subscription_id TEXT,
      stripe_checkout_session_id TEXT, discovery_call_status TEXT DEFAULT 'not_required',
      onboarding_status TEXT DEFAULT 'not_started'
    )`)
    db.prepare('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)').run(accountId, 'Analytics Test', 'analytics-test')
    applyCommerceSchema(db)

    // Seed store + products
    db.prepare('INSERT INTO commerce_stores (id, account_id, platform, store_url, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('s1', accountId, 'shopify', 'https://test.myshopify.com', Date.now())
    db.prepare("INSERT INTO commerce_products (id, account_id, store_id, title, stock_status, is_active, product_url) VALUES (?, ?, ?, ?, ?, 1, ?)")
      .run('prod-a', accountId, 's1', 'Shirt', 'instock', 'https://t.com/a')
    db.prepare("INSERT INTO commerce_products (id, account_id, store_id, title, stock_status, is_active, product_url) VALUES (?, ?, ?, ?, ?, 1, ?)")
      .run('prod-b', accountId, 's1', 'Jeans', 'instock', 'https://t.com/b')

    // Seed commerce_conversations
    const now = Date.now()
    db.prepare('INSERT INTO commerce_conversations (id, account_id, session_id, contact_id, products_discussed, purchase_detected, recovery_email_sent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('cc-1', accountId, 'sess-1', 'a@test.com', '["prod-a","prod-b"]', 0, 1, now, now)
    db.prepare('INSERT INTO commerce_conversations (id, account_id, session_id, contact_id, products_discussed, purchase_detected, recovery_email_sent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('cc-2', accountId, 'sess-2', 'b@test.com', '["prod-a"]', 1, 1, now, now)
  })

  after(() => db.close())

  test('products_discussed counts conversations with products', () => {
    const row = db.prepare(`
      SELECT COUNT(*) as c FROM commerce_conversations
      WHERE account_id = ? AND products_discussed IS NOT NULL AND products_discussed != '[]'
    `).get(accountId)
    assert.strictEqual(row.c, 2)
  })

  test('top_products uses json_each to count mentions', () => {
    const rows = db.prepare(`
      SELECT p.title, p.stock_status, COUNT(*) as count
      FROM commerce_conversations cc, json_each(cc.products_discussed) je
      JOIN commerce_products p ON p.id = je.value
      WHERE cc.account_id = ?
      GROUP BY je.value
      ORDER BY count DESC
      LIMIT 5
    `).all(accountId)
    assert.ok(rows.length >= 1)
    // prod-a appears in both conversations → count=2
    assert.strictEqual(rows[0].title, 'Shirt')
    assert.strictEqual(rows[0].count, 2)
  })

  test('recovery email conversion rate calculation', () => {
    const sent = db.prepare('SELECT COUNT(*) as c FROM commerce_conversations WHERE account_id = ? AND recovery_email_sent = 1').get(accountId).c
    const converted = db.prepare('SELECT COUNT(*) as c FROM commerce_conversations WHERE account_id = ? AND recovery_email_sent = 1 AND purchase_detected = 1').get(accountId).c
    assert.strictEqual(sent, 2)
    assert.strictEqual(converted, 1)
    const rate = sent > 0 ? `${Math.round((converted / sent) * 100)}%` : '—'
    assert.strictEqual(rate, '50%')
  })
})
```

- [ ] **Step 2: Run tests — expect failures (endpoint not yet added)**

```bash
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm test 2>&1 | grep -E "fail|pass|analytics"
```

Wait — these tests test the SQL logic directly (no HTTP), so they should pass once the SQL is correct. But they're importing nothing new — they use `db` directly. So they should pass immediately after adding the describe block if the DB/schema are set up correctly.

Actually: the describe block creates its own in-memory DB, so it doesn't depend on any new route code. Run and expect PASS.

- [ ] **Step 3: Add the 3 new endpoints to `routes/commerce.js`**

Add before the `// ── Platform webhooks` comment line (after the existing `delete('/product-relations/:id')` handler):

```js
// ── GET /api/commerce/analytics ──────────────────────────────────────────────
commerceRouter.get('/analytics', (req, res) => {
  const accountId = req.company.id
  const convCount = db.prepare(`
    SELECT COUNT(*) as c FROM commerce_conversations
    WHERE account_id = ? AND products_discussed IS NOT NULL AND products_discussed != '[]'
  `).get(accountId).c

  const topProducts = db.prepare(`
    SELECT p.title, p.stock_status, COUNT(*) as count
    FROM commerce_conversations cc, json_each(cc.products_discussed) je
    JOIN commerce_products p ON p.id = je.value
    WHERE cc.account_id = ?
    GROUP BY je.value
    ORDER BY count DESC
    LIMIT 5
  `).all(accountId)

  const emailsSent = db.prepare('SELECT COUNT(*) as c FROM commerce_conversations WHERE account_id = ? AND recovery_email_sent = 1').get(accountId).c
  const emailsConverted = db.prepare('SELECT COUNT(*) as c FROM commerce_conversations WHERE account_id = ? AND recovery_email_sent = 1 AND purchase_detected = 1').get(accountId).c
  const conversionRate = emailsSent > 0 ? `${Math.round((emailsConverted / emailsSent) * 100)}%` : '—'

  res.json({
    products_discussed: convCount,
    top_products: topProducts,
    out_of_stock_requests: 0,
    alternatives_shown: 0,
    upsell_shown: 0,
    recovery_emails_sent: emailsSent,
    recovery_emails_converted: emailsConverted,
    conversion_rate: conversionRate,
    revenue_attributed: 0
  })
})

// ── DELETE /api/commerce/stores/:storeId ─────────────────────────────────────
commerceRouter.delete('/stores/:storeId', (req, res) => {
  const store = db.prepare('SELECT id FROM commerce_stores WHERE id = ? AND account_id = ?')
    .get(req.params.storeId, req.company.id)
  if (!store) return res.status(404).json({ error: 'Tienda no encontrada' })
  db.prepare('UPDATE commerce_products SET is_active = 0 WHERE store_id = ?').run(req.params.storeId)
  db.prepare('DELETE FROM commerce_stores WHERE id = ?').run(req.params.storeId)
  res.json({ ok: true })
})

// ── PUT /api/commerce/config ──────────────────────────────────────────────────
commerceRouter.put('/config', (req, res) => {
  const allowed = [
    'recovery_coupon_enabled', 'recovery_coupon_discount_type', 'recovery_coupon_discount_value',
    'recovery_coupon_expiration_hours', 'recovery_coupon_minimum_order_amount',
    'recovery_coupon_usage_limit', 'recovery_delay_minutes'
  ]
  const incoming = req.body || {}
  const company = db.prepare('SELECT config FROM companies WHERE id = ?').get(req.company.id)
  const cfg = JSON.parse(company.config || '{}')
  cfg.commerce = cfg.commerce || {}
  for (const key of allowed) {
    if (key in incoming) cfg.commerce[key] = incoming[key]
  }
  db.prepare('UPDATE companies SET config = ? WHERE id = ?').run(JSON.stringify(cfg), req.company.id)
  res.json({ ok: true })
})
```

- [ ] **Step 4: Run full tests + smoke test**

```bash
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm test 2>&1 | tail -15
```

Expected: 53 tests pass (50 existing + 3 new).

```bash
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") ADMIN_PASSWORD=test timeout 6 node server.js 2>&1 || true
```

Expected: server boots with both scheduler lines, no import errors.

- [ ] **Step 5: Commit**

```bash
git add routes/commerce.js tests/commerce.test.js
git commit -m "feat: add analytics, store-disconnect, and commerce config endpoints"
```

---

## Task 2: admin.html — Commerce Pro sections

**Files:**
- Modify: `public/admin.html`

### What to add

The existing `#tab-billing` ends at line ~774 with:
```html
  </div>  <!-- closes commerce-status-card -->
 </div>   <!-- closes tab-billing -->
</div>    <!-- closes main -->
```

Replace just the closing of tab-billing:
- Keep the status card
- Add 4 new sections after it (only shown when active)
- These sections are rendered/hidden in JS based on `commerce_pro_status`

### Sections to add

**A. Stores** — list connected stores, sync now, disconnect

**B. Product Relations** — table, add form

**C. Recovery Settings** — form with save button

**D. Analytics** — metric cards

### Steps

- [ ] **Step 1: Replace the closing of `#tab-billing`**

Find this exact block (around line 773-774):
```html
  </div>
 </div>
```
which closes `commerce-status-card` and `tab-billing`.

Replace with the full expansion (status card close + 4 new sections + tab close):

```html
  </div>
 </div>

 <!-- Commerce Pro sections — only visible when active -->
 <div id="commerce-pro-sections" style="display:none">

  <!-- STORES -->
  <h3 style="margin:28px 0 14px;font-size:16px">Tiendas conectadas</h3>
  <div id="stores-list" style="margin-bottom:16px"></div>
  <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:32px">
   <button onclick="tab('billing')" style="background:#1e1e2e;color:#fff;border:1px solid #3a3a4a;padding:8px 16px;border-radius:8px;cursor:pointer;font-size:13px" onclick="showConnectForm()">+ Conectar Shopify</button>
   <button onclick="showConnectWooForm()" style="background:#1e1e2e;color:#fff;border:1px solid #3a3a4a;padding:8px 16px;border-radius:8px;cursor:pointer;font-size:13px">+ Conectar WooCommerce</button>
  </div>
  <!-- Connect Shopify form (hidden by default) -->
  <div id="connect-shopify-form" style="display:none;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:20px;max-width:480px;margin-bottom:20px">
   <h4 style="margin:0 0 14px;font-size:14px">Conectar Shopify</h4>
   <input id="shopify-url" placeholder="https://tu-tienda.myshopify.com" style="width:100%;box-sizing:border-box;background:#111;border:1px solid #333;color:#fff;padding:8px 12px;border-radius:6px;font-size:13px;margin-bottom:8px">
   <input id="shopify-token" placeholder="shpat_..." style="width:100%;box-sizing:border-box;background:#111;border:1px solid #333;color:#fff;padding:8px 12px;border-radius:6px;font-size:13px;margin-bottom:12px">
   <div style="display:flex;gap:8px">
    <button onclick="connectShopify()" style="background:#6c47ff;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px">Conectar</button>
    <button onclick="document.getElementById('connect-shopify-form').style.display='none'" style="background:transparent;color:#aaa;border:1px solid #333;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px">Cancelar</button>
   </div>
  </div>
  <!-- Connect WooCommerce form (hidden by default) -->
  <div id="connect-woo-form" style="display:none;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:20px;max-width:480px;margin-bottom:20px">
   <h4 style="margin:0 0 14px;font-size:14px">Conectar WooCommerce</h4>
   <input id="woo-url" placeholder="https://tu-tienda.com" style="width:100%;box-sizing:border-box;background:#111;border:1px solid #333;color:#fff;padding:8px 12px;border-radius:6px;font-size:13px;margin-bottom:8px">
   <input id="woo-key" placeholder="ck_..." style="width:100%;box-sizing:border-box;background:#111;border:1px solid #333;color:#fff;padding:8px 12px;border-radius:6px;font-size:13px;margin-bottom:8px">
   <input id="woo-secret" placeholder="cs_..." style="width:100%;box-sizing:border-box;background:#111;border:1px solid #333;color:#fff;padding:8px 12px;border-radius:6px;font-size:13px;margin-bottom:12px">
   <div style="display:flex;gap:8px">
    <button onclick="connectWoo()" style="background:#6c47ff;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px">Conectar</button>
    <button onclick="document.getElementById('connect-woo-form').style.display='none'" style="background:transparent;color:#aaa;border:1px solid #333;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px">Cancelar</button>
   </div>
  </div>

  <!-- PRODUCT RELATIONS -->
  <h3 style="margin:28px 0 14px;font-size:16px">Relaciones de productos</h3>
  <div id="relations-list" style="margin-bottom:14px;font-size:13px"></div>
  <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:16px;max-width:600px;margin-bottom:32px">
   <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:8px;align-items:end">
    <div>
     <label style="font-size:11px;color:#888;display:block;margin-bottom:4px">Producto origen (ID)</label>
     <input id="rel-source" placeholder="ID producto" style="width:100%;box-sizing:border-box;background:#111;border:1px solid #333;color:#fff;padding:7px 10px;border-radius:6px;font-size:12px">
    </div>
    <div>
     <label style="font-size:11px;color:#888;display:block;margin-bottom:4px">Tipo</label>
     <select id="rel-type" style="width:100%;box-sizing:border-box;background:#111;border:1px solid #333;color:#fff;padding:7px 10px;border-radius:6px;font-size:12px">
      <option value="alternative">Alternativa</option>
      <option value="upsell">Upsell</option>
      <option value="downsell">Downsell</option>
      <option value="cross_sell">Cross-sell</option>
      <option value="bundle">Bundle</option>
      <option value="replacement">Reemplazo</option>
     </select>
    </div>
    <div>
     <label style="font-size:11px;color:#888;display:block;margin-bottom:4px">Producto destino (ID)</label>
     <input id="rel-target" placeholder="ID producto" style="width:100%;box-sizing:border-box;background:#111;border:1px solid #333;color:#fff;padding:7px 10px;border-radius:6px;font-size:12px">
    </div>
    <button onclick="addRelation()" style="background:#6c47ff;color:#fff;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;white-space:nowrap">+ Agregar</button>
   </div>
  </div>

  <!-- RECOVERY SETTINGS -->
  <h3 style="margin:28px 0 14px;font-size:16px">Configuración de recuperación</h3>
  <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:20px;max-width:480px;margin-bottom:32px">
   <label style="display:flex;align-items:center;gap:10px;margin-bottom:16px;cursor:pointer">
    <input type="checkbox" id="rec-coupon-enabled" style="width:16px;height:16px;accent-color:#6c47ff">
    <span style="font-size:14px">Enviar cupón de descuento en emails de recuperación</span>
   </label>
   <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
    <div>
     <label style="font-size:11px;color:#888;display:block;margin-bottom:4px">Tipo de descuento</label>
     <select id="rec-discount-type" style="width:100%;box-sizing:border-box;background:#111;border:1px solid #333;color:#fff;padding:8px;border-radius:6px;font-size:13px">
      <option value="percent">Porcentaje (%)</option>
      <option value="fixed">Monto fijo</option>
     </select>
    </div>
    <div>
     <label style="font-size:11px;color:#888;display:block;margin-bottom:4px">Valor del descuento</label>
     <input type="number" id="rec-discount-value" min="1" max="100" value="10" style="width:100%;box-sizing:border-box;background:#111;border:1px solid #333;color:#fff;padding:8px;border-radius:6px;font-size:13px">
    </div>
    <div>
     <label style="font-size:11px;color:#888;display:block;margin-bottom:4px">Expiración (horas)</label>
     <input type="number" id="rec-expiration-hours" min="1" value="48" style="width:100%;box-sizing:border-box;background:#111;border:1px solid #333;color:#fff;padding:8px;border-radius:6px;font-size:13px">
    </div>
    <div>
     <label style="font-size:11px;color:#888;display:block;margin-bottom:4px">Delay de envío (min)</label>
     <input type="number" id="rec-delay-minutes" min="15" value="60" style="width:100%;box-sizing:border-box;background:#111;border:1px solid #333;color:#fff;padding:8px;border-radius:6px;font-size:13px">
    </div>
   </div>
   <button onclick="saveRecoveryConfig()" style="background:#6c47ff;color:#fff;border:none;padding:9px 20px;border-radius:7px;cursor:pointer;font-size:13px;font-weight:600">Guardar configuración</button>
  </div>

  <!-- ANALYTICS -->
  <h3 style="margin:28px 0 14px;font-size:16px">Analytics</h3>
  <div id="analytics-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:32px">
   <div class="analytics-card" id="an-discussed"><span class="an-val">—</span><span class="an-lbl">Conversaciones con productos</span></div>
   <div class="analytics-card" id="an-sent"><span class="an-val">—</span><span class="an-lbl">Emails de recuperación</span></div>
   <div class="analytics-card" id="an-converted"><span class="an-val">—</span><span class="an-lbl">Recuperados</span></div>
   <div class="analytics-card" id="an-rate"><span class="an-val">—</span><span class="an-lbl">Tasa de conversión</span></div>
  </div>
  <h4 style="font-size:13px;color:#aaa;margin-bottom:10px">Productos más consultados</h4>
  <div id="top-products-list" style="margin-bottom:32px;font-size:13px"></div>

 </div><!-- /#commerce-pro-sections -->
</div><!-- /#tab-billing -->
```

- [ ] **Step 2: Add CSS for analytics cards**

Find the `<style>` block in admin.html (after the opening `<style>` tag). Add before the `</style>` closing tag:

```css
.analytics-card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:6px}
.an-val{font-size:28px;font-weight:700;color:#fff}
.an-lbl{font-size:11px;color:#888;line-height:1.3}
```

- [ ] **Step 3: Add JS functions**

Find the closing `</script>` tag (at the end of admin.html, around line 2069). Add these functions BEFORE `</script>`:

```js
// ── Commerce Pro sections ──────────────────────────────────────────────────

function showConnectForm() {
  document.getElementById('connect-shopify-form').style.display = 'block'
  document.getElementById('connect-woo-form').style.display = 'none'
}

function showConnectWooForm() {
  document.getElementById('connect-woo-form').style.display = 'block'
  document.getElementById('connect-shopify-form').style.display = 'none'
}

async function connectShopify() {
  const url = document.getElementById('shopify-url').value.trim()
  const token = document.getElementById('shopify-token').value.trim()
  if (!url || !token) return alert('Completá la URL y el token')
  const res = await fetch('/api/commerce/stores/connect-shopify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-password': password, 'x-admin-email': adminEmail, 'x-company-id': activeCompanyId },
    body: JSON.stringify({ store_url: url, access_token: token })
  })
  const data = await res.json()
  if (data.error) return alert('Error: ' + data.error)
  toast('Tienda conectada. Sincronizando catálogo...')
  document.getElementById('connect-shopify-form').style.display = 'none'
  loadCommerceStores()
}

async function connectWoo() {
  const url = document.getElementById('woo-url').value.trim()
  const key = document.getElementById('woo-key').value.trim()
  const secret = document.getElementById('woo-secret').value.trim()
  if (!url || !key || !secret) return alert('Completá todos los campos')
  const res = await fetch('/api/commerce/stores/connect-woocommerce', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-password': password, 'x-admin-email': adminEmail, 'x-company-id': activeCompanyId },
    body: JSON.stringify({ store_url: url, consumer_key: key, consumer_secret: secret })
  })
  const data = await res.json()
  if (data.error) return alert('Error: ' + data.error)
  toast('Tienda conectada. Sincronizando catálogo...')
  document.getElementById('connect-woo-form').style.display = 'none'
  loadCommerceStores()
}

async function loadCommerceStores() {
  const list = document.getElementById('stores-list')
  if (!list) return
  try {
    const res = await fetch('/api/commerce/stores', {
      headers: { 'x-admin-password': password, 'x-admin-email': adminEmail, 'x-company-id': activeCompanyId }
    })
    const stores = await res.json()
    if (!stores.length) {
      list.innerHTML = '<p style="color:#888;font-size:13px">No hay tiendas conectadas.</p>'
      return
    }
    list.innerHTML = stores.map(s => `
      <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:16px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <div>
          <span style="background:${s.platform==='shopify'?'#96bf48':'#7f54b3'};color:#fff;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:600;margin-right:8px">${s.platform.toUpperCase()}</span>
          <strong style="font-size:13px">${s.store_url}</strong>
          <div style="font-size:11px;color:#888;margin-top:4px">${s.product_count || 0} productos · ${s.sync_status} · ${s.last_sync_at ? new Date(s.last_sync_at).toLocaleString('es-AR') : 'nunca sincronizado'}</div>
        </div>
        <div style="display:flex;gap:8px">
          <button onclick="syncStore('${s.id}')" style="background:#1e1e2e;color:#aaa;border:1px solid #333;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px">↻ Sync</button>
          <button onclick="disconnectStore('${s.id}')" style="background:transparent;color:#ef4444;border:1px solid #3a1414;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px">Desconectar</button>
        </div>
      </div>
    `).join('')
  } catch(e) { list.innerHTML = '<p style="color:#ef4444;font-size:13px">Error cargando tiendas</p>' }
}

async function syncStore(storeId) {
  await fetch(`/api/commerce/stores/${storeId}/sync`, {
    method: 'POST',
    headers: { 'x-admin-password': password, 'x-admin-email': adminEmail, 'x-company-id': activeCompanyId }
  })
  toast('Sincronización iniciada')
  setTimeout(loadCommerceStores, 3000)
}

async function disconnectStore(storeId) {
  if (!confirm('¿Desconectar esta tienda? Se desactivarán sus productos del catálogo.')) return
  const res = await fetch(`/api/commerce/stores/${storeId}`, {
    method: 'DELETE',
    headers: { 'x-admin-password': password, 'x-admin-email': adminEmail, 'x-company-id': activeCompanyId }
  })
  const data = await res.json()
  if (data.error) return alert('Error: ' + data.error)
  toast('Tienda desconectada')
  loadCommerceStores()
}

async function loadRelations() {
  const list = document.getElementById('relations-list')
  if (!list) return
  try {
    const res = await fetch('/api/commerce/product-relations', {
      headers: { 'x-admin-password': password, 'x-admin-email': adminEmail, 'x-company-id': activeCompanyId }
    })
    const relations = await res.json()
    if (!relations.length) {
      list.innerHTML = '<p style="color:#888;font-size:13px;margin-bottom:10px">No hay relaciones definidas.</p>'
      return
    }
    list.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:12px">
      <thead><tr style="color:#888;text-align:left;border-bottom:1px solid #2a2a2a">
        <th style="padding:6px 8px">Origen</th><th style="padding:6px 8px">Tipo</th><th style="padding:6px 8px">Destino</th><th style="padding:6px 8px"></th>
      </tr></thead>
      <tbody>${relations.map(r => `<tr style="border-bottom:1px solid #1a1a1a">
        <td style="padding:6px 8px;color:#ccc">${r.source_product_id}</td>
        <td style="padding:6px 8px"><span style="background:#1e1e2e;color:#aaa;padding:2px 8px;border-radius:4px;font-size:11px">${r.relation_type}</span></td>
        <td style="padding:6px 8px;color:#ccc">${r.target_product_id}</td>
        <td style="padding:6px 8px;text-align:right"><button onclick="deleteRelation('${r.id}')" style="background:transparent;color:#ef4444;border:none;cursor:pointer;font-size:12px">✕</button></td>
      </tr>`).join('')}</tbody>
    </table>`
  } catch(e) { list.innerHTML = '<p style="color:#ef4444;font-size:13px">Error cargando relaciones</p>' }
}

async function addRelation() {
  const source = document.getElementById('rel-source').value.trim()
  const type = document.getElementById('rel-type').value
  const target = document.getElementById('rel-target').value.trim()
  if (!source || !target) return alert('Ingresá IDs de origen y destino')
  await fetch('/api/commerce/product-relations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-password': password, 'x-admin-email': adminEmail, 'x-company-id': activeCompanyId },
    body: JSON.stringify({ source_product_id: source, relation_type: type, target_product_id: target })
  })
  document.getElementById('rel-source').value = ''
  document.getElementById('rel-target').value = ''
  toast('Relación agregada')
  loadRelations()
}

async function deleteRelation(id) {
  await fetch(`/api/commerce/product-relations/${id}`, {
    method: 'DELETE',
    headers: { 'x-admin-password': password, 'x-admin-email': adminEmail, 'x-company-id': activeCompanyId }
  })
  toast('Relación eliminada')
  loadRelations()
}

async function loadCommerceConfig() {
  // Load company config and populate recovery settings form
  try {
    const res = await fetch('/api/config', {
      headers: { 'x-admin-password': password, 'x-admin-email': adminEmail, 'x-company-id': activeCompanyId }
    })
    const cfg = await res.json()
    const c = cfg.commerce || {}
    const el = id => document.getElementById(id)
    if (el('rec-coupon-enabled')) el('rec-coupon-enabled').checked = !!c.recovery_coupon_enabled
    if (el('rec-discount-type')) el('rec-discount-type').value = c.recovery_coupon_discount_type || 'percent'
    if (el('rec-discount-value')) el('rec-discount-value').value = c.recovery_coupon_discount_value ?? 10
    if (el('rec-expiration-hours')) el('rec-expiration-hours').value = c.recovery_coupon_expiration_hours ?? 48
    if (el('rec-delay-minutes')) el('rec-delay-minutes').value = c.recovery_delay_minutes ?? 60
  } catch(e) {}
}

async function saveRecoveryConfig() {
  const payload = {
    recovery_coupon_enabled: document.getElementById('rec-coupon-enabled').checked,
    recovery_coupon_discount_type: document.getElementById('rec-discount-type').value,
    recovery_coupon_discount_value: Number(document.getElementById('rec-discount-value').value),
    recovery_coupon_expiration_hours: Number(document.getElementById('rec-expiration-hours').value),
    recovery_delay_minutes: Number(document.getElementById('rec-delay-minutes').value)
  }
  const res = await fetch('/api/commerce/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-admin-password': password, 'x-admin-email': adminEmail, 'x-company-id': activeCompanyId },
    body: JSON.stringify(payload)
  })
  const data = await res.json()
  if (data.error) return alert('Error: ' + data.error)
  toast('Configuración guardada')
}

async function loadAnalytics() {
  try {
    const res = await fetch('/api/commerce/analytics', {
      headers: { 'x-admin-password': password, 'x-admin-email': adminEmail, 'x-company-id': activeCompanyId }
    })
    if (!res.ok) return
    const data = await res.json()
    const set = (id, val) => { const el = document.querySelector(`#${id} .an-val`); if (el) el.textContent = val }
    set('an-discussed', data.products_discussed)
    set('an-sent', data.recovery_emails_sent)
    set('an-converted', data.recovery_emails_converted)
    set('an-rate', data.conversion_rate)
    const topList = document.getElementById('top-products-list')
    if (topList && data.top_products?.length) {
      topList.innerHTML = data.top_products.map(p =>
        `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #1a1a1a;max-width:400px">
          <span style="color:#ccc">${p.title}</span>
          <span style="color:#888">${p.count} veces · <span style="color:${p.stock_status==='instock'?'#22c55e':'#ef4444'}">${p.stock_status}</span></span>
         </div>`
      ).join('')
    } else if (topList) {
      topList.innerHTML = '<p style="color:#888;font-size:13px">Sin datos aún.</p>'
    }
  } catch(e) {}
}
```

- [ ] **Step 4: Wire Commerce Pro sections into `loadBillingStatus`**

Find the existing `loadBillingStatus` function. After the line that reads:
```js
btnPortal.style.display = data.stripe_customer_id ? 'inline-block' : 'none'
```

Add:
```js
// Show/hide Commerce Pro sections
const sections = document.getElementById('commerce-pro-sections')
if (sections) {
  sections.style.display = data.commerce_pro_status === 'active' ? 'block' : 'none'
  if (data.commerce_pro_status === 'active') {
    loadCommerceStores()
    loadRelations()
    loadCommerceConfig()
    loadAnalytics()
  }
}
```

- [ ] **Step 5: Verify no syntax errors**

```bash
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") ADMIN_PASSWORD=test timeout 5 node server.js 2>&1 || true
```

Expected: server boots cleanly.

```bash
# Also validate HTML is well-formed (basic check)
grep -c '<div' /root/mi-agente-ia/public/admin.html
grep -c '</div>' /root/mi-agente-ia/public/admin.html
```

Expected: div counts should be equal (or differ by at most 2 due to comment style).

- [ ] **Step 6: Commit**

```bash
git add public/admin.html
git commit -m "feat: add Commerce Pro sections to admin dashboard (stores, relations, recovery settings, analytics)"
```

---

## Task 3: Final integration test + tag `phase5-commerce-pro`

**Files:** None (verification only)

- [ ] **Step 1: Full test suite**

```bash
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm test 2>&1 | tail -15
```

Expected: 53 tests pass, 0 fail.

- [ ] **Step 2: Verify all phase exports**

```bash
node --input-type=module << 'EOF'
import { generateCouponCode } from '/root/mi-agente-ia/services/coupons.js'
import { buildRecoveryEmail } from '/root/mi-agente-ia/services/recovery.js'
import { SEARCH_PRODUCTS_TOOL } from '/root/mi-agente-ia/services/recommendations.js'
console.assert(SEARCH_PRODUCTS_TOOL.name === 'search_products')
console.assert(typeof buildRecoveryEmail === 'function')
console.assert(typeof generateCouponCode === 'function')
console.log('All phase exports OK')
EOF
```

- [ ] **Step 3: Server boot — check all scheduler lines + no errors**

```bash
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") ADMIN_PASSWORD=test timeout 6 node server.js 2>&1 || true
```

Expected: 3 lines:
```
[sync-scheduler] Catalog sync scheduler started (every 6 hours)
[sync-scheduler] Recovery job started (every 15 minutes)
Agente multi-empresa corriendo en http://localhost:3100
```

- [ ] **Step 4: Tag**

```bash
git tag phase5-commerce-pro && git tag -l "phase*"
```

Expected: `phase1-commerce-pro` through `phase5-commerce-pro`.
