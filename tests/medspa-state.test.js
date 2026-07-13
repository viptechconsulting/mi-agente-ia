import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import { db } from '../db.js'
import { loadState, saveState, isValidTransition, setDoNotContact, isDoNotContact } from '../services/medspa-state.js'
import { validateAgentResponse } from '../services/medspa-response-schema.js'

function makeConversation() {
  const id = crypto.randomUUID()
  const now = Date.now()
  db.prepare('INSERT INTO conversations (id, visitor_id, channel, created_at, updated_at, company_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'test-visitor', 'web', now, now, 'test-company')
  return id
}

describe('medspa-state: transitions', () => {
  test('happy-path forward transition is valid', () => {
    assert.ok(isValidTransition('NEW_INQUIRY', 'INTENT_DISCOVERY'))
    assert.ok(isValidTransition('INTENT_DISCOVERY', 'BOOKING_CONFIRMATION'))
  })

  test('staying in the same state is always valid', () => {
    assert.ok(isValidTransition('SERVICE_DISCOVERY', 'SERVICE_DISCOVERY'))
  })

  test('backward happy-path transition is invalid', () => {
    assert.equal(isValidTransition('BOOKING_INTENT', 'NEW_INQUIRY'), false)
  })

  test('QUESTION_HANDLING reachable from any happy-path state', () => {
    assert.ok(isValidTransition('BOOKING_INTENT', 'QUESTION_HANDLING'))
    assert.ok(isValidTransition('CONTACT_CAPTURE', 'QUESTION_HANDLING'))
  })

  test('escape-hatch states reachable from anywhere', () => {
    assert.ok(isValidTransition('NEW_INQUIRY', 'HUMAN_HANDOFF'))
    assert.ok(isValidTransition('BOOKING_CONFIRMATION', 'COMPLAINT_OR_SENSITIVE_CASE'))
    assert.ok(isValidTransition('SERVICE_DISCOVERY', 'DO_NOT_CONTACT'))
  })

  test('unknown state is invalid', () => {
    assert.equal(isValidTransition('NEW_INQUIRY', 'NOT_A_REAL_STATE'), false)
  })
})

describe('medspa-state: load/save', () => {
  test('loadState returns defaults for a fresh conversation', () => {
    const convId = makeConversation()
    const state = loadState(convId)
    assert.equal(state.current_state, 'NEW_INQUIRY')
    assert.equal(state.lead_temperature, 'COLD')
    assert.deepEqual(state.captured_fields, {})
  })

  test('saveState persists and merges captured_fields across turns', () => {
    const convId = makeConversation()
    saveState(convId, {
      next_state: 'SERVICE_DISCOVERY',
      primary_intent: 'PRICE_QUESTION',
      lead_temperature: 'WARM',
      confidence: 0.9,
      captured_fields: { interested_service: 'Botox' },
      handoff_required: false,
      follow_up_eligible: false,
      conversation_summary_update: 'Asked about Botox pricing.'
    })
    saveState(convId, {
      next_state: 'QUESTION_HANDLING',
      primary_intent: 'SERVICE_INFORMATION',
      lead_temperature: 'WARM',
      confidence: 0.85,
      captured_fields: { treatment_area: 'forehead' },
      handoff_required: false,
      follow_up_eligible: false,
      conversation_summary_update: 'Asked about Botox pricing; specified forehead area.'
    })

    const state = loadState(convId)
    assert.equal(state.current_state, 'QUESTION_HANDLING')
    assert.equal(state.previous_state, 'SERVICE_DISCOVERY')
    assert.deepEqual(state.captured_fields, { interested_service: 'Botox', treatment_area: 'forehead' })
    assert.equal(state.conversation_summary, 'Asked about Botox pricing; specified forehead area.')
  })

  test('invalid transition is flagged but not rejected', () => {
    const convId = makeConversation()
    saveState(convId, { next_state: 'BOOKING_CONFIRMATION', primary_intent: 'BOOKING_REQUEST', lead_temperature: 'HOT', confidence: 0.9, handoff_required: false, follow_up_eligible: false, conversation_summary_update: 'x' })
    const state = saveState(convId, { next_state: 'NEW_INQUIRY', primary_intent: 'GENERAL_QUESTION', lead_temperature: 'HOT', confidence: 0.5, handoff_required: false, follow_up_eligible: false, conversation_summary_update: 'y' })
    assert.equal(state.current_state, 'NEW_INQUIRY')
    assert.equal(state.flagged_invalid_transition, true)
  })

  test('does not clobber the Lynkro-internal flow_state namespace', () => {
    const convId = makeConversation()
    db.prepare('UPDATE conversations SET flow_state = ? WHERE id = ?').run(JSON.stringify({ fu1: true, phase: 'mid' }), convId)
    saveState(convId, { next_state: 'INTENT_DISCOVERY', primary_intent: 'GENERAL_QUESTION', lead_temperature: 'COLD', confidence: 0.5, handoff_required: false, follow_up_eligible: false, conversation_summary_update: 'z' })
    const row = db.prepare('SELECT flow_state FROM conversations WHERE id = ?').get(convId)
    const blob = JSON.parse(row.flow_state)
    assert.equal(blob.fu1, true)
    assert.equal(blob.phase, 'mid')
    assert.equal(blob.medspa.current_state, 'INTENT_DISCOVERY')
  })
})

describe('medspa-state: do_not_contact', () => {
  test('defaults to false and flips on setDoNotContact', () => {
    const convId = makeConversation()
    assert.equal(isDoNotContact(convId), false)
    setDoNotContact(convId)
    assert.equal(isDoNotContact(convId), true)
  })
})

describe('medspa-response-schema: validateAgentResponse', () => {
  test('valid response passes', () => {
    const { valid, errors } = validateAgentResponse({
      message_to_user: 'Botox is $12/unit.',
      next_state: 'SERVICE_DISCOVERY',
      primary_intent: 'PRICE_QUESTION',
      lead_temperature: 'WARM',
      handoff_required: false,
      follow_up_eligible: false
    })
    assert.equal(valid, true)
    assert.deepEqual(errors, [])
  })

  test('missing message_to_user fails', () => {
    const { valid, errors } = validateAgentResponse({
      message_to_user: '  ',
      next_state: 'SERVICE_DISCOVERY',
      primary_intent: 'PRICE_QUESTION',
      lead_temperature: 'WARM',
      handoff_required: false,
      follow_up_eligible: false
    })
    assert.equal(valid, false)
    assert.ok(errors.some(e => e.includes('message_to_user')))
  })

  test('invalid enum values fail', () => {
    const { valid, errors } = validateAgentResponse({
      message_to_user: 'hi',
      next_state: 'NOT_A_STATE',
      primary_intent: 'NOT_AN_INTENT',
      lead_temperature: 'SCALDING',
      handoff_required: false,
      follow_up_eligible: false
    })
    assert.equal(valid, false)
    assert.equal(errors.length, 3)
  })
})
