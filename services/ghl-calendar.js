export function verifyGHLSignature(headerSecret, expectedSecret) {
  return headerSecret === expectedSecret
}

export function extractEmailFromGHLPayload(payload) {
  if (payload?.contact?.email) return payload.contact.email
  if (payload?.email) return payload.email
  if (payload?.data?.contact?.email) return payload.data.contact.email
  return null
}

/**
 * Process a GHL appointment webhook.
 * Finds the matching company by email and marks discovery_call_status = 'scheduled'.
 *
 * @param {object} db - better-sqlite3 instance
 * @param {Function} setCommercePro - from db-commerce.js
 * @param {object} payload - raw GHL webhook body
 * @returns {{ found: boolean, companyId: string|null }}
 */
export function processGHLAppointmentWebhook(db, setCommercePro, payload) {
  const email = extractEmailFromGHLPayload(payload)
  if (!email) return { found: false, companyId: null }

  const companies = db.prepare(`
    SELECT id, config FROM companies
    WHERE active = 1
      AND commerce_pro_enabled = 1
      AND discovery_call_status = 'required'
  `).all()

  for (const row of companies) {
    try {
      const cfg = JSON.parse(row.config || '{}')
      if (cfg.ownerEmail && cfg.ownerEmail.toLowerCase() === email.toLowerCase()) {
        setCommercePro(db, row.id, {
          discovery_call_status: 'scheduled',
          onboarding_status: 'discovery_scheduled'
        })
        return { found: true, companyId: row.id }
      }
    } catch {}
  }

  const byStripe = db.prepare(`
    SELECT id FROM companies
    WHERE active = 1
      AND commerce_pro_enabled = 1
      AND discovery_call_status = 'required'
      AND config LIKE ?
  `).get(`%${email}%`)

  if (byStripe) {
    setCommercePro(db, byStripe.id, {
      discovery_call_status: 'scheduled',
      onboarding_status: 'discovery_scheduled'
    })
    return { found: true, companyId: byStripe.id }
  }

  return { found: false, companyId: null }
}
