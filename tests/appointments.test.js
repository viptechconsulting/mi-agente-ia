import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

describe('appointments service — canModifyAppointment', () => {
  test('allows when well outside the notice window', async () => {
    const { canModifyAppointment } = await import('../services/appointments.js')
    const result = canModifyAppointment({
      startTimeISO: '2026-07-15T13:00:00.000Z',
      nowISO: '2026-07-13T13:00:00.000Z',
      minNoticeHours: 4
    })
    assert.equal(result.allowed, true)
    assert.equal(result.hoursUntil, 48)
  })

  test('blocks when inside the notice window', async () => {
    const { canModifyAppointment } = await import('../services/appointments.js')
    const result = canModifyAppointment({
      startTimeISO: '2026-07-13T15:00:00.000Z',
      nowISO: '2026-07-13T13:00:00.000Z',
      minNoticeHours: 4
    })
    assert.equal(result.allowed, false)
    assert.equal(result.hoursUntil, 2)
  })

  test('blocks appointments already in the past', async () => {
    const { canModifyAppointment } = await import('../services/appointments.js')
    const result = canModifyAppointment({
      startTimeISO: '2026-07-13T10:00:00.000Z',
      nowISO: '2026-07-13T13:00:00.000Z',
      minNoticeHours: 4
    })
    assert.equal(result.allowed, false)
    assert.ok(result.hoursUntil < 0)
  })

  test('defaults minNoticeHours to 4 when not provided', async () => {
    const { canModifyAppointment } = await import('../services/appointments.js')
    const result = canModifyAppointment({
      startTimeISO: '2026-07-13T16:00:00.000Z',
      nowISO: '2026-07-13T13:00:00.000Z'
    })
    assert.equal(result.allowed, false) // 3 hours < default 4
  })
})
