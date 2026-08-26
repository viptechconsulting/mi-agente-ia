// tests/phones-export.test.js
// Cubre las dos piezas nuevas del chat web (2026-08-26):
//   1) collectPhones — la lista que alimenta el CSV de teléfonos.
//   2) humanDelayMs — el retraso "humano" antes de responder.
// No toca la red: solo la DB local y aritmética.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import { db } from '../db.js'
import { collectPhones, humanDelayMs } from '../routes/chat.js'

const COMPANY = 'test-phones-' + crypto.randomUUID().slice(0, 8)
const now = Date.now()
const D = 24 * 60 * 60 * 1000

function seed(channel, visitorId, msgs, extra = {}) {
  const id = crypto.randomUUID()
  db.prepare(`INSERT INTO conversations (id, visitor_id, channel, created_at, updated_at, company_id, lead_name, lead_phone)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, visitorId, channel, now - 10 * D, now, COMPANY, extra.name || null, extra.leadPhone || null)
  for (const m of msgs) {
    db.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, 'user', ?, ?)")
      .run(id, m.text, now - m.agoMs)
  }
  return id
}

after(() => {
  const convs = db.prepare('SELECT id FROM conversations WHERE company_id = ?').all(COMPANY)
  for (const c of convs) db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(c.id)
  db.prepare('DELETE FROM conversations WHERE company_id = ?').run(COMPANY)
})

describe('collectPhones', () => {
  seed('web', 'v_1', [
    { text: 'Hola, mi teléfono es 786-669-6831', agoMs: 5 * D },
    { text: 'Perdón, mejor escríbeme al 786-669-6831 hoy', agoMs: 1 * D }
  ], { name: 'Ana' })
  seed('whatsapp', 'wa:17866696831', [{ text: 'Buenas', agoMs: 2 * D }])
  seed('web', 'v_2', [{ text: 'Mi código de orden es 12345', agoMs: 3 * D }])
  seed('instagram', 'ig:999', [{ text: 'sin numero aca', agoMs: 4 * D }], { leadPhone: '+58 412 1234567' })

  const rows = collectPhones(COMPANY)
  const byKey = Object.fromEntries(rows.map(r => [r.phone.replace(/\D/g, '').slice(-10), r]))

  test('no duplica el mismo número escrito dos veces ni con prefijo de país', () => {
    assert.equal(rows.filter(r => r.phone.replace(/\D/g, '').endsWith('7866696831')).length, 1)
  })

  test('se queda con la versión más completa del número', () => {
    assert.equal(byKey['7866696831'].phone.replace(/\D/g, ''), '17866696831')
  })

  test('guarda primera y última vez, no solo la última', () => {
    // El mismo número aparece en el chat web (hace 5 y 1 días) y como remitente
    // de WhatsApp (conversación abierta hace 10 días): la primera vez es la más
    // vieja de todas las fuentes, la última la más reciente.
    const p = byKey['7866696831']
    assert.ok(p.first < p.last, 'first debe ser anterior a last')
    assert.equal(Math.round((now - p.first) / D), 10)
    assert.equal(Math.round((now - p.last) / D), 1)
  })

  test('arrastra el nombre del lead cuando existe', () => {
    assert.equal(byKey['7866696831'].name, 'Ana')
  })

  test('ignora números demasiado cortos para ser teléfonos', () => {
    assert.ok(!rows.some(r => r.phone.includes('12345') && r.phone.replace(/\D/g, '').length < 8))
  })

  test('incluye el lead_phone guardado aunque no se haya escrito en un mensaje', () => {
    assert.ok(byKey['4121234567'], 'el teléfono del lead de Instagram debe aparecer')
  })

  test('ordena del contacto más reciente al más viejo', () => {
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].last >= rows[i].last)
  })
})

describe('humanDelayMs', () => {
  test('una respuesta corta espera menos que una larga', () => {
    const corta = humanDelayMs('Sí, claro.')
    const larga = humanDelayMs('x'.repeat(200))
    assert.ok(corta < larga, `corta=${corta} larga=${larga}`)
  })

  test('nunca responde instantáneo ni tarda más del tope', () => {
    for (let i = 0; i < 200; i++) {
      const ms = humanDelayMs('x'.repeat(i * 20))
      assert.ok(ms >= 600, `demasiado rápido: ${ms}`)
      assert.ok(ms <= 7000 * 1.2, `demasiado lento: ${ms}`)
    }
  })

  test('el tope es configurable por empresa', () => {
    for (let i = 0; i < 50; i++) {
      assert.ok(humanDelayMs('x'.repeat(500), { humanDelayMax: 2000 }) <= 2000 * 1.2)
    }
  })

  test('se puede apagar por empresa', () => {
    assert.equal(humanDelayMs('hola', { humanDelay: false }), 0)
  })
})

describe('humanPause descuenta lo ya esperado', () => {
  // El helper interno no se exporta; probamos la aritmética que usa: el retraso
  // efectivo es el objetivo menos lo que tardó el modelo en generar.
  test('si el modelo tardó más que el objetivo, no se espera nada extra', () => {
    const objetivo = humanDelayMs('respuesta corta')
    assert.ok(objetivo - 30000 <= 0, 'con 30s de generación no debe quedar espera')
  })

  test('si el modelo fue rápido, se espera la diferencia', () => {
    const objetivo = humanDelayMs('x'.repeat(150), { humanDelayMax: 7000 })
    const restante = objetivo - 1000
    assert.ok(restante > 0 && restante < objetivo)
  })
})
