# Lynkro Commerce Pro — Design Spec
**Date:** 2026-06-12  
**Project:** chat.lynkro.io (`mi-agente-ia`)  
**Status:** Approved

---

## 1. Context

`mi-agente-ia` is a multi-tenant AI chat system built on Node.js + Express + SQLite (better-sqlite3), deployed via Docker on Easypanel at `chat.lynkro.io`. It supports Web, WhatsApp (Baileys), and Instagram DM channels. Each tenant is a `company` row with a JSON `config` blob.

Lynkro Commerce Pro adds an AI sales assistant layer for e-commerce businesses (Shopify and WooCommerce), gated behind a monthly Stripe subscription.

---

## 2. Decisions

| Topic | Decision | Reason |
|---|---|---|
| Database | SQLite + tables in `db-commerce.js` | No new infra; current WAL mode handles concurrent writes |
| Vector search | FTS5 now, sqlite-vec later | No customers yet; FTS5 covers 85% of product queries |
| Pricing | Monthly subscription only (Stripe) | Simplest billing model |
| Discovery Call | GHL Calendar + webhook | GHL already integrated; auto-marks call as scheduled |
| Email | Nodemailer SMTP (existing) | Already configured per company |
| Architecture | Modular monolith (Option A) | Refactor server.js into routers; no new services |

---

## 3. File Structure

```
mi-agente-ia/
├── server.js                  ← Entry point, mounts routers (refactored)
├── db.js                      ← Base schema (existing, unchanged)
├── db-commerce.js             ← Commerce Pro tables and helpers (new)
├── routes/
│   ├── chat.js                ← /api/chat, /api/conversations (extracted)
│   ├── admin.js               ← /api/companies, /api/config (extracted)
│   ├── billing.js             ← /api/billing/* Stripe endpoints (new)
│   └── commerce.js            ← /api/commerce/* catalog and sync (new)
├── services/
│   ├── stripe.js              ← Checkout sessions, webhooks, customer portal
│   ├── ghl-calendar.js        ← GHL appointment webhook handler
│   ├── shopify.js             ← Shopify Admin REST API sync
│   ├── woocommerce.js         ← WooCommerce REST API v3 sync
│   └── recommendations.js    ← Upsell/downsell/alternatives engine
└── jobs/
    └── sync-scheduler.js      ← 6h catalog sync + 15min recovery job
```

The refactor of `server.js` → `routes/` happens alongside Phase 1, moving existing code without changing behavior.

---

## 4. Database Schema

### 4.1 Additions to `companies` table

Added via `softAlter` (idempotent, safe):

```sql
ALTER TABLE companies ADD COLUMN commerce_pro_enabled INTEGER DEFAULT 0;
ALTER TABLE companies ADD COLUMN commerce_pro_status TEXT DEFAULT 'inactive';
-- 'inactive' | 'pending_payment' | 'active' | 'past_due' | 'cancelled'
ALTER TABLE companies ADD COLUMN commerce_pro_source TEXT;
-- 'upgrade' | 'standalone'
ALTER TABLE companies ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE companies ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE companies ADD COLUMN stripe_checkout_session_id TEXT;
ALTER TABLE companies ADD COLUMN discovery_call_status TEXT DEFAULT 'not_required';
-- 'not_required' | 'required' | 'scheduled' | 'completed'
ALTER TABLE companies ADD COLUMN onboarding_status TEXT DEFAULT 'not_started';
-- 'not_started' | 'payment_completed' | 'discovery_scheduled' | 'in_setup' | 'live'
```

### 4.2 `commerce_stores`

```sql
CREATE TABLE IF NOT EXISTS commerce_stores (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  platform TEXT NOT NULL,           -- 'shopify' | 'woocommerce'
  store_url TEXT NOT NULL,
  access_token_encrypted TEXT,      -- Shopify
  consumer_key_encrypted TEXT,      -- WooCommerce
  consumer_secret_encrypted TEXT,   -- WooCommerce
  sync_status TEXT DEFAULT 'idle',  -- 'idle' | 'syncing' | 'error'
  last_sync_at INTEGER,
  created_at INTEGER,
  updated_at INTEGER,
  FOREIGN KEY(account_id) REFERENCES companies(id)
);
```

### 4.3 `commerce_products`

