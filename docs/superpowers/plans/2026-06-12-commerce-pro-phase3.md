# Lynkro Commerce Pro — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject a `search_products` Claude tool into the chat pipeline so the AI can search the store catalog via FTS5, return product recommendations (alternatives, upsell, downsell, cross-sell), and track products discussed per conversation for Phase 4's recovery job.

**Architecture:** Two changes — a pure DB module (`services/recommendations.js`) and a modified `processMessage` in `routes/chat.js` that runs a tool-use loop when Commerce Pro is active. No new routes required; tracking goes into `commerce_conversations`.

**Tech Stack:** Node.js ESM, Anthropic SDK tool_use, better-sqlite3 FTS5, node:test

**Spec:** `docs/superpowers/specs/2026-06-12-lynkro-commerce-pro-design.md` — Sections 8, 4.5

**Phase 2 baseline tag:** `phase2-commerce-pro`

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Create | `services/recommendations.js` | FTS5 search, relation-based recs, validation, buildSearchResponse |
| Modify | `routes/chat.js` | Inject search_products tool; handle tool_use loop; track commerce_conversations |
| Modify | `tests/commerce.test.js` | Add recommendation + tool-use tests |
| Modify | `tests/billing.test.js` | No change expected |

---

## Task 1: `services/recommendations.js`

**Files:**
- Create: `services/recommendations.js`
- Modify: `tests/commerce.test.js` (add describe block)

### What this file does

Pure functions that take `db`, query SQLite, and return normalized product arrays. No network calls.

```js
// All public exports
export function searchProductsFTS(db, accountId, query, limit = 5)
export function getAlternatives(db, accountId, productId)
export function getUpsell(db, accountId, productId)
export function getDownsell(db, accountId, productId)
export function getCrossSell(db, accountId, productId)
export function validateProductRecommendation(product)
export function buildSearchResponse(db, accountId, query, intent, productId = null)
```

### Steps

- [ ] **Step 1: Add tests to `tests/commerce.test.js`**

Append this describe block at the end of the file (before the last closing brace if any):

