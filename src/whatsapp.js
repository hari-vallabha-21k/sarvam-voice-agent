'use strict';

// Sends confirmations through the WhatsApp service (wa-service/, Baileys). That
// service keeps the WhatsApp connection open, which a serverless function can't.
// Without WA_SERVICE_URL the message is only logged, like SMS in development.

// Indian mobile numbers only: "98110 11111", "+91 98110-11111" and "09811011111" all become 919811011111.
function toWhatsAppNumber(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  return null;
}

function orderMessage(config, order) {
  const items = order.items.map((i) => `${i.quantity} x ${i.name}`).join(', ');
  const type = order.order_type === 'delivery' ? 'Delivery' : 'Pickup';
  return [
    `Hi ${order.customer_name || 'there'}, thanks for ordering from ${config.restaurantName}!`,
    `Order ${order.id}: ${items}.`,
    `Total: Rs ${order.total} (incl. GST). ${type}.`,
  ].join('\n');
}

function bookingMessage(config, booking) {
  return [
    `Hi ${booking.customer_name || 'there'}, your table at ${config.restaurantName} is confirmed.`,
    `Booking ${booking.id}: ${booking.party_size} guests on ${booking.booking_date} at ${booking.booking_time}` +
      (booking.table_id ? `, table ${booking.table_id}.` : '.'),
  ].join('\n');
}

async function sendWhatsApp(config, to, text) {
  const number = toWhatsAppNumber(to);
  if (!number) return { ok: false, provider: 'whatsapp', status: 'invalid_number' };
  const { url, secret } = config.whatsapp;
  if (!url) {
    console.log(`[whatsapp:log] to=${number} text=${JSON.stringify(text)}`);
    return { ok: true, provider: 'log', status: 'logged' };
  }
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: number, text }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, provider: 'whatsapp', status: data.error || `http_${res.status}` };
    return { ok: true, provider: 'whatsapp', status: 'sent' };
  } catch (err) {
    return { ok: false, provider: 'whatsapp', status: err.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}

module.exports = { toWhatsAppNumber, orderMessage, bookingMessage, sendWhatsApp };