```sql
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
  stock_status TEXT DEFAULT 'instock',  -- 'instock' | 'outofstock' | 'backorder'
  inventory_quantity INTEGER,
  product_url TEXT,
  image_url TEXT,
  brand TEXT,
  category TEXT,
  tags TEXT,        -- JSON array
  attributes TEXT,  -- JSON object
  allow_backorder INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  last_synced_at INTEGER,
  created_at INTEGER,
  updated_at INTEGER,
  FOREIGN KEY(account_id) REFERENCES companies(id),
  FOREIGN KEY(store_id) REFERENCES commerce_stores(id)
);

-- FTS5 index for product search
CREATE VIRTUAL TABLE IF NOT EXISTS commerce_products_fts USING fts5(
  product_id UNINDEXED,
  account_id UNINDEXED,
  title,
  description,
  category,
  tags,
  tokenize='unicode61 remove_diacritics 2'
);
```

### 4.4 `commerce_product_relations`

```sql
CREATE TABLE IF NOT EXISTS commerce_product_relations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  source_product_id TEXT NOT NULL,
  target_product_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  -- 'alternative' | 'upsell' | 'downsell' | 'cross_sell' | 'bundle' | 'replacement'
  priority INTEGER DEFAULT 0,
  reason TEXT,
  created_by TEXT DEFAULT 'admin',  -- 'system' | 'admin' | 'ai'
  created_at INTEGER,
  updated_at INTEGER
);
```

### 4.5 `commerce_conversations`

```sql
CREATE TABLE IF NOT EXISTS commerce_conversations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  session_id TEXT,              -- links to conversations.id
  contact_id TEXT,              -- lead email / visitor identifier
  channel TEXT,
  purchase_detected INTEGER DEFAULT 0,
  products_discussed TEXT,      -- JSON array of product IDs
  cart_url TEXT,
  checkout_url TEXT,
  recovery_email_sent INTEGER DEFAULT 0,
  recovery_coupon_code TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
```

### 4.6 `commerce_coupons`

```sql
CREATE TABLE IF NOT EXISTS commerce_coupons (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  store_id TEXT,
  platform_coupon_id TEXT,
  coupon_code TEXT NOT NULL,
  discount_type TEXT,           -- 'percent' | 'fixed'
  discount_value REAL,
  expires_at INTEGER,
  minimum_order_amount REAL,
  usage_limit INTEGER DEFAULT 1,
  contact_id TEXT,
  conversation_id TEXT,
  status TEXT DEFAULT 'created', -- 'created' | 'sent' | 'used' | 'expired'
  created_at INTEGER,
  updated_at INTEGER
);
```

All store credentials are encrypted with `crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY)` before storage. Never exposed to frontend.

---

## 5. Stripe Payment Flow

### 5.1 Upgrade (existing customer)

```
POST /api/billing/commerce-pro/upgrade
  → Create/retrieve Stripe Customer
  → Create Checkout Session (mode: 'subscription')
    metadata: { account_id, purchase_type: 'upgrade', product: 'commerce_pro' }
  → Return { url } → frontend redirects to Stripe Hosted Checkout
  → On success → webhook: checkout.session.completed
  → commerce_pro_enabled = 1, commerce_pro_status = 'active'
  → Redirect to /dashboard/commerce-pro
```

### 5.2 Standalone (new customer)

```
POST /api/billing/commerce-pro/checkout
  → Create company with active = 0, commerce_pro_status = 'pending_payment'
  → Create Checkout Session (mode: 'subscription')
    metadata: { account_id, purchase_type: 'standalone', product: 'commerce_pro' }
  → Return { url } → frontend redirects to Stripe Hosted Checkout
  → On success → webhook: checkout.session.completed
  → company.active = 1, commerce_pro_enabled = 1
  → discovery_call_status = 'required'
  → Redirect to /onboarding/commerce-pro/discovery
```

### 5.3 Webhook — `POST /api/billing/stripe/webhook`

Signature verified with `stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)`. Raw body preserved via `express.raw({ type: 'application/json' })` before JSON middleware.

| Event | Action |
|---|---|
| `checkout.session.completed` | Activate Commerce Pro; if standalone → set discovery_call_status = 'required' |
| `customer.subscription.updated` | Sync status field |
| `customer.subscription.deleted` | `commerce_pro_status = 'cancelled'`; disable features |
| `invoice.payment_succeeded` | `commerce_pro_status = 'active'` if was past_due |
| `invoice.payment_failed` | `commerce_pro_status = 'past_due'`; show billing warning |

### 5.4 Customer Portal — `POST /api/billing/customer-portal`

