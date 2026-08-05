// A .mp4/.webm/.mov link inside a WhatsApp text renders as a bare link, not a
// player. Split it out so we can send the video as a real media attachment
// (caption = the rest of the message). Kept side-effect free so it's testable.
export const VIDEO_URL_RE = /(https?:\/\/[^\s<>"]+?\.(?:mp4|webm|mov))(\?[^\s<>"]*)?/i

export function splitVideoMessage(text) {
  const m = (text || '').match(VIDEO_URL_RE)
  if (!m) return null
  const mediaUrl = m[0]
  const caption = text.replace(mediaUrl, '').replace(/[ \t]{2,}/g, ' ').trim()
  return { mediaUrl, caption }
}