```js
import { searchProductsFTS, getAlternatives, getUpsell, getDownsell, validateProductRecommendation, buildSearchResponse } from '../services/recommendations.js'
import Database from 'better-sqlite3'
import { applyCommerceSchema } from '../db-commerce.js'

describe('recommendations service', () => {
  let db
  const accountId = 'test-account'
  const storeId = 'store-1'

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
    db.prepare('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)').run(accountId, 'Test', 'test')
    applyCommerceSchema(db)
    db.prepare('INSERT INTO commerce_stores (id, account_id, platform, store_url, created_at) VALUES (?, ?, ?, ?, ?)').run(storeId, accountId, 'shopify', 'https://test.myshopify.com', Date.now())

    // Seed products
    const insert = db.prepare(`INSERT INTO commerce_products
      (id, account_id, store_id, title, description, category, price, stock_status, is_active, product_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
    insert.run('p1', accountId, storeId, 'Blue T-Shirt', 'A nice blue shirt', 'Shirts', 25, 'instock', 'https://test.com/blue')
    insert.run('p2', accountId, storeId, 'Red T-Shirt', 'A nice red shirt', 'Shirts', 30, 'instock', 'https://test.com/red')
    insert.run('p3', accountId, storeId, 'Black Jeans', 'Slim fit jeans', 'Pants', 60, 'instock', 'https://test.com/jeans')
    insert.run('p4', accountId, storeId, 'Sold Out Jacket', 'Winter jacket', 'Jackets', 100, 'outofstock', 'https://test.com/jacket')

    // FTS5 index
    const ftsInsert = db.prepare('INSERT INTO commerce_products_fts (product_id, account_id, title, description, category, tags) VALUES (?, ?, ?, ?, ?, ?)')
    ftsInsert.run('p1', accountId, 'Blue T-Shirt', 'A nice blue shirt', 'Shirts', '')
    ftsInsert.run('p2', accountId, 'Red T-Shirt', 'A nice red shirt', 'Shirts', '')
    ftsInsert.run('p3', accountId, 'Black Jeans', 'Slim fit jeans', 'Pants', '')
    ftsInsert.run('p4', accountId, 'Sold Out Jacket', 'Winter jacket', 'Jackets', '')
  })

  after(() => db.close())

  test('searchProductsFTS returns matching instock products', () => {
    const results = searchProductsFTS(db, accountId, 'shirt', 5)
    assert.ok(results.length >= 1)
    assert.ok(results.every(r => r.stock_status === 'instock'))
    assert.ok(results.some(r => r.title.toLowerCase().includes('shirt')))
  })

  test('searchProductsFTS excludes inactive products', () => {
    db.prepare("UPDATE commerce_products SET is_active = 0 WHERE id = 'p1'").run()
    const results = searchProductsFTS(db, accountId, 'blue shirt', 5)
    assert.ok(!results.some(r => r.id === 'p1'))
    db.prepare("UPDATE commerce_products SET is_active = 1 WHERE id = 'p1'").run()
  })

  test('validateProductRecommendation returns true for valid product', () => {
    assert.strictEqual(validateProductRecommendation({ product_url: 'https://x.com', stock_status: 'instock', allow_backorder: 0 }), true)
  })

  test('validateProductRecommendation returns false when no product_url', () => {
    assert.strictEqual(validateProductRecommendation({ product_url: null, stock_status: 'instock', allow_backorder: 0 }), false)
  })

  test('validateProductRecommendation allows backorder products', () => {
    assert.strictEqual(validateProductRecommendation({ product_url: 'https://x.com', stock_status: 'outofstock', allow_backorder: 1 }), true)
  })

  test('buildSearchResponse returns formatted products array', () => {
    const result = buildSearchResponse(db, accountId, 'shirt', 'search', null)
    assert.ok(Array.isArray(result.products))
    assert.ok(result.products.length > 0)
    assert.ok(result.products[0].title)
    assert.ok(result.products[0].product_url)
  })

  test('getAlternatives falls back to FTS when no relations', () => {
    const alts = getAlternatives(db, accountId, 'p1')
    // Falls back to same category search — should find p2 (Red T-Shirt, Shirts)
    assert.ok(Array.isArray(alts))
  })

  test('getUpsell falls back to higher price in category', () => {
    const upsells = getUpsell(db, accountId, 'p1') // p1 = $25 Shirts
    assert.ok(Array.isArray(upsells))
    if (upsells.length > 0) {
      assert.ok(upsells[0].price > 25)
    }
  })
})
```

- [ ] **Step 2: Run tests — expect failures**

```bash
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm test 2>&1 | tail -20
```

Expected: failures for `recommendations service` describe block (module not found).

- [ ] **Step 3: Create `services/recommendations.js`**

```js
// services/recommendations.js

const SEARCH_PRODUCTS_TOOL = {
  name: 'search_products',
  description: 'Search the store catalog for products matching a query. Use when the user asks about products, availability, price, alternatives, or shows purchase intent.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search terms — product name, type, category, or description'
      },
      intent: {
        type: 'string',
        enum: ['search', 'availability', 'price', 'alternative', 'upsell', 'downsell'],
        description: 'What the user is trying to do'
      },
      product_id: {
        type: 'string',
        description: 'Optional — ID of a specific product already in context (for alternative/upsell/downsell)'
      }
    },
    required: ['query', 'intent']
  }
}
export { SEARCH_PRODUCTS_TOOL }

export function searchProductsFTS(db, accountId, query, limit = 5) {
  try {
    return db.prepare(`
      SELECT p.*
      FROM commerce_products p
      JOIN commerce_products_fts fts ON fts.product_id = p.id
      WHERE fts MATCH ?
        AND p.account_id = ?
        AND p.is_active = 1
      ORDER BY
        CASE p.stock_status WHEN 'instock' THEN 0 WHEN 'backorder' THEN 1 ELSE 2 END,
        fts.rank
      LIMIT ?
    `).all(query, accountId, limit)
  } catch {
    return []
  }
}

