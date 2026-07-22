# Activadores: motor de disparo + botón con enlace — Diseño

## Contexto

El usuario pidió agregar la opción de "botón" (estilo ManyChat) a los Activadores (`config.keywordTriggers`), para que al configurar un activador se pueda elegir entre una respuesta de texto normal o una respuesta con un botón que dirija a un enlace.

Investigando antes de diseñar, se encontró que **el motor de Activadores no tiene ninguna lógica en el backend** — ni en `routes/chat.js`, ni en `db.js` (`buildSystemPrompt`), ni en ningún archivo de `services/`. El panel de admin permite configurar etiqueta, palabras clave, tipo de coincidencia, respuesta o flujo de pasos, y una casilla de seguimiento — pero nada en el servidor lee `cfg.keywordTriggers` cuando llega un mensaje real. El bot siempre responde vía la IA general (prompt + FAQs), nunca por coincidencia determinística de palabra clave. El usuario confirmó que nunca había verificado esto con una prueba puntual.

Por lo tanto este proyecto incluye dos partes inseparables: **(1)** construir el motor de disparo que hoy no existe, y **(2)** agregar el botón. La casilla "Enviar seguimiento 1 hora después" (`followupEnabled`) también está inerte, pero queda fuera de alcance — se anota como pendiente separado, no se toca acá.

## Alcance

**Canales:** WhatsApp, widget web, Instagram — los tres.

**Tipos de activador:** el botón solo aplica a "Respuesta automática" (un solo mensaje). Los "Flujos de preguntas" (multi-paso) quedan fuera del alcance del botón por ahora, pero si no tienen botón deben seguir funcionando exactamente igual una vez construido el motor (no hay regresión).

**Botón: uno solo por respuesta**, con `label` (texto del botón) y `url` (enlace). No hay soporte para múltiples botones en esta iteración.

**Riesgo en WhatsApp:** decisión explícita del usuario de NO usar mensajes interactivos nativos de WhatsApp (`interactiveMessage`/botón nativo) porque es una función de Business API oficial que, usada desde un cliente no oficial (Baileys/QR), puede no renderizar correctamente en el destinatario o aumentar el riesgo de bloqueo del número. En WhatsApp el "botón" se resuelve como texto muy visual, no como componente interactivo real.

**Fuera de alcance:** `followupEnabled` (seguimiento 1h), botones en flujos multi-paso, múltiples botones por mensaje, botones en FAQs o en el mensaje de bienvenida (solo Activadores por ahora).

## Arquitectura

### 1. Motor de disparo (nuevo)

Nueva función en `routes/chat.js`, junto a `processMessage`:

```js
function matchKeywordTrigger(cfg, text) {
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
```

`processMessage({ companyId, message, conversationId, visitorId, channel, ... })` revisa esto **antes** de llamar a Claude:

1. Si la conversación tiene un flujo activo (namespace `keywordTrigger` en `flow_state`, con `triggerIndex` no nulo) → envía el siguiente paso (`cfg.keywordTriggers[triggerIndex].steps[step]`), avanza `step`, y si era el último paso limpia el namespace (vuelve a modo normal). No se re-evalúa contra activadores mientras un flujo está en curso. `triggerIndex` es la posición en el array `cfg.keywordTriggers` (mismo esquema de referencia que ya usa `admin.html` en todos sus `onclick` — por índice, no por id, porque los triggers no tienen id propio).
2. Si no hay flujo activo, evalúa `matchKeywordTrigger` (que retorna `{ trigger, index }` o `null`). Si matchea:
   - Tipo `response`: retorna `{ reply: trigger.response, button: trigger.button || null }` — nunca llama a Claude.
   - Tipo `flow`: guarda `keywordTrigger: { triggerIndex: index, step: 1 }` en `flow_state`, retorna `{ reply: trigger.steps[0].message, button: null }`.
3. Si no matchea nada → camino actual sin cambios (llamada a Claude, `button: null` siempre).

En ambos casos de match, el mensaje del asistente se guarda en `messages` igual que hoy (para que el dashboard/leads/historial no se rompan).