Creates Stripe Billing Portal session for the company's `stripe_customer_id`. Returns `{ url }`. User manages subscription (cancel, update card) in Stripe UI and returns to `STRIPE_CUSTOMER_PORTAL_RETURN_URL`.

---

## 6. Discovery Call Flow (GHL)

```
/onboarding/commerce-pro/discovery page
  → "Schedule your Discovery Call" button
  → Opens DISCOVERY_CALL_BOOKING_URL (GHL Calendar link)
  → Customer books appointment in GHL
  → GHL fires appointment webhook
  → POST /api/billing/ghl-calendar/webhook
    Header: x-ghl-secret (verified against GHL_WEBHOOK_SECRET)
  → Match contact email → companies record
  → discovery_call_status = 'scheduled'
  → onboarding_status = 'discovery_scheduled'
```

Lynkro team manually sets `in_setup` and `live` from the admin panel.

**Onboarding status progression:**
```
not_started → payment_completed → discovery_scheduled → in_setup → live
```

### Feature Gate Middleware

```js
function requireCommercePro(req, res, next) {
  if (!req.company.commerce_pro_enabled ||
      req.company.commerce_pro_status !== 'active') {
    return res.status(403).json({
      error: 'Commerce Pro requerido',
      upgrade_url: '/billing/upgrade'
    })
  }
  next()
}
```

Applied to all `/api/commerce/*` endpoints.

---

## 7. E-commerce Integrations

### 7.1 Connection

```
POST /api/commerce/stores/connect-shopify   { store_url, access_token }
POST /api/commerce/stores/connect-woocommerce { store_url, consumer_key, consumer_secret }
  → Encrypt credentials with AES-256-GCM
  → Save to commerce_stores
  → Trigger immediate first sync
```

### 7.2 Normalized product object

Both platforms produce:
```js
{
  platform_product_id, platform_variant_id,
  title, description, short_description,
  price, compare_at_price, currency,
  sku, stock_status,        // 'instock' | 'outofstock' | 'backorder'
  inventory_quantity,
  product_url, image_url,
  brand, category, tags[],
  attributes: {}
}
```

**Shopify:** Admin REST API `/admin/api/2024-01/products.json`. Paginated with `page_info`. `product_url = store_url/products/{handle}`.

**WooCommerce:** REST API v3 `/wp-json/wc/v3/products`. Paginated with `page + per_page=100`. `product_url = product.permalink`.

### 7.3 Sync endpoint

```
POST /api/commerce/stores/:storeId/sync
  1. requireCommercePro
  2. Fetch all products (paginated)
  3. For each product: UPSERT in commerce_products + update FTS5 index
  4. Mark products not in response as is_active = 0
  5. Update last_sync_at in commerce_stores
  6. Log sync result (total, new, updated, errors)
```

### 7.4 Scheduled sync

`jobs/sync-scheduler.js` runs `setInterval` every 6 hours, iterating all stores where `company.commerce_pro_status = 'active'`.

### 7.5 Real-time webhooks

| Platform | Event | Endpoint |
|---|---|---|
| Shopify | `products/create`, `products/update`, `products/delete` | `POST /api/commerce/webhooks/shopify` |
| WooCommerce | `product.created`, `product.updated`, `product.deleted` | `POST /api/commerce/webhooks/woocommerce` |

Shopify verified via HMAC-SHA256 (`X-Shopify-Hmac-Sha256`). WooCommerce via `X-WC-Webhook-Signature`.

---

## 8. AI Product Search and Recommendations

### 8.1 Claude tool use

When `commerce_pro_enabled = true`, the system prompt receives an additional commerce block and a `search_products` tool definition. Claude calls the tool when it detects purchase intent, product questions, or availability queries.

```js
// Tool definition injected into Claude API call
{
  name: 'search_products',
  description: 'Search the store catalog for products matching a query',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      intent: { 
        type: 'string',
        enum: ['search', 'availability', 'price', 'alternative', 'upsell', 'downsell']
      }
    }
  }
}
```

### 8.2 FTS5 search

```sql
SELECT p.* FROM commerce_products p
JOIN commerce_products_fts fts ON fts.product_id = p.id
WHERE fts MATCH ? AND p.account_id = ? AND p.is_active = 1
  AND p.stock_status = 'instock'
ORDER BY rank LIMIT 5
```

### 8.3 Recommendation engine (`services/recommendations.js`)

