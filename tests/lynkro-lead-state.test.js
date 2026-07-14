import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import { db } from '../db.js'
import { loadState, saveState, isValidTransition, shouldNotifyQualified } from '../services/lynkro-lead-state.js'
import { validateAgentResponse } from '../services/lynkro-lead-schema.js'

function makeConversation() {
  const id = crypto.randomUUID()
  const now = Date.now()
  db.prepare('INSERT INTO conversations (id, visitor_id, channel, created_at, updated_at, company_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'test-visitor', 'web', now, now, 'test-company')
  return id
}

describe('lynkro-lead-state: transitions', () => {
  test('happy-path forward transition is valid', () => {
    assert.ok(isValidTransition('OPENING', 'BUSINESS_TYPE'))
    assert.ok(isValidTransition('BUSINESS_TYPE', 'DEMO_OFFERED'))
  })

  test('staying in the same state is always valid', () => {
    assert.ok(isValidTransition('VOLUME_DISCOVERY', 'VOLUME_DISCOVERY'))
  })

  test('backward happy-path transition is invalid', () => {
    assert.equal(isValidTransition('TICKET_DISCOVERY', 'OPENING'), false)
  })

  test('QUESTION_HANDLING reachable from any happy-path state', () => {
    assert.ok(isValidTransition('VOLUME_DISCOVERY', 'QUESTION_HANDLING'))
    assert.ok(isValidTransition('TICKET_DISCOVERY', 'QUESTION_HANDLING'))
  })

  test('escape-hatch states reachable from anywhere', () => {
    assert.ok(isValidTransition('OPENING', 'HUMAN_HANDOFF'))
    assert.ok(isValidTransition('DEMO_OFFERED', 'DO_NOT_CONTACT'))
  })
})

describe('lynkro-lead-state: loadState/saveState', () => {
  test('loadState returns defaults for a fresh conversation', () => {
    const convId = makeConversation()
    const state = loadState(convId)
    assert.equal(state.current_state, 'OPENING')
    assert.equal(state.volume_level, null)
    assert.equal(state.qualified_notified, false)
  })

  test('saveState persists and merges captured_fields incrementally', () => {
    const convId = makeConversation()
    saveState(convId, {
      next_state: 'BUSINESS_TYPE', business_type: 'clínica dental', handoff_required: false,
      conversation_summary_update: 'a', captured_fields: { website: 'clinica.com' }
    })
    const state = saveState(convId, {
      next_state: 'VOLUME_DISCOVERY', volume_level: 'ALTO', handoff_required: false,
      conversation_summary_update: 'b', captured_fields: { instagram: '@clinica' }
    })
    assert.equal(state.current_state, 'VOLUME_DISCOVERY')
    assert.equal(state.business_type, 'clínica dental')
    assert.equal(state.volume_level, 'ALTO')
    assert.deepEqual(state.captured_fields, { website: 'clinica.com', instagram: '@clinica' })
  })

  test('lynkro-lead state coexists with unrelated flow_state data without collision', () => {
    const convId = makeConversation()
    db.prepare('UPDATE conversations SET flow_state = ? WHERE id = ?').run(JSON.stringify({ fu1: true, phase: 'mid' }), convId)
    saveState(convId, { next_state: 'BUSINESS_TYPE', handoff_required: false, conversation_summary_update: 'x' })
    const row = db.prepare('SELECT flow_state FROM conversations WHERE id = ?').get(convId)
    const blob = JSON.parse(row.flow_state)
    assert.equal(blob.fu1, true)
    assert.equal(blob.phase, 'mid')
    assert.equal(blob.leadQuali.current_state, 'BUSINESS_TYPE')
  })
})

describe('lynkro-lead-state: shouldNotifyQualified', () => {
  test('true when volume is ALTO and both website and instagram are captured', () => {
    assert.equal(shouldNotifyQualified({
      volume_level: 'ALTO',
      captured_fields: { website: 'a.com', instagram: '@a' },
      qualified_notified: false
    }), true)
  })

  test('true when volume is MEDIO and both fields are captured', () => {
    assert.equal(shouldNotifyQualified({
      volume_level: 'MEDIO',
      captured_fields: { website: 'a.com', instagram: '@a' },
      qualified_notified: false
    }), true)
  })

  test('false when volume is BAJO even with both fields captured', () => {
    assert.equal(shouldNotifyQualified({
      volume_level: 'BAJO',
      captured_fields: { website: 'a.com', instagram: '@a' },
      qualified_notified: false
    }), false)
  })

  test('false when instagram is missing', () => {
    assert.equal(shouldNotifyQualified({
      volume_level: 'ALTO',
      captured_fields: { website: 'a.com' },
      qualified_notified: false
    }), false)
  })

  test('false when already notified', () => {
    assert.equal(shouldNotifyQualified({
      volume_level: 'ALTO',
      captured_fields: { website: 'a.com', instagram: '@a' },
      qualified_notified: true
    }), false)
  })
})

describe('lynkro-lead-schema: validateAgentResponse', () => {
  test('valid response passes', () => {
    const { valid, errors } = validateAgentResponse({
      message_to_user: 'Con ese volumen seguro se te escapan mensajes.',
      next_state: 'VOLUME_DISCOVERY', handoff_required: false, conversation_summary_update: 'x'
    })
    assert.equal(valid, true)
    assert.deepEqual(errors, [])
  })

  test('missing message_to_user fails', () => {
    const { valid, errors } = validateAgentResponse({
      message_to_user: '   ', next_state: 'VOLUME_DISCOVERY', handoff_required: false, conversation_summary_update: 'x'
    })
    assert.equal(valid, false)
    assert.ok(errors.some(e => e.includes('message_to_user')))
  })

  test('invalid enum values fail', () => {
    const { valid, errors } = validateAgentResponse({
      message_to_user: 'hi', next_state: 'NOT_A_STATE', volume_level: 'HIRVIENDO', handoff_required: false, conversation_summary_update: 'x'
    })
    assert.equal(valid, false)
    assert.equal(errors.length, 2)
  })
})
