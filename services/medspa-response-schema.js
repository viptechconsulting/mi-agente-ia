// ============================================================
// MED SPA — structured agent response (forced tool call)
// ============================================================
// Every medspa-vertical turn ends by calling this tool instead of
// returning raw text. `message_to_user` is the only field ever sent
// to the patient; everything else is persisted into flow_state.

export const STATES = [
  'NEW_INQUIRY', 'INTENT_DISCOVERY', 'SERVICE_DISCOVERY', 'QUESTION_HANDLING',
  'LEAD_QUALIFICATION', 'VALUE_BUILDING', 'CONTACT_CAPTURE', 'BOOKING_INTENT',
  'AVAILABILITY_SELECTION', 'BOOKING_CONFIRMATION', 'FOLLOW_UP_ELIGIBLE',
  'HUMAN_HANDOFF', 'EXISTING_PATIENT_SUPPORT', 'COMPLAINT_OR_SENSITIVE_CASE',
  'CONVERSATION_COMPLETE', 'DO_NOT_CONTACT'
]

export const PRIMARY_INTENTS = [
  'SERVICE_INFORMATION', 'PRICE_QUESTION', 'PROMOTION_QUESTION', 'AVAILABILITY',
  'BOOKING_REQUEST', 'RESCHEDULING', 'CANCELLATION', 'LOCATION', 'HOURS',
  'FINANCING', 'NEW_PATIENT', 'EXISTING_PATIENT', 'TREATMENT_SUITABILITY',
  'TREATMENT_RESULTS', 'SAFETY_OR_MEDICAL_QUESTION', 'COMPLAINT', 'HUMAN_REQUEST',
  'GENERAL_QUESTION', 'UNCLEAR', 'OPT_OUT', 'EMERGENCY_OR_URGENT_MEDICAL_CONCERN'
]

export const LEAD_TEMPERATURES = ['HOT', 'WARM', 'COLD', 'EXISTING_PATIENT']

export const RESPOND_TO_PATIENT_TOOL = {
  name: 'respond_to_patient',
  description: 'Termina SIEMPRE tu turno llamando esta herramienta. message_to_user es lo único que el paciente ve — el resto es estado interno para el sistema.',
  input_schema: {
    type: 'object',
    properties: {
      message_to_user: { type: 'string', description: 'Respuesta final para el paciente. 1-4 oraciones cortas, sin JSON, sin markdown.' },
      detected_language: { type: 'string', description: "Código de idioma detectado, ej. 'en' o 'es'." },
      primary_intent: { type: 'string', enum: PRIMARY_INTENTS },
      secondary_intents: { type: 'array', items: { type: 'string', enum: PRIMARY_INTENTS } },
      next_state: { type: 'string', enum: STATES },
      lead_temperature: { type: 'string', enum: LEAD_TEMPERATURES },
      confidence: { type: 'number', description: 'Confianza 0.0-1.0 en la clasificación de intención.' },
      captured_fields: {
        type: 'object',
        description: 'Campos nuevos o actualizados detectados en este turno (nombre, servicio, área, teléfono, etc.). Solo incluye lo nuevo/confirmado.',
        additionalProperties: true
      },
      next_best_action: { type: 'string', description: 'Próxima acción recomendada en snake_case, ej. ask_treatment_area.' },
      handoff_required: { type: 'boolean' },
      handoff_reason: { type: ['string', 'null'] },
      follow_up_eligible: { type: 'boolean' },
      conversation_summary_update: { type: 'string', description: 'Resumen actualizado de la conversación en 1-2 oraciones (reemplaza el anterior).' }
    },
    required: [
      'message_to_user', 'detected_language', 'primary_intent', 'next_state',
      'lead_temperature', 'confidence', 'handoff_required', 'follow_up_eligible',
      'conversation_summary_update'
    ]
  }
}

// Thin structural check — not a full JSON-schema validator, matches this
// repo's existing posture of not adding validation libraries for one call site.
export function validateAgentResponse(input) {
  const errors = []
  if (typeof input?.message_to_user !== 'string' || !input.message_to_user.trim()) {
    errors.push('message_to_user missing or empty')
  }
  if (!STATES.includes(input?.next_state)) errors.push(`next_state invalid: ${input?.next_state}`)
  if (!PRIMARY_INTENTS.includes(input?.primary_intent)) errors.push(`primary_intent invalid: ${input?.primary_intent}`)
  if (!LEAD_TEMPERATURES.includes(input?.lead_temperature)) errors.push(`lead_temperature invalid: ${input?.lead_temperature}`)
  if (typeof input?.handoff_required !== 'boolean') errors.push('handoff_required must be boolean')
  if (typeof input?.follow_up_eligible !== 'boolean') errors.push('follow_up_eligible must be boolean')
  return { valid: errors.length === 0, errors }
}
