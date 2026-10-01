# Lynkro — Agente de IA (chat.lynkro.io)

Plataforma multi-empresa: agente de IA que atiende por WhatsApp, chat web (widget),
Instagram y SMS; califica leads, agenda citas y hace follow-up. Panel de admin propio.

## ⚠️ Directorio correcto

**El código vive en `/root/mi-agente-ia`.** Es el repo git y la fuente de la imagen Docker.

`/etc/easypanel/projects/mi-agente-ai/mi-agente-ai/code` es una **copia vieja** (congelada
el 27-ago-2026). Editar ahí no despliega nada. Si una sesión arranca en esa ruta, `cd` a
`/root/mi-agente-ia` antes de tocar nada.

## Stack

Node 22 ESM · Express 4 · SQLite (`better-sqlite3`, `data/agent.db`) · Anthropic SDK ·
Baileys (WhatsApp) · Stripe · Twilio (SMS) · PDFKit · nodemailer. Puerto 3100.

## Estructura

```
server.js              arranque + buena parte del core (~48 KB)
db.js                  esquema y acceso a SQLite (+ db-commerce.js, db-prospecting.js)
routes/                chat.js (el grande: agente, tools, prompts) · admin · billing
                       commerce · prospecting
services/              integraciones: square · shopify · woocommerce · qbo · stripe
                       twilio · ghl + ghl-calendar · google-calendar · apify · transcribe
                       wa-media · recovery · appointments · appointment-confirm
                       verticales: lynkro-lead-* · medspa-* · followup-prompt
                       prospecting-*: scraper · audit · score · outreach · send
jobs/                  campaign-scheduler · prospecting-followups · sync-scheduler
public/                admin.html · inbox.html · widget.js + landings por vertical
                       (dentistas, plumbing, medspa, promo, video, demo)
tests/                 node:test — `npm test`
data/                  agent.db + config.json (NO versionar, NO borrar)
```

## Despliegue

Docker Swarm vía EasyPanel. No hay CI: se construye y se actualiza el servicio a mano.

```bash
cd /root/mi-agente-ia
docker build -t lynkro-agente:<feature>-<YYYYMMDD> .
docker service update --image lynkro-agente:<feature>-<YYYYMMDD> \
  --update-failure-action rollback mi-agente-ai_mi-agente-ai
```

Convención del tag: `<feature>-<fecha>` (ej. `booking-link-20260904`). Después de
desplegar, verificar que quede **un solo contenedor** arriba — dos compiten por la
sesión de WhatsApp y la corrompen.

Servicio: `mi-agente-ai_mi-agente-ai`. Imagen en producción al 4-sep-2026:
`lynkro-agente:booking-link-20260904`.

## Reglas del agente (ganadas a golpes, no cambiar sin pedir)

- **Agendar = mandar el link del calendario.** Si la empresa tiene `bookingUrl` en su
  config, el agente manda ese link y las herramientas de Square ni se activan. Nunca
  pregunta "¿qué día te queda mejor?", nunca propone horarios él, nunca dice que ya
  agendó algo: quien reserva es la persona, en el link.
- El link va entero y en su propia línea (`tests/booking-link.test.js` lo protege).
- Las zonas horarias van por nombre (`America/New_York`), nunca por offset fijo — un
  offset hardcodeado miente medio año.
- El texto del flujo de reserva está unificado en una constante compartida entre el chat
  real y el demo. No duplicarlo otra vez.

## Estado pendiente (al 1-oct-2026)

- **`GROQ_API_KEY` inválida (401)** → no se transcribe ningún audio de WhatsApp, en
  ninguna empresa. Necesita una key nueva en el env del servicio; el código está bien.
  Desde `3b1ea75` eso dispara alerta en vez de morir en los logs.
- **BeGlam Studio y Glow MedSpa tienen que reconectar Square desde el admin.** Sus
  conexiones son del 8-jul-2026, de antes de que se guardara el `refresh_token`, así que
  no se pueden renovar solas. Una vez reconectadas ya no vuelven a caducar.
  `/api/admin/square/status` expone `can_refresh` para ver quién está así.
- `square_get_slots` quedó inerte: con `bookingUrl` cargado en las 10 empresas no se
  activa nunca. Está probada y no estorba; decidir si se borra (preguntar antes).
- `recovery.test.js` falla desde antes; el resto pasa (186/187).
- **`origin` tiene un token de GitHub incrustado en la URL** (`.git/config`, en texto
  plano). Conviene revocarlo y pasar a SSH o a un credential helper.

## Convenciones

- Español en commits, en el producto y en la conversación con el usuario.
- Tests con `node:test`, sin frameworks. `npm test`.
- Nunca borrar datos sin preguntar — el usuario lo ha pedido explícitamente más de una vez.
- Empresa de referencia para pruebas: BeGlam Studio, `1361ee88-9b4f-4e25-915f-417be46aec59`.
