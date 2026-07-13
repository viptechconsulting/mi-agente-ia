// services/recovery.js
import nodemailer from 'nodemailer'
import { generateCouponCode, buildCouponDbRecord, createWooCoupon, createShopifyCoupon, createSellibriCoupon } from './coupons.js'
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

// ── AI email generation ────────────────────────────────────────────────────────

async function buildAiRecoveryEmail({ leadName, messages, products, couponCode, expirationDate }) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY no configurado')

  const firstName = (leadName || '').split(' ')[0] || 'hola'

  // Last 12 messages of the conversation (enough context, not too long)
  const transcript = messages.slice(-12).map(m =>
    `${m.role === 'user' ? firstName : 'Asistente'}: ${m.content}`
  ).join('\n')

  const productLines = products.map((p, i) =>
    `${i === 0 ? '★ Principal' : '  También'}: ${p.title} — ${p.currency || 'USD'} ${p.price}`
  ).join('\n')

  const couponLine = couponCode
    ? `\nCupón reservado: ${couponCode}${expirationDate ? ` (vence ${expirationDate})` : ''}`
    : ''

  const prompt = `Sos un redactor de emails de seguimiento post-conversación. Tu trabajo es escribir un email que se sienta como un mensaje personal de alguien que estuvo en el chat — NO un email de marketing genérico.

EXTRACTO DE LA CONVERSACIÓN:
${transcript}

PRODUCTOS:
${productLines}${couponLine}

INSTRUCCIONES:
- Idioma: el mismo que usó ${firstName} en el chat
- Tono: cálido, directo, como quien se acordó de algo que quedó pendiente
- PROHIBIDO: "carrito", "abandonaste", "no olvides", frases de marketing genérico
- OBLIGATORIO: mencioná al menos un detalle específico de lo que se habló (usa el transcript)
- El precio de cada producto DEBE aparecer en el texto del email
- Si hay cupón, presentarlo como un gesto personal, no como promoción masiva
- Máximo 120 palabras en el cuerpo — ser conciso es más poderoso
- Subject: máximo 7 palabras, personal, que genere curiosidad sin ser clickbait

Devolvé ÚNICAMENTE este JSON (sin markdown, sin bloques de código):
{"subject":"...","body_html":"...","body_text":"..."}`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    })
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Anthropic API error ${res.status}: ${errText}`)
  }

  const data = await res.json()
  const raw = data.content?.[0]?.text || '{}'
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('AI no devolvió JSON válido')

  const parsed = JSON.parse(jsonMatch[0])

  // Product cards always show real price regardless of AI copy
  const productCards = products.slice(0, 2).map(p => `
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:12px">
      <div style="min-width:0">
        <div style="font-weight:600;font-size:14px;color:#111"><a href="${p.product_url}" style="color:#111;text-decoration:none">${p.title}</a></div>
        <div style="color:#16a34a;font-weight:800;font-size:16px;margin-top:3px">${p.currency || 'USD'} ${p.price}</div>
      </div>
      <a href="${p.product_url}" style="background:#111;color:#fff;padding:9px 16px;border-radius:7px;text-decoration:none;font-size:13px;font-weight:600;white-space:nowrap;flex-shrink:0">Ver →</a>
    </div>`).join('')

  const couponBlock = couponCode
    ? `<div style="background:#f0fdf4;border:2px dashed #86efac;border-radius:10px;padding:16px;margin:20px 0;text-align:center">
         <div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Tu código especial</div>
         <div style="font-size:28px;font-weight:800;letter-spacing:3px;color:#16a34a">${couponCode}</div>
         ${expirationDate ? `<div style="font-size:12px;color:#888;margin-top:4px">Válido hasta el ${expirationDate}</div>` : ''}
       </div>`
    : ''

  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:580px;margin:auto;padding:24px;background:#f9fafb">
  <div style="background:#fff;border-radius:12px;padding:32px;box-shadow:0 1px 4px rgba(0,0,0,.06)">
    <div style="font-size:15px;line-height:1.7;color:#222;margin-bottom:16px">${parsed.body_html}</div>
    ${couponBlock}
    <div style="margin-top:16px">${productCards}</div>
    <p style="font-size:12px;color:#bbb;margin-top:24px;padding-top:16px;border-top:1px solid #f0f0f0">Respondé este email si tenés alguna duda.</p>
  </div>
</body></html>`

  const text = [
    parsed.body_text,
    '',
    couponCode ? `Código de descuento: ${couponCode}${expirationDate ? ` (válido hasta ${expirationDate})` : ''}` : '',
    '',
    ...products.slice(0, 2).map(p => `${p.title} — ${p.currency || 'USD'} ${p.price}\n${p.product_url}`)
  ].filter(l => l !== null).join('\n')

  return { subject: parsed.subject, html, text }
}