```
getAlternatives(productId, accountId)
  → commerce_product_relations WHERE type IN ('replacement','alternative') ORDER BY priority
  → Fallback: FTS5 same category + tags, instock, limit 3

getUpsell(productId, accountId)
  → commerce_product_relations WHERE type = 'upsell'
  → Fallback: same category, price > current product, instock, limit 1

getDownsell(productId, accountId)
  → commerce_product_relations WHERE type = 'downsell'
  → Fallback: same category, price < current product, instock, limit 1

getCrossSell(productId, accountId)
  → commerce_product_relations WHERE type = 'cross_sell'
```

### 8.4 Pre-send validation

Every product recommendation is validated before being sent to the user:

```js
function validateProductRecommendation(product) {
  if (!product.product_url) {
    logMissingUrl(product)  // logged for admin review
    return false
  }
  if (product.stock_status !== 'instock' && !product.allow_backorder) {
    return false
  }
  return true
}
```

### 8.5 Intent → action mapping

| User signal | Action |
|---|---|
| "¿tienen X?" | Search + show with URL |
| Product out of stock | Up to 3 alternatives with URLs |
| "el mejor" / high intent | Show upsell if available |
| "muy caro" / "más económico" | Show downsell |
| Product selected | Suggest cross-sell |
| No product URL | Do not recommend; log for admin |

---

## 9. Abandoned Conversation Recovery

### 9.1 Detection job (every 15 minutes)

Queries `commerce_conversations` for records where:
- `purchase_detected = 0`
- `recovery_email_sent = 0`
- `products_discussed` is non-empty JSON array
- `updated_at` older than `recovery_delay_minutes` (default: 60)
- Linked conversation has `lead_email IS NOT NULL`

### 9.2 Coupon generation

```js
function generateCouponCode(leadName) {
  const first = (leadName || '').split(' ')[0].toUpperCase().replace(/[^A-Z]/g, '')
  const rand = Math.random().toString(36).slice(2,6).toUpperCase()
  return first ? `LYNKRO-${first}-${rand}` : `LYNKRO-${rand}${rand}`
}
```

If `recovery_coupon_enabled = true`:
1. Generate code
2. Create coupon in WooCommerce (`POST /wp-json/wc/v3/coupons`) or Shopify discount API
3. Save to `commerce_coupons` with `status = 'created'`

### 9.3 Recovery email

Uses existing nodemailer SMTP (`cfg.smtpHost`). Template:

```
Subject: Tus recomendaciones + un descuento especial, {{name}}

Hola {{name}},

Gracias por chatear con nosotros. Te recomendamos:
→ {{product_name}} — {{price}} · {{product_url}}

Usá el código {{coupon_code}} antes del {{expiration_date}}.

[Ver productos]

Para no recibir más emails: {{unsubscribe_url}}
```

After sending: `recovery_email_sent = 1`, `commerce_coupons.status = 'sent'`.

### 9.4 Purchase detection

```
POST /api/commerce/webhooks/shopify-order
POST /api/commerce/webhooks/woocommerce-order
  → Extract customer email from order
  → Find commerce_conversation by account_id + lead_email
  → purchase_detected = 1
  → Cancel pending recovery
  → If coupon used → commerce_coupons.status = 'used'
```

### 9.5 Per-company recovery config (in `companies.config`)

```json
{
  "commerce": {
    "recovery_coupon_enabled": true,
    "recovery_coupon_discount_type": "percent",
    "recovery_coupon_discount_value": 10,
    "recovery_coupon_expiration_hours": 48,
    "recovery_coupon_minimum_order_amount": null,
    "recovery_coupon_usage_limit": 1,
    "recovery_delay_minutes": 60
  }
}
```

---

## 10. Admin Dashboard

New sections added to `public/admin.html`:

**Billing section:** Current plan status, next billing date, "Manage billing" button (→ Stripe Customer Portal), upgrade prompt if inactive.

**Store connection:** Platform badge, store URL, last sync timestamp, product count, sync errors, "Sync now" button, "Disconnect" button.

**Product relations editor:** Table of source → relation_type → target. Add/edit/delete manually. Backed by `GET/POST/PUT/DELETE /api/commerce/product-relations`.

**Recovery settings:** Toggle coupon on/off, discount amount, expiration, minimum order, delay minutes.

**Analytics (`GET /api/commerce/analytics`):**

```js
{
  products_discussed: number,
  top_products: [{ title, count, stock_status }],  // top 5
  out_of_stock_requests: number,
  alternatives_shown: number,
  upsell_shown: number,
  recovery_emails_sent: number,
  recovery_emails_converted: number,
  conversion_rate: string,
  revenue_attributed: number
}
```

