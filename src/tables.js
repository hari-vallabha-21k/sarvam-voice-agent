'use strict';

// The restaurant floor. The Supabase migration seeds the same list into the
// "tables" table; the file store uses it directly.
const DEFAULT_TABLES = [
  { id: 'T-01', size: 'small', seats: 4, area: 'Main Hall', sort: 1 },
  { id: 'T-02', size: 'small', seats: 4, area: 'Main Hall', sort: 2 },
  { id: 'T-03', size: 'small', seats: 4, area: 'Main Hall', sort: 3 },
  { id: 'T-04', size: 'medium', seats: 6, area: 'Main Hall', sort: 4 },
  { id: 'T-05', size: 'medium', seats: 6, area: 'Main Hall', sort: 5 },
  { id: 'T-06', size: 'large', seats: 8, area: 'Main Hall', sort: 6 },
  { id: 'T-07', size: 'small', seats: 4, area: 'Patio', sort: 7 },
  { id: 'T-08', size: 'small', seats: 4, area: 'Patio', sort: 8 },
  { id: 'T-09', size: 'medium', seats: 6, area: 'Patio', sort: 9 },
  { id: 'T-10', size: 'medium', seats: 6, area: 'Family Room', sort: 10 },
  { id: 'T-11', size: 'large', seats: 8, area: 'Family Room', sort: 11 },
  { id: 'T-12', size: 'large', seats: 8, area: 'Family Room', sort: 12 },
];

// Booking statuses that hold a table.
const ACTIVE = ['confirmed', 'seated'];

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

// Two bookings clash when their start times are closer than one sitting.
function overlaps(a, b, durationMin) {
  return Math.abs(toMinutes(a) - toMinutes(b)) < durationMin;
}

// Tables that can take `party` guests at `time`, smallest first.
function freeTables(tables, dayBookings, time, party, durationMin) {
  return tables
    .filter((t) => t.seats >= party)
    .filter((t) => !dayBookings.some((b) => b.table_id === t.id && ACTIVE.includes(b.status) && overlaps(b.booking_time, time, durationMin)))
    .sort((a, b) => a.seats - b.seats || a.sort - b.sort);
}

// What a table looks like at `time` on the viewed day:
//   occupied  guests are seated (on today's view they stay until the table is freed)
//   reserved  a confirmed booking's sitting covers this time
//   available otherwise, with the next confirmed booking after `time` if any
function tableState(table, dayBookings, time, { durationMin, isToday }) {
  const mine = dayBookings.filter((b) => b.table_id === table.id).sort((a, b) => a.booking_time.localeCompare(b.booking_time));
  const seated = mine.find((b) => b.status === 'seated' && (isToday || overlaps(b.booking_time, time, durationMin)));
  if (seated) return { status: 'occupied', current: seated, next: null, bookings: mine };
  const reserved = mine.find((b) => b.status === 'confirmed' && overlaps(b.booking_time, time, durationMin));
  if (reserved) return { status: 'reserved', current: reserved, next: null, bookings: mine };
  const next = mine.find((b) => b.status === 'confirmed' && toMinutes(b.booking_time) > toMinutes(time)) || null;
  return { status: 'available', current: null, next, bookings: mine };
}

module.exports = { DEFAULT_TABLES, ACTIVE, toMinutes, overlaps, freeTables, tableState };
