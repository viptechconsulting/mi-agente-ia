# Lynkro Commerce Pro — Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Abandoned conversation recovery — detect idle conversations with discussed products, generate a coupon (optionally via WooCommerce/Shopify API), send a recovery email via SMTP, and mark coupons used when an order webhook fires.

**Architecture:** Two new services (`services/coupons.js`, `services/recovery.js`), a 15-min job wired into `jobs/sync-scheduler.js`, and two small additions to the existing order webhooks in `routes/commerce.js`.

**Tech Stack:** Node.js ESM, nodemailer (already in package.json), better-sqlite3, node:test

**Spec:** `docs/superpowers/specs/2026-06-12-lynkro-commerce-pro-design.md` — Section 9 (9.1–9.5)

**Phase 3 baseline tag:** `phase3-commerce-pro`

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Create | `services/coupons.js` | Code generation + WooCommerce/Shopify API coupon creation |
| Create | `services/recovery.js` | Recovery query, email template, orchestration |
| Modify | `jobs/sync-scheduler.js` | Add 15-min recovery job |
| Modify | `routes/commerce.js` | Extend order webhooks to mark coupons used |
| Create | `tests/recovery.test.js` | Tests for coupons service + recovery service |

---

## Task 1: `services/coupons.js`

**Files:**
- Create: `services/coupons.js`
- Create: `tests/recovery.test.js` (first tests)

### What this file does

Pure-ish functions: code generation is pure; platform API functions are async and make HTTP calls (not unit-tested beyond structure checks).

```js
export function generateCouponCode(leadName)
export async function createWooCoupon(storeUrl, consumerKey, consumerSecret, code, config)
export async function createShopifyCoupon(storeUrl, accessToken, code, config)
export function buildCouponDbRecord(accountId, storeId, platform, code, config, platformCouponId = null)
```

### Steps

- [ ] **Step 1: Create `tests/recovery.test.js`**

```js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { generateCouponCode, buildCouponDbRecord } from '../services/coupons.js'

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
    // "JOS" after stripping — only alpha chars kept
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
    assert.ok(rec.expires_at > Date.now())   // 48h in the future
    assert.strictEqual(rec.status, 'created')
  })
})
```

- [ ] **Step 2: Run tests — expect failure**

```bash
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm test 2>&1 | grep -E "fail|pass|coupons"
```

Expected: failures for `coupons service` (module not found).

- [ ] **Step 3: Create `services/coupons.js`**

```js
// services/coupons.js

export function generateCouponCode(leadName) {
  const first = (leadName || '').split(' ')[0].toUpperCase().replace(/[^A-Z]/g, '')
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return first ? `LYNKRO-${first}-${rand}` : `LYNKRO-${rand}${rand}`
}

export function buildCouponDbRecord(accountId, storeId, platform, code, config, platformCouponId = null) {
  const expiresAt = config.recovery_coupon_expiration_hours
    ? Date.now() + config.recovery_coupon_expiration_hours * 3600_000
    : null
  return {
    account_id: accountId,
    store_id: storeId,
    platform_coupon_id: platformCouponId,
    coupon_code: code,
    discount_type: config.recovery_coupon_discount_type || 'percent',
    discount_value: config.recovery_coupon_discount_value ?? 10,
    expires_at: expiresAt,
    minimum_order_amount: config.recovery_coupon_minimum_order_amount || null,
    usage_limit: config.recovery_coupon_usage_limit ?? 1,
    status: 'created'
  }
}

export async function createWooCoupon(storeUrl, consumerKey, consumerSecret, code, config) {
  const expiresAt = config.recovery_coupon_expiration_hours
    ? new Date(Date.now() + config.recovery_coupon_expiration_hours * 3600_000).toISOString().split('T')[0]
    : undefined

  const body = {
    code,
    discount_type: config.recovery_coupon_discount_type === 'fixed' ? 'fixed_cart' : 'percent',
    amount: String(config.recovery_coupon_discount_value ?? 10),
    individual_use: true,
    usage_limit: config.recovery_coupon_usage_limit ?? 1,
    ...(config.recovery_coupon_minimum_order_amount
      ? { minimum_amount: String(config.recovery_coupon_minimum_order_amount) }
      : {}),
    ...(expiresAt ? { date_expires: expiresAt } : {})
  }

  const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')
  const res = await fetch(`${storeUrl}/wp-json/wc/v3/coupons`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${credentials}`
    },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`WooCommerce coupon API error ${res.status}: ${text}`)
  }

  const data = await res.json()
  return { platformCouponId: String(data.id) }
}

