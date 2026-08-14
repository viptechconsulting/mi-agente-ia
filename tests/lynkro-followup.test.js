// tests/lynkro-followup.test.js
// Cubre los dos bugs de follow-up arreglados en runLynkroFollowUp:
//   1) el breakup (fu3) NO se manda a un lead que nunca respondió.
//   2) idempotencia: no se reenvía un texto idéntico al último saliente (duplicados).
// El envío real (WhatsApp/IG) se inyecta como stub, así el test no toca la red.
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import { db } from '../db.js'
import { runLynkroFollowUp, LYNKRO_FU, LYNKRO_COMPANY_ID } from '../routes/chat.js'

const H = 60 * 60 * 1000
const D = 24 * H

// Crea un lead Lynkro (whatsapp) con updated_at relativo y una lista de mensajes.
// msgs: [{ role, agoMs }] — created_at = now - agoMs. El último de la lista es el más nuevo.
function seedLead({ updatedAgoMs, msgs }) {
  const id = crypto.randomUUID()
  const now = Date.now()
  db.prepare(`INSERT INTO conversations
      (id, visitor_id, channel, created_at, updated_at, company_id, human_mode, do_not_contact, flow_state)
      VALUES (?, ?, 'whatsapp', ?, ?, ?, 0, 0, '{}')`)
    .run(id, 'wa:' + id.slice(0, 8), now - updatedAgoMs, now - updatedAgoMs, LYNKRO_COMPANY_ID)
  for (const m of msgs) {
    db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)')
      .run(id, m.role, m.content, now - m.agoMs)
  }
  return id
}

const flags = id => JSON.parse(db.prepare('SELECT flow_state FROM conversations WHERE id = ?').get(id).flow_state || '{}')

// Corre el job con un stub que graba los envíos y devuelve solo los de conv `id`.
async function runAndCollect(id) {
  const calls = []
  await runLynkroFollowUp((conv, _cfg, text) => { calls.push({ id: conv.id, text }); return Promise.resolve() })
  return calls.filter(c => c.id === id)
}

describe('runLynkroFollowUp: breakup (fu3) solo a quien respondió', () => {
  test('lead que NUNCA respondió no recibe el breakup', async () => {
    // 4 días de silencio (ventana de fu3), último mensaje = bot, cero mensajes del lead.
    const id = seedLead({ updatedAgoMs: 4 * D, msgs: [{ role: 'assistant', content: 'Hola, soy el asistente 👋', agoMs: 4 * D }] })
    const calls = await runAndCollect(id)
    assert.equal(calls.length, 0, 'no debe enviarse ningún follow-up a un lead que nunca contestó')
  })

  test('lead que SÍ respondió sí recibe el breakup', async () => {
    const id = seedLead({ updatedAgoMs: 4 * D, msgs: [
      { role: 'assistant', content: 'Hola, soy el asistente 👋', agoMs: 4 * D + H },
      { role: 'user', content: 'hola', agoMs: 4 * D + 30 * 60 * 1000 },
      { role: 'assistant', content: '¿Me contás de tu negocio?', agoMs: 4 * D },
    ] })
    const calls = await runAndCollect(id)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].text, LYNKRO_FU.fu3)
  })
})

describe('runLynkroFollowUp: idempotencia (no duplicar)', () => {
  test('no reenvía si el último saliente es idéntico al texto del touch', async () => {
    // Due para fu1 (6h de silencio), pero el último mensaje del bot YA es el fu1
    // (simula: se envió pero el flag no quedó marcado — reinicio/carrera).
    const id = seedLead({ updatedAgoMs: 6 * H, msgs: [{ role: 'assistant', content: LYNKRO_FU.fu1.early, agoMs: 6 * H }] })
    const calls = await runAndCollect(id)
    assert.equal(calls.length, 0, 'no debe reenviar un texto idéntico al último saliente')
    assert.equal(flags(id).fu1, true, 'debe marcar el flag para no volver a intentarlo')
  })

  test('sí envía fu1 si el último saliente es distinto', async () => {
    const id = seedLead({ updatedAgoMs: 6 * H, msgs: [{ role: 'assistant', content: 'Hola, soy el asistente 👋', agoMs: 6 * H }] })
    const calls = await runAndCollect(id)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].text, LYNKRO_FU.fu1.early)
  })
})
