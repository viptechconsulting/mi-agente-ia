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
