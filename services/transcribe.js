// Transcribes WhatsApp voice notes (OGG/Opus) to text.
// Anthropic's API has no speech-to-text endpoint, so this uses a separate
// provider. Prefers Groq (whisper-large-v3, cheap/fast, OpenAI-compatible API);
// falls back to OpenAI's Whisper if only OPENAI_API_KEY is set. Switching
// providers is just a matter of which env var is present.
export async function transcribeAudioBuffer(buffer, mimetype = 'audio/ogg') {
  const groqKey = process.env.GROQ_API_KEY
  const openaiKey = process.env.OPENAI_API_KEY

  let url, apiKey, model
  if (groqKey) {
    url = 'https://api.groq.com/openai/v1/audio/transcriptions'
    apiKey = groqKey
    model = 'whisper-large-v3'
  } else if (openaiKey) {
    url = 'https://api.openai.com/v1/audio/transcriptions'
    apiKey = openaiKey
    model = 'whisper-1'
  } else {
    throw new Error('Ni GROQ_API_KEY ni OPENAI_API_KEY configuradas')
  }

  const ext = mimetype.includes('mp4') ? 'm4a' : 'ogg'
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mimetype }), `audio.${ext}`)
  form.append('model', model)

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  })
  if (!res.ok) throw new Error(`Transcribe API ${res.status}: ${await res.text()}`)

  const data = await res.json()
  return data.text?.trim() || ''
}
