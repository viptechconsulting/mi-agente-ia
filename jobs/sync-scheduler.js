// jobs/sync-scheduler.js
// Runs a full catalog sync for all active Commerce Pro stores every 6 hours.
import { db, loadConfig } from '../db.js'
import { decryptCredential } from '../db-commerce.js'
import { syncStore } from '../routes/commerce.js'
import { getEligibleConversations, sendRecoveryEmail } from '../services/recovery.js'

const SIX_HOURS = 6 * 60 * 60 * 1000

async function runScheduledSync() {
  const stores = db.prepare(`
    SELECT s.*, c.id as company_id
    FROM commerce_stores s
    JOIN companies c ON c.id = s.account_id
    WHERE c.commerce_pro_status = 'active' AND c.commerce_pro_enabled = 1
    ORDER BY s.last_sync_at ASC
  `).all()

  if (!stores.length) {
    console.log('[sync-scheduler] No active stores to sync')
    return
  }

  console.log(`[sync-scheduler] Starting sync for ${stores.length} store(s)`)

  for (const store of stores) {
    try {
      const accessToken = store.access_token_encrypted ? decryptCredential(store.access_token_encrypted) : null
      const consumerKey = store.consumer_key_encrypted ? decryptCredential(store.consumer_key_encrypted) : null
      const consumerSecret = store.consumer_secret_encrypted ? decryptCredential(store.consumer_secret_encrypted) : null
      const apiKey = store.api_key_encrypted ? decryptCredential(store.api_key_encrypted) : null

      const result = await syncStore(
        store.id, store.account_id, store.platform,
        store.store_url, accessToken, consumerKey, consumerSecret, apiKey
      )
      console.log(`[sync-scheduler] Store ${store.id}: ${result.count} products synced`)
    } catch (err) {
      console.error(`[sync-scheduler] Error syncing store ${store.id}:`, err.message)
    }
  }
}

setInterval(runScheduledSync, SIX_HOURS)
console.log('[sync-scheduler] Catalog sync scheduler started (every 6 hours)')

async function runRecoveryJob() {
  const eligible = getEligibleConversations(db)
  if (!eligible.length) return

  console.log(`[recovery-job] Processing ${eligible.length} eligible conversation(s)`)

  for (const conv of eligible) {
    try {
      const cfg = loadConfig(conv.account_id)
      const result = await sendRecoveryEmail(db, conv, cfg)
      if (result.sent) {
        console.log(`[recovery-job] Recovery email sent to ${result.email}`)
      } else {
        console.log(`[recovery-job] Skipped ${conv.id}: ${result.skipped}`)
      }
    } catch (err) {
      console.error(`[recovery-job] Error for conversation ${conv.id}:`, err.message)
    }
  }
}

setInterval(runRecoveryJob, 15 * 60 * 1000)
console.log('[sync-scheduler] Recovery job started (every 15 minutes)')
// Appended to sync-scheduler.js

// ============================================================
// CAMPAIGN + APPOINTMENT REMINDER SCHEDULER (daily at 8am)
// ============================================================

async function runCampaignScheduler() {
  console.log('[campaign-scheduler] Starting daily run')
  try {
    const { runAllCampaigns } = await import('./campaign-scheduler.js')
    await runAllCampaigns()
    console.log('[campaign-scheduler] Done')
  } catch(e) {
    console.error('[campaign-scheduler] Fatal:', e.message)
  }
}

// Schedule daily at 08:00 local time
function scheduleDaily(hour, fn) {
  const now = new Date()
  const next = new Date(now)
  next.setHours(hour, 0, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)
  const delay = next - now
  setTimeout(() => {
    fn()
    setInterval(fn, 24 * 60 * 60 * 1000)
  }, delay)
  console.log(`[campaign-scheduler] Next run in ${Math.round(delay/60000)} minutes (${next.toLocaleTimeString()})`)
}

scheduleDaily(8, runCampaignScheduler)

// ============================================================
// PROSPECTING FOLLOW-UPS (daily at 9am)
// ============================================================

async function runProspectingFollowupsJob() {
  console.log('[prospecting-followups] Starting daily run')
  try {
    const { runProspectingFollowups } = await import('./prospecting-followups.js')
    await runProspectingFollowups()
    console.log('[prospecting-followups] Done')
  } catch (e) {
    console.error('[prospecting-followups] Fatal:', e.message)
  }
}

scheduleDaily(9, runProspectingFollowupsJob)

// ============================================================
// SEGUNDO AVISO DE CONFIRMACIÓN DE CITA (cada hora)
// ============================================================
// Horario y no diario: el segundo aviso sale 6h después del primero, y el
// primero puede salir a cualquier hora según cuándo corrió el recordatorio.
async function runConfirmationSecondTouchJob() {
  try {
    const { runConfirmationSecondTouch } = await import('./campaign-scheduler.js')
    await runConfirmationSecondTouch()
  } catch (e) {
    console.error('[confirm-2] Fatal:', e.message)
  }
}

setInterval(runConfirmationSecondTouchJob, 60 * 60 * 1000)
console.log('[confirm-2] Segundo aviso de confirmación: cada hora')
