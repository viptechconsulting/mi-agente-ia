export const SEARCH_PRODUCTS_TOOL = {
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

export function searchProductsFTS(db, accountId, query, limit = 5) {
  try {
    return db.prepare(`
      SELECT p.*
      FROM commerce_products p
      JOIN commerce_products_fts fts ON fts.product_id = p.id
      WHERE commerce_products_fts MATCH ?
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
  const related = getRelated(db, accountId, productId, ['alternative', 'replacement'])
  if (related.length > 0) return related

  // Fallback: same-category FTS search
  const source = db.prepare('SELECT * FROM commerce_products WHERE id = ? AND account_id = ?').get(productId, accountId)
  if (!source || !source.category) return []
  return searchProductsFTS(db, accountId, source.category, 5).filter(p => p.id !== productId)
}

export function getUpsell(db, accountId, productId) {
  const related = getRelated(db, accountId, productId, ['upsell'])
  if (related.length > 0) return related

  // Fallback: same-category higher price
  const source = db.prepare('SELECT * FROM commerce_products WHERE id = ? AND account_id = ?').get(productId, accountId)
  if (!source) return []
  const result = db.prepare(`
    SELECT * FROM commerce_products
    WHERE account_id = ?
      AND category = ?
      AND price > ?
      AND id != ?
      AND is_active = 1
    ORDER BY price ASC
    LIMIT 1
  `).get(accountId, source.category, source.price, productId)
  return result ? [result] : []
}

export function getDownsell(db, accountId, productId) {
  const related = getRelated(db, accountId, productId, ['downsell'])
  if (related.length > 0) return related

  // Fallback: same-category lower price
  const source = db.prepare('SELECT * FROM commerce_products WHERE id = ? AND account_id = ?').get(productId, accountId)
  if (!source) return []
  const result = db.prepare(`
    SELECT * FROM commerce_products
    WHERE account_id = ?
      AND category = ?
      AND price < ?
      AND id != ?
      AND is_active = 1
    ORDER BY price DESC
    LIMIT 1
  `).get(accountId, source.category, source.price, productId)
  return result ? [result] : []
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
  if (productId && intent === 'alternative') products = getAlternatives(db, accountId, productId)
  else if (productId && intent === 'upsell') products = getUpsell(db, accountId, productId)
  else if (productId && intent === 'downsell') products = getDownsell(db, accountId, productId)
  else products = searchProductsFTS(db, accountId, query)

  const valid = products.filter(validateProductRecommendation).slice(0, 5)
  const invalid = products.filter(p => !validateProductRecommendation(p))
  if (invalid.length) console.warn(`[recommendations] ${invalid.length} product(s) filtered`)

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
