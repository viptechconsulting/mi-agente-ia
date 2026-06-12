import Stripe from 'stripe'

// Lazy-initialize so tests can import without STRIPE_SECRET_KEY set
let _stripe
function getStripe() {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set')
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' })
  }
  return _stripe
}

// ── Pure helpers (testable without Stripe API) ───────────────────────────────

export function buildCheckoutParams({ accountId, purchaseType, stripeCustomerId, successUrl, cancelUrl, priceId }) {
  const params = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      account_id: accountId,
      purchase_type: purchaseType,
      product: 'commerce_pro'
    },
    allow_promotion_codes: true
  }
  if (stripeCustomerId) {
    params.customer = stripeCustomerId
  } else {
    params.customer_creation = 'always'
  }
  return params
}

export function verifyWebhookSignature(rawBody, signature, secret) {
  return Stripe.webhooks.constructEvent(rawBody, signature, secret)
}

export function parseWebhookEvent(event) {
  const obj = event.data.object
  return {
    eventType: event.type,
    stripeCustomerId: obj.customer || null,
    stripeSubscriptionId: obj.subscription || null,
    accountId: obj.metadata?.account_id || null,
    purchaseType: obj.metadata?.purchase_type || null,
    product: obj.metadata?.product || null
  }
}

// ── Stripe API calls ─────────────────────────────────────────────────────────

export async function createOrRetrieveCustomer({ email, name, accountId }) {
  const stripe = getStripe()
  const existing = await stripe.customers.search({
    query: `metadata['account_id']:'${accountId}'`,
    limit: 1
  })
  if (existing.data.length > 0) return existing.data[0]
  return stripe.customers.create({
    email,
    name,
    metadata: { account_id: accountId }
  })
}

export async function createCheckoutSession(params) {
  return getStripe().checkout.sessions.create(params)
}

export async function createPortalSession({ stripeCustomerId, returnUrl }) {
  return getStripe().billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl
  })
}
