// services/recovery.js
import nodemailer from 'nodemailer'
import { generateCouponCode, buildCouponDbRecord, createWooCoupon, createShopifyCoupon } from './coupons.js'
import { decryptCredential } from '../db-commerce.js'

const DEFAULT_DELAY_MS = 60 * 60_000  // 60 minutes

export function getEligibleConversations(db, delayOverrideMs = null) {
  const cutoff = Date.now() - (delayOverrideMs ?? DEFAULT_DELAY_MS)
  return db.prepare(`
    SELECT cc.*, conv.lead_email, conv.lead_name
    FROM commerce_conversations cc
    JOIN conversations conv ON conv.id = cc.session_id
    JOIN companies comp ON comp.id = cc.account_id
    WHERE cc.purchase_detected = 0
      AND cc.recovery_email_sent = 0
      AND cc.products_discussed IS NOT NULL
      AND cc.products_discussed != '[]'
      AND cc.updated_at < ?
      AND conv.lead_email IS NOT NULL
      AND comp.commerce_pro_enabled = 1
      AND comp.commerce_pro_status = 'active'
  `).all(cutoff)
}

export function buildRecoveryEmail({ leadName, products, couponCode, expirationDate, storeUrl }) {
  const name = leadName || 'Cliente'
  const productLines = products.map(p =>
    `→ ${p.title} — ${p.currency || 'USD'} ${p.price} · ${p.product_url}`
  ).join('\n')

  const productHtml = products.map(p =>
    `<tr><td style="padding:8px 0"><a href="${p.product_url}" style="color:#35d472;font-weight:bold">${p.title}</a> — ${p.currency || 'USD'} ${p.price}</td></tr>`
  ).join('')

  const couponBlock = couponCode
    ? `<p>Usá el código <strong>${couponCode}</strong>${expirationDate ? ` antes del ${expirationDate}` : ''}.</p>`
    : ''

  const couponText = couponCode
    ? `\nUsá el código ${couponCode}${expirationDate ? ` antes del ${expirationDate}` : ''}.\n`
    : ''

  const subject = `Tus recomendaciones + ${couponCode ? 'un descuento especial, ' : ''}${name}`

  const html = `<!DOCTYPE html>
<html><body style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px;background:#f9f9f9">
  <div style="background:#fff;border-radius:8px;padding:32px">
    <h2 style="color:#0a0a0a">Hola ${name},</h2>
    <p>Gracias por chatear con nosotros. Te recomendamos:</p>
    <table style="width:100%;border-collapse:collapse">${productHtml}</table>
    ${couponBlock}
    <p><a href="${storeUrl}" style="background:#35d472;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:16px">Ver productos</a></p>
  </div>
</body></html>`

  const text = `Hola ${name},\n\nGracias por chatear con nosotros. Te recomendamos:\n${productLines}${couponText}\nVer productos: ${storeUrl}\n`

  return { subject, html, text }
}

function getMailer(cfg) {
  if (!cfg.smtpHost || !cfg.notifyEmail) return null
  return nodemailer.createTransport({
    host: cfg.smtpHost,
    port: parseInt(cfg.smtpPort) || 587,
    secure: !!cfg.smtpSecure,
    auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined
  })
}

export async function sendRecoveryEmail(db, conv, cfg) {
  const commerceConfig = cfg.commerce || {}
  const storeUrl = cfg.storeUrl || cfg.websiteUrl || 'https://tienda.com'

  const productIds = JSON.parse(conv.products_discussed || '[]')
  if (!productIds.length) return { skipped: 'no products' }

  const products = productIds
    .map(id => db.prepare('SELECT * FROM commerce_products WHERE id = ?').get(id))
    .filter(Boolean)
    .filter(p => p.product_url)
    .slice(0, 3)

  if (!products.length) return { skipped: 'no valid products' }

  let couponCode = null
  let expirationDate = null
  let couponId = null

  if (commerceConfig.recovery_coupon_enabled) {
    couponCode = generateCouponCode(conv.lead_name)
    const expirationHours = commerceConfig.recovery_coupon_expiration_hours || 48
    expirationDate = new Date(Date.now() + expirationHours * 3600_000)
      .toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })

    const store = db.prepare(`
      SELECT * FROM commerce_stores WHERE account_id = ? AND id = (
        SELECT store_id FROM commerce_products WHERE id = ? LIMIT 1
      )
    `).get(conv.account_id, productIds[0])

    if (store) {
      try {
        let platformResult = null
        if (store.platform === 'woocommerce' && store.consumer_key_encrypted) {
          const key = decryptCredential(store.consumer_key_encrypted)
          const secret = decryptCredential(store.consumer_secret_encrypted)
          platformResult = await createWooCoupon(store.store_url, key, secret, couponCode, commerceConfig)
        } else if (store.platform === 'shopify' && store.access_token_encrypted) {
          const token = decryptCredential(store.access_token_encrypted)
          platformResult = await createShopifyCoupon(store.store_url, token, couponCode, commerceConfig)
        }

        const rec = buildCouponDbRecord(conv.account_id, store.id, store.platform, couponCode, commerceConfig, platformResult?.platformCouponId)
        couponId = crypto.randomUUID()
        db.prepare(`INSERT INTO commerce_coupons
          (id, account_id, store_id, platform_coupon_id, coupon_code, discount_type, discount_value,
           expires_at, minimum_order_amount, usage_limit, contact_id, conversation_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          couponId, rec.account_id, rec.store_id, rec.platform_coupon_id, rec.coupon_code,
          rec.discount_type, rec.discount_value, rec.expires_at, rec.minimum_order_amount,
          rec.usage_limit, conv.contact_id, conv.id, rec.status, Date.now(), Date.now()
        )
      } catch (err) {
        console.warn(`[recovery] coupon creation failed for ${conv.id}:`, err.message)
      }
    }
  }

  const mailer = getMailer(cfg)
  if (!mailer) return { skipped: 'no SMTP config' }

  const email = buildRecoveryEmail({ leadName: conv.lead_name, products, couponCode, expirationDate, storeUrl })

  await mailer.sendMail({
    from: cfg.smtpUser || cfg.notifyEmail,
    to: conv.lead_email,
    subject: email.subject,
    html: email.html,
    text: email.text
  })

  db.prepare('UPDATE commerce_conversations SET recovery_email_sent = 1, recovery_coupon_code = ?, updated_at = ? WHERE id = ?')
    .run(couponCode, Date.now(), conv.id)

  if (couponId) {
    db.prepare("UPDATE commerce_coupons SET status = 'sent', updated_at = ? WHERE id = ?").run(Date.now(), couponId)
  }

  return { sent: true, email: conv.lead_email, couponCode }
}
