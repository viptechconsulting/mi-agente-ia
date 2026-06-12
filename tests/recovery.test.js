import { test, describe, before, after } from 'node:test'
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
    assert.ok(rec.expires_at > Date.now())
    assert.strictEqual(rec.status, 'created')
  })
})
