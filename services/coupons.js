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
    headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${credentials}` },
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
  const headers = { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken }

  const ruleRes = await fetch(`${baseUrl}/admin/api/2024-01/price_rules.json`, {
    method: 'POST', headers, body: JSON.stringify(ruleBody)
  })

  if (!ruleRes.ok) {
    const text = await ruleRes.text()
    throw new Error(`Shopify price_rule error ${ruleRes.status}: ${text}`)
  }

  const { price_rule } = await ruleRes.json()

  const codeRes = await fetch(`${baseUrl}/admin/api/2024-01/price_rules/${price_rule.id}/discount_codes.json`, {
    method: 'POST', headers, body: JSON.stringify({ discount_code: { code } })
  })

  if (!codeRes.ok) {
    const text = await codeRes.text()
    throw new Error(`Shopify discount_code error ${codeRes.status}: ${text}`)
  }

  return { platformCouponId: String(price_rule.id) }
}
