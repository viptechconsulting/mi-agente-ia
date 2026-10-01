// tests/wa-telefono-lid.test.js
// WhatsApp identifica a la gente por LID (123456@lid) en vez de por número, así
// que remoteJid ya no sirve como teléfono. Lo que no puede romperse: que un LID
// nunca se cuele como si fuera un número de teléfono — la clienta lo marcaría.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extraerTelefonoWa } from '../routes/chat.js'

test('toma el número de senderPn cuando el chat llega como @lid', () => {
  assert.equal(
    extraerTelefonoWa({ remoteJid: '101112254337143@lid', senderPn: '17863830513@s.whatsapp.net' }),
    '+17863830513'
  )
})

test('un @lid sin senderPn NO se devuelve como teléfono', () => {
  // Es el caso de los 106 leads históricos de BeGlam: no hay número, y decirlo
  // es mejor que inventar uno que nadie puede marcar.
  assert.equal(extraerTelefonoWa({ remoteJid: '101112254337143@lid' }), null)
})

test('chat directo clásico: sale de remoteJid', () => {
  assert.equal(extraerTelefonoWa({ remoteJid: '17863830513@s.whatsapp.net' }), '+17863830513')
})

test('en grupo usa participantPn, no el jid del grupo', () => {
  assert.equal(
    extraerTelefonoWa({ remoteJid: '120363@g.us', participantPn: '17863830513@s.whatsapp.net' }),
    '+17863830513'
  )
})

test('estados y difusiones no son leads', () => {
  assert.equal(extraerTelefonoWa({ remoteJid: 'status@broadcast' }), null)
  assert.equal(extraerTelefonoWa({ remoteJid: '120363@g.us' }), null)
})

test('descarta lo que no tiene largo de teléfono', () => {
  assert.equal(extraerTelefonoWa({ remoteJid: '123@s.whatsapp.net' }), null)
  assert.equal(extraerTelefonoWa({}), null)
  assert.equal(extraerTelefonoWa({ remoteJid: null }), null)
})

test('normaliza con + y sin el sufijo de dispositivo', () => {
  assert.equal(extraerTelefonoWa({ remoteJid: '17863830513:12@s.whatsapp.net' }), '+17863830513')
})