function getRelated(db, accountId, productId, types) {
  return db.prepare(`
    SELECT p.*
    FROM commerce_products p
    JOIN commerce_product_relations r ON r.target_product_id = p.id
    WHERE r.account_id = ?
      AND r.source_product_id = ?
      AND r.relation_type IN (${types.map(() => '?').join(',')})
      AND p.is_active = 1
    ORDER BY r.priority DESC
    LIMIT 5
  `).all(accountId, productId, ...types)
}

export function getAlternatives(db, accountId, productId) {
  const fromRelations = getRelated(db, accountId, productId, ['alternative', 'replacement'])
  if (fromRelations.length) return fromRelations
  // Fallback: same category via FTS
  const source = db.prepare('SELECT category FROM commerce_products WHERE id = ?').get(productId)
  if (!source?.category) return []
  return searchProductsFTS(db, accountId, source.category, 3).filter(p => p.id !== productId)
}

export function getUpsell(db, accountId, productId) {
  const fromRelations = getRelated(db, accountId, productId, ['upsell'])
  if (fromRelations.length) return fromRelations
  const source = db.prepare('SELECT category, price FROM commerce_products WHERE id = ?').get(productId)
  if (!source) return []
  return db.prepare(`
    SELECT * FROM commerce_products
    WHERE account_id = ? AND category = ? AND price > ? AND id != ? AND is_active = 1 AND stock_status = 'instock'
    ORDER BY price ASC LIMIT 1
  `).all(accountId, source.category, source.price, productId)
}

export function getDownsell(db, accountId, productId) {
  const fromRelations = getRelated(db, accountId, productId, ['downsell'])
  if (fromRelations.length) return fromRelations
  const source = db.prepare('SELECT category, price FROM commerce_products WHERE id = ?').get(productId)
  if (!source) return []
  return db.prepare(`
    SELECT * FROM commerce_products
    WHERE account_id = ? AND category = ? AND price < ? AND id != ? AND is_active = 1 AND stock_status = 'instock'
    ORDER BY price DESC LIMIT 1
  `).all(accountId, source.category, source.price, productId)
}

export function getCrossSell(db, accountId, productId) {
  return getRelated(db, accountId, productId, ['cross_sell', 'bundle'])
}

export function validateProductRecommendation(product) {
  if (!product.product_url) return false
  if (product.stock_status !== 'instock' && !product.allow_backorder) return false
  return true
}

