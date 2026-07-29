# Lynkro — Funnel del agente + Dashboard (diseño)

Fecha: 2026-07-29
Alcance: empresa **Lynkro** (`LYNKRO_COMPANY_ID = 4a945bfd-5090-472e-a3e4-a137c1da56c9`) en chat.lynkro.io.
Objetivo: llevar el manual operativo de ventas por WhatsApp al comportamiento del agente inbound + visualizar el funnel en el admin.

Todos los cambios son **aditivos** sobre el subsistema ya existente (`services/lynkro-lead-*.js`, `routes/chat.js`, `routes/admin.js`, `public/admin.html`). No se rehace la máquina de estados.

## Decisiones tomadas (locked)

- **Precio/trial:** el agente **SÍ** puede mencionar precio ($147/mes) y trial de 14 días. Revierte la regla dura previa de "nunca precio antes del Discovery".
- **Inbound-only:** NO se hace outbound en frío (riesgo de ban del número Baileys compartido con el inbound de ads). Las plantillas de Etapa 1 en frío quedan como atajo manual del humano.
- **Cifras por rubro:** siempre como **estimado suave** ("la mayoría…", "suele ser…"), nunca dato duro. El número de pérdida final se calcula con datos reales del lead.
- **Sin promesas que el sistema no cumple:** el agente no ofrece enviar documentos/links que no existen (evita el bug histórico tipo "link de Zoom").

## Mejora 1 — Hooks numéricos por rubro

- Nuevo campo interno `vertical` (como `volume_level`/`temperature`): `clinica_estetica | salon_belleza | ecommerce | otro`.
- El modelo lo infiere del tipo de negocio en los primeros mensajes.
- Banco de hooks por vertical en el prompt (estimado suave):
  - `clinica_estetica`: "clínicas como la tuya suelen perder 5–8 prospectos/semana por no responder a tiempo"
  - `salon_belleza`: "salones así suelen perder 3–4 clientas/semana solo por contestar tarde"
  - `ecommerce`: "de cada 10 que preguntan por un producto, ¿cuántas te compran? si no es 7+, se te van ventas todos los días"
  - `otro`: comportamiento actual (número de impacto calculado con datos del lead)
- Archivos: `lynkro-lead-prompt.js`, `lynkro-lead-schema.js`, `lynkro-lead-state.js`.

## Mejora 2 — Playbook de objeciones (Etapa 5)

Sección nueva en el prompt, activa cuando el lead objeta. Captura campo interno `objection_type` (para el dashboard).

- **"Es caro"** → reencuadre a pérdida ($X/semana → $Y/mes) + ofrecer **trial 14 días**.
- **"No es el momento"** → preguntar qué lo haría reaccionar (presupuesto/temporada) y enlazar con la reactivación de Etapa 6.
- **"Necesito pensarlo"** → exponer la duda específica ("¿qué info te faltó del demo?").
- **"Tengo que consultarlo"** → dar los números clave **en el chat** (NO promete enviar un documento).
- **"Ya probé eso / desconfianza"** (5ª, no está en el manual) → contar como historia el testimonio real de la clienta escéptica ("había probado bots que respondían tonterías… la diferencia fue cielo y tierra"). Sin prometer nada.
- **Cierre digno** cuando ya no hay espacio (puerta abierta, sin sonar a derrota).

## Mejora 3 — Retomar 30/60/90 días (Etapa 6)

Hoy `runLynkroFollowUp` pone banderas `reactivacion` (7-30d) y `nurture` (30d+) y **no manda nada**. Se reemplaza esa cola por 3 envíos reales, respetando `do_not_contact` y sin insistir a quien pidió parar:

| Día | Ángulo | Link |
|---|---|---|
| 30 | Cambio de situación (referencia la charla previa) | solo texto |
| 60 | Guía gratuita de 7 puntos | **campo admin configurable**; vacío ⇒ solo texto |
| 90 | Caso de éxito del rubro (usa `vertical`) | **campo admin configurable** (link testimonio de la web) |

Campos de link: en la sección **Follow-up** del admin, guardados en la config de la empresa (patrón de `bookingUrl`). Nombres tentativos: `reengageGuideUrl`, `reengageCaseUrl`.

## Mejora 4 — Follow-up post-demo (Etapa 4C)

El sistema **no sabe solo** cuándo ocurrió el demo/llamada (el demo es un link `/demo/:token` de una empresa-demo aparte, no ligada a la conversación). El manual marca la Etapa 4 como "manual siempre".

- Disparador **manual**: botón **"Demo hecho"** en la ficha del lead (dashboard) → setea flag + timestamp.
- El job de follow-up envía el mensaje post-demo ("¿qué te quedó dando vueltas después del demo?") **24h después** de esa marca.

## Mejora 5 — Dashboard del funnel Lynkro

Panel nuevo que aparece **solo cuando la empresa activa es Lynkro**. Backend nuevo `GET /dashboard/lynkro-funnel` que lee `flow_state.leadQuali`.

**A) Métricas (tiles):** Conversaciones → Respondieron → Calificados (vol. medio/alto + web+IG) → Demo hecho → No contactar.
Desgloses en chips: por **vertical** y por **temperatura** (🔥/🟡/🧊). Objeciones más frecuentes. Follow-ups en vuelo (fu1/fu2/fu3 + reactivación 30/60/90).

**B) Lista de leads (una fila c/u):** nombre/teléfono · **etapa** (badge) · vertical · temperatura · última actividad · botones **[Demo hecho]** y **[No contactar]**.

Mapeo etapa (badge) desde `leadQuali.current_state` + flags:
Primer contacto (OPENING/BUSINESS_TYPE) → Calificando (VOLUME/TICKET) → Demo ofrecido (DEMO_OFFERED) → **Demo hecho** (flag nuevo) → Objeción (QUESTION_HANDLING) → No califica (LOW_VOLUME_CLOSE) → Cerrada (CONVERSATION_COMPLETE) / No contactar (DO_NOT_CONTACT).

## Deploy

Método seguro (ver memoria deploy-mi-agente-ia):
- `admin.html` (estático): `docker cp` al container activo, sin restart.
- Backend (routes/services/db): `docker commit` + `docker service update --image` + **parar el container viejo** (evita doble sesión WhatsApp / loop 440). Nunca `docker restart`.

Verificación con datos reales antes de pedir prueba al usuario (no prueba y error).
