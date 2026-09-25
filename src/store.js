'use strict';

// Tiny JSON-file store for local development and tests. Production uses
// SupabaseStore (src/supabase-store.js), which has the same async interface.

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_TABLES, ACTIVE, overlaps } = require('./tables');

const EMPTY = () => ({ counters: { order: 1000, booking: 500 }, tables: DEFAULT_TABLES.map((t) => ({ ...t })), orders: [], bookings: [], calls: [], sms: [] });
const MAX_CALL_LOG = 500;

class Store {
  constructor(file, { bookingDurationMin = 90 } = {}) {
    this.file = file;
    this.bookingDurationMin = bookingDurationMin;
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

  async createOrder(fields) {
    const now = new Date().toISOString();
    const order = {
      id: this.nextId('order', 'ORD'),
      status: 'new',
      created_at: now,
      updated_at: now,
      completed_at: null,
      ...fields,
    };
    this.data.orders.push(order);
    this.save();
    return order;
  }

  async findOrder(id) {
    return this.data.orders.find((o) => o.id === id);
  }

  async findOrderByCall(callId) {
    if (!callId) return undefined;
    return this.data.orders.find((o) => o.call_id === callId);
  }

  async updateOrder(id, patch) {
    const order = await this.findOrder(id);
    if (!order) return null;
    Object.assign(order, patch, { updated_at: new Date().toISOString() });
    this.save();
    return order;
  }

  // from / to are Date bounds on created_at (to is exclusive).
  async listOrders({ status, q, from, to } = {}) {
    let list = [...this.data.orders];
    if (status) list = list.filter((o) => o.status === status);
    if (from) list = list.filter((o) => new Date(o.created_at) >= from);
    if (to) list = list.filter((o) => new Date(o.created_at) < to);
    if (q) list = list.filter((o) => matchesQuery(o, q));
    return list.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  // Tables

  async listTables() {
    return this.data.tables.filter((t) => t.active !== false).sort((a, b) => a.sort - b.sort);
  }

  // Bookings

  async createBooking(fields) {
    const booking = {
      id: null,
      status: 'confirmed',
      table_id: null,
      created_at: new Date().toISOString(),
      ...fields,
    };
    this.assertTableFree(booking);
    booking.id = this.nextId('booking', 'BKG');
    this.data.bookings.push(booking);
    this.save();
    return booking;
  }

  // Same rule as the database trigger: one active booking per table per sitting.
  assertTableFree(booking) {
    if (!booking.table_id || !ACTIVE.includes(booking.status)) return;
    const clash = this.data.bookings.some(
      (b) =>
        b.id !== booking.id &&
        b.table_id === booking.table_id &&
        b.booking_date === booking.booking_date &&
        ACTIVE.includes(b.status) &&
        overlaps(b.booking_time, booking.booking_time, this.bookingDurationMin)
    );
    if (clash) throw tableTaken();
  }

  async findBooking(id) {
    return this.data.bookings.find((b) => b.id === id);
  }

  async findBookingByCall(callId) {
    if (!callId) return undefined;
    return this.data.bookings.find((b) => b.call_id === callId);
  }

  async updateBooking(id, patch) {
    const booking = this.data.bookings.find((b) => b.id === id);
    if (!booking) return null;
    this.assertTableFree({ ...booking, ...patch });
    Object.assign(booking, patch, { updated_at: new Date().toISOString() });
    this.save();
    return booking;
  }

  async listBookings({ date } = {}) {
    let list = [...this.data.bookings];
    if (date) list = list.filter((b) => b.booking_date === date);
    return list.sort((a, b) => `${a.booking_date} ${a.booking_time}`.localeCompare(`${b.booking_date} ${b.booking_time}`));
  }

  // Call log (raw post-call payloads, newest last)

  async logCall(entry) {
    this.data.calls.push({ received_at: new Date().toISOString(), ...entry });
    if (this.data.calls.length > MAX_CALL_LOG) this.data.calls.splice(0, this.data.calls.length - MAX_CALL_LOG);
    this.save();
  }

  async recentCalls(limit) {
    return this.data.calls.slice(-limit).reverse().map(({ payload, ...rest }) => rest);
  }

  async logSms(entry) {
    this.data.sms.push({ sent_at: new Date().toISOString(), ...entry });
    this.save();
  }

  // Dashboard KPIs for one day. `date` is YYYY-MM-DD in the restaurant's time zone.
  async stats({ date, timeZone }) {
    const all = this.data.orders;
    const day = all.filter((o) => localDate(new Date(o.created_at), timeZone) === date);
    const count = (s) => day.filter((o) => o.status === s).length;
    return {
      date,
      orders: day.length,
      new: count('new'),
      cooking: count('cooking'),
      completed: count('completed'),
      cancelled: count('cancelled'),
      all_time_orders: all.length,
    };
  }
}

function localDate(d, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// Shared by both stores so search behaves the same everywhere.
function matchesQuery(order, q) {
  const needle = q.toLowerCase();
  return (
    order.id.toLowerCase().includes(needle) ||
    (order.customer_name || '').toLowerCase().includes(needle) ||
    (order.customer_phone || '').includes(needle) ||
    order.items.some((it) => it.name.toLowerCase().includes(needle))
  );
}

function tableTaken() {
  const err = new Error('That table is already booked for this time.');
  err.status = 409;
  err.code = 'table_taken';
  return err;
}

module.exports = { Store, localDate, matchesQuery, tableTaken };