export async function createShopifyCoupon(storeUrl, accessToken, code, config) {
  const expiresAt = config.recovery_coupon_expiration_hours
    ? new Date(Date.now() + config.recovery_coupon_expiration_hours * 3600_000).toISOString()
    : null

  // Step 1: Create price rule
  const ruleBody = {
    price_rule: {
      title: code,
      target_type: 'line_item',
      target_selection: 'all',
      allocation_method: 'across',
      value_type: config.recovery_coupon_discount_type === 'fixed' ? 'fixed_amount' : 'percentage',
      value: `-${config.recovery_coupon_discount_value ?? 10}`,
      customer_selection: 'all',
      usage_limit: config.recovery_coupon_usage_limit ?? 1,
      starts_at: new Date().toISOString(),
      ...(expiresAt ? { ends_at: expiresAt } : {}),
      ...(config.recovery_coupon_minimum_order_amount
        ? { prerequisite_subtotal_range: { greater_than_or_equal_to: String(config.recovery_coupon_minimum_order_amount) } }
        : {})
    }
  }

  const baseUrl = storeUrl.replace(/\/$/, '')
  const headers = {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': accessToken
  }

  const ruleRes = await fetch(`${baseUrl}/admin/api/2024-01/price_rules.json`, {
    method: 'POST',
    headers,
    body: JSON.stringify(ruleBody)
  })

  if (!ruleRes.ok) {
    const text = await ruleRes.text()
    throw new Error(`Shopify price_rule error ${ruleRes.status}: ${text}`)
  }

  const { price_rule } = await ruleRes.json()

  // Step 2: Create discount code under the price rule
  const codeRes = await fetch(`${baseUrl}/admin/api/2024-01/price_rules/${price_rule.id}/discount_codes.json`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ discount_code: { code } })
  })

  if (!codeRes.ok) {
    const text = await codeRes.text()
    throw new Error(`Shopify discount_code error ${codeRes.status}: ${text}`)
  }

  return { platformCouponId: String(price_rule.id) }
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm test 2>&1 | tail -20
```

Expected: 46 tests pass (42 existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add services/coupons.js tests/recovery.test.js
git commit -m "feat: add coupons service (code generation, WooCommerce/Shopify API)"
```

---

## Task 2: `services/recovery.js`

**Files:**
- Create: `services/recovery.js`
- Modify: `tests/recovery.test.js` (add describe block)

### What this file does

```js
export function getEligibleConversations(db)      // query returning rows ready for recovery
export function buildRecoveryEmail(opts)           // pure: returns { subject, html, text }
export async function sendRecoveryEmail(db, conv, cfg, companyId)  // orchestrates coupon + email
```

### Steps

- [ ] **Step 1: Add tests to `tests/recovery.test.js`**

Append after the `coupons service` describe block:

```js
import { buildRecoveryEmail, getEligibleConversations } from '../services/recovery.js'
import Database from 'better-sqlite3'
import { applyCommerceSchema } from '../db-commerce.js'

describe('recovery service', () => {
  test('buildRecoveryEmail returns subject and html', () => {
    const email = buildRecoveryEmail({
      leadName: 'Ana',
      products: [{ title: 'Blue T-Shirt', price: 25, currency: 'USD', product_url: 'https://test.com/blue' }],
      couponCode: 'LYNKRO-ANA-TEST',
      expirationDate: '2026-06-20',
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

  test('getEligibleConversations queries correctly', () => {
    const db = new Database(':memory:')
    // minimal schema for conversations + commerce_conversations
    db.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, company_id TEXT, lead_email TEXT,
        created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE commerce_conversations (
        id TEXT PRIMARY KEY, account_id TEXT, session_id TEXT,
        contact_id TEXT, products_discussed TEXT,
        purchase_detected INTEGER DEFAULT 0,
        recovery_email_sent INTEGER DEFAULT 0,
        created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE companies (
        id TEXT PRIMARY KEY, name TEXT, slug TEXT, active INTEGER DEFAULT 1,
        config TEXT DEFAULT '{}', created_at INTEGER, expires_at INTEGER,
        commerce_pro_enabled INTEGER DEFAULT 1,
        commerce_pro_status TEXT DEFAULT 'active',
        commerce_pro_source TEXT, stripe_customer_id TEXT,
        stripe_subscription_id TEXT, stripe_checkout_session_id TEXT,
        discovery_call_status TEXT DEFAULT 'not_required',
        onboarding_status TEXT DEFAULT 'not_started'
      );
    `)

    const now = Date.now()
    const twoHoursAgo = now - 2 * 3600_000
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
      CREATE TABLE conversations (id TEXT PRIMARY KEY, company_id TEXT, lead_email TEXT, created_at INTEGER, updated_at INTEGER);
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
```

- [ ] **Step 2: Run tests — expect failures for recovery service**

```bash
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm test 2>&1 | grep -E "fail|pass|recovery"
```

- [ ] **Step 3: Create `services/recovery.js`**

```js
// services/recovery.js
import nodemailer from 'nodemailer'
import { generateCouponCode, buildCouponDbRecord, createWooCoupon, createShopifyCoupon } from './coupons.js'
import { decryptCredential } from '../db-commerce.js'

