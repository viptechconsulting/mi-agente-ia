// tests/prospecting-reconcile.test.js
// reconcileIssues combina Paso 2 (auditoría) + "Revisar auditoría con IA" en los
// problemas finales del mensaje. Acá cubrimos las ramas deterministas (sin red):
//  - sin chat de revisión → devuelve los problemas de la auditoría tal cual
//  - sin auditoría → devuelve []
// (la rama que llama a la IA cuando SÍ hay chat no se testea aquí para no pegarle
//  a la API; su contrato es "devuelve 1-3 problemas o cae a los originales".)
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import { db } from '../db.js'
import { applyProspectingSchema } from '../db-prospecting.js'
import { reconcileIssues } from '../services/prospecting-audit.js'

applyProspectingSchema(db)

function seedProspect({ withAudit, issues } = {}) {
  const pid = crypto.randomUUID()
  const bid = crypto.randomUUID()
  const now = Date.now()
  db.prepare('INSERT INTO prospect_batches (id, niche, city) VALUES (?,?,?)').run(bid, 'test', 'test')
  db.prepare('INSERT INTO prospects (id, batch_id, name, created_at) VALUES (?,?,?,?)').run(pid, bid, 'Negocio Test', now)
  if (withAudit) {
    db.prepare('INSERT INTO prospect_audits (id, prospect_id, issues_json, audited_at) VALUES (?,?,?,?)')
      .run(crypto.randomUUID(), pid, JSON.stringify(issues), now)
  }
  return pid
}

describe('reconcileIssues', () => {
  test('sin chat de revisión → devuelve los problemas de la auditoría sin tocar la IA', async () => {
    const pid = seedProspect({ withAudit: true, issues: ['no responde de noche', 'sin reservas 24/7'] })
    const out = await reconcileIssues(pid, 'es')
    assert.deepEqual(out, ['no responde de noche', 'sin reservas 24/7'])
  })

  test('sin auditoría → devuelve []', async () => {
    const pid = seedProspect({ withAudit: false })
    assert.deepEqual(await reconcileIssues(pid, 'es'), [])
  })
})
