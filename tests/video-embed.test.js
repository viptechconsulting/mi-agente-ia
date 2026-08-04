import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

// ponytail: videoEmbed() is duplicated inline in public/widget.js and public/demo.html
// (classic browser scripts, not importable). This mirrors its detection regexes so a
// broken/over-eager pattern fails here. Keep in sync if the inline copies change.
function videoEmbed(url) {
  if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) return 'video'
  if (/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{11})/.test(url)) return 'youtube'
  if (/vimeo\.com\/(\d+)/.test(url)) return 'vimeo'
  return ''
}

describe('videoEmbed detection', () => {
  test('renders a player for video URLs', () => {
    assert.equal(videoEmbed('https://chat.lynkro.io/lynkro-intro.mp4'), 'video')
    assert.equal(videoEmbed('https://x.com/a.webm?v=2'), 'video')
    assert.equal(videoEmbed('https://youtu.be/dQw4w9WgXcQ'), 'youtube')
    assert.equal(videoEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'youtube')
    assert.equal(videoEmbed('https://vimeo.com/123456789'), 'vimeo')
  })
  test('leaves non-video links alone', () => {
    assert.equal(videoEmbed('https://chat.lynkro.io/demo/abc'), '')
    assert.equal(videoEmbed('https://calendly.com/lynkro/15min'), '')
    assert.equal(videoEmbed('https://lynkro.io/mp4-guide'), '') // no real extension
  })
})
