// tests/wa-jid-filter.test.js
// Regresión 2026-09-04: los dos webhooks de WhatsApp (builtin Baileys y
// Evolution) solo filtraban grupos, así que los estados/stories
// (status@broadcast) entraban como si fueran leads y el agente los "atendía".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isConversableJid } from '../routes/chat.js'

test('acepta contactos reales (número y LID)', () => {
  assert.equal(isConversableJid('584140779258@s.whatsapp.net'), true)
  assert.equal(isConversableJid('156148535697646@lid'), true)
})

test('descarta estados, canales y grupos', () => {
  assert.equal(isConversableJid('status@broadcast'), false)
  assert.equal(isConversableJid('120363000000000000@newsletter'), false)
  assert.equal(isConversableJid('120363000000000000@g.us'), false)
})

test('descarta valores vacíos o ausentes', () => {
  assert.equal(isConversableJid(''), false)
  assert.equal(isConversableJid(undefined), false)
  assert.equal(isConversableJid(null), false)
})
