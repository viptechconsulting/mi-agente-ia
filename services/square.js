import { getServerSetting } from '../db.js'

const BASE_URL = process.env.SQUARE_SANDBOX
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com';

const SQUARE_VERSION = '2024-01-17';
const REDIRECT_URI = process.env.SQUARE_CALLBACK_URL || 'https://chat.lynkro.io/api/square/callback';
const SCOPES = 'MERCHANT_PROFILE_READ CUSTOMERS_READ CUSTOMERS_WRITE APPOINTMENTS_READ APPOINTMENTS_WRITE ITEMS_READ';

function appId()     { return process.env.SQUARE_APP_ID     || getServerSetting('square_app_id')     || '' }
function appSecret() { return process.env.SQUARE_APP_SECRET || getServerSetting('square_app_secret') || '' }

export function hasCredentials() {
  return !!(appId() && appSecret())
}

export function getOAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: appId(),
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    ...(state != null && { state: String(state) }),
  });
  return `${BASE_URL}/oauth2/authorize?${params}`;
}

export async function exchangeCode(code) {
  const res = await fetch(`${BASE_URL}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Square-Version': SQUARE_VERSION,
    },
    body: JSON.stringify({
      client_id: appId(),
      client_secret: appSecret(),
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Square exchangeCode failed ${res.status}: ${err.message || JSON.stringify(err)}`);
  }

  const data = await res.json();
  return {
    access_token: data.access_token,
    merchant_id: data.merchant_id,
    expires_at: data.expires_at,
  };
}

export async function revokeToken(accessToken) {
  const res = await fetch(`${BASE_URL}/oauth2/revoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Square-Version': SQUARE_VERSION,
      Authorization: `Client ${appSecret()}`,
    },
    body: JSON.stringify({
      client_id: appId(),
      access_token: accessToken,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Square revokeToken failed ${res.status}: ${err.message || JSON.stringify(err)}`);
  }

  return res.json();
}

export async function findOrCreateCustomer(accessToken, { name, phone, email }) {
  const nameParts = (name || '').trim().split(/\s+/);
  const givenName = nameParts[0] || '';
  const familyName = nameParts.slice(1).join(' ') || '';

  // Search by phone first, then email
  const searchFilter = phone
    ? { phone_number: { exact: phone } }
    : email
    ? { email_address: { exact: email } }
    : null;

  if (searchFilter) {
    const searchRes = await fetch(`${BASE_URL}/v2/customers/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': SQUARE_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { filter: searchFilter } })
    });
    const searchData = await searchRes.json();
    if (searchData.customers?.length > 0) return searchData.customers[0].id;
  }

  // Create new customer
  const body = { given_name: givenName, family_name: familyName };
  if (phone) body.phone_number = phone;
  if (email) body.email_address = email;

  const res = await fetch(`${BASE_URL}/v2/customers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': SQUARE_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify({ idempotency_key: `customer-${Date.now()}-${givenName}`, ...body })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Square findOrCreateCustomer failed: ${data.errors?.[0]?.detail || res.status}`);
  return data.customer?.id || null;
}

export async function getCustomers(accessToken) {
  const customers = [];
  let cursor = undefined;

  do {
    const params = new URLSearchParams({ limit: '200' });
    if (cursor) params.set('cursor', cursor);

    const res = await fetch(`${BASE_URL}/v2/customers?${params}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Square-Version': SQUARE_VERSION,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Square getCustomers failed ${res.status}: ${err.message || JSON.stringify(err)}`);
    }

    const data = await res.json();
    if (data.customers) customers.push(...data.customers);
    cursor = data.cursor;
  } while (cursor);

  return customers;
}

export async function getBookings(accessToken, startAt, endAt) {
  const bookings = [];
  let cursor = undefined;

  do {
    const params = new URLSearchParams({ limit: '100' });
    if (startAt) params.set('start_at_min', startAt);
    if (endAt) params.set('start_at_max', endAt);
    if (cursor) params.set('cursor', cursor);

    const res = await fetch(`${BASE_URL}/v2/bookings?${params}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Square-Version': SQUARE_VERSION,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Square getBookings failed ${res.status}: ${err.message || JSON.stringify(err)}`);
    }

    const data = await res.json();
    if (data.bookings) bookings.push(...data.bookings);
    cursor = data.cursor;
  } while (cursor);

  return bookings;
}

