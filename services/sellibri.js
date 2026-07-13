import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifySellibriWebhook(rawBody, signatureHeader, secret) {
  try {
    const expected = createHmac('sha256', secret).update(rawBody).digest('base64')
    const a = Buffer.from(signatureHeader || '', 'base64')
    const b = Buffer.from(expected, 'base64')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch { return false }
}

export function normalizeSellibriProduct(product, storeUrl, storeId) {
  const qty = product.stock_quantity ?? product.inventory_quantity ?? null
  const inStock = qty === null ? true : qty > 0
  const stock_status = inStock ? 'instock' : 'outofstock'
  const handle = product.slug || product.handle || String(product.id)

  return {
    store_id: storeId,
    platform_product_id: String(product.id),
    platform_variant_id: '',
    title: product.name || '',
    description: (product.description || '').replace(/<[^>]+>/g, '').trim(),
    short_description: (product.short_description || '').replace(/<[^>]+>/g, '').trim(),
    price: parseFloat(product.price || 0),
    compare_at_price: product.compare_at_price ? parseFloat(product.compare_at_price) : null,
    currency: product.currency || 'VES',
    sku: product.sku || '',
    stock_status,
    inventory_quantity: qty,
    product_url: product.url || `${storeUrl}/productos/${handle}`,
    image_url: product.images?.[0]?.src || product.image?.src || '',
    brand: product.brand || '',
    category: product.categories?.[0]?.name || product.category || '',
    tags: JSON.stringify((product.tags || []).map(t => typeof t === 'string' ? t : t.name).filter(Boolean)),
    attributes: JSON.stringify({}),
    allow_backorder: 0,
    is_active: 1
  }
}

export async function fetchSellibriProducts(storeUrl, apiKey, storeId) {
  const products = []
  let page = 1
  const PER_PAGE = 50
  const base = storeUrl.replace(/\/$/, '')
  const headers = { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' }

  while (true) {
    const url = `${base}/api/v1/products?page=${page}&per_page=${PER_PAGE}`
    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`Sellibri API error: ${res.status} ${await res.text()}`)
    const data = await res.json()
    const items = data.products || data.data || []
    if (!items.length) break
    for (const p of items) {
      products.push(normalizeSellibriProduct(p, base, storeId))
    }
    if (items.length < PER_PAGE) break
    page++
  }

  return products
}
