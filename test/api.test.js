'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('../src/app');
const { Store } = require('../src/store');
const { loadConfig } = require('../src/config');
const { parseOrderItems, normalizeCall } = require('../src/sarvam');

function startServer(env = {}) {
  const config = loadConfig({ ...env });
  const store = new Store(null); // in-memory
  const server = http.createServer(createApp({ store, config }));
  return new Promise((resolve) => {
    server.listen(0, () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const call = async (method, path, body, headers = {}) => {
        const res = await fetch(base + path, {
          method,
          headers: { 'Content-Type': 'application/json', ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
      };
      resolve({ server, store, call });
    });
  });
}

test('parses free-text order items and matches the menu', () => {
  const items = parseOrderItems('2 x Paneer Butter Masala, Butter Naan x 4 and one mango lassi');
  assert.deepEqual(
    items.map((i) => [i.name, i.quantity, i.unit_price]),
    [
      ['Paneer Butter Masala', 2, 220],
      ['Butter Naan', 4, 40],
      ['Mango Lassi', 1, 90],
    ]
  );
});

test('parses JSON order items and flags unknown dishes', () => {
  const items = parseOrderItems('[{"item":"veg biryani","qty":"3"},{"name":"Pizza","quantity":1}]');
  assert.equal(items[0].name, 'Veg Biryani');
  assert.equal(items[0].quantity, 3);
  assert.equal(items[1].on_menu, false);
});

test('reads variables wrapped as {value} objects under agent_variables', () => {
  const call = normalizeCall({
    interaction_id: 'abc',
    agent_variables: { customer_name: { name: 'customer_name', value: 'Asha' }, order_items: { value: '1 Raita' } },
  });
  assert.equal(call.call_id, 'abc');
  assert.equal(call.customer_name, 'Asha');
  assert.equal(call.order_items[0].name, 'Raita');
});

test('post-call webhook creates an order and a booking; stats reflect it', async (t) => {
  const { server, call } = await startServer();
  t.after(() => server.close());

  const res = await call('POST', '/api/sarvam/webhook', {
    call_id: 'c1',
    customer_name: 'Rahul',
    customer_phone: '+919800000000',
    order_items: '3 Veg Biryani',
    order_type: 'Dine In',
    booking_date: '2030-01-05',
    booking_time: '8 pm',
    party_size: '4',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.order.id, 'ORD-1001');
  assert.equal(res.body.order.status, 'new');
  assert.equal(res.body.order.order_type, 'dine-in');
  assert.equal(res.body.order.total, 567); // 540 + 5% GST
  assert.equal(res.body.booking.booking_time, '20:00');

  // Same call delivered twice must not create a second order.
  const again = await call('POST', '/api/sarvam/webhook', { call_id: 'c1', order_items: '3 Veg Biryani' });
  assert.equal(again.body.order.id, 'ORD-1001');

  await call('PATCH', '/api/orders/ORD-1001', { status: 'cooking' });
  await call('PATCH', '/api/orders/ORD-1001', { status: 'completed' });
  await call('POST', '/api/sarvam/webhook', { call_id: 'c2', customer_name: 'Asha', order_items: '1 Raita' });
  const second = await call('POST', '/api/sarvam/webhook', { call_id: 'c3', order_items: '1 Naan' });
  assert.equal(second.body.order.id, 'ORD-1003'); // every order gets the next number
  await call('PATCH', '/api/orders/ORD-1003', { status: 'cooking' });

  const stats = await call('GET', '/api/stats');
  assert.equal(stats.body.orders, 3);
  assert.equal(stats.body.new, 1);
  assert.equal(stats.body.cooking, 1);
  assert.equal(stats.body.completed, 1);
  assert.equal(stats.body.all_time_orders, 3);
});

test('webhook skips order creation when the caller cancelled', async (t) => {
  const { server, call } = await startServer();
  t.after(() => server.close());
  const res = await call('POST', '/api/sarvam/webhook', { call_id: 'x', order_items: '1 Raita', disposition: 'order_cancelled' });
  assert.equal(res.body.order, null);
});

test('place_order tool then webhook for the same call keeps one order', async (t) => {
  const { server, call } = await startServer();
  t.after(() => server.close());
  const placed = await call('POST', '/api/tools/place_order', { call_id: 'c9', order_items: '2 Gulab Jamun' });
  assert.equal(placed.status, 200);
  assert.match(placed.body.message, /Order ORD-1001 placed/);
  const hook = await call('POST', '/api/sarvam/webhook', { call_id: 'c9', customer_name: 'Meera', order_items: '2 Gulab Jamun' });
  assert.equal(hook.body.order.id, 'ORD-1001');
  assert.equal(hook.body.order.customer_name, 'Meera');
  const list = await call('GET', '/api/orders');
  assert.equal(list.body.orders.length, 1);
});

test('bookings take the smallest free table and suggest other times when full', async (t) => {
  const { server, call, store } = await startServer();
  t.after(() => server.close());
  // Two 8-seat tables in the default floor plan: T-06 and T-11, T-12 (three in total).
  const big = { booking_date: '2030-01-05', booking_time: '19:30', party_size: 8, customer_name: 'Big party' };
  const first = await call('POST', '/api/tools/create_booking', big);
  assert.equal(first.status, 200);
  assert.equal(first.body.table_id, 'T-06');
  assert.match(first.body.message, /Booking BKG-501 is confirmed\. Table T-06 for 8 on Saturday 5 January at 7:30 PM/);
  await call('POST', '/api/tools/create_booking', big);
  await call('POST', '/api/tools/create_booking', big);
  const full = await call('POST', '/api/tools/check_table_availability', { booking_date: '2030-01-05', booking_time: '20:00', party_size: 8 });
  assert.equal(full.body.available, false);
  assert.ok(full.body.alternative_times.length > 0);
  assert.equal((await call('POST', '/api/tools/create_booking', big)).status, 409);

  const small = await call('POST', '/api/tools/check_table_availability', { booking_date: '2030-01-05', booking_time: '8 pm', party_size: 2 });
  assert.equal(small.body.available, true);
  assert.equal(small.body.table_id, 'T-01');
  const huge = await call('POST', '/api/tools/check_table_availability', { booking_date: '2030-01-05', booking_time: '20:00', party_size: 12 });
  assert.match(huge.body.message, /largest table seats 8/);
  const closed = await call('POST', '/api/tools/check_table_availability', { booking_date: '2030-01-05', booking_time: '10:00', party_size: 2 });
  assert.equal(closed.body.available, false);
  assert.match(closed.body.message, /We take table bookings from 12 PM to 2 PM, and from 7 PM to 9:30 PM/);
  assert.equal((await call('POST', '/api/tools/create_booking', { ...big, booking_date: '2020-01-01' })).status, 400);
  assert.equal(store.data.bookings.length, 3);
});

test('tables view shows reserved, occupied and available with guest details', async (t) => {
  const { server, call } = await startServer();
  t.after(() => server.close());
  const book = (body) => call('POST', '/api/bookings', { booking_date: '2030-01-05', ...body });
  const a = await book({ customer_name: 'Asha', customer_phone: '+919800000001', booking_time: '19:00', party_size: 4 });
  const b = await book({ customer_name: 'Ravi', booking_time: '21:30', party_size: 5, table_id: 'T-05' });
  assert.equal(a.body.table_id, 'T-01');
  assert.equal(a.body.source, 'staff');
  assert.equal(b.body.table_id, 'T-05');
  assert.equal((await book({ customer_name: 'Clash', booking_time: '21:00', party_size: 2, table_id: 'T-05' })).status, 409);
  assert.equal((await book({ customer_name: 'Too many', booking_time: '13:00', party_size: 7, table_id: 'T-01' })).status, 409);
  assert.equal((await book({ booking_time: '13:00', party_size: 2 })).status, 400); // name required

  const at = async (time) => (await call('GET', `/api/tables?date=2030-01-05&time=${time}`)).body;
  let floor = await at('19:30');
  const byId = (f, id) => f.tables.find((x) => x.id === id);
  assert.equal(floor.tables.length, 12);
  assert.deepEqual(floor.areas, ['Main Hall', 'Patio', 'Family Room']);
  assert.equal(byId(floor, 'T-01').status, 'reserved');
  assert.equal(byId(floor, 'T-01').current.customer_name, 'Asha');
  assert.equal(byId(floor, 'T-05').status, 'available');
  assert.equal(byId(floor, 'T-05').next.customer_name, 'Ravi');
  assert.deepEqual(floor.summary, { total: 12, available: 11, reserved: 1, occupied: 0 });

  // Seat Asha, then free the table.
  assert.equal((await call('PATCH', `/api/bookings/${a.body.id}`, { status: 'seated' })).body.status, 'seated');
  floor = await at('19:30');
  assert.equal(byId(floor, 'T-01').status, 'occupied');
  assert.equal((await call('PATCH', `/api/bookings/${a.body.id}`, { status: 'completed' })).body.status, 'completed');
  assert.equal(byId(await at('19:30'), 'T-01').status, 'available');

  // Move Ravi to a table that is free; moving onto a too-small table is refused.
  assert.equal((await call('PATCH', `/api/bookings/${b.body.id}`, { table_id: 'T-09' })).body.table_id, 'T-09');
  assert.equal((await call('PATCH', `/api/bookings/${b.body.id}`, { table_id: 'T-02' })).status, 409);
  assert.equal((await call('PATCH', `/api/bookings/${b.body.id}`, { status: 'eaten' })).status, 400);
  assert.equal((await call('GET', '/api/tables?time=25:00')).status, 400);
});

test('post-call webhook links the mid-call booking and falls back to an unassigned booking', async (t) => {
  const { server, call } = await startServer();
  t.after(() => server.close());
  const made = await call('POST', '/api/tools/create_booking', { customer_name: 'Meera', booking_date: '2030-01-05', booking_time: '19:00', party_size: 2 });
  const hook = await call('POST', '/api/sarvam/webhook', { booking_id: made.body.booking_id, call_summary: 'Booked a table' });
  assert.equal(hook.body.booking.id, made.body.booking_id);

  const late = await call('POST', '/api/sarvam/webhook', { call_id: 'z1', customer_name: 'Late', booking_date: '2030-01-05', booking_time: '23:30', party_size: 2 });
  assert.equal(late.body.booking.table_id, null);
  assert.match(late.body.booking.notes, /Needs a table/);
  const floor = (await call('GET', '/api/tables?date=2030-01-05&time=19:00')).body;
  assert.deepEqual(floor.unassigned.map((b) => b.customer_name), ['Late']);
});

test('dates and times spoken by callers are understood', () => {
  const { normalizeDate, normalizeTime } = require('../src/app');
  const { localDate } = require('../src/store');
  const today = localDate(new Date(), 'Asia/Kolkata');
  const plus = (n) => new Date(Date.parse(today) + n * 864e5).toISOString().slice(0, 10);
  assert.equal(normalizeDate('today'), today);
  assert.equal(normalizeDate('Tomorrow'), plus(1));
  const sat = normalizeDate('saturday');
  assert.equal(new Date(sat).getUTCDay(), 6);
  assert.ok(sat >= today && sat <= plus(6));
  assert.equal(normalizeDate('27/09/2030'), '2030-09-27');
  assert.equal(normalizeDate('27 September 2030'), '2030-09-27');
  assert.ok(normalizeDate('1 January') > today);
  assert.equal(normalizeTime('8 pm'), '20:00');
  assert.equal(normalizeTime('7:30 PM'), '19:30');
});

test('get_menu and send_confirmation_sms (log mode)', async (t) => {
  const { server, call, store } = await startServer();
  t.after(() => server.close());
  const menu = await call('GET', '/api/tools/get_menu');
  assert.ok(menu.body.items.length >= 10);
  await call('POST', '/api/tools/place_order', { call_id: 's1', customer_name: 'Ravi', order_items: '1 Raita' });
  const sms = await call('POST', '/api/tools/send_confirmation_sms', { call_id: 's1', customer_phone: '+919811111111', customer_name: 'Ravi' });
  assert.equal(sms.status, 200);
  assert.equal(sms.body.provider, 'log');
  assert.match(store.data.sms[0].text, /ORD-1001/);
});

test('WEBHOOK_SECRET is enforced on Sarvam endpoints only', async (t) => {
  const { server, call } = await startServer({ WEBHOOK_SECRET: 's3cret' });
  t.after(() => server.close());
  assert.equal((await call('POST', '/api/sarvam/webhook', { order_items: '1 Raita' })).status, 401);
  assert.equal((await call('POST', '/api/sarvam/webhook', { order_items: '1 Raita' }, { Authorization: 'Bearer s3cret' })).status, 200);
  assert.equal((await call('POST', '/api/tools/place_order', { order_items: '1 Raita' }, { 'X-API-Key': 's3cret' })).status, 200);
  assert.equal((await call('GET', '/api/stats')).status, 200);
});

test('DASHBOARD_PASSWORD guards the dashboard but not the Sarvam endpoints', async (t) => {
  const { server, call } = await startServer({ DASHBOARD_PASSWORD: 'pw', WEBHOOK_SECRET: 's3cret' });
  t.after(() => server.close());
  const basic = (pw) => ({ Authorization: 'Basic ' + Buffer.from(`staff:${pw}`).toString('base64') });
  assert.equal((await call('GET', '/api/stats')).status, 401);
  assert.equal((await call('GET', '/api/stats', undefined, basic('nope'))).status, 401);
  assert.equal((await call('GET', '/api/stats', undefined, basic('pw'))).status, 200);
  assert.equal((await call('GET', '/api/health')).status, 200);
  assert.equal((await call('POST', '/api/tools/place_order', { order_items: '1 Raita' }, { Authorization: 'Bearer s3cret' })).status, 200);
});

test('SupabaseStore sends the app secret and maps rows', async (t) => {
  const { SupabaseStore } = require('../src/supabase-store');
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push({ url, opts });
    const rows = opts.method === 'POST' ? [{ id: 'ORD-1001', ...JSON.parse(opts.body) }] : [];
    return new Response(JSON.stringify(rows), { status: opts.method === 'POST' ? 201 : 200 });
  };
  t.after(() => (global.fetch = realFetch));

  const store = new SupabaseStore({ url: 'https://x.supabase.co/', key: 'pk', appSecret: 'sec' });
  const order = await store.createOrder({ call_id: 'c 1', items: [] });
  assert.equal(order.id, 'ORD-1001');
  assert.equal(order.status, 'new');
  assert.equal(await store.findOrderByCall('c 1'), undefined);
  await store.logSms({ to: '+91', text: 'hi' });

  assert.equal(seen[0].url, 'https://x.supabase.co/rest/v1/orders');
  assert.equal(seen[0].opts.headers['x-app-secret'], 'sec');
  assert.equal(seen[0].opts.headers.Prefer, 'return=representation');
  assert.match(seen[1].url, /call_id=eq\.c%201/);
  assert.equal(JSON.parse(seen[2].opts.body).to_phone, '+91');
});

test('webhook matches the order place_order created via order_id and cancels it', async (t) => {
  const { server, call } = await startServer();
  t.after(() => server.close());
  const placed = await call('POST', '/api/tools/place_order', { customer_name: 'Ravi', order_items: '1 Raita' });
  const hook = await call('POST', '/api/sarvam/webhook', {
    order_id: placed.body.order_id,
    order_details: '1 Raita',
    call_summary: 'Ordered raita, then cancelled',
    disposition: 'order_cancelled',
  });
  assert.equal(hook.body.order.id, placed.body.order_id);
  assert.equal(hook.body.order.status, 'cancelled');
  assert.equal(hook.body.order.call_summary, 'Ordered raita, then cancelled');
  assert.equal((await call('GET', '/api/orders')).body.orders.length, 1);
});

test('DASHBOARD_USERS adds named logins alongside DASHBOARD_PASSWORD', async (t) => {
  const { server, call } = await startServer({ DASHBOARD_PASSWORD: 'pw', DASHBOARD_USERS: 'test:t3st, manager:m9' });
  t.after(() => server.close());
  const basic = (user, pw) => ({ Authorization: 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64') });
  assert.equal((await call('GET', '/api/stats', undefined, basic('test', 't3st'))).status, 200);
  assert.equal((await call('GET', '/api/stats', undefined, basic('manager', 'm9'))).status, 200);
  assert.equal((await call('GET', '/api/stats', undefined, basic('anyone', 'pw'))).status, 200);
  assert.equal((await call('GET', '/api/stats', undefined, basic('test', 'm9'))).status, 401);
  assert.equal((await call('GET', '/api/stats', undefined, basic('other', 't3st'))).status, 401);
});

test('stats and order list follow ?date, and bad dates are rejected', async (t) => {
  const { server, call, store } = await startServer();
  t.after(() => server.close());
  await call('POST', '/api/tools/place_order', { customer_name: 'Today', order_items: '1 Raita' });
  const old = await call('POST', '/api/tools/place_order', { customer_name: 'Last week', order_items: '2 Raita' });
  // Backdate one order to 20 Sep, 11:30 pm IST, which is still 20 Sep in the restaurant's time zone.
  store.data.orders.find((o) => o.id === old.body.order_id).created_at = '2026-09-20T18:00:00.000Z';

  const day = await call('GET', '/api/stats?date=2026-09-20');
  assert.equal(day.body.orders, 1);
  assert.equal(day.body.new, 1);
  assert.equal(day.body.all_time_orders, 2);
  const list = await call('GET', '/api/orders?date=2026-09-20');
  assert.deepEqual(list.body.orders.map((o) => o.customer_name), ['Last week']);
  assert.equal((await call('GET', '/api/orders?date=2026-09-21')).body.orders.length, 0);
  assert.equal((await call('GET', '/api/orders')).body.orders.length, 2);
  assert.equal((await call('GET', '/api/stats?date=20-09-2026')).status, 400);
});

test('CSV export covers the date range, oldest first, with safe cells', async (t) => {
  const { server, store } = await startServer();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const place = (body) =>
    fetch(`${base}/api/tools/place_order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const a = await place({ customer_name: '=HYPERLINK("x")', customer_phone: '+919800000000', order_items: '2 x Veg Biryani, 1 Raita' });
  const b = await place({ customer_name: 'Asha, R', order_items: '1 Mango Lassi' });
  const c = await place({ customer_name: 'Outside range', order_items: '1 Raita' });
  const setDate = (id, iso) => (store.data.orders.find((o) => o.id === id).created_at = iso);
  setDate(a.order_id, '2026-09-21T06:00:00.000Z');
  setDate(b.order_id, '2026-09-20T06:00:00.000Z');
  setDate(c.order_id, '2026-09-23T06:00:00.000Z');

  const res = await fetch(`${base}/api/orders/export?from=2026-09-20&to=2026-09-22`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /orders_2026-09-20_to_2026-09-22\.csv/);
  const lines = (await res.text()).replace(/^\uFEFF/, '').trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^Order ID,Date,Time,Customer,Phone/);
  assert.match(lines[1], /^ORD-1002,2026-09-20,11:30,"Asha, R",/);
  assert.match(lines[2], /^ORD-1001,2026-09-21,11:30,"'=HYPERLINK\(""x""\)",\+919800000000,/);
  assert.match(lines[2], /2 x Veg Biryani; 1 x Raita,3,420,21,441,new/);

  assert.equal((await fetch(`${base}/api/orders/export?from=2026-09-22&to=2026-09-20`)).status, 400);
  assert.equal((await fetch(`${base}/api/orders/export?from=2026-09-20`)).status, 400);
});

test('orders move new -> cooking -> completed and a re-placed order keeps its status', async (t) => {
  const { server, call } = await startServer();
  t.after(() => server.close());
  const placed = await call('POST', '/api/tools/place_order', { call_id: 'k1', order_items: '1 Raita' });
  assert.equal(placed.body.status, 'new');
  assert.equal((await call('PATCH', `/api/orders/${placed.body.id}`, { status: 'cooking' })).body.status, 'cooking');
  const again = await call('POST', '/api/tools/place_order', { call_id: 'k1', order_items: '2 Raita' });
  assert.equal(again.body.status, 'cooking');
  const done = await call('PATCH', `/api/orders/${placed.body.id}`, { status: 'completed' });
  assert.equal(done.body.status, 'completed');
  assert.ok(done.body.completed_at);
});
