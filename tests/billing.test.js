import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

// ── Unit tests for services/stripe.js ────────────────────────────────────────
// These tests do NOT make real API calls.

describe('stripe service', () => {
  test('buildCheckoutParams includes correct metadata for upgrade', async () => {
    const { buildCheckoutParams } = await import('../services/stripe.js')
    const params = buildCheckoutParams({
      accountId: 'acc_123',
      purchaseType: 'upgrade',
      stripeCustomerId: 'cus_abc',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      priceId: 'price_xyz'
    })
    assert.equal(params.mode, 'subscription')
    assert.equal(params.customer, 'cus_abc')
    assert.equal(params.metadata.account_id, 'acc_123')
    assert.equal(params.metadata.purchase_type, 'upgrade')
    assert.equal(params.metadata.product, 'commerce_pro')
    assert.equal(params.line_items[0].price, 'price_xyz')
    assert.equal(params.line_items[0].quantity, 1)
  })

  test('buildCheckoutParams for standalone has no customer pre-set', async () => {
    const { buildCheckoutParams } = await import('../services/stripe.js')
    const params = buildCheckoutParams({
      accountId: 'acc_456',
      purchaseType: 'standalone',
      stripeCustomerId: null,
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      priceId: 'price_xyz'
    })
    assert.ok(!params.customer, 'should not set customer for standalone')
    assert.equal(params.metadata.purchase_type, 'standalone')
    assert.equal(params.customer_creation, 'always')
  })

  test('verifyWebhookSignature throws on bad signature', async () => {
    const { verifyWebhookSignature } = await import('../services/stripe.js')
    assert.throws(
      () => verifyWebhookSignature(Buffer.from('payload'), 'bad-sig', 'whsec_test'),
      /signature/i
    )
  })

  test('parseWebhookEvent extracts account_id and purchase_type from metadata', async () => {
    const { parseWebhookEvent } = await import('../services/stripe.js')
    const fakeEvent = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test',
          customer: 'cus_123',
          subscription: 'sub_456',
          metadata: {
            account_id: 'acc_789',
            purchase_type: 'standalone',
            product: 'commerce_pro'
          }
        }
      }
    }
    const result = parseWebhookEvent(fakeEvent)
    assert.equal(result.accountId, 'acc_789')
    assert.equal(result.purchaseType, 'standalone')
    assert.equal(result.stripeCustomerId, 'cus_123')
    assert.equal(result.stripeSubscriptionId, 'sub_456')
  })
})

// ── Unit tests for services/ghl-calendar.js ──────────────────────────────────

describe('ghl-calendar service', () => {
  test('extractEmailFromGHLPayload reads contact email', async () => {
    const { extractEmailFromGHLPayload } = await import('../services/ghl-calendar.js')
    const payload = {
      contact: { email: 'john@example.com', firstName: 'John' },
      appointmentId: 'appt_123',
      calendarId: 'cal_abc',
      status: 'confirmed'
    }
    assert.equal(extractEmailFromGHLPayload(payload), 'john@example.com')
  })

  test('extractEmailFromGHLPayload handles nested email formats', async () => {
    const { extractEmailFromGHLPayload } = await import('../services/ghl-calendar.js')
    const payload = { email: 'jane@example.com', type: 'AppointmentCreate' }
    assert.equal(extractEmailFromGHLPayload(payload), 'jane@example.com')
  })

  test('extractEmailFromGHLPayload returns null when no email found', async () => {
    const { extractEmailFromGHLPayload } = await import('../services/ghl-calendar.js')
    assert.equal(extractEmailFromGHLPayload({ foo: 'bar' }), null)
  })

  test('verifyGHLSignature returns true for matching secret', async () => {
    const { verifyGHLSignature } = await import('../services/ghl-calendar.js')
    assert.equal(verifyGHLSignature('mysecret', 'mysecret'), true)
  })

  test('verifyGHLSignature returns false for wrong secret', async () => {
    const { verifyGHLSignature } = await import('../services/ghl-calendar.js')
    assert.equal(verifyGHLSignature('wrong', 'mysecret'), false)
  })
})
