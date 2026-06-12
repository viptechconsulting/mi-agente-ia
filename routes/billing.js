// routes/billing.js
import express from 'express'
import { db } from '../db.js'
import { requireAdmin, withCompany } from '../middleware/auth.js'
import { setCommercePro } from '../db-commerce.js'
import {
  buildCheckoutParams,
  verifyWebhookSignature,
  parseWebhookEvent,
  createOrRetrieveCustomer,
  createCheckoutSession,
  createPortalSession
} from '../services/stripe.js'
import {
  verifyGHLSignature,
  processGHLAppointmentWebhook
} from '../services/ghl-calendar.js'

export const billingRouter = express.Router()

// ── GET /api/billing/status ───────────────────────────────────────────────────
billingRouter.get('/status', requireAdmin, withCompany, (req, res) => {
  const row = db.prepare(`
    SELECT commerce_pro_enabled, commerce_pro_status, commerce_pro_source,
           stripe_customer_id, discovery_call_status, onboarding_status
    FROM companies WHERE id = ?
  `).get(req.company.id)
  res.json(row || {})
})

// ── POST /api/billing/commerce-pro/upgrade ───────────────────────────────────
billingRouter.post('/commerce-pro/upgrade', requireAdmin, withCompany, async (req, res) => {
  try {
    const company = req.company
    const cfg = JSON.parse(company.config || '{}')

    const customer = await createOrRetrieveCustomer({
      email: cfg.ownerEmail || cfg.adminEmail || '',
      name: company.name,
      accountId: company.id
    })

    setCommercePro(db, company.id, { stripe_customer_id: customer.id })

    const params = buildCheckoutParams({
      accountId: company.id,
      purchaseType: 'upgrade',
      stripeCustomerId: customer.id,
      successUrl: `${process.env.APP_URL || 'https://chat.lynkro.io'}/admin.html?commerce=activated`,
      cancelUrl: `${process.env.APP_URL || 'https://chat.lynkro.io'}/admin.html`,
      priceId: process.env.STRIPE_COMMERCE_PRO_PRICE_ID
    })

    const session = await createCheckoutSession(params)
    setCommercePro(db, company.id, { stripe_checkout_session_id: session.id })

    res.json({ url: session.url })
  } catch (err) {
    console.error('[billing] upgrade error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ── POST /api/billing/commerce-pro/checkout ──────────────────────────────────
billingRouter.post('/commerce-pro/checkout', async (req, res) => {
  try {
    const { name, email } = req.body || {}
    if (!name || !email) return res.status(400).json({ error: 'name y email requeridos' })

    // Create a new company (inactive until payment completes)
    const id = crypto.randomUUID()
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 50)
    const now = Date.now()
    db.prepare(`
      INSERT INTO companies (id, name, slug, active, created_at, config)
      VALUES (?, ?, ?, 0, ?, ?)
    `).run(id, name, slug + '-' + id.slice(0, 8), now, JSON.stringify({ ownerEmail: email, businessName: name }))

    setCommercePro(db, id, {
      commerce_pro_status: 'pending_payment',
      commerce_pro_source: 'standalone'
    })

    const params = buildCheckoutParams({
      accountId: id,
      purchaseType: 'standalone',
      stripeCustomerId: null,
      successUrl: `${process.env.APP_URL || 'https://chat.lynkro.io'}/onboarding-discovery.html?account=${id}`,
      cancelUrl: `${process.env.APP_URL || 'https://chat.lynkro.io'}/`,
      priceId: process.env.STRIPE_COMMERCE_PRO_PRICE_ID
    })

    const session = await createCheckoutSession(params)
    setCommercePro(db, id, { stripe_checkout_session_id: session.id })

    res.json({ url: session.url })
  } catch (err) {
    console.error('[billing] checkout error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ── POST /api/billing/stripe/webhook ─────────────────────────────────────────
// IMPORTANT: Must receive raw body. Mount with express.raw() BEFORE express.json() in server.js
billingRouter.post('/stripe/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const sig = req.headers['stripe-signature']
    let event
    try {
      event = verifyWebhookSignature(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
    } catch (err) {
      console.error('[stripe webhook] bad signature:', err.message)
      return res.status(400).json({ error: 'Invalid signature' })
    }

    handleStripeEvent(event).catch(err => {
      console.error('[stripe webhook] handler error:', err)
    })

    res.json({ received: true })
  }
)

async function handleStripeEvent(event) {
  const parsed = parseWebhookEvent(event)
  const { eventType, accountId, purchaseType, stripeCustomerId, stripeSubscriptionId } = parsed

  if (!accountId) {
    console.warn('[stripe webhook] no account_id in metadata, event:', event.type)
    return
  }

  if (eventType === 'checkout.session.completed') {
    db.prepare("UPDATE companies SET active = 1 WHERE id = ?").run(accountId)
    setCommercePro(db, accountId, {
      commerce_pro_enabled: 1,
      commerce_pro_status: 'active',
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      commerce_pro_source: purchaseType,
      onboarding_status: 'payment_completed',
      ...(purchaseType === 'standalone'
        ? { discovery_call_status: 'required' }
        : { discovery_call_status: 'not_required' }
      )
    })
    console.log(`[stripe webhook] Commerce Pro activated for account ${accountId} (${purchaseType})`)
    return
  }

  if (eventType === 'invoice.payment_succeeded') {
    setCommercePro(db, accountId, { commerce_pro_status: 'active' })
    return
  }

  if (eventType === 'invoice.payment_failed') {
    setCommercePro(db, accountId, { commerce_pro_status: 'past_due' })
    console.warn(`[stripe webhook] payment failed for account ${accountId}`)
    return
  }

  if (eventType === 'customer.subscription.deleted') {
    setCommercePro(db, accountId, {
      commerce_pro_enabled: 0,
      commerce_pro_status: 'cancelled'
    })
    console.log(`[stripe webhook] Commerce Pro cancelled for account ${accountId}`)
    return
  }

  if (eventType === 'customer.subscription.updated') {
    const sub = event.data.object
    const status = sub.status === 'active' ? 'active'
      : sub.status === 'past_due' ? 'past_due'
      : sub.status === 'canceled' ? 'cancelled'
      : null
    if (status) setCommercePro(db, accountId, { commerce_pro_status: status })
    return
  }
}

// ── POST /api/billing/customer-portal ────────────────────────────────────────
billingRouter.post('/customer-portal', requireAdmin, withCompany, async (req, res) => {
  try {
    const company = req.company
    const stripeCustomerId = db.prepare(
      "SELECT stripe_customer_id FROM companies WHERE id = ?"
    ).get(company.id)?.stripe_customer_id

    if (!stripeCustomerId) {
      return res.status(400).json({ error: 'No Stripe customer found. Upgrade to Commerce Pro first.' })
    }

    const session = await createPortalSession({
      stripeCustomerId,
      returnUrl: process.env.STRIPE_CUSTOMER_PORTAL_RETURN_URL || 'https://chat.lynkro.io/admin.html'
    })

    res.json({ url: session.url })
  } catch (err) {
    console.error('[billing] portal error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ── POST /api/billing/ghl-calendar/webhook ───────────────────────────────────
billingRouter.post('/ghl-calendar/webhook', (req, res) => {
  const headerSecret = req.headers['x-ghl-secret'] || ''
  if (!verifyGHLSignature(headerSecret, process.env.GHL_WEBHOOK_SECRET || '')) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const result = processGHLAppointmentWebhook(db, setCommercePro, req.body)
  if (result.found) {
    console.log(`[ghl-calendar] Discovery call scheduled for company ${result.companyId}`)
  } else {
    console.warn('[ghl-calendar] No matching company found for appointment email')
  }

  res.json({ ok: true, ...result })
})
