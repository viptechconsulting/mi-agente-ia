import { db } from '../db.js'
import { STATES } from './lynkro-lead-schema.js'

// ============================================================
// LYNKRO LEAD QUALIFICATION — conversation state machine
// ============================================================
// Persists into the existing conversations.flow_state JSON column
// (already used by the medspa vertical and the Lynkro-internal fu1/fu2/fu3
// follow-up flags). Lives under a `leadQuali` namespace so it never
// collides with either of those.

const DEFAULT_STATE = {
  current_state: 'OPENING',
  previous_state: null,
  business_type: null,
  volume_level: null,
  avg_ticket: null,
  handoff_required: false,
  handoff_reason: null,
  captured_fields: {},
  conversation_summary: '',
  qualified_notified: false
}

const ESCAPE_HATCH_STATES = new Set(['HUMAN_HANDOFF', 'DO_NOT_CONTACT', 'CONVERSATION_COMPLETE'])

const HAPPY_PATH = [
  'OPENING', 'BUSINESS_TYPE', 'VOLUME_DISCOVERY', 'TICKET_DISCOVERY',
  'DEMO_OFFERED', 'LOW_VOLUME_CLOSE'
]

export function isValidTransition(from, to) {
  if (!STATES.includes(to)) return false
  if (to === from) return true
  if (ESCAPE_HATCH_STATES.has(to)) return true
  if (to === 'QUESTION_HANDLING' && HAPPY_PATH.includes(from)) return true
  const fromIdx = HAPPY_PATH.indexOf(from)
  const toIdx = HAPPY_PATH.indexOf(to)
  if (fromIdx === -1 || toIdx === -1) return false
  return toIdx >= fromIdx
}

function parseFlowState(raw) {
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return {} }
}

export function loadState(conversationId) {
  const row = db.prepare('SELECT flow_state FROM conversations WHERE id = ?').get(conversationId)
  const blob = parseFlowState(row?.flow_state)
  return { ...DEFAULT_STATE, ...(blob.leadQuali || {}) }
}

// patch: partial state update (the fields extracted from respond_to_lead,
// plus optionally qualified_notified). Merges captured_fields rather than
// replacing it wholesale.
export function saveState(conversationId, patch) {
  const row = db.prepare('SELECT flow_state FROM conversations WHERE id = ?').get(conversationId)
  const blob = parseFlowState(row?.flow_state)
  const current = { ...DEFAULT_STATE, ...(blob.leadQuali || {}) }

  const nextState = patch.next_state || current.current_state
  const validTransition = isValidTransition(current.current_state, nextState)

  const merged = {
    ...current,
    previous_state: current.current_state,
    current_state: nextState,
    business_type: patch.business_type ?? current.business_type,
    volume_level: patch.volume_level ?? current.volume_level,
    avg_ticket: patch.avg_ticket ?? current.avg_ticket,
    handoff_required: patch.handoff_required ?? current.handoff_required,
    handoff_reason: patch.handoff_reason ?? current.handoff_reason,
    captured_fields: { ...current.captured_fields, ...(patch.captured_fields || {}) },
    conversation_summary: patch.conversation_summary_update ?? current.conversation_summary,
    qualified_notified: patch.qualified_notified ?? current.qualified_notified
  }
  if (!validTransition) {
    console.warn(`[lynkro-lead] invalid transition ${current.current_state} -> ${nextState} (conv ${conversationId})`)
    merged.flagged_invalid_transition = true
  } else {
    delete merged.flagged_invalid_transition
  }

  const nextBlob = { ...blob, leadQuali: merged }
  db.prepare('UPDATE conversations SET flow_state = ? WHERE id = ?').run(JSON.stringify(nextBlob), conversationId)
  return merged
}

// Pure decision function: has this lead crossed the "qualified" line, and
// have we not already told the sales team about it?
export function shouldNotifyQualified(state) {
  return (state.volume_level === 'MEDIO' || state.volume_level === 'ALTO')
    && !!state.captured_fields?.website
    && !!state.captured_fields?.instagram
    && !state.qualified_notified
}
