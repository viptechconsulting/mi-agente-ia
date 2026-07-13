# Canal de SMS (saliente, vía Twilio) — Diseño

## Contexto

Una clienta potencial preguntó por SMS en una reunión de ventas (junto con reagendar/cancelar citas, ya construido y desplegado — ver `docs/superpowers/specs/2026-07-13-reagendar-cancelar-citas-design.md`). Hoy el sistema no tiene ninguna integración de SMS: cero dependencia de Twilio/Nexmo/etc. en `package.json`, cero código de SMS. Los canales existentes (WhatsApp vía Baileys, Instagram) siguen el mismo patrón: `channel` como string libre en `conversations`, `visitor_id` con prefijo (`wa:`, `ig:`), una función de envío por canal (`sendWhatsApp`, `sendInstagram`), y una ruta de webhook que llama a `processMessage()`.

## Alcance

**Solo saliente.** El cliente no puede iniciar ni sostener una conversación de IA por SMS — no hay webhook de entrada de Twilio, no hay nueva fila en `conversations` para SMS. SMS es un canal de entrega adicional para mensajes que el sistema ya envía automáticamente por WhatsApp:

- `citas.confirm` — confirmación al crear una cita (webhooks GHL y genérico)
- `citas.cancel` — aviso al cancelarse una cita (webhooks GHL y genérico)
- `reminder_24h` / `reminder_day` — recordatorios automáticos (`jobs/campaign-scheduler.js`)

**Fuera de alcance:** campañas de marketing (inactivos, reseñas, post-consulta, winback) y las confirmaciones del nuevo flujo de reagendar/cancelar por chat (esas ya las confirma el propio bot de IA en el mismo canal — WhatsApp/Instagram — donde el cliente está escribiendo; no hay un mensaje "de sistema" separado que duplicar ahí).

**Modo de envío: doble, siempre.** Cuando una empresa tiene Twilio conectado, el SMS se manda además del WhatsApp existente en los 5 puntos de envío listados abajo — no reemplaza, no es fallback condicional.

**Cuenta Twilio: por empresa.** Cada empresa cliente conecta su propia cuenta Twilio (Account SID + Auth Token + número "From"), igual que hoy cada empresa conecta su propio GHL (`cfg.ghl.api_key` / `cfg.ghl.location_id`) — no es una cuenta compartida a nivel servidor como Square/QuickBooks.

## Arquitectura

**`services/twilio.js`** (nuevo, sin dependencia nueva en `package.json` — Twilio expone una API REST simple):

```js
export async function getAccountInfo(accountSid, authToken) { /* GET .../Accounts/{Sid}.json, Basic Auth */ }
export async function sendSMS(accountSid, authToken, fromNumber, toPhone, text) { /* POST .../Accounts/{Sid}/Messages.json */ }
```

Mismo estilo que `services/ghl.js`/`services/square.js`: `fetch` directo, `throw new Error(...)` en respuesta no-ok.

**`routes/chat.js`** — nuevo wrapper, junto a `sendWhatsApp`/`sendInstagram`:

```js
export async function sendSMS(cfg, phone, text) {
  if (!cfg.twilio?.accountSid) return
  try {
    const { sendSMS: twilioSend } = await import('../services/twilio.js')
    await twilioSend(cfg.twilio.accountSid, cfg.twilio.authToken, cfg.twilio.fromNumber, phone, text)
  } catch (err) { console.error('SMS send error:', err.message) }
}
```

Fire-and-forget, igual que `sendWhatsApp` hoy — no relanza, no reintenta.

**Config:** `cfg.twilio = { accountSid, authToken, fromNumber, connected_at }` — sin `defaultConfig` (opcional, como `cfg.ghl`, no aparece hasta que la empresa lo conecta).

## Los 5 puntos de envío duplicado

En cada uno, justo después de la llamada a WhatsApp existente:

1. `routes/admin.js:765` (webhook GHL, `citas.confirm`)
2. `routes/admin.js:770` (webhook GHL, `citas.cancel`)
3. `routes/admin.js:983` (webhook genérico, `citas.confirm`)
4. `routes/admin.js:988` (webhook genérico, `citas.cancel`)
5. `jobs/campaign-scheduler.js:57` (`sendReminder`, usado por `reminder_24h` y `reminder_day`)

## Admin UI

Nueva sección "Twilio — SMS" en el panel (mirror de la sección GHL): 3 campos (Account SID, Auth Token, número "From"), botón "Conectar" → `POST /api/twilio/test` (valida con `getAccountInfo` antes de guardar), botón "Desconectar" → `DELETE /api/twilio/disconnect`.

Rutas nuevas en `routes/admin.js` (mismo patrón que `/ghl/status`, `/ghl/test`, `/ghl/disconnect`):
- `GET /twilio/status` → `{ connected, fromNumber, connected_at }`
- `POST /twilio/test` → valida credenciales, si OK guarda `cfg.twilio` y responde `{ ok: true }`
- `DELETE /twilio/disconnect` → `delete cfg.twilio`

## Manejo de errores

- Falla de Twilio (número inválido, sin crédito, cuenta suspendida) → se loguea, no bloquea ni revierte el envío por WhatsApp del mismo punto. Ambos envíos son independientes.
- Sin Twilio conectado → no se manda nada por SMS, sin error, sin log — comportamiento actual sin cambios.
- Sin reintentos — mismo comportamiento que `sendWhatsApp` hoy.

## Testing

`tests/twilio.test.js` (patrón `node:test` + `node:assert/strict`): pruebas de las partes puras de `services/twilio.js` — construcción del header Basic Auth (base64 de `accountSid:authToken`), construcción del body (`URLSearchParams` con `From`/`To`/`Body`), y el mensaje de error cuando la respuesta no es ok. La llamada real a la API de Twilio (red) no se testea automatizado, siguiendo la convención ya establecida para `createBooking`/`getAppointments`/etc. — se verifica manualmente contra una cuenta de prueba de Twilio antes de producción.