const DEFAULT_DELAY_MS = 60 * 60_000  // 60 minutes

export function getEligibleConversations(db, delayOverrideMs = null) {
  const cutoff = Date.now() - (delayOverrideMs ?? DEFAULT_DELAY_MS)
  return db.prepare(`
    SELECT cc.*, conv.lead_email, conv.lead_name
    FROM commerce_conversations cc
    JOIN conversations conv ON conv.id = cc.session_id
    JOIN companies comp ON comp.id = cc.account_id
    WHERE cc.purchase_detected = 0
      AND cc.recovery_email_sent = 0
      AND cc.products_discussed IS NOT NULL
      AND cc.products_discussed != '[]'
      AND cc.updated_at < ?
      AND conv.lead_email IS NOT NULL
      AND comp.commerce_pro_enabled = 1
      AND comp.commerce_pro_status = 'active'
  `).all(cutoff)
}

export function buildRecoveryEmail({ leadName, products, couponCode, expirationDate, storeUrl }) {
  const name = leadName || 'Cliente'
  const productLines = products.map(p =>
    `→ ${p.title} — ${p.currency || 'USD'} ${p.price} · ${p.product_url}`
  ).join('\n')

  const productHtml = products.map(p =>
    `<tr><td style="padding:8px 0"><a href="${p.product_url}" style="color:#35d472;font-weight:bold">${p.title}</a> — ${p.currency || 'USD'} ${p.price}</td></tr>`
  ).join('')

  const couponBlock = couponCode
    ? `<p>Usá el código <strong>${couponCode}</strong>${expirationDate ? ` antes del ${expirationDate}` : ''}.</p>`
    : ''

  const couponText = couponCode
    ? `\nUsá el código ${couponCode}${expirationDate ? ` antes del ${expirationDate}` : ''}.\n`
    : ''

  const subject = `Tus recomendaciones + ${couponCode ? 'un descuento especial, ' : ''}${name}`

  const html = `<!DOCTYPE html>
<html><body style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px;background:#f9f9f9">
  <div style="background:#fff;border-radius:8px;padding:32px">
    <h2 style="color:#0a0a0a">Hola ${name},</h2>
    <p>Gracias por chatear con nosotros. Te recomendamos:</p>
    <table style="width:100%;border-collapse:collapse">${productHtml}</table>
    ${couponBlock}
    <p><a href="${storeUrl}" style="background:#35d472;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:16px">Ver productos</a></p>
  </div>
</body></html>`

  const text = `Hola ${name},\n\nGracias por chatear con nosotros. Te recomendamos:\n${productLines}${couponText}\nVer productos: ${storeUrl}\n`

  return { subject, html, text }
}

function getMailer(cfg) {
  if (!cfg.smtpHost || !cfg.notifyEmail) return null
  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port: parseInt(cfg.smtpPort) || 587,
    secure: !!cfg.smtpSecure,
    auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined
  })
}

