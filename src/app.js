'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { MENU, GST_RATE } = require('./menu');
const { normalizeCall, parseOrderItems, computeTotals, normalizeOrderType, toPartySize } = require('./sarvam');
const { sendSms } = require('./sms');
const { localDate } = require('./store');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
// Orders move new -> cooking -> completed; cancelled can happen from new or cooking.
const ORDER_STATUSES = ['new', 'cooking', 'completed', 'cancelled'];
const OPEN_STATUSES = ['new', 'cooking'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EXPORT_DAYS = 366;
const NEGATIVE_DISPOSITIONS = ['order_cancelled', 'no_order', 'cancelled'];

// A non-JSON reply, such as the CSV export.
class RawResponse {
  constructor(status, headers, body) {
    this.status = status;
    this.headers = headers;
    this.body = body;
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createApp({ store, config }) {
  const routes = [
    // Sarvam post-call webhook (on_end API)
    ['POST', '/api/sarvam/webhook', requireSecret(postCallWebhook)],
    ['POST', '/api/sarvam/call-ended', requireSecret(postCallWebhook)],

    // Sarvam agent tools (called mid-call)
    ['GET', '/api/tools/get_menu', requireSecret(getMenu)],
    ['POST', '/api/tools/get_menu', requireSecret(getMenu)],
    ['POST', '/api/tools/check_table_availability', requireSecret(checkTableAvailability)],
    ['POST', '/api/tools/create_booking', requireSecret(createBooking)],
    ['POST', '/api/tools/place_order', requireSecret(placeOrder)],
    ['POST', '/api/tools/send_confirmation_sms', requireSecret(sendConfirmationSms)],

    // Dashboard API
    ['GET', '/api/stats', getStats],
    ['GET', '/api/orders', listOrders],
    ['GET', '/api/orders/export', exportOrders],
    ['GET', '/api/orders/:id', getOrder],
    ['PATCH', '/api/orders/:id', patchOrder],
    ['GET', '/api/bookings', listBookings],
    ['PATCH', '/api/bookings/:id', patchBooking],
    ['GET', '/api/calls', listCalls],
    ['GET', '/api/health', () => ({ ok: true })],
  ];

  function requireSecret(handler) {
    return (req, ctx) => {
      if (config.webhookSecret) {
        const auth = req.headers.authorization || '';
        const token = auth.replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '';
        if (!safeEqual(token, config.webhookSecret)) throw new HttpError(401, 'Invalid or missing API key');
      }
      return handler(req, ctx);
    };
  }

  // ---------- Sarvam post-call webhook ----------

  async function postCallWebhook(req, { body }) {
    const call = normalizeCall(body);
    const disposition = (call.disposition || '').toLowerCase();
    const result = { ok: true, call_id: call.call_id || null, order: null, booking: null };

    // place_order may already have run during the call. Sarvam hands back the
    // order_id it saved from that response; call_id is the fallback match.
    let order = (call.order_id && (await store.findOrder(call.order_id))) || (await store.findOrderByCall(call.call_id));
    if (order) {
      // Fill in anything we learnt later.
      const patch = {};
      for (const k of ['customer_name', 'customer_phone', 'delivery_address', 'call_summary']) {
        if (!order[k] && call[k]) patch[k] = call[k];
      }
      if (NEGATIVE_DISPOSITIONS.includes(disposition) && OPEN_STATUSES.includes(order.status)) patch.status = 'cancelled';
      if (Object.keys(patch).length) order = await store.updateOrder(order.id, patch);
      result.order = order;
    } else if (call.order_items.length && !NEGATIVE_DISPOSITIONS.includes(disposition)) {
      result.order = await store.createOrder(orderFields(call, 'sarvam_call_end'));
    }

    if (call.booking_date && call.booking_time) {
      result.booking =
        (await store.findBookingByCall(call.call_id)) ||
        (await store.createBooking({
          call_id: call.call_id || null,
          customer_name: call.customer_name || null,
          customer_phone: call.customer_phone || null,
          booking_date: normalizeDate(call.booking_date) || call.booking_date,
          booking_time: normalizeTime(call.booking_time) || call.booking_time,
          party_size: call.party_size,
          source: 'sarvam_call_end',
        }));
    }

    await store.logCall({
      call_id: call.call_id || null,
      customer_name: call.customer_name || null,
      customer_phone: call.customer_phone || null,
      disposition: call.disposition || null,
      call_summary: call.call_summary || null,
      order_id: result.order ? result.order.id : null,
      booking_id: result.booking ? result.booking.id : null,
      payload: body,
    });
    return result;
  }

  function orderFields(call, source) {
    return {
      call_id: call.call_id || null,
      customer_name: call.customer_name || null,
      customer_phone: call.customer_phone || null,
      order_type: call.order_type || null,
      delivery_address: call.delivery_address || null,
      items: call.order_items,
      ...computeTotals(call.order_items),
      notes: call.notes || null,
      call_summary: call.call_summary || null,
      source,
    };
  }

  // ---------- Agent tools ----------

  function getMenu() {
    const items = MENU.filter((m) => m.available);
    return {
      items,
      gst_percent: GST_RATE * 100,
      message: items.map((m) => `${m.name} ${m.price} rupees`).join(', '),
    };
  }

  async function checkTableAvailability(req, { body }) {
    const date = normalizeDate(body.booking_date || body.date);
    const time = normalizeTime(body.booking_time || body.time);
    const party = toPartySize(body.party_size || body.guests);
    if (!date || !time || !party) {
      throw new HttpError(400, 'booking_date (YYYY-MM-DD), booking_time (HH:MM) and party_size are required');
    }
    const bookings = await store.listBookings({ date });
    const requested = slotStatus(bookings, time, party);
    const alternatives = requested.available
      ? []
      : candidateSlots(time)
          .filter((t) => slotStatus(bookings, t, party).available)
          .slice(0, 3);
    return {
      available: requested.available,
      booking_date: date,
      booking_time: time,
      party_size: party,
      seats_left: requested.seats_left,
      alternative_times: alternatives,
      message: requested.available
        ? `A table for ${party} is available on ${date} at ${time}.`
        : requested.reason ||
          (alternatives.length
            ? `That time is full. Available times are ${alternatives.join(', ')}.`
            : `Sorry, there are no tables for ${party} on ${date}.`),
    };
  }

  async function createBooking(req, { body }) {
    const call = normalizeCall(body);
    const date = normalizeDate(call.booking_date);
    const time = normalizeTime(call.booking_time);
    if (!date || !time || !call.party_size) {
      throw new HttpError(400, 'booking_date, booking_time and party_size are required');
    }
    const status = slotStatus(await store.listBookings({ date }), time, call.party_size);
    if (!status.available) {
      throw new HttpError(409, status.reason || 'That slot is fully booked. Please pick another time.');
    }
    const booking = await store.createBooking({
      call_id: call.call_id || null,
      customer_name: call.customer_name || null,
      customer_phone: call.customer_phone || null,
      booking_date: date,
      booking_time: time,
      party_size: call.party_size,
      notes: call.notes || null,
      source: 'sarvam_tool',
    });
    return {
      ...booking,
      booking_id: booking.id,
      message: `Booking ${booking.id} confirmed for ${booking.party_size} on ${date} at ${time}.`,
    };
  }

  async function placeOrder(req, { body }) {
    const call = normalizeCall(body);
    if (!call.order_items.length) throw new HttpError(400, 'order_items is required');
    const unknown = call.order_items.filter((it) => !it.on_menu).map((it) => it.name);
    if (unknown.length && config.rejectUnknownItems) {
      throw new HttpError(422, `Not on the menu: ${unknown.join(', ')}`);
    }
    // If the agent calls place_order twice in one call (e.g. after a change), update instead of duplicating.
    const existing = await store.findOrderByCall(call.call_id);
    const fields = orderFields(call, 'sarvam_tool');
    // A re-placed order keeps its kitchen status, unless it had been cancelled.
    const order = existing
      ? await store.updateOrder(existing.id, existing.status === 'cancelled' ? { ...fields, status: 'new' } : fields)
      : await store.createOrder(fields);
    return {
      ...order,
      order_id: order.id,
      message: `Order ${order.id} placed. Total is ${order.total} rupees including GST.`,
    };
  }

  async function sendConfirmationSms(req, { body }) {
    const call = normalizeCall(body);
    const to = call.customer_phone;
    if (!to) throw new HttpError(400, 'customer_phone is required');
    let text = body.message;
    if (!text) {
      const order = body.order_id ? await store.findOrder(body.order_id) : await store.findOrderByCall(call.call_id);
      const booking = await store.findBookingByCall(call.call_id);
      const lines = [`Hi ${call.customer_name || 'there'}, thanks for calling ${config.restaurantName}.`];
      if (order) lines.push(`Order ${order.id}: ${order.items.map((i) => `${i.quantity} x ${i.name}`).join(', ')}. Total Rs ${order.total}.`);
      if (booking) lines.push(`Table booking ${booking.id}: ${booking.party_size} people on ${booking.booking_date} at ${booking.booking_time}.`);
      text = lines.join(' ');
    }
    const result = await sendSms(config, to, text);
    await store.logSms({ to, text, provider: result.provider, status: result.status, call_id: call.call_id || null });
    return { ...result, to, message: 'Confirmation SMS sent.' };
  }

  // ---------- Dashboard ----------

  // ?date=YYYY-MM-DD picks the day (restaurant time zone); defaults to today.
  function getStats(req, { query }) {
    return store.stats({ date: dateParam(query, 'date') || today(), timeZone: config.timeZone });
  }

  // ?date=YYYY-MM-DD limits the list to one day; without it every order is returned.
  async function listOrders(req, { query }) {
    const date = dateParam(query, 'date');
    const range = date ? dayRange(date, date) : {};
    return {
      orders: await store.listOrders({ status: query.get('status') || undefined, q: query.get('q') || undefined, ...range }),
    };
  }

  // CSV of every order placed between ?from= and ?to= (inclusive, YYYY-MM-DD).
  async function exportOrders(req, { query }) {
    const from = dateParam(query, 'from');
    const to = dateParam(query, 'to');
    if (!from || !to) throw new HttpError(400, 'from and to are required (YYYY-MM-DD)');
    if (from > to) throw new HttpError(400, 'The start date must be on or before the end date');
    const range = dayRange(from, to);
    if ((range.to - range.from) / 864e5 > MAX_EXPORT_DAYS + 1) {
      throw new HttpError(400, `Export at most ${MAX_EXPORT_DAYS} days at a time`);
    }
    const orders = (await store.listOrders(range)).reverse(); // oldest first
    const csv = '\uFEFF' + ordersToCsv(orders, config.timeZone); // BOM so Excel reads UTF-8 names correctly
    return new RawResponse(
      200,
      {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="orders_${from}_to_${to}.csv"`,
      },
      csv
    );
  }

  function today() {
    return localDate(new Date(), config.timeZone);
  }

  function dateParam(query, name) {
    const v = query.get(name);
    if (!v) return null;
    if (!DATE_RE.test(v) || Number.isNaN(Date.parse(v))) throw new HttpError(400, `${name} must be YYYY-MM-DD`);
    return v;
  }

  // Start of `from` to the start of the day after `to`, in the restaurant's time zone.
  function dayRange(from, to) {
    const next = new Date(Date.parse(to) + 864e5).toISOString().slice(0, 10);
    return { from: zonedMidnight(from, config.timeZone), to: zonedMidnight(next, config.timeZone) };
  }

  async function getOrder(req, { params }) {
    const order = await store.findOrder(params.id);
    if (!order) throw new HttpError(404, 'Order not found');
    return order;
  }

  async function patchOrder(req, { params, body }) {
    const patch = {};
    if (body.status !== undefined) {
      if (!ORDER_STATUSES.includes(body.status)) throw new HttpError(400, `status must be one of ${ORDER_STATUSES.join(', ')}`);
      patch.status = body.status;
      patch.completed_at = body.status === 'completed' ? new Date().toISOString() : null;
    }
    if (body.items !== undefined) {
      patch.items = parseOrderItems(body.items);
      Object.assign(patch, computeTotals(patch.items));
    }
    for (const k of ['customer_name', 'customer_phone', 'notes']) if (body[k] !== undefined) patch[k] = body[k];
    if (body.order_type !== undefined) patch.order_type = normalizeOrderType(body.order_type);
    const order = await store.updateOrder(params.id, patch);
    if (!order) throw new HttpError(404, 'Order not found');
    return order;
  }

  async function listBookings(req, { query }) {
    return { bookings: await store.listBookings({ date: query.get('date') || undefined }) };
  }

  async function patchBooking(req, { params, body }) {
    if (!['confirmed', 'seated', 'cancelled', 'no_show'].includes(body.status)) {
      throw new HttpError(400, 'status must be confirmed, seated, cancelled or no_show');
    }
    const booking = await store.updateBooking(params.id, { status: body.status });
    if (!booking) throw new HttpError(404, 'Booking not found');
    return booking;
  }

  async function listCalls(req, { query }) {
    const limit = Math.min(parseInt(query.get('limit') || '50', 10) || 50, 500);
    return { calls: await store.recentCalls(limit) };
  }

  // ---------- Table capacity ----------

  // `bookings` are that day's bookings, fetched once by the caller.
  function slotStatus(bookings, time, party) {
    const mins = toMinutes(time);
    const open = config.openingHours.some(([from, to]) => mins >= toMinutes(from) && mins + config.bookingDurationMin <= toMinutes(to));
    if (!open) {
      const hours = config.openingHours.map(([a, b]) => `${a} to ${b}`).join(' and ');
      return { available: false, seats_left: 0, reason: `We take bookings between ${hours}.` };
    }
    const taken = bookings
      .filter((b) => b.status !== 'cancelled' && b.status !== 'no_show')
      .filter((b) => Math.abs(toMinutes(b.booking_time) - mins) < config.bookingDurationMin)
      .reduce((sum, b) => sum + (b.party_size || 0), 0);
    const seatsLeft = Math.max(0, config.seatCapacity - taken);
    return { available: party <= seatsLeft, seats_left: seatsLeft };
  }

  function candidateSlots(time) {
    const base = toMinutes(time);
    const out = [];
    for (const [from, to] of config.openingHours) {
      for (let m = toMinutes(from); m + config.bookingDurationMin <= toMinutes(to); m += 30) out.push(m);
    }
    return out.sort((a, b) => Math.abs(a - base) - Math.abs(b - base)).map(fromMinutes);
  }

  // ---------- Dashboard login ----------

  // Sarvam endpoints use WEBHOOK_SECRET instead, and /api/health stays open for uptime checks.
  function isPublicPath(pathname) {
    return pathname.startsWith('/api/sarvam/') || pathname.startsWith('/api/tools/') || pathname === '/api/health';
  }

  // HTTP Basic auth: any username with DASHBOARD_PASSWORD, or a named login from
  // DASHBOARD_USERS. Off when neither is set.
  function dashboardAuthorized(req) {
    if (!config.dashboardPassword && !config.dashboardUsers.size) return true;
    const m = (req.headers.authorization || '').match(/^Basic\s+(.+)$/i);
    if (!m) return false;
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const user = decoded.slice(0, decoded.indexOf(':'));
    const password = decoded.slice(decoded.indexOf(':') + 1);
    if (config.dashboardPassword && safeEqual(password, config.dashboardPassword)) return true;
    return config.dashboardUsers.has(user) && safeEqual(password, config.dashboardUsers.get(user));
  }

  // ---------- HTTP plumbing ----------

  const compiled = routes.map(([method, pattern, handler]) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
    return { method, re, keys, handler };
  });

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'OPTIONS') return send(res, 204, null);
      if (!isPublicPath(url.pathname) && !dashboardAuthorized(req)) {
        res.setHeader('WWW-Authenticate', `Basic realm="${config.restaurantName} dashboard", charset="UTF-8"`);
        return send(res, 401, { ok: false, error: 'Login required' });
      }
      const match = compiled.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!match) {
        if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
        throw new HttpError(404, 'Not found');
      }
      const m = url.pathname.match(match.re);
      const params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const body = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readJson(req);
      const result = await match.handler(req, { params, query: url.searchParams, body });
      if (result instanceof RawResponse) {
        res.writeHead(result.status, result.headers);
        return res.end(result.body);
      }
      send(res, 200, result);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      // "message" is what the Sarvam tool's on_failure/resp_template can read out.
      send(res, status, { ok: false, error: err.message, message: err.message });
    }
  };
}

function send(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
  });
  res.end(payload === null ? '' : JSON.stringify(payload));
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, { ok: false, error: 'Not found' });
  }
  res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) reject(new HttpError(413, 'Payload too large'));
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      const type = req.headers['content-type'] || '';
      if (type.includes('application/x-www-form-urlencoded')) return resolve(Object.fromEntries(new URLSearchParams(raw)));
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : { value: parsed });
      } catch (_) {
        reject(new HttpError(400, 'Body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

function fromMinutes(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

// "19:30", "7:30 pm", "7 PM", "1930" -> "19:30"
function normalizeTime(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase().replace(/\./g, '');
  const m = s.match(/^(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2] || '0', 10);
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return fromMinutes(h * 60 + min);
}

// "2026-09-27", "27/09/2026", "27-09-2026" -> "2026-09-27"
function normalizeDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  const rel = { today: 0, tomorrow: 1, 'day after tomorrow': 2 }[s.toLowerCase()];
  if (rel !== undefined) return new Date(Date.now() + rel * 864e5).toISOString().slice(0, 10);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Midnight of YYYY-MM-DD in `timeZone`, as a Date.
function zonedMidnight(date, timeZone) {
  const guess = Date.parse(`${date}T00:00:00Z`);
  let t = guess - tzOffset(guess, timeZone);
  const corrected = tzOffset(t, timeZone); // differs only when a DST change falls between
  if (corrected !== tzOffset(guess, timeZone)) t = guess - corrected;
  return new Date(t);
}

// How far `timeZone` is ahead of UTC at instant t, in ms.
function tzOffset(t, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(t));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
}

const CSV_COLUMNS = [
  ['Order ID', (o) => o.id],
  ['Date', (o, tz) => localDate(new Date(o.created_at), tz)],
  ['Time', (o, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(o.created_at))],
  ['Customer', (o) => o.customer_name],
  ['Phone', (o) => o.customer_phone],
  ['Order type', (o) => o.order_type],
  ['Items', (o) => o.items.map((i) => `${i.quantity} x ${i.name}`).join('; ')],
  ['Item count', (o) => o.items.reduce((n, i) => n + i.quantity, 0)],
  ['Subtotal', (o) => o.subtotal],
  ['GST', (o) => o.tax],
  ['Total', (o) => o.total],
  ['Status', (o) => o.status],
  ['Delivery address', (o) => o.delivery_address],
  ['Notes', (o) => o.notes],
];

function ordersToCsv(orders, timeZone) {
  const rows = [CSV_COLUMNS.map(([h]) => h), ...orders.map((o) => CSV_COLUMNS.map(([, get]) => get(o, timeZone)))];
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Stop spreadsheet apps from running caller-supplied text as a formula; phone numbers stay as they are.
  if (/^[=+\-@\t\r]/.test(s) && !/^\+?[\d\s-]+$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = { createApp, normalizeTime, normalizeDate };