// Fallback: template estático si la IA falla
function buildFallbackEmail({ leadName, products, couponCode, expirationDate }) {
  const firstName = ((leadName || '').split(' ')[0] || 'hola')
  const p = products[0]
  const subject = couponCode ? `Algo quedó pendiente, ${firstName}` : `${firstName}, ¿seguís interesado/a?`

  const couponBlock = couponCode
    ? `<div style="background:#f0fdf4;border:2px dashed #86efac;border-radius:10px;padding:16px;margin:20px 0;text-align:center">
         <div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Tu código</div>
         <div style="font-size:28px;font-weight:800;letter-spacing:3px;color:#16a34a">${couponCode}</div>
         ${expirationDate ? `<div style="font-size:12px;color:#888;margin-top:4px">Válido hasta el ${expirationDate}</div>` : ''}
       </div>`
    : ''

  const productCards = products.slice(0, 2).map(prod => `
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:12px">
      <div>
        <div style="font-weight:600;font-size:14px"><a href="${prod.product_url}" style="color:#111;text-decoration:none">${prod.title}</a></div>
        <div style="color:#16a34a;font-weight:800;font-size:16px;margin-top:3px">${prod.currency || 'USD'} ${prod.price}</div>
      </div>
      <a href="${prod.product_url}" style="background:#111;color:#fff;padding:9px 16px;border-radius:7px;text-decoration:none;font-size:13px;font-weight:600;white-space:nowrap;flex-shrink:0">Ver →</a>
    </div>`).join('')

  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:580px;margin:auto;padding:24px;background:#f9fafb">
  <div style="background:#fff;border-radius:12px;padding:32px;box-shadow:0 1px 4px rgba(0,0,0,.06)">
    <p style="font-size:15px;line-height:1.7;color:#222">Hola ${firstName}, vi que estuviste consultando sobre <strong>${p.title}</strong>. Quería dejarte el acceso directo por si te interesa:</p>
    ${couponBlock}
    <div style="margin-top:16px">${productCards}</div>
    <p style="font-size:12px;color:#bbb;margin-top:24px;padding-top:16px;border-top:1px solid #f0f0f0">Respondé este email si tenés alguna duda.</p>
  </div>
</body></html>`

  return {
    subject,
    html,
    text: `Hola ${firstName},\n\nVi que consultaste sobre "${p.title}" (${p.currency || 'USD'} ${p.price}).\n${p.product_url}\n${couponCode ? `\nCódigo: ${couponCode}` : ''}`
  }
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

  const productIds = JSON.parse(conv.products_discussed || '[]')
  if (!productIds.length) return { skipped: 'no products' }

  const products = productIds
    .map(id => db.prepare('SELECT * FROM commerce_products WHERE id = ?').get(id))
    .filter(Boolean)
    .filter(p => p.product_url)
    .slice(0, 3)

  if (!products.length) return { skipped: 'no valid products' }

  // Get conversation transcript for AI context
  const messages = conv.session_id
    ? db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id').all(conv.session_id)
    : []

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
        } else if (store.platform === 'sellibri' && store.api_key_encrypted) {
          const apiKey = decryptCredential(store.api_key_encrypted)
          platformResult = await createSellibriCoupon(store.store_url, apiKey, commerceConfig, conv.lead_email)
          if (platformResult.actualCouponCode) couponCode = platformResult.actualCouponCode
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

  // Generate email with AI; fall back to template if AI fails
  let email
  try {
    email = await buildAiRecoveryEmail({
      leadName: conv.lead_name,
      messages,
      products,
      couponCode,
      expirationDate
    })
    console.log(`[recovery] AI email generated for ${conv.id}`)
  } catch (err) {
    console.warn(`[recovery] AI email failed, using fallback: ${err.message}`)
    email = buildFallbackEmail({ leadName: conv.lead_name, products, couponCode, expirationDate })
  }

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
