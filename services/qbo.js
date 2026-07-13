import { Buffer } from 'node:buffer';
import { getServerSetting } from '../db.js'

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const SCOPE = 'com.intuit.quickbooks.accounting';

function baseUrl() {
  return process.env.QBO_SANDBOX
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';
}

function redirectUri() {
  return process.env.QBO_CALLBACK_URL || 'https://chat.lynkro.io/api/qbo/callback';
}

function clientId()     { return process.env.QBO_CLIENT_ID     || getServerSetting('qbo_client_id')     || '' }
function clientSecret() { return process.env.QBO_CLIENT_SECRET || getServerSetting('qbo_client_secret') || '' }

export function hasCredentials() {
  return !!(clientId() && clientSecret())
}

export function getOAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    state: state ?? '',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeCode(code) {
  const credentials = Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QBO exchangeCode failed (${res.status}): ${text}`);
  }

  return res.json();
}

export async function refreshAccessToken(refreshToken) {
  const credentials = Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QBO refreshAccessToken failed (${res.status}): ${text}`);
  }

  return res.json();
}

export async function queryQBO(accessToken, realmId, sql) {
  const url = new URL(`/v3/company/${realmId}/query`, baseUrl());
  url.searchParams.set('query', sql);
  url.searchParams.set('minorversion', '65');

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QBO query failed (${res.status}): ${text}`);
  }

  return res.json();
}

export function normalizeCustomer(c) {
  return {
    id: c.Id,
    name: c.DisplayName || '',
    phone: c.PrimaryPhone?.FreeFormNumber || '',
    email: c.PrimaryEmailAddr?.Address || '',
  };
}

export async function getCustomers(accessToken, realmId) {
  const sql = 'SELECT * FROM Customer WHERE Active = true MAXRESULTS 1000';
  const data = await queryQBO(accessToken, realmId, sql);
  const customers = data?.QueryResponse?.Customer ?? [];
  return customers.map(normalizeCustomer);
}

export async function getPaidInvoices(accessToken, realmId, sinceDate) {
  const dateStr = sinceDate instanceof Date
    ? sinceDate.toISOString().slice(0, 10)
    : sinceDate;

  const sql = `SELECT * FROM Invoice WHERE Balance = '0' AND MetaData.LastUpdatedTime > '${dateStr}' MAXRESULTS 1000`;
  const data = await queryQBO(accessToken, realmId, sql);
  const invoices = data?.QueryResponse?.Invoice ?? [];

  return invoices.map((inv) => ({
    id: inv.Id,
    customerId: inv.CustomerRef?.value ?? null,
    paidDate: inv.MetaData?.LastUpdatedTime ?? null,
  }));
}