export async function sendRecoveryEmail(db, conv, cfg) {
  const commerceConfig = cfg.commerce || {}
  const storeUrl = cfg.storeUrl || cfg.websiteUrl || 'https://tienda.com'

  // Fetch discussed products
  const productIds = JSON.parse(conv.products_discussed || '[]')
  if (!productIds.length) return { skipped: 'no products' }

  const products = productIds
    .map(id => db.prepare('SELECT * FROM commerce_products WHERE id = ?').get(id))
    .filter(Boolean)
    .filter(p => p.product_url)
    .slice(0, 3)

  if (!products.length) return { skipped: 'no valid products' }

  // Coupon
  let couponCode = null
  let expirationDate = null
  let couponId = null

  if (commerceConfig.recovery_coupon_enabled) {
    couponCode = generateCouponCode(conv.lead_name)
    const expirationHours = commerceConfig.recovery_coupon_expiration_hours || 48
    expirationDate = new Date(Date.now() + expirationHours * 3600_000)
      .toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })

    // Find the store for this company to create platform coupon
    const store = db.prepare(`
      SELECT * FROM commerce_stores WHERE account_id = ? AND id = (
        SELECT store_id FROM commerce_products WHERE id = ? LIMIT 1
      )
    `).get(conv.account_id, productIds[0])

    if (store) {
      try {
        let platformResult = null
        if (store.platform === 'woocommerce' && store.consumer_key_encrypted) {
          const key = decryptCredential(store.consumer_key_encrypted)
          const secret = decryptCredential(store.consumer_secret_encrypted)
          platformResult = await createWooCoupon(store.store_url, key, secret, couponCode, commerceConfig)
        } else if (store.platform === 'shopify' && store.access_token_encrypted) {
          const token = decryptCredential(store.access_token_encrypted)
          platformResult = await createShopifyCoupon(store.store_url, token, couponCode, commerceConfig)
        }

        const rec = buildCouponDbRecord(conv.account_id, store.id, store.platform, couponCode, commerceConfig, platformResult?.platformCouponId)
        couponId = crypto.randomUUID()
        db.prepare(`INSERT INTO commerce_coupons
          (id, account_id, store_id, platform_coupon_id, coupon_code, discount_type, discount_value,
           expires_at, minimum_order_amount, usage_limit, contact_id, conversation_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          couponId, rec.account_id, rec.store_id, rec.platform_coupon_id, rec.coupon_code,
          rec.discount_type, rec.discount_value, rec.expires_at, rec.minimum_order_amount,
          rec.usage_limit, conv.contact_id, conv.id, rec.status, Date.now(), Date.now()
        )
      } catch (err) {
        console.warn(`[recovery] coupon creation failed for ${conv.id}:`, err.message)
        // Continue without coupon rather than blocking the email
      }
    }
  }

  // Email
  const mailer = getMailer(cfg)
  if (!mailer) {
    return { skipped: 'no SMTP config' }
  }

  const email = buildRecoveryEmail({
    leadName: conv.lead_name,
    products,
    couponCode,
    expirationDate,
    storeUrl
  })

  await mailer.sendMail({
    from: cfg.smtpUser || cfg.notifyEmail,
    to: conv.lead_email,
    subject: email.subject,
    html: email.html,
    text: email.text
  })

  // Mark sent
  db.prepare('UPDATE commerce_conversations SET recovery_email_sent = 1, recovery_coupon_code = ?, updated_at = ? WHERE id = ?')
    .run(couponCode, Date.now(), conv.id)

  if (couponId) {
    db.prepare("UPDATE commerce_coupons SET status = 'sent', updated_at = ? WHERE id = ?").run(Date.now(), couponId)
  }

  return { sent: true, email: conv.lead_email, couponCode }
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm test 2>&1 | tail -20
```

Expected: 50 tests pass (46 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add services/recovery.js tests/recovery.test.js
git commit -m "feat: add recovery service (email template, eligible conversations query, coupon orchestration)"
```

---

## Task 3: Wire recovery job + extend order webhooks

**Files:**
- Modify: `jobs/sync-scheduler.js`
- Modify: `routes/commerce.js`

### What to add

**`jobs/sync-scheduler.js`:** Import `sendRecoveryEmail` and `getEligibleConversations` from recovery.js. Add `runRecoveryJob()` and wire `setInterval(runRecoveryJob, 15 * 60 * 1000)`.

**`routes/commerce.js`:** In both `/shopify-order` and `/woocommerce-order` handlers, after setting `purchase_detected=1`, also mark open coupons as 'used'.

### Steps

- [ ] **Step 1: Modify `jobs/sync-scheduler.js`**

Add at top of file:
```js
import { getEligibleConversations, sendRecoveryEmail } from '../services/recovery.js'
import { loadConfig } from '../db.js'
```

Add before the final `console.log`:
```js
async function runRecoveryJob() {
  const eligible = getEligibleConversations(db)
  if (!eligible.length) return

  console.log(`[recovery-job] Processing ${eligible.length} eligible conversation(s)`)

  for (const conv of eligible) {
    try {
      const cfg = loadConfig(conv.account_id)
      const result = await sendRecoveryEmail(db, conv, cfg)
      if (result.sent) {
        console.log(`[recovery-job] Recovery email sent to ${result.email}`)
      } else {
        console.log(`[recovery-job] Skipped ${conv.id}: ${result.skipped}`)
      }
    } catch (err) {
      console.error(`[recovery-job] Error for conversation ${conv.id}:`, err.message)
    }
  }
}

setInterval(runRecoveryJob, 15 * 60 * 1000)
console.log('[sync-scheduler] Recovery job started (every 15 minutes)')
```

Note: `loadConfig` is already used in routes/admin.js — check its export from `db.js`. If it's not exported there, check where it's defined. It loads `JSON.parse(company.config || '{}')` merged with defaults. If not available from db.js, use the DB directly:
```js
// Alternative if loadConfig not exported from db.js:
function getCompanyConfig(companyId) {
  const company = db.prepare('SELECT config FROM companies WHERE id = ?').get(companyId)
  return JSON.parse(company?.config || '{}')
}
```

- [ ] **Step 2: Extend `/shopify-order` and `/woocommerce-order` in `routes/commerce.js`**

In the `/shopify-order` handler, after the UPDATE to `purchase_detected=1`, add:
```js
// Mark open coupons as used
db.prepare(`
  UPDATE commerce_coupons SET status='used', updated_at=?
  WHERE contact_id=? AND status IN ('created','sent')
`).run(Date.now(), order.email)
```

In the `/woocommerce-order` handler, after the UPDATE to `purchase_detected=1`, add:
```js
// Mark open coupons as used
db.prepare(`
  UPDATE commerce_coupons SET status='used', updated_at=?
  WHERE contact_id=? AND status IN ('created','sent')
`).run(Date.now(), email)
```

- [ ] **Step 3: Verify loadConfig is available**

```bash
grep -n "export.*loadConfig\|export function loadConfig\|export const loadConfig" /root/mi-agente-ia/db.js | head -5
```

If not exported, add it. It reads `JSON.parse(company.config || '{}')` from DB. But check admin.js to see how it's defined there — do NOT duplicate if already in db.js.

- [ ] **Step 4: Run full tests + smoke test**

```bash
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm test 2>&1 | tail -20
```

Expected: all 50 tests pass.

```bash
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") ADMIN_PASSWORD=test timeout 6 node server.js 2>&1 || true
```

Expected: both scheduler lines appear:
```
[sync-scheduler] Catalog sync scheduler started (every 6 hours)
[sync-scheduler] Recovery job started (every 15 minutes)
```

- [ ] **Step 5: Commit**

```bash
git add jobs/sync-scheduler.js routes/commerce.js
git commit -m "feat: add 15-min recovery job and coupon-used tracking on order webhooks"
```

---

## Task 4: Final integration test + tag `phase4-commerce-pro`

**Files:** None (verification only)

- [ ] **Step 1: Full test suite**

```bash
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm test 2>&1 | tail -20
```

Expected: all 50 tests pass, 0 fail.

- [ ] **Step 2: Verify exports**

```bash
node --input-type=module << 'EOF'
import { generateCouponCode, buildCouponDbRecord } from '/root/mi-agente-ia/services/coupons.js'
import { buildRecoveryEmail, getEligibleConversations } from '/root/mi-agente-ia/services/recovery.js'
console.assert(generateCouponCode('Test').startsWith('LYNKRO-'), 'wrong prefix')
console.assert(typeof buildRecoveryEmail === 'function', 'missing buildRecoveryEmail')
console.log('Phase 4 exports OK')
EOF
```

- [ ] **Step 3: Server boot check**

```bash
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") ADMIN_PASSWORD=test timeout 6 node server.js 2>&1 || true
```

Expected: both scheduler logs, no errors.

- [ ] **Step 4: Tag**

```bash
git tag phase4-commerce-pro && git tag -l "phase*"
```

Expected: `phase1-commerce-pro`, `phase2-commerce-pro`, `phase3-commerce-pro`, `phase4-commerce-pro`.
