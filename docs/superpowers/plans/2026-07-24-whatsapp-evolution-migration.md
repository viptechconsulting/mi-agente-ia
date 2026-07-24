# WhatsApp builtin→Evolution API — Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. This plan mixes one code change (Task 1) with live VPS ops + user-in-the-loop QR scans (Tasks 2-5); execute inline with the operator.

**Goal:** Mover el transporte de WhatsApp de Lynkro y Vip Tech de builtin Baileys a Evolution API, sin respuestas dobles ni pérdida de datos.

**Architecture:** El código ya tiene salida (`sendWhatsApp` → Evolution `/message/sendText`) y entrada (`POST /api/whatsapp/webhook`). Se agrega un interruptor por empresa (`usesEvolution(cfg)`) que impide arrancar el builtin cuando la empresa tiene Evolution configurado. Luego se crea/linkea una instancia Evolution por número y se apaga el builtin de esa empresa.

**Tech Stack:** Node/Express, better-sqlite3, Baileys (builtin, a retirar), Evolution API v2.3.7 (Postgres+Redis), Docker Swarm en VPS, Easypanel.

## Global Constraints

- Deploy de código que Node carga en memoria: `docker cp` al contenedor activo → `docker commit lynkro-agente:<tag>` → `docker service update --image` → `docker stop` del viejo. NUNCA `docker restart`.
- Datos reales en bind-mount Easypanel: `/etc/easypanel/projects/mi-agente-ai/mi-agente-ai/volumes/data` (NO el named volume, vacío).
- Contenedor activo: `docker ps --format '{{.Names}}' | grep agente | head -1`.
- Evolution API interno: `http://n8n-projects_evolution-api:8080` (misma red docker) o público `https://n8n-projects-evolution-api.nlc4eh.easypanel.host`. Webhook debe apuntar a `https://chat.lynkro.io/api/whatsapp/webhook`.
- Un número linkeado a builtin Y Evolution a la vez = respuesta doble → apagar builtin ANTES de linkear Evolution.
- Validar Lynkro end-to-end ANTES de tocar Vip Tech.
- IDs: Lynkro `4a945bfd-5090-472e-a3e4-a137c1da56c9` (17866696831), Vip Tech `a858eb9c-efd5-4274-b183-4072e8ab3fcd` (17863830513).

---

### Task 0: Prerrequisitos — credenciales y alcanzabilidad

**Files:** ninguno (recolección).

- [ ] **Step 1: Obtener la API key global de Evolution**
Run: `docker exec n8n-projects_evolution-api.1.<id> printenv | grep AUTHENTICATION_API_KEY`
Guardar el valor (se usa como header `apikey` para crear instancias).

- [ ] **Step 2: Confirmar red compartida entre app y Evolution**
Run: `docker exec <app-container> sh -c 'wget -qO- http://n8n-projects_evolution-api:8080/ 2>&1 | head -c 200'`
Si no resuelve por nombre de servicio, usar la URL pública en `waBaseUrl`.

- [ ] **Step 3: Confirmar que el webhook público es alcanzable**
Run: `curl -s -o /dev/null -w '%{http_code}' -X POST https://chat.lynkro.io/api/whatsapp/webhook -H 'content-type: application/json' -d '{}'`
Expected: `200` (el handler responde 200 y descarta payloads sin evento válido).

---

### Task 1: Interruptor `usesEvolution` — no arrancar builtin si hay Evolution configurado

**Files:**
- Modify: `routes/chat.js` (helper nuevo + guards en boot-loop ~1490, retry-loop ~1481, y opcional followup ~1607)
- Test: `/tmp/test_usesEvolution.mjs` (aislado)

**Interfaces:**
- Produces: `usesEvolution(cfg)` → boolean, `true` sii `cfg.waBaseUrl && cfg.waInstance && cfg.waApiKey`.

- [ ] **Step 1: Test aislado del helper y del gate del boot-loop**
```js
import assert from 'node:assert'
const usesEvolution = (cfg) => !!(cfg?.waBaseUrl && cfg?.waInstance && cfg?.waApiKey)
assert.strictEqual(usesEvolution({}), false)
assert.strictEqual(usesEvolution({ waBaseUrl:'x', waInstance:'i' }), false) // falta key
assert.strictEqual(usesEvolution({ waBaseUrl:'x', waInstance:'i', waApiKey:'k' }), true)
// simulación del boot-loop: solo arranca builtin las que NO usan evolution
const companies = { A:{}, B:{waBaseUrl:'x',waInstance:'i',waApiKey:'k'} }
const started = []
for (const [id,cfg] of Object.entries(companies)) if (!usesEvolution(cfg)) started.push(id)
assert.deepStrictEqual(started, ['A'])
console.log('usesEvolution OK')
```
- [ ] **Step 2: Correr el test** — `node /tmp/test_usesEvolution.mjs` → `usesEvolution OK`
- [ ] **Step 3: Agregar `usesEvolution` cerca de `sendWhatsApp` en `routes/chat.js`** (export para reuso).
- [ ] **Step 4: Guardar el boot-loop (`~1490`) y el retry-loop (`~1481`)**: antes de `startBuiltinWhatsApp(cid)`, cargar `loadConfig(cid)` y `if (usesEvolution(cfg)) continue`.
- [ ] **Step 5: (defensa) followup `~1607`**: `if (usesEvolution(cfg)) { await sendWhatsApp(cfg, jid, fuText) }` explícito antes de la rama del socket builtin.
- [ ] **Step 6: `node --check routes/chat.js`** → SYNTAX OK
- [ ] **Step 7: Deploy** (método de Global Constraints) + verificar en logs que Lynkro/Vip Tech NO arrancan builtin una vez que tengan Evolution config (todavía no la tienen → en este punto siguen en builtin; el gate recién actúa tras Task 3/4). Confirmar que las demás empresas builtin siguen igual y 0×440.
- [ ] **Step 8: Commit** `git add routes/chat.js && git commit -m "feat(wa): skip builtin Baileys for companies configured on Evolution API"`

