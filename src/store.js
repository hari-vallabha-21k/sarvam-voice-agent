'use strict';

// Tiny JSON-file store. Good for a single restaurant on one server; swap for a
// real database when you run more than one instance.

const fs = require('node:fs');
const path = require('node:path');

const EMPTY = () => ({ counters: { order: 1000, booking: 500 }, orders: [], bookings: [], calls: [], sms: [] });
const MAX_CALL_LOG = 500;

class Store {
  constructor(file) {
    this.file = file;
    this.data = EMPTY();
    if (file && fs.existsSync(file)) {
      this.data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  nextId(kind, prefix) {
    this.data.counters[kind] += 1;
    return `${prefix}-${this.data.counters[kind]}`;
  }

  // Orders

  createOrder(fields) {
    const now = new Date().toISOString();
    const order = {
      id: this.nextId('order', 'ORD'),
      status: 'cooking',
      created_at: now,
      updated_at: now,
      completed_at: null,
      ...fields,
    };
    this.data.orders.push(order);
    this.save();
    return order;
  }

  findOrder(id) {
    return this.data.orders.find((o) => o.id === id);
  }

  findOrderByCall(callId) {
    if (!callId) return undefined;
    return this.data.orders.find((o) => o.call_id === callId);
  }

  updateOrder(id, patch) {
    const order = this.findOrder(id);
    if (!order) return null;
    Object.assign(order, patch, { updated_at: new Date().toISOString() });
    this.save();
    return order;
  }

  listOrders({ status, q } = {}) {
    let list = [...this.data.orders];
    if (status) list = list.filter((o) => o.status === status);
    if (q) {
      const needle = q.toLowerCase();
      list = list.filter(
        (o) =>
          o.id.toLowerCase().includes(needle) ||
          (o.customer_name || '').toLowerCase().includes(needle) ||
          (o.customer_phone || '').includes(needle) ||
          o.items.some((it) => it.name.toLowerCase().includes(needle))
      );
    }
    return list.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  // Bookings

  createBooking(fields) {
    const booking = {
      id: this.nextId('booking', 'BKG'),
      status: 'confirmed',
      created_at: new Date().toISOString(),
      ...fields,
    };
    this.data.bookings.push(booking);
    this.save();
    return booking;
  }

  findBookingByCall(callId) {
    if (!callId) return undefined;
    return this.data.bookings.find((b) => b.call_id === callId);
  }

  updateBooking(id, patch) {
    const booking = this.data.bookings.find((b) => b.id === id);
    if (!booking) return null;
    Object.assign(booking, patch);
    this.save();
    return booking;
  }

  listBookings({ date } = {}) {
    let list = [...this.data.bookings];
    if (date) list = list.filter((b) => b.booking_date === date);
    return list.sort((a, b) => `${a.booking_date} ${a.booking_time}`.localeCompare(`${b.booking_date} ${b.booking_time}`));
  }

  // Call log (raw post-call payloads, newest last)

  logCall(entry) {
    this.data.calls.push({ received_at: new Date().toISOString(), ...entry });
    if (this.data.calls.length > MAX_CALL_LOG) this.data.calls.splice(0, this.data.calls.length - MAX_CALL_LOG);
    this.save();
  }

  logSms(entry) {
    this.data.sms.push({ sent_at: new Date().toISOString(), ...entry });
    this.save();
  }
}

module.exports = { Store };