### 2. Estado de flujo en `conversations`

`conversations.flow_state` ya existe como columna JSON compartida y namespaced (la usan `services/lynkro-lead-state.js` bajo `leadQuali` y `services/medspa-state.js`, con tests que confirman que conviven sin chocar). Se reutiliza el mismo patrón en vez de agregar columnas nuevas: namespace `keywordTrigger` → `{ triggerId, step }`. Sin migración de esquema.

### 3. Modelo de datos del botón

En cada trigger de `cfg.keywordTriggers` (solo tipo `response`):

```js
{ ...trigger existente, button: { label: 'Ver más', url: 'https://...' } | null }
```

`processMessage` devuelve `{ conversationId, reply, button, messageId }` en vez de solo `{ conversationId, reply, messageId }` — `button` es `null` salvo cuando un activador con botón dispara.

### 4. Envío por canal

- **WhatsApp** (`sock.sendMessage` en el handler de `messages.upsert`): si `result.button`, concatenar antes de enviar:
  ```js
  const text = result.button
    ? `${result.reply}\n\n👉 *${result.button.label}*\n${result.button.url}`
    : result.reply
  ```
  Sin nuevo tipo de mensaje — sigue siendo `{ text }` plano. WhatsApp linkifica la URL automáticamente en el dispositivo del destinatario.

- **Widget web** (`/api/chat`): la respuesta JSON agrega el campo `button`. En `public/widget.js`, `addBubble` recibe `button` opcional y, si viene, agrega un elemento `<a class="ai-cta-btn">` debajo de la burbuja con el estilo del widget (usa `--ai-accent`, mismo patrón que el resto de `widget.js`).

- **Instagram**: nueva función `sendInstagramButton(accessToken, recipientId, text, button)` en `routes/chat.js`, junto a `sendInstagram`, usando el "button template" oficial de Meta:
  ```js
  body: JSON.stringify({
    recipient: { id: recipientId },
    message: { attachment: { type: 'template', payload: {
      template_type: 'button', text,
      buttons: [{ type: 'web_url', url: button.url, title: button.label }]
    }}}
  })
  ```
  Si la llamada falla (`d.error`), cae a `sendInstagram(accessToken, recipientId, `${text}\n\n${button.label}: ${button.url}`)` como fallback de texto plano — el cliente nunca se queda sin respuesta por un error de la API de botones.

## Admin UI (`public/admin.html`)

Bajo el textarea de "Respuesta automática" (`#tresponse_i`, solo visible cuando `type !== 'flow'`), agregar:

- Checkbox "Agregar botón con enlace" (`data-field="hasButton"`, no persiste directo — controla visibilidad de los 2 campos siguientes).
- Input "Texto del botón" (`t.button.label`), placeholder "Ver más".
- Input "Enlace" (`t.button.url`), placeholder "https://...". Validación simple en `saveTriggers()`/`save()`: si el checkbox está marcado y la URL no empieza con `http://` o `https://`, bloquear el guardado con un `toast()` de error existente.

Al desmarcar el checkbox, `t.button = null` (no se pierde el label/url si se vuelve a marcar en la misma sesión de edición — se puede mantener en un campo oculto, detalle menor de implementación).

## Manejo de errores

- URL sin `http(s)://` → bloqueado al guardar en el admin, no llega a producción.
- Falla el template de botón en Instagram → fallback automático a texto plano (ver arriba).
- Ningún activador matchea → comportamiento actual sin cambios, cero riesgo de regresión para el camino mayoritario (LLM).

## Verificación

- Activador con botón probado en los 3 canales, confirmando el formato de renderizado descrito arriba en cada uno.
- Activador de flujo (sin botón) probado end-to-end para confirmar que sigue funcionando como hoy tras construir el motor.
- Los 3 `matchType` (`contains`/`word`/`exact`) y `caseSensitive` probados con mensajes reales.
- Un mensaje que no coincide con ningún activador sigue yendo a la IA normalmente (sin regresión).
