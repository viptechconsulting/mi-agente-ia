// ============================================================
// LYNKRO LEAD QUALIFICATION — structured agent response (forced tool call)
// ============================================================
// Every turn of this vertical ends by calling this tool instead of
// returning raw text. `message_to_user` is the only field ever sent
// to the lead; everything else is persisted into flow_state.

export const STATES = [
  'OPENING', 'BUSINESS_TYPE', 'VOLUME_DISCOVERY', 'TICKET_DISCOVERY',
  'DEMO_OFFERED', 'LOW_VOLUME_CLOSE', 'QUESTION_HANDLING',
  'HUMAN_HANDOFF', 'DO_NOT_CONTACT', 'CONVERSATION_COMPLETE'
]

export const VOLUME_LEVELS = ['BAJO', 'MEDIO', 'ALTO']

export const RESPOND_TO_LEAD_TOOL = {
  name: 'respond_to_lead',
  description: 'Termina SIEMPRE tu turno llamando esta herramienta. message_to_user es lo único que el lead ve — el resto es estado interno para el sistema.',
  input_schema: {
    type: 'object',
    properties: {
      message_to_user: { type: 'string', description: 'Respuesta para el lead. Frases cortas, sin JSON, sin markdown, máximo un emoji si el tono lo amerita.' },
      next_state: { type: 'string', enum: STATES },
      business_type: { type: ['string', 'null'], description: 'Tipo de negocio detectado, o null si aún no se sabe.' },
      volume_level: { type: ['string', 'null'], enum: [...VOLUME_LEVELS, null], description: 'Clasificación interna del volumen de mensajes — nunca se le dice directamente al lead, se infiere de su respuesta.' },
      avg_ticket: { type: ['string', 'null'], description: 'Ticket promedio mencionado por el lead, o null si aún no se sabe.' },
      captured_fields: {
        type: 'object',
        description: 'Campos nuevos capturados en este turno (website, instagram). Solo incluye lo nuevo/confirmado.',
        additionalProperties: true
      },
      handoff_required: { type: 'boolean' },
      conversation_summary_update: { type: 'string', description: 'Resumen actualizado de la conversación en 1-2 oraciones (reemplaza el anterior).' }
    },
    required: ['message_to_user', 'next_state', 'handoff_required', 'conversation_summary_update']
  }
}

// Thin structural check — not a full JSON-schema validator, matches this
// repo's existing posture (see services/medspa-response-schema.js).
export function validateAgentResponse(input) {
  const errors = []
  if (typeof input?.message_to_user !== 'string' || !input.message_to_user.trim()) {
    errors.push('message_to_user missing or empty')
  }
  if (!STATES.includes(input?.next_state)) errors.push(`next_state invalid: ${input?.next_state}`)
  if (input?.volume_level != null && !VOLUME_LEVELS.includes(input.volume_level)) {
    errors.push(`volume_level invalid: ${input?.volume_level}`)
  }
  if (typeof input?.handoff_required !== 'boolean') errors.push('handoff_required must be boolean')
  return { valid: errors.length === 0, errors }
}
