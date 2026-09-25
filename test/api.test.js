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
  assert.equal(res.body.order.status, 'cooking');
  assert.equal(res.body.order.order_type, 'dine-in');
  assert.equal(res.body.order.total, 567); // 540 + 5% GST
  assert.equal(res.body.booking.booking_time, '20:00');

  // Same call delivered twice must not create a second order.
  const again = await call('POST', '/api/sarvam/webhook', { call_id: 'c1', order_items: '3 Veg Biryani' });
  assert.equal(again.body.order.id, 'ORD-1001');

  await call('PATCH', '/api/orders/ORD-1001', { status: 'completed' });
  await call('POST', '/api/sarvam/webhook', { call_id: 'c2', customer_name: 'Asha', order_items: '1 Raita' });

  const stats = await call('GET', '/api/stats');
  assert.equal(stats.body.total_orders, 2);
  assert.equal(stats.body.completed, 1);
  assert.equal(stats.body.cooking, 1);
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

test('table availability and booking respect seat capacity', async (t) => {
  const { server, call } = await startServer({ SEAT_CAPACITY: '10' });
  t.after(() => server.close());
  const ok = await call('POST', '/api/tools/check_table_availability', { booking_date: '2030-01-05', booking_time: '19:30', party_size: 8 });
  assert.equal(ok.body.available, true);
  const booked = await call('POST', '/api/tools/create_booking', { customer_name: 'A', booking_date: '2030-01-05', booking_time: '19:30', party_size: 8 });
  assert.equal(booked.status, 200);
  const full = await call('POST', '/api/tools/check_table_availability', { booking_date: '2030-01-05', booking_time: '20:00', party_size: 4 });
  assert.equal(full.body.available, false);
  assert.ok(full.body.alternative_times.length > 0);
  const closed = await call('POST', '/api/tools/check_table_availability', { booking_date: '2030-01-05', booking_time: '10:00', party_size: 2 });
  assert.equal(closed.body.available, false);
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
  assert.equal(order.status, 'cooking');
  assert.equal(await store.findOrderByCall('c 1'), undefined);
  await store.logSms({ to: '+91', text: 'hi' });

  assert.equal(seen[0].url, 'https://x.supabase.co/rest/v1/orders');
  assert.equal(seen[0].opts.headers['x-app-secret'], 'sec');
  assert.equal(seen[0].opts.headers.Prefer, 'return=representation');
  assert.match(seen[1].url, /call_id=eq\.c%201/);
  assert.equal(JSON.parse(seen[2].opts.body).to_phone, '+91');
});