---

### Task 2: Crear la instancia Evolution de Lynkro (SIN linkear todavía)

**Files:** ninguno (ops sobre Evolution).

> Orden anti-doble-respuesta: la instancia recién entrega mensajes al webhook DESPUÉS de escanear el QR. Por eso creamos la instancia y apagamos el builtin ANTES de escanear (QR queda para Task 3 Step 3).

- [ ] **Step 1: Crear instancia `lynkro` en Evolution**
```bash
curl -s -X POST "$EVO/instance/create" -H "apikey: $EVOKEY" -H 'content-type: application/json' -d '{
  "instanceName":"lynkro","integration":"WHATSAPP-BAILEYS","qrcode":true,
  "webhook":{"url":"https://chat.lynkro.io/api/whatsapp/webhook","byEvents":false,"events":["MESSAGES_UPSERT"]}
}'
```
Guardar el `hash`/`apikey` devuelto (es el `waApiKey` de la instancia). NO escanear el QR todavía.
- [ ] **Step 2: Confirmar instancia creada y en estado `connecting`/`close`** (aún no `open`): `GET /instance/connectionState/lynkro`.

---

### Task 3: Config Lynkro + apagar builtin + linkear + verificar E2E

**Files:** DB `companies.config` de Lynkro; bind-mount `wa-auth/4a945bfd...`.

- [ ] **Step 1: Setear config Evolution en Lynkro** (`waBaseUrl`=EVO, `waInstance`=`lynkro`, `waApiKey`=hash de Task 2). Esto activa el gate `usesEvolution` → el builtin ya no arrancará para Lynkro.
- [ ] **Step 2: Reiniciar + apagar builtin** — renombrar creds builtin (`mv wa-auth/4a945bfd.../ wa-auth/4a945bfd....disabled-2026-07-24/`) y scale 0→1. Confirmar en logs: NO aparece `[WA:4a945bfd] Conectado` (builtin OFF para Lynkro). En este punto el número de Lynkro NO tiene bot (ventana breve, esperada).
- [ ] **Step 3: Linkear Evolution** — `GET /instance/connect/lynkro` → mostrar QR al usuario → usuario escanea en el teléfono de Lynkro (17866696831) → `connectionState = open`. Ahora Evolution recibe y el builtin está apagado → sin doble respuesta.
- [ ] **Step 4: Prueba E2E** — usuario escribe desde un número nuevo → verificar en DB fila `user` nueva (entró por webhook) + el bot responde (fila `assistant` + mensaje recibido en WhatsApp). Confirmar en logs `[WA webhook]` / `processMessage` sin error.
- [ ] **Step 5: Verificar followup** — `POST /api/jobs/lynkro-followup` (admin) o esperar el interval; confirmar salida por Evolution (`sendWhatsApp`) sin error.

---

### Task 4: Vip Tech Consulting (solo tras validar Lynkro)

**Files:** igual que Tasks 2-3 para `a858eb9c` / instancia `viptech`.

- [ ] **Step 1: Crear/rehusar instancia `viptech`** en Evolution (mismo `create` con webhook). Guardar apikey. NO escanear QR aún.
- [ ] **Step 2: Config Evolution en Vip Tech** (`waBaseUrl`=EVO, `waInstance=viptech`, apikey de la instancia) → activa el gate.
- [ ] **Step 3: Apagar builtin + reiniciar** — renombrar creds builtin de Vip Tech, scale 0→1, confirmar builtin OFF para `a858eb9c` en logs.
- [ ] **Step 4: Linkear** — `GET /instance/connect/viptech` → QR → usuario escanea en 17863830513 → `connectionState open`.
- [ ] **Step 5: Prueba E2E** desde número nuevo.

---

### Task 5: Cleanup + memoria

- [ ] **Step 1: Limpiar config `viptech` sobrante de Lynkro.io** (`e26e29d3`) si quedó apuntando a la instancia equivocada.
- [ ] **Step 2: Confirmar watchers** (`wa-alert-watcher`, `wa-gap-monitor`) siguen activos y reenganchados al contenedor nuevo.
- [ ] **Step 3: Actualizar memoria** (`project_whatsapp_decrypt_alert.md` / nuevo memo de migración) con estado final: qué números en Evolution, qué instancias, builtin inerte.
- [ ] **Step 4: Nota** — borrado del código builtin queda fuera de alcance (hacer después de días de estabilidad).
