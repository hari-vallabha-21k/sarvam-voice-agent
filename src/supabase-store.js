'use strict';

// Supabase (PostgREST) store with the same async interface as the file store.
// Used whenever SUPABASE_URL is set, which is how it runs on Vercel where the
// filesystem does not persist between requests.
//
// Every request carries the "x-app-secret" header. The RLS policies in
// supabase/migrations only let rows through when it matches, so the
// publishable key on its own can read or write nothing.

const { matchesQuery, tableTaken } = require('./store');

const PAGE_SIZE = 1000; // PostgREST's default max rows per request

class SupabaseStore {
  constructor({ url, key, appSecret }) {
    if (!url || !key || !appSecret) {
      throw new Error('SupabaseStore needs SUPABASE_URL, SUPABASE_KEY and SUPABASE_APP_SECRET');
    }
    this.base = `${url.replace(/\/+$/, '')}/rest/v1`;
    this.headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'x-app-secret': appSecret,
      'Content-Type': 'application/json',
    };
  }

  async request(method, path, { body, returnRows = false } = {}) {
    const headers = { ...this.headers };
    if (returnRows) headers.Prefer = 'return=representation';
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      // 23P01 is raised by the bookings trigger when a table is already taken.
      if (data && data.code === '23P01') throw tableTaken();
      const err = new Error(`Database error: ${(data && (data.message || data.hint)) || res.status}`);
      err.status = 502;
      throw err;
    }
    return data;
  }

  async one(path) {
    const rows = await this.request('GET', `${path}&limit=1`);
    return rows[0];
  }

  async insert(table, row) {
    const rows = await this.request('POST', `/${table}`, { body: row, returnRows: true });
    return rows[0];
  }

  async update(table, id, patch) {
    const rows = await this.request('PATCH', `/${table}?id=eq.${enc(id)}`, { body: patch, returnRows: true });
    return rows[0] || null;
  }

  // Orders

  // The id (ORD-1001, ORD-1002, ...) is assigned by a trigger from a gap-free counter.
  async createOrder(fields) {
    return this.insert('orders', { status: 'new', completed_at: null, ...fields });
  }

  async findOrder(id) {
    return this.one(`/orders?id=eq.${enc(id)}`);
  }

  async findOrderByCall(callId) {
    if (!callId) return undefined;
    return this.one(`/orders?call_id=eq.${enc(callId)}&order=created_at.asc`);
  }

  async updateOrder(id, patch) {
    return this.update('orders', id, { ...patch, updated_at: new Date().toISOString() });
  }

  // from / to are Date bounds on created_at (to is exclusive). Pages through
  // every match, so a long CSV export is not cut off at PostgREST's row cap.
  async listOrders({ status, q, from, to } = {}) {
    let filter = 'order=created_at.desc,id.desc';
    if (status) filter += `&status=eq.${enc(status)}`;
    if (from) filter += `&created_at=gte.${enc(from.toISOString())}`;
    if (to) filter += `&created_at=lt.${enc(to.toISOString())}`;
    const list = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await this.request('GET', `/orders?${filter}&limit=${PAGE_SIZE}&offset=${offset}`);
      list.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    return q ? list.filter((o) => matchesQuery(o, q)) : list;
  }

  // Tables

  async listTables() {
    return this.request('GET', '/tables?active=eq.true&order=sort.asc');
  }

  // Bookings

  async findBooking(id) {
    return this.one(`/bookings?id=eq.${enc(id)}`);
  }

  async createBooking(fields) {
    return this.insert('bookings', { status: 'confirmed', ...fields });
  }

  async findBookingByCall(callId) {
    if (!callId) return undefined;
    return this.one(`/bookings?call_id=eq.${enc(callId)}&order=created_at.asc`);
  }

  async updateBooking(id, patch) {
    return this.update('bookings', id, { ...patch, updated_at: new Date().toISOString() });
  }

  async listBookings({ date } = {}) {
    let path = `/bookings?order=booking_date.asc,booking_time.asc&limit=${PAGE_SIZE}`;
    if (date) path += `&booking_date=eq.${enc(date)}`;
    return this.request('GET', path);
  }

  // Call and SMS logs

  async logCall(entry) {
    await this.request('POST', '/calls', { body: entry });
  }

  async recentCalls(limit) {
    return this.request(
      'GET',
      `/calls?select=received_at,call_id,customer_name,customer_phone,disposition,call_summary,order_id,booking_id&order=received_at.desc&limit=${limit}`
    );
  }

  async logSms({ to, ...rest }) {
    await this.request('POST', '/sms', { body: { to_phone: to, ...rest } });
  }

  async stats({ date, timeZone }) {
    return this.request('POST', '/rpc/order_stats', { body: { p_date: date, p_tz: timeZone } });
  }
}

function enc(v) {
  return encodeURIComponent(String(v));
}

module.exports = { SupabaseStore };