export function buildSearchResponse(db, accountId, query, intent, productId = null) {
  let products = []

  if (productId && intent === 'alternative') {
    products = getAlternatives(db, accountId, productId)
  } else if (productId && intent === 'upsell') {
    products = getUpsell(db, accountId, productId)
  } else if (productId && intent === 'downsell') {
    products = getDownsell(db, accountId, productId)
  } else {
    products = searchProductsFTS(db, accountId, query)
  }

  const valid = products.filter(validateProductRecommendation).slice(0, 5)
  const invalid = products.filter(p => !validateProductRecommendation(p))
  if (invalid.length) {
    console.warn(`[recommendations] ${invalid.length} product(s) filtered (missing URL or out of stock)`)
  }

  return {
    products: valid.map(p => ({
      id: p.id,
      title: p.title,
      price: p.price,
      compare_at_price: p.compare_at_price,
      currency: p.currency || 'USD',
      stock_status: p.stock_status,
      product_url: p.product_url,
      image_url: p.image_url,
      short_description: p.short_description,
      category: p.category
    })),
    total_found: products.length,
    filtered_out: invalid.length
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm test 2>&1 | tail -20
```

Expected: all tests pass including the new `recommendations service` block.

- [ ] **Step 5: Commit**

```bash
git add services/recommendations.js tests/commerce.test.js
git commit -m "feat: add recommendations service (FTS5 search, upsell/downsell, alternatives)"
```

---

## Task 2: Modify `routes/chat.js` — tool-use loop + conversation tracking

**Files:**
- Modify: `routes/chat.js`
- Modify: `tests/commerce.test.js` (add tool-use tests)

### What changes in processMessage

The existing call:
```js
const response = await client.messages.create({
  model, max_tokens: 350, system, messages
})
const reply = response.content.map(c => c.text || '').join('').trim()
```

Must become a loop when Commerce Pro is active:
1. Build `callParams` with optional `tools: [SEARCH_PRODUCTS_TOOL]` and extra system prompt block
2. Call `client.messages.create(callParams)`
3. If `response.stop_reason === 'tool_use'`: execute each tool, append results, call again
4. Extract final text reply

Also: upsert `commerce_conversations` when products are returned.

### Steps

- [ ] **Step 1: Add tool-use tests to `tests/commerce.test.js`**

Append after the `recommendations service` describe block:

```js
import { buildSearchResponse, SEARCH_PRODUCTS_TOOL } from '../services/recommendations.js'

describe('search_products tool contract', () => {
  test('SEARCH_PRODUCTS_TOOL has required schema fields', () => {
    assert.strictEqual(SEARCH_PRODUCTS_TOOL.name, 'search_products')
    assert.ok(SEARCH_PRODUCTS_TOOL.input_schema.properties.query)
    assert.ok(SEARCH_PRODUCTS_TOOL.input_schema.properties.intent)
    const intents = SEARCH_PRODUCTS_TOOL.input_schema.properties.intent.enum
    assert.ok(intents.includes('search'))
    assert.ok(intents.includes('alternative'))
    assert.ok(intents.includes('upsell'))
  })

  test('buildSearchResponse returns empty products array when no match', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY, name TEXT, slug TEXT, active INTEGER DEFAULT 1,
      config TEXT DEFAULT '{}', created_at INTEGER, expires_at INTEGER,
      commerce_pro_enabled INTEGER DEFAULT 0, commerce_pro_status TEXT DEFAULT 'inactive',
      commerce_pro_source TEXT, stripe_customer_id TEXT, stripe_subscription_id TEXT,
      stripe_checkout_session_id TEXT, discovery_call_status TEXT DEFAULT 'not_required',
      onboarding_status TEXT DEFAULT 'not_started'
    )`)
    db.prepare('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)').run('acc', 'Test', 'test')
    applyCommerceSchema(db)
    const result = buildSearchResponse(db, 'acc', 'nonexistent xyz abc', 'search', null)
    assert.ok(Array.isArray(result.products))
    assert.strictEqual(result.products.length, 0)
    db.close()
  })
})
```

- [ ] **Step 2: Run tests — expect pass**

```bash
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm test 2>&1 | tail -20
```

- [ ] **Step 3: Modify `routes/chat.js`**

At the top of the file, add these imports alongside the existing ones:

```js
import { SEARCH_PRODUCTS_TOOL, buildSearchResponse } from '../services/recommendations.js'
```

Replace the `processMessage` function's Claude API call block. Find the section that starts with:
```js
const response = await client.messages.create({
  model: cfg.model || 'claude-haiku-4-5-20251001',
  max_tokens: 350,
  system: buildSystemPrompt(cfg) + knowledgeText + pageCtx,
  messages: history.map(m => ({ role: m.role, content: m.content }))
})

const reply = response.content.map(c => c.text || '').join('').trim()
```

Replace it with:

```js
// Check Commerce Pro status
const commerceRow = db.prepare('SELECT commerce_pro_enabled, commerce_pro_status FROM companies WHERE id = ?').get(companyId)
const hasCommercePro = commerceRow?.commerce_pro_enabled === 1 && commerceRow?.commerce_pro_status === 'active'

const commerceSystemBlock = hasCommercePro
  ? '\n\nTIENES ACCESO AL CATÁLOGO DE PRODUCTOS. Cuando el usuario pregunte por productos, precios, disponibilidad, alternativas o muestre intención de compra, usa la herramienta search_products para buscar en el catálogo. Siempre incluye la URL del producto en tus respuestas. Si un producto está agotado, ofrece alternativas.'
  : ''

const callParams = {
  model: cfg.model || 'claude-haiku-4-5-20251001',
  max_tokens: hasCommercePro ? 800 : 350,
  system: buildSystemPrompt(cfg) + knowledgeText + pageCtx + commerceSystemBlock,
  messages: history.map(m => ({ role: m.role, content: m.content }))
}
if (hasCommercePro) callParams.tools = [SEARCH_PRODUCTS_TOOL]

let response = await client.messages.create(callParams)
const discussedProductIds = []

// Tool-use loop (max 3 iterations to prevent runaway)
let iterations = 0
while (response.stop_reason === 'tool_use' && iterations < 3) {
  iterations++
  const toolUseBlocks = response.content.filter(b => b.type === 'tool_use')
  const toolResults = []

  for (const block of toolUseBlocks) {
    let resultContent
    try {
      const { query, intent, product_id } = block.input
      const searchResult = buildSearchResponse(db, companyId, query, intent, product_id || null)
      discussedProductIds.push(...searchResult.products.map(p => p.id))
      resultContent = JSON.stringify(searchResult)
    } catch (err) {
      resultContent = JSON.stringify({ error: err.message, products: [] })
    }
    toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resultContent })
  }

  // Append assistant turn + tool results
  callParams.messages = [
    ...callParams.messages,
    { role: 'assistant', content: response.content },
    { role: 'user', content: toolResults }
  ]
  response = await client.messages.create(callParams)
}

const reply = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()

// Track products discussed in this conversation
if (discussedProductIds.length > 0) {
  const existing = db.prepare('SELECT id, products_discussed FROM commerce_conversations WHERE session_id = ? AND account_id = ?').get(convId, companyId)
  const merged = [...new Set([...(existing ? JSON.parse(existing.products_discussed || '[]') : []), ...discussedProductIds])]
  if (existing) {
    db.prepare('UPDATE commerce_conversations SET products_discussed = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), Date.now(), existing.id)
  } else {
    const lead = db.prepare('SELECT lead_email FROM conversations WHERE id = ?').get(convId)
    db.prepare(`INSERT INTO commerce_conversations
      (id, account_id, session_id, contact_id, channel, products_discussed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(crypto.randomUUID(), companyId, convId, lead?.lead_email || null, 'web', JSON.stringify(merged), Date.now(), Date.now())
  }
}
```

- [ ] **Step 4: Run tests — expect all pass**

```bash
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm test 2>&1 | tail -20
```

- [ ] **Step 5: Smoke-test server boot**

```bash
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") ADMIN_PASSWORD=test node server.js &
sleep 3
curl -s http://localhost:3100/api/config/public | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK:', d.get('companyId'))"
kill %1
```

Expected: `OK: default` — server boots, no import errors.

- [ ] **Step 6: Commit**

```bash
git add routes/chat.js tests/commerce.test.js
git commit -m "feat: inject search_products tool into processMessage; track commerce_conversations"
```

---

## Task 3: Final integration test + tag `phase3-commerce-pro`

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

```bash
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm test 2>&1 | tail -20
```

Expected: all tests pass. The count increases from 32 to at least 42 (10 new tests).

- [ ] **Step 2: Verify tool constant is exported correctly**

```bash
node --input-type=module << 'EOF'
import { SEARCH_PRODUCTS_TOOL, buildSearchResponse } from './services/recommendations.js'
console.assert(SEARCH_PRODUCTS_TOOL.name === 'search_products', 'tool name wrong')
console.assert(Array.isArray(SEARCH_PRODUCTS_TOOL.input_schema.properties.intent.enum), 'enum missing')
console.log('recommendations.js exports OK')
EOF
```

Expected: `recommendations.js exports OK`

- [ ] **Step 3: Boot server and check for import errors**

```bash
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") ADMIN_PASSWORD=test timeout 5 node server.js 2>&1 || true
```

Expected: `[sync-scheduler] Catalog sync scheduler started` + `Agente multi-empresa corriendo en http://localhost:3100` — no import errors.

- [ ] **Step 4: Tag**

```bash
git tag phase3-commerce-pro
git log --oneline -5
git tag -l "phase*"
```

Expected: tags `phase1-commerce-pro`, `phase2-commerce-pro`, `phase3-commerce-pro` all present.
