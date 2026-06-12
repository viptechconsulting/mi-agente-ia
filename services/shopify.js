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
 */
export async function fetchShopifyProducts(storeUrl, accessToken, storeId) {
  const products = []
  let url = `${storeUrl}/admin/api/2024-01/products.json?limit=250&fields=id,title,body_html,vendor,product_type,handle,tags,images,variants`

  while (url) {
    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': accessToken }
    })
    if (!res.ok) throw new Error(`Shopify API error: ${res.status} ${await res.text()}`)
    const data = await res.json()
    for (const p of data.products || []) {
      products.push(normalizeShopifyProduct(p, storeUrl, storeId))
    }
    const link = res.headers.get('link') || ''
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/)
    url = nextMatch ? nextMatch[1] : null
  }

  return products
}