export async function getLocations(accessToken) {
  const res = await fetch(`${BASE_URL}/v2/locations`, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': SQUARE_VERSION }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Square getLocations failed: ${data.errors?.[0]?.detail || res.status}`);
  return (data.locations || []).map(l => ({ id: l.id, name: l.name, timezone: l.timezone }));
}

export async function getServices(accessToken) {
  const res = await fetch(`${BASE_URL}/v2/catalog/list?types=ITEM`, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': SQUARE_VERSION }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Square getServices failed: ${data.errors?.[0]?.detail || res.status}`);
  const services = [];
  for (const obj of (data.objects || [])) {
    const item = obj.item_data;
    if (!item) continue;
    // Only include appointment-bookable services
    if (item.product_type && item.product_type !== 'APPOINTMENTS_SERVICE') continue;
    for (const variation of (item.variations || [])) {
      const v = variation.item_variation_data;
      // Skip variations that are not available for online booking
      if (v?.available_for_booking === false) continue;
      services.push({
        serviceId: obj.id,
        variationId: variation.id,
        variationVersion: variation.version,
        name: item.name,
        variation: v?.name || 'Regular',
        durationMinutes: v?.service_duration ? Math.round(v.service_duration / 60000) : null,
        priceCents: v?.price_money?.amount || null,
        currency: v?.price_money?.currency || 'USD',
      });
    }
  }
  return services;
}

export async function searchAvailability(accessToken, { serviceVariationId, startAt, endAt, locationId }) {
  const body = {
    query: {
      filter: {
        start_at_range: { start_at: startAt, end_at: endAt },
        location_id: locationId,
        segment_filters: [{ service_variation_id: serviceVariationId }]
      }
    }
  };
  const res = await fetch(`${BASE_URL}/v2/bookings/availability/search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': SQUARE_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Square searchAvailability failed: ${data.errors?.[0]?.detail || res.status}`);
  return (data.availabilities || []).map(a => ({
    startAt: a.start_at,
    serviceVariationId: a.appointment_segments?.[0]?.service_variation_id,
    teamMemberId: a.appointment_segments?.[0]?.team_member_id,
    locationId: a.location_id,
  }));
}

export async function createBooking(accessToken, { startAt, serviceVariationId, serviceVariationVersion, teamMemberId, locationId, customerName, customerEmail, customerPhone, note }) {
  // Find or create customer so Square can send SMS/email confirmation
  let customerId = null;
  if (customerName || customerPhone || customerEmail) {
    try {
      customerId = await findOrCreateCustomer(accessToken, { name: customerName, phone: customerPhone, email: customerEmail });
    } catch (e) {
      console.warn('[Square] findOrCreateCustomer failed (continuing without customer):', e.message);
    }
  }

  const segment = {
    service_variation_id: serviceVariationId,
    team_member_id: teamMemberId,
  };
  if (serviceVariationVersion) segment.service_variation_version = serviceVariationVersion;

  const bookingBody = {
    start_at: startAt,
    location_id: locationId,
    customer_note: note || '',
    appointment_segments: [segment],
  };
  if (customerId) bookingBody.customer_id = customerId;

  const body = {
    idempotency_key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    booking: bookingBody
  };
  const res = await fetch(`${BASE_URL}/v2/bookings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': SQUARE_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Square createBooking failed: ${data.errors?.[0]?.detail || res.status}`);
  return data.booking;
}

export function normalizeCustomer(c) {
  const nameParts = [c.given_name, c.family_name].filter(Boolean);
  return {
    id: c.id,
    name: nameParts.length > 0 ? nameParts.join(' ') : (c.nickname || null),
    phone: c.phone_number || null,
    email: c.email_address || null,
    birthday: c.birthday || null,
  };
}

export function normalizeBooking(b) {
  const service = b.appointment_segments?.[0];
  return {
    id: b.id,
    contactId: b.customer_id || null,
    startTime: b.start_at || null,
    title: service?.service_variation_id || null,
    status: b.status || null,
  };
}
