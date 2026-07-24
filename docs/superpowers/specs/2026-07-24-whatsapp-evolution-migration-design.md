# WhatsApp: migración builtin Baileys → Evolution API

**Fecha:** 2026-07-24
**Estado:** diseño aprobado (verbal), pendiente review escrito

## Problema

El manejador de WhatsApp hecho a mano dentro del proceso Node (`startBuiltinWhatsApp` en `routes/chat.js`) es la causa de todos los incidentes recientes: socket doble en cada deploy (loop 440), corrupción de sesiones Signal, carreras del watchdog. Guarda las conexiones y sesiones en memoria del proceso + archivos en disco, sin coordinación robusta. Cada incidente = leads sin respuesta.

Evolution API (Baileys empaquetado como servicio dedicado, con Postgres+Redis para sesiones) ya corre sano en el mismo VPS (`n8n-projects_evolution-api`, 13+ días uptime). Era lo que usaba el proyecto antes del 2026-06-12, cuando se cambió al manejador in-process y empezaron los problemas.

## Objetivo

Mover la capa de transporte de WhatsApp de builtin Baileys a Evolution API, por empresa, sin migrar a la API oficial de Meta (Evolution sigue siendo no-oficial/QR, vendible como producto).

## Alcance

Migrar **todos** los números actualmente en builtin. Estado real: solo 4 empresas tienen credenciales builtin, y las 2 activas son propias del usuario:
- `4a945bfd` **Lynkro** — 17866696831 (activo, número principal de leads)
- `a858eb9c` **Vip Tech Consulting** — 17863830513 (activo)
- `default` Glow MedSpa — deslogueado (re-linkear solo si se sigue usando)
- `e26e29d3` Lynkro.io — deslogueado (idem)

Ningún cliente (BeGlam, Andy Hair, Mimlot, etc.) usa el WhatsApp builtin → no hay que tocar teléfonos ajenos. El usuario tiene acceso a los 2 números activos.

Config vieja de Evolution a limpiar: Lynkro.io y Vip Tech ambas apuntan a una instancia `viptech` (sobrante). Cada número debe tener su propia instancia.

**Fuera de alcance:** eliminar el código builtin por completo (queda inerte tras migrar, se borra después de confirmar estabilidad). Re-linkeo de los 2 números deslogueados salvo que se sigan usando.

## Arquitectura objetivo

Ya existe la plomería completa de Evolution en el código:
- **Salida:** `sendWhatsApp(cfg, phone, text)` (`routes/chat.js:335`) → `POST {waBaseUrl}/message/sendText/{waInstance}` con header `apikey: waApiKey`.
- **Entrada:** `POST /api/whatsapp/webhook` (`routes/chat.js:1897`, montado en `/api`, público sin auth) → parsea evento `messages.upsert` de Evolution → `findCompanyByWaInstance(instance)` → `processMessage` → `sendWhatsApp`.
- **Config por empresa:** campos `waBaseUrl`, `waInstance`, `waApiKey` (`db.js:138`). Endpoints admin de connect/estado/QR ya existen (`/instance/connect/{inst}`, `/instance/connectionState/{inst}`).

Una **instancia Evolution por número**: p.ej. `lynkro` (17866696831), `viptech` (17863830513).

## Cambio de código (mínimo)

Hoy el builtin arranca incondicionalmente para toda empresa con creds en `wa-auth/` (boot-loop `routes/chat.js:~1490`, retry-loop `~1481`, health-check interval `~1450`). No hay interruptor por empresa.

**Cambio:** helper `usesEvolution(cfg)` = `!!(cfg.waBaseUrl && cfg.waInstance && cfg.waApiKey)`. Guardar con él:
1. El boot-loop de auto-arranque → saltear empresas con Evolution configurado.
2. El retry-loop del interval de 30s → idem.
3. (Opcional, defensa) el followup: preferir `sendWhatsApp` explícitamente cuando `usesEvolution(cfg)`, en vez de depender de que no haya socket abierto.

Sin campo nuevo en el schema: la presencia de config Evolution ES el interruptor. Diff chico, testeable en aislamiento.

## Secuencia de ejecución (por número, Lynkro primero y validado antes de Vip Tech)

1. Crear instancia en Evolution (`POST /instance/create`, integración WHATSAPP-BAILEYS, webhook por instancia → evento `messages.upsert` → `https://chat.lynkro.io/api/whatsapp/webhook`).
2. **Apagar builtin para esa empresa** (parar socket + renombrar sus `creds.json`/dir en `wa-auth` para que no re-arranque) — ANTES de linkear Evolution.
3. Usuario escanea el QR en el teléfono de ese número → instancia queda `open`.
4. Setear config de la empresa (`waBaseUrl`, `waInstance`, `waApiKey`) y limpiar el `viptech` duplicado donde corresponda.
5. Verificar `connectionState = open` + prueba end-to-end: mensaje entrante real → descifra → `processMessage` → responde.

## Riesgos

- **Respuesta doble:** un número linkeado a builtin Y Evolution simultáneamente → ambos reciben y responden. Mitigación: apagar builtin ANTES de linkear Evolution (breve ventana sin bot en ese número; los números son del usuario).
- **Alcance del cambio de código:** el guard `usesEvolution` afecta el arranque de WhatsApp de TODAS las empresas. Verificar que las que quedan en builtin (ninguna activa relevante salvo las que migramos) sigan igual.
- **Persistencia:** los datos viven en el bind-mount de Easypanel (`/etc/easypanel/projects/mi-agente-ai/mi-agente-ai/volumes/data`), NO en el named volume del spec (que está vacío). Cualquier operación de datos usa esa ruta real.
- **Deploy:** código que Node carga en memoria → `docker commit` + `docker service update --image` + parar el viejo. Nunca `docker restart`.
- **Residual:** Evolution reduce fuerte esta clase de incidentes pero sigue siendo WhatsApp no-oficial; no es cero absoluto.

## Verificación de éxito

- Lynkro: un lead real (o número de prueba nuevo) escribe → recibe respuesta del bot; followup agenda y dispara.
- Sin loop 440 ni Bad MAC en logs del contenedor.
- Vip Tech: idem, tras validar Lynkro.
