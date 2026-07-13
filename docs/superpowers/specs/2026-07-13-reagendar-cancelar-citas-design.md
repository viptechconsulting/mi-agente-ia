# Reagendar y cancelar citas por chat — Diseño

## Contexto

El agente de WhatsApp/Instagram (Claude, tool-use en `routes/chat.js`) puede crear citas nuevas para empresas con Square conectado (`SQUARE_GET_SERVICES_TOOL` + `SQUARE_BOOK_APPOINTMENT_TOOL`), pero no puede reagendar ni cancelar ninguna cita existente para ningún proveedor. `services/square.js` y `services/ghl.js` solo tienen funciones de lectura/creación (`getBookings`, `createBooking`, `getAppointments`) — no hay `updateBooking`/`cancelBooking` ni equivalentes GHL. Google Calendar no tiene integración alguna todavía.

Motivo: una clienta potencial preguntó directamente por estas funciones (reagendar, cancelar, SMS) en una reunión de ventas; no existen hoy.

Investigación de viabilidad por proveedor (ver hallazgos completos en la conversación de diseño):
- **GHL** — API v2 confirma `PUT /calendars/events/appointments/:eventId` (reagendar vía `startTime`/`endTime`, cancelar vía `appointmentStatus: cancelled`) y delete de evento. Viable.
- **Square Bookings API** — `UpdateBooking` y `POST /v2/bookings/{id}/cancel` confirmados. Requiere plan pago Appointments Plus/Premium del vendedor. Viable.
- **Google Calendar API** — `events.patch`/`events.update` y `events.delete` estándar, sin restricciones especiales. Viable. Integración nueva desde cero (OAuth de conexión por empresa, calcado del flujo de Square en el admin).
- **Vagaro** — API pública existe pero no se confirmó soporte de escritura para reagendar/cancelar a nivel de endpoint; requiere aprobación manual (~5 días hábiles) + addon pago. No incluido en v1.
- **Booksy** — sin API pública de escritura conocida; solo viable con partnership formal directo con Booksy. No incluido en v1.

## Alcance v1

Reagendar y cancelar por chat para empresas con `calendarProvider` en `{'square', 'ghl', 'google'}`. Para empresas sin este campo (incluye Vagaro/Booksy y cualquier empresa sin proveedor conectado), sin cambios respecto a hoy: el bot no reagenda/cancela, escala a un humano — cubierto por la regla ya existente en `buildSystemPrompt` ("nunca prometas acciones que el sistema no ejecuta").

## Arquitectura

Nuevo campo de config: `cfg.calendarProvider: 'square' | 'ghl' | 'google' | null`, explícito por empresa (no inferido de qué credenciales existen).

4 tools nuevos de Claude en `routes/chat.js`, registrados solo si `cfg.calendarProvider` tiene un valor soportado:
- `find_my_appointments` — busca citas futuras por el teléfono de la conversación actual.
- `check_availability` — valida que un horario propuesto esté libre.
- `reschedule_appointment` — mueve una cita a un nuevo horario ya validado.
- `cancel_appointment` — cancela una cita.

Cada tool-handler hace `switch (cfg.calendarProvider)` y llama a la función correspondiente:
- `services/square.js` — nuevas: `updateBooking(accessToken, bookingId, { startAt, version })`, `cancelBooking(accessToken, bookingId, version)`.
- `services/ghl.js` — nuevas: `updateAppointment(apiKey, eventId, { startTime, endTime })`, `cancelAppointment(apiKey, eventId)`.
- `services/google-calendar.js` — **nuevo archivo**: OAuth connect (calcado del flujo de Square en `routes/admin.js`), `getEvents`, `updateEvent`, `deleteEvent`, `checkFreeBusy`.

Se elige este enfoque (tools genéricos + branching interno por proveedor) sobre un adaptador formal (más ceremonia de diseño para 3 proveedores y un solo consumidor) o sobre duplicar el patrón de Square por proveedor (6 tools, triplica mantenimiento). Buen balance entre rapidez y no repetir la misma conversación 3 veces.

## Flujo de conversación

**Reagendar:**
1. `find_my_appointments` (busca por teléfono del canal actual — WhatsApp/SMS).
2. Si hay 1 cita futura, la menciona. Si hay varias, pide cuál. Si no hay ninguna, lo dice — no inventa.
3. Valida la ventana mínima configurable (ej. "no se puede reagendar con menos de N horas de anticipación") antes de continuar.
4. Cliente da nueva fecha/hora preferida → `check_availability`. Si no está libre, ofrece la alternativa más cercana (mismo patrón que el booking de Square hoy).
5. Cliente confirma el horario exacto → `reschedule_appointment`. Solo confirma al cliente después de que la llamada responde éxito.
6. Notifica al negocio (nuevo toggle `notifyOnReschedule`/`notifyOnCancel`, mismo mecanismo que `notifyOnLead`/`notifyOnEscalation`).

**Cancelar:** mismos pasos 1-3 (encontrar, confirmar cuál, validar ventana mínima), luego confirmación explícita del cliente antes de llamar `cancel_appointment` — nunca cancela con un mensaje ambiguo. Notifica al negocio igual.

## Manejo de errores

- **Falla la API del proveedor:** el bot no confirma como si hubiera funcionado — le dice al cliente que hubo un problema técnico y que el equipo lo confirma manualmente; se dispara la notificación al negocio marcada "requiere atención manual" para no perder el pedido.
- **Condición de carrera** (el horario deja de estar libre entre `check_availability` y la confirmación): el bot avisa y pide otra hora, no reintenta silenciosamente.
- **Cita no encontrada / ambigüedad no resuelta** tras una pregunta de aclaración: escala a humano en vez de insistir en bucle.
- **Sin `calendarProvider` soportado:** comportamiento actual sin cambios.

## Testing

Nuevo `tests/appointments.test.js` (patrón `node:test` + `node:assert/strict`, como `tests/billing.test.js`):
- Funciones de servicio nuevas (`updateBooking`/`cancelBooking`, `updateAppointment`/`cancelAppointment`, equivalentes Google) con mocks HTTP, sin llamar APIs reales.
- Política de ventana mínima como función pura (hora de la cita, hora actual, mínimo configurado → permite o no) — testeable aislada.
- Branching por `cfg.calendarProvider` en los 4 tool-handlers (mocks/spies, no HTTP real).

Sin pruebas end-to-end contra APIs reales en este spec — se verifica manualmente contra cuentas sandbox/test antes de lanzar a producción, siguiendo la práctica de verificar con datos reales antes de desplegar (ver memoria `deploy-mi-agente-ia`).
