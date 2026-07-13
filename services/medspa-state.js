import { db } from '../db.js'
import { STATES } from './medspa-response-schema.js'

// ============================================================
// MED SPA — conversation state machine
// ============================================================
// Persists into the existing conversations.flow_state JSON column
// (already used by the Lynkro-only follow-up flow in routes/chat.js).
// Med Spa state lives under a `medspa` namespace inside that blob so
// it never collides with the Lynkro-internal fu1/fu2/fu3 flags.

const DEFAULT_STATE = {
  current_state: 'NEW_INQUIRY',
  previous_state: null,
  detected_intent: null,
  confidence_score: null,
  lead_temperature: 'COLD',
  next_best_action: null,
  handoff_required: false,
  handoff_reason: null,
  follow_up_eligible: false,
  follow_up_stage: 0,
  last_meaningful_user_message: null,
  last_agent_action: null,
  booking_status: 'none',
  captured_fields: {},
  missing_fields: [],
  conversation_summary: ''
}

// States reachable from ANY state — escalation/exit paths always available
// regardless of where the conversation currently is in the happy path.
const ESCAPE_HATCH_STATES = new Set([
  'HUMAN_HANDOFF', 'EXISTING_PATIENT_SUPPORT', 'COMPLAINT_OR_SENSITIVE_CASE',
  'CONVERSATION_COMPLETE', 'DO_NOT_CONTACT'
])

// Happy-path forward adjacency. QUESTION_HANDLING is reachable from every
// happy-path state since a new question can interrupt qualification/booking
// at any point without that being a modeling error.
const HAPPY_PATH = [
  'NEW_INQUIRY', 'INTENT_DISCOVERY', 'SERVICE_DISCOVERY', 'QUESTION_HANDLING',
  'LEAD_QUALIFICATION', 'VALUE_BUILDING', 'CONTACT_CAPTURE', 'BOOKING_INTENT',
  'AVAILABILITY_SELECTION', 'BOOKING_CONFIRMATION', 'FOLLOW_UP_ELIGIBLE'
]

export function isValidTransition(from, to) {
  if (!STATES.includes(to)) return false
  if (to === from) return true
  if (ESCAPE_HATCH_STATES.has(to)) return true
  if (to === 'QUESTION_HANDLING' && HAPPY_PATH.includes(from)) return true
  const fromIdx = HAPPY_PATH.indexOf(from)
  const toIdx = HAPPY_PATH.indexOf(to)
  if (fromIdx === -1 || toIdx === -1) return false
  return toIdx >= fromIdx // forward or same progress along the happy path
}

function parseFlowState(raw) {
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return {} }
}

export function loadState(conversationId) {
  const row = db.prepare('SELECT flow_state FROM conversations WHERE id = ?').get(conversationId)
  const blob = parseFlowState(row?.flow_state)
  return { ...DEFAULT_STATE, ...(blob.medspa || {}) }
}

// patch: partial state update (e.g. the fields extracted from respond_to_patient).
// Merges captured_fields/missing_fields rather than replacing them wholesale.
export function saveState(conversationId, patch) {
  const row = db.prepare('SELECT flow_state FROM conversations WHERE id = ?').get(conversationId)
  const blob = parseFlowState(row?.flow_state)
  const current = { ...DEFAULT_STATE, ...(blob.medspa || {}) }

  const nextState = patch.next_state || current.current_state
  const validTransition = isValidTransition(current.current_state, nextState)

  const merged = {
    ...current,
    previous_state: current.current_state,
    current_state: nextState,
    detected_intent: patch.primary_intent ?? current.detected_intent,
    confidence_score: patch.confidence ?? current.confidence_score,
    lead_temperature: patch.lead_temperature ?? current.lead_temperature,
    next_best_action: patch.next_best_action ?? current.next_best_action,
    handoff_required: patch.handoff_required ?? current.handoff_required,
    handoff_reason: patch.handoff_reason ?? current.handoff_reason,
    follow_up_eligible: patch.follow_up_eligible ?? current.follow_up_eligible,
    last_meaningful_user_message: patch.last_meaningful_user_message ?? current.last_meaningful_user_message,
    last_agent_action: patch.next_best_action ?? current.last_agent_action,
    booking_status: patch.booking_status ?? current.booking_status,
    captured_fields: { ...current.captured_fields, ...(patch.captured_fields || {}) },
    missing_fields: patch.missing_fields ?? current.missing_fields,
    conversation_summary: patch.conversation_summary_update ?? current.conversation_summary
  }
  if (!validTransition) {
    console.warn(`[medspa-state] invalid transition ${current.current_state} -> ${nextState} (conv ${conversationId}), keeping model's choice but flagging`)
    merged.flagged_invalid_transition = true
  } else {
    delete merged.flagged_invalid_transition
  }

  const nextBlob = { ...blob, medspa: merged }
  db.prepare('UPDATE conversations SET flow_state = ? WHERE id = ?').run(JSON.stringify(nextBlob), conversationId)
  return merged
}

export function setDoNotContact(conversationId) {
  db.prepare('UPDATE conversations SET do_not_contact = 1 WHERE id = ?').run(conversationId)
}

export function isDoNotContact(conversationId) {
  const row = db.prepare('SELECT do_not_contact FROM conversations WHERE id = ?').get(conversationId)
  return !!row?.do_not_contact
}
