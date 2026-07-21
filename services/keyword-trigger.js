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
