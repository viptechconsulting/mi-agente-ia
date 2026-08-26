# Web chat: intervención humana, retraso humano y export de teléfonos

Fecha: 2026-08-26
Repo: `/root/mi-agente-ia` (chat.lynkro.io)

## Problema

Tres quejas sobre el chat web:

1. Cuando una persona quiere atender manualmente, el agente vuelve a meterse solo.
2. El agente responde instantáneo y se nota que es una IA.
3. Los teléfonos que la gente escribe en el chat no se pueden exportar.

## 1. Intervención humana

### Lo que ya existe (no se reconstruye)

- Columna `conversations.human_mode`. Con `human_mode = 1`, `processMessage` devuelve `reply: null` sin llamar al LLM (`routes/chat.js:557`).
- Toggle "▶ IA activa / ⏸ Tú atiendes" en `public/inbox.html` y en el tab Conversaciones de `public/admin.html`, ambos contra `POST /api/conversations/:id/human-mode`.
- Comandos desde el WhatsApp del dueño: `*` pausa, `**` reactiva. Responder a la alerta de web chat también pausa (`routes/chat.js:~1420-1460`).
- El widget hace polling de mensajes nuevos vía `GET /api/chat/poll`.

### Cambios

**C1 — La pausa dura hasta que se quite a mano.** Eliminar las dos auto-reactivaciones:
- `routes/chat.js:519-523` — reset de `human_mode` cuando la conversación web lleva >30 min quieta.
- `routes/chat.js:547-554` — expiración de `human_mode` si el humano no respondió en 10 min.

`isReactivation` se conserva (marca la vuelta del visitante tras 30 min) pero deja de tocar `human_mode`. La única forma de reactivar la IA pasa a ser explícita: toggle del panel, `**` en WhatsApp, o `POST /human-mode {mode:0}`.

**C2 — El visitante ve al humano sin tener que escribir.** Hoy `startPolling()` solo se dispara después de que el visitante manda un mensaje (`public/widget.js:390`), y `stopPolling()` corta en cuanto `human_mode` es 0. Cambio: mientras el panel esté abierto, el widget consulta cada 5s; al cerrarlo, para. El corte por `human_mode = 0` solo aplica con el panel cerrado.

Fuera de alcance: `public/demo.html` (páginas de demo para prospectos) no recibe takeover — no hay a quién avisar en una demo.

## 2. Retraso humano al responder

Helper único en `routes/chat.js`, aplicado dentro de `processMessage` justo antes de devolver la respuesta del agente. Al ser un solo punto, cubre los 5 call sites (web, WhatsApp x2, Instagram DM y comentario) sin tocarlos.

```
delay = clamp(base + porCaracter * largo, min, max) * jitter
base = 1200 ms   porCaracter = 28 ms   min = 800 ms   max = 7000 ms   jitter = 0.8–1.2
```

- No aplica a respuestas de activadores canned ni a `reply: null` (takeover).
- Configurable por empresa en Personalidad: `humanDelay` (on/off, default on) y `humanDelayMax` (ms, default 7000).
- Web: el widget ya muestra "escribiendo…" mientras espera la respuesta HTTP, así que el efecto sale gratis.
- WhatsApp/IG: silencio y luego el mensaje. El indicador nativo de "escribiendo" de Evolution (`delay` + `presence` en el payload de `sendText`) queda como mejora posterior opcional.

Riesgo controlado: la petición HTTP del chat web queda abierta hasta 7s. Es `await` no bloqueante; no afecta a otras peticiones.

## 3. Export CSV de teléfonos

**Sin tabla nueva.** Endpoint `GET /api/leads/phones.csv` (requireAdmin + withCompany), que arma la lista al vuelo:

- Barre `messages` con `role='user'` de las conversaciones de la empresa y extrae teléfonos con la misma regex de `extractContacts` (`routes/chat.js:246`).
- Suma el número de las conversaciones de canal `whatsapp` (el `visitor_id` `wa:<número>`).
- Normaliza a solo dígitos, descarta <8 dígitos, deduplica por número.
- Columnas: `telefono, nombre, canal, primera_vez, ultima_vez`. Nombre = `lead_name` de la conversación si existe.
- BOM UTF-8 al inicio, igual que `dashboard/lynkro-funnel.csv` (`routes/admin.js:807`), para que Excel respete los acentos.

Botón "⬇ Descargar CSV" en el tab Leads de `public/admin.html`, con el mismo patrón de descarga que `downloadLkCsv()`.

El histórico entra solo: al derivarse de los mensajes ya guardados, no hace falta migración ni script de rescate. A cambio, los teléfonos no se listan en una pantalla del panel — decisión explícita del usuario ("solo descarga").

## Verificación

- C1: pausar una conversación web, esperar el umbral viejo (>10 min sin respuesta del humano), mandar un mensaje como visitante y confirmar que el agente NO responde.
- C2: con el chat abierto y quieto, responder desde el Inbox y ver el mensaje aparecer sin escribir nada.
- Retraso: test unitario del cálculo (texto corto vs largo vs tope) y una conversación real cronometrada.
- CSV: descargar y comparar contra un conteo directo en SQL de teléfonos distintos.

## Deploy

Backend (`routes/chat.js`) → `docker cp` + `docker commit` + `docker service update --image`, y parar el contenedor viejo. Nunca `docker restart`. Estáticos (`widget.js`, `admin.html`) → `docker cp` basta.
