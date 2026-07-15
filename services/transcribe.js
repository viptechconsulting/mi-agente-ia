// Transcribes WhatsApp voice notes (OGG/Opus) via OpenAI's Whisper API.
// Anthropic's API has no speech-to-text endpoint, so this is a separate provider.
export async function transcribeAudioBuffer(buffer, mimetype = 'audio/ogg') {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY no configurada')

  const ext = mimetype.includes('mp4') ? 'm4a' : 'ogg'
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mimetype }), `audio.${ext}`)
  form.append('model', 'whisper-1')

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  })
  if (!res.ok) throw new Error(`Whisper API ${res.status}: ${await res.text()}`)

  const data = await res.json()
  return data.text?.trim() || ''
}