All computed with direct SQLite queries, no external analytics service.

---

## 11. API Endpoints

```
# Billing
POST /api/billing/commerce-pro/checkout      ← new standalone purchase
POST /api/billing/commerce-pro/upgrade       ← existing customer upgrade
POST /api/billing/stripe/webhook             ← Stripe events (raw body)
POST /api/billing/customer-portal           ← Stripe portal session
POST /api/billing/ghl-calendar/webhook      ← GHL appointment booked

# Commerce (all require requireCommercePro)
POST /api/commerce/stores/connect-shopify
POST /api/commerce/stores/connect-woocommerce
POST /api/commerce/stores/:storeId/sync
GET  /api/commerce/products
GET  /api/commerce/products/:id
GET  /api/commerce/product-relations
POST /api/commerce/product-relations
PUT  /api/commerce/product-relations/:id
DELETE /api/commerce/product-relations/:id
POST /api/commerce/chat/recommend
GET  /api/commerce/analytics

# Webhooks (platform events)
POST /api/commerce/webhooks/shopify
POST /api/commerce/webhooks/woocommerce
POST /api/commerce/webhooks/shopify-order
POST /api/commerce/webhooks/woocommerce-order
```

---

## 12. Environment Variables

```env
# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_COMMERCE_PRO_PRICE_ID=
STRIPE_CUSTOMER_PORTAL_RETURN_URL=

# Discovery Call
DISCOVERY_CALL_BOOKING_URL=
GHL_WEBHOOK_SECRET=

# Platform webhooks
SHOPIFY_WEBHOOK_SECRET=
WOOCOMMERCE_WEBHOOK_SECRET=

# Security
ENCRYPTION_KEY=                 # 32-byte hex string for AES-256-GCM
```

---

## 13. Security

- All store credentials encrypted at rest with AES-256-GCM before INSERT
- `ENCRYPTION_KEY` only in `.env`, never logged or exposed
- Stripe webhook: `stripe.webhooks.constructEvent` with raw body (not parsed JSON)
- GHL webhook: `x-ghl-secret` header verified against `GHL_WEBHOOK_SECRET`
- Shopify webhook: HMAC-SHA256 verified against `SHOPIFY_WEBHOOK_SECRET`
- WooCommerce webhook: signature verified against `WOOCOMMERCE_WEBHOOK_SECRET`
- `requireCommercePro` middleware on all commerce endpoints
- No Stripe secret keys or platform credentials exposed to frontend
- Unsubscribe link in all recovery emails

---

## 14. Implementation Phases

| Phase | Scope | Key deliverables |
|---|---|---|
| **1** | Stripe + entitlements + Discovery Call | `routes/billing.js`, `services/stripe.js`, `services/ghl-calendar.js`, `db-commerce.js` schema only |
| **2** | Shopify + WooCommerce sync | `services/shopify.js`, `services/woocommerce.js`, `routes/commerce.js` (stores + sync), `jobs/sync-scheduler.js` |
| **3** | AI product search + recommendations | `services/recommendations.js`, Claude tool use integration, FTS5 product search |
| **4** | Abandoned recovery + coupons | Recovery job in scheduler, coupon generation, recovery email, purchase detection webhooks |
| **5** | Admin dashboard + analytics | `public/admin.html` extensions, `GET /api/commerce/analytics` |

Each phase is independently deployable and testable before the next begins.

---

## 15. Success Criteria

1. Existing users can upgrade to Commerce Pro through Stripe
2. New users can purchase as standalone and are redirected to GHL Discovery Call
3. GHL appointment webhook automatically marks call as scheduled
4. Stripe webhooks correctly activate, suspend, and cancel Commerce Pro
5. Shopify products sync into `commerce_products` with correct URLs and stock status
6. WooCommerce products sync into `commerce_products` with correct URLs and stock status
7. Chat recommends products with valid purchase links using Claude tool use
8. Chat suggests alternatives when a product is out of stock
9. Chat makes upsell and downsell recommendations based on user signals
10. Abandoned product conversations trigger recovery emails after configured delay
11. Recovery emails include unique coupon codes with expiration dates
12. Coupons are created in the connected store
13. Purchase detection cancels pending recovery emails
14. Admin can manage product relations and recovery settings
15. Analytics show conversations, recommendations, coupons, and attributed revenue
16. All platform credentials encrypted at rest
17. Commerce Pro features disabled when subscription is past_due or cancelled
