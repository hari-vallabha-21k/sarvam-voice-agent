'use strict';

// Helpers that turn whatever the Sarvam voice agent sends into plain values.
//
// The post-call webhook body is a template we configure on the agent
// (see sarvam/agent-setup.md), but the platform can also wrap agent variables
// as { name, value } objects or nest them under agent_variables / variables /
// data. Everything here is tolerant of those shapes so a template tweak on the
// Sarvam side never silently drops an order.

const { findMenuItem, GST_RATE } = require('./menu');

const WORD_NUMBERS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12,
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5,
};

const CONTAINER_KEYS = ['agent_variables', 'variables', 'data', 'payload', 'interaction', 'call', 'extracted_variables'];

function unwrap(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) return v.value;
  return v;
}

// Flattens the body into one lookup of variable name -> value. Outer keys win
// over nested ones only when the outer value is non-empty.
function extractVariables(body) {
  const out = {};
  const visit = (obj, depth) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 3) return;
    for (const [k, raw] of Object.entries(obj)) {
      if (CONTAINER_KEYS.includes(k) && raw && typeof raw === 'object' && !Array.isArray(raw)) continue;
      const v = unwrap(raw);
      if (isEmpty(out[k]) && !isEmpty(v)) out[k] = v;
    }
    for (const k of CONTAINER_KEYS) {
      const inner = obj[k];
      if (Array.isArray(inner)) {
        // [{ name: 'customer_name', value: 'Asha' }, ...]
        for (const item of inner) {
          if (item && item.name && isEmpty(out[item.name]) && !isEmpty(item.value)) out[item.name] = item.value;
        }
      } else {
        visit(inner, depth + 1);
      }
    }
  };
  visit(body, 0);
  return out;
}

function isEmpty(v) {
  // An unrendered "{{variable}}" placeholder counts as empty too.
  return v === undefined || v === null || (typeof v === 'string' && (v.trim() === '' || /^\{\{.*\}\}$/.test(v.trim())));
}

function pick(vars, ...keys) {
  for (const k of keys) {
    if (!isEmpty(vars[k])) return typeof vars[k] === 'string' ? vars[k].trim() : vars[k];
  }
  return undefined;
}

function toQuantity(q) {
  if (typeof q === 'number' && Number.isFinite(q)) return Math.max(1, Math.round(q));
  const s = String(q || '').trim().toLowerCase();
  if (/^\d+$/.test(s)) return Math.max(1, parseInt(s, 10));
  return WORD_NUMBERS[s] || 1;
}

function buildItem(name, quantity) {
  const menuItem = findMenuItem(name);
  const qty = toQuantity(quantity);
  return {
    name: menuItem ? menuItem.name : String(name).trim(),
    quantity: qty,
    unit_price: menuItem ? menuItem.price : null,
    on_menu: Boolean(menuItem),
  };
}

// Accepts:
//   [{ name: 'Veg Biryani', quantity: 2 }]           (tool / JSON payloads)
//   '[{"item":"Veg Biryani","qty":2}]'                 (JSON in a string variable)
//   '2 x Veg Biryani, Butter Naan x 3 and one Raita'   (free text summary)
function parseOrderItems(input) {
  if (isEmpty(input)) return [];
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        return parseOrderItems(JSON.parse(trimmed));
      } catch (_) {
        // fall through to free-text parsing
      }
    }
    return parseFreeText(trimmed);
  }
  if (!Array.isArray(input)) input = [input];
  return mergeDuplicates(
    input
      .map((it) => {
        if (typeof it === 'string') return parseFreeText(it);
        if (!it || typeof it !== 'object') return [];
        const name = it.name || it.item || it.dish || it.dish_name || it.item_name || it.title;
        if (isEmpty(name)) return [];
        return [buildItem(name, it.quantity ?? it.qty ?? it.count ?? 1)];
      })
      .flat()
  );
}

function parseFreeText(text) {
  const parts = text
    .split(/,|;|\n|\band\b|\bplus\b|&|\+/i)
    .map((p) => p.trim())
    .filter(Boolean);
  const items = [];
  for (let part of parts) {
    part = part.replace(/^[-*•\d]+[.)]\s+/, '').trim(); // list bullets like "1. " or "- "
    let m;
    let name;
    let qty = 1;
    if ((m = part.match(/^(\d+|[a-z]+)\s*(?:x|×|\*|nos?\.?|pcs?\.?|plates?|of)?\s+(.+)$/i)) && (/^\d+$/.test(m[1]) || WORD_NUMBERS[m[1].toLowerCase()])) {
      qty = toQuantity(m[1]);
      name = m[2];
    } else if ((m = part.match(/^(.+?)\s*(?:x|×|\*|-|:|qty|quantity)\s*(\d+)$/i)) || (m = part.match(/^(.+?)\s+\(?(\d+)\)?$/))) {
      name = m[1];
      qty = toQuantity(m[2]);
    } else {
      name = part;
    }
    name = name.replace(/^(of|plates? of)\s+/i, '').trim();
    if (name) items.push(buildItem(name, qty));
  }
  return mergeDuplicates(items);
}

function mergeDuplicates(items) {
  const map = new Map();
  for (const it of items) {
    const key = it.name.toLowerCase();
    if (map.has(key)) map.get(key).quantity += it.quantity;
    else map.set(key, { ...it });
  }
  return [...map.values()];
}

function computeTotals(items) {
  const subtotal = items.reduce((sum, it) => sum + (it.unit_price || 0) * it.quantity, 0);
  const tax = Math.round(subtotal * GST_RATE);
  return { subtotal, tax, total: subtotal + tax };
}

function normalizeOrderType(v) {
  const s = String(v || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!s || s === 'none') return null;
  if (['dinein', 'dine', 'table', 'eatin'].includes(s)) return 'dine-in';
  if (['takeaway', 'takeout', 'pickup', 'parcel', 'collect'].includes(s)) return 'takeaway';
  if (['delivery', 'homedelivery', 'deliver'].includes(s)) return 'delivery';
  return s;
}

function toPartySize(v) {
  if (isEmpty(v)) return null;
  const n = toQuantity(v);
  return Number.isFinite(n) ? n : null;
}

// Pulls the fields the restaurant cares about out of a Sarvam payload.
function normalizeCall(body) {
  const vars = extractVariables(body || {});
  return {
    call_id: pick(vars, 'call_id', 'interaction_id', 'session_id', 'conversation_id', 'callSid', 'call_sid', 'id'),
    order_id: pick(vars, 'order_id'),
    booking_id: pick(vars, 'booking_id'),
    customer_name: pick(vars, 'customer_name', 'user_name', 'caller_name'),
    customer_phone: pick(vars, 'customer_phone', 'phone', 'phone_number', 'user_phone', 'user_identifier', 'from', 'caller_number'),
    order_items: parseOrderItems(pick(vars, 'order_items', 'items', 'order_details', 'order')),
    order_type: normalizeOrderType(pick(vars, 'order_type')),
    delivery_address: pick(vars, 'delivery_address', 'address'),
    booking_date: pick(vars, 'booking_date'),
    booking_time: pick(vars, 'booking_time'),
    party_size: toPartySize(pick(vars, 'party_size', 'guests', 'people')),
    notes: pick(vars, 'notes', 'special_instructions'),
    call_summary: pick(vars, 'call_summary', 'summary'),
    disposition: pick(vars, 'disposition', 'outcome'),
    agent_id: pick(vars, 'app_id', 'agent_id'),
  };
}

module.exports = { extractVariables, parseOrderItems, computeTotals, normalizeCall, normalizeOrderType, toPartySize };
