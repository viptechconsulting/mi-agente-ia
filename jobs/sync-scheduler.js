// jobs/sync-scheduler.js
// Runs a full catalog sync for all active Commerce Pro stores every 6 hours.
import { db } from '../db.js'
import { decryptCredential } from '../db-commerce.js'
import { syncStore } from '../routes/commerce.js'

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

      const result = await syncStore(
        store.id, store.account_id, store.platform,
        store.store_url, accessToken, consumerKey, consumerSecret
      )
      console.log(`[sync-scheduler] Store ${store.id}: ${result.count} products synced`)
    } catch (err) {
      console.error(`[sync-scheduler] Error syncing store ${store.id}:`, err.message)
    }
  }
}

setInterval(runScheduledSync, SIX_HOURS)
console.log('[sync-scheduler] Catalog sync scheduler started (every 6 hours)')
