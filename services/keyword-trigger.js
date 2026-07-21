import { db } from '../db.js'

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function matchKeywordTrigger(cfg, text) {
  const triggers = cfg.keywordTriggers || []
  for (let index = 0; index < triggers.length; index++) {
    const t = triggers[index]
    const hay = t.caseSensitive ? text : text.toLowerCase()
    for (const kwRaw of t.keywords || []) {
      const kw = t.caseSensitive ? kwRaw : kwRaw.toLowerCase()
      const isMatch =
        t.matchType === 'exact' ? hay.trim() === kw.trim() :
        t.matchType === 'word'  ? new RegExp(`\\b${escapeRegex(kw)}\\b`).test(hay) :
        hay.includes(kw) // 'contains', default
      if (isMatch) return { trigger: t, index }
    }
  }
  return null
}

function parseFlowState(raw) {
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return {} }
}

function loadFlowBlob(conversationId) {
  const row = db.prepare('SELECT flow_state FROM conversations WHERE id = ?').get(conversationId)
  return parseFlowState(row?.flow_state)
}

function saveFlowBlob(conversationId, blob) {
  db.prepare('UPDATE conversations SET flow_state = ? WHERE id = ?').run(JSON.stringify(blob), conversationId)
}

export function getActiveTriggerFlow(conversationId) {
  return loadFlowBlob(conversationId).keywordTrigger || null
}

export function startTriggerFlow(conversationId, triggerIndex) {
  const blob = loadFlowBlob(conversationId)
  blob.keywordTrigger = { triggerIndex, step: 1 }
  saveFlowBlob(conversationId, blob)
}

export function advanceTriggerFlow(conversationId, nextStep) {
  const blob = loadFlowBlob(conversationId)
  if (!blob.keywordTrigger) return
  blob.keywordTrigger.step = nextStep
  saveFlowBlob(conversationId, blob)
}

export function clearTriggerFlow(conversationId) {
  const blob = loadFlowBlob(conversationId)
  delete blob.keywordTrigger
  saveFlowBlob(conversationId, blob)
}
