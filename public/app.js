'use strict';

(function () {
  const REFRESH_MS = 5000;
  const state = { status: '', q: '', knownIds: null };
  const $ = (id) => document.getElementById(id);

  // Theme toggle (remembered per browser; storage may be unavailable)
  const root = document.documentElement;
  try {
    const saved = localStorage.getItem('theme');
    if (saved) root.dataset.theme = saved;
  } catch (_) {}
  $('theme-toggle').addEventListener('click', () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('theme', root.dataset.theme); } catch (_) {}
  });

  document.querySelectorAll('.tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      state.status = tab.dataset.status;
      loadOrders();
    })
  );

  let searchTimer;
  $('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = e.target.value.trim();
      loadOrders();
    }, 200);
  });

  $('orders-body').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    btn.disabled = true;
    try {
      await api(`/api/orders/${encodeURIComponent(btn.dataset.id)}`, { method: 'PATCH', body: JSON.stringify({ status: btn.dataset.action }) });
      await refresh();
    } catch (err) {
      alert(`Could not update order: ${err.message}`);
      btn.disabled = false;
    }
  });

  async function api(url, opts = {}) {
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const rupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
  const timeFmt = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });

  function placed(iso) {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return today ? timeFmt.format(d) : `${dayFmt.format(d)}, ${timeFmt.format(d)}`;
  }

  const STATUS_LABEL = { cooking: 'Cooking', completed: 'Completed', cancelled: 'Cancelled', confirmed: 'Confirmed', seated: 'Seated', no_show: 'No show' };

  function orderRow(o, isNew) {
    const dishes = o.items.map((i) => `<li>${esc(i.name)}${i.on_menu === false ? '<span class="off-menu" title="Not matched to the menu">not on menu</span>' : ''}</li>`).join('');
    const qtys = o.items.map((i) => `<li>× ${esc(i.quantity)}</li>`).join('');
    let actions = '';
    if (o.status === 'cooking') {
      actions = `<button class="btn primary" data-action="completed" data-id="${esc(o.id)}">Mark completed</button>
                 <button class="btn" data-action="cancelled" data-id="${esc(o.id)}">Cancel</button>`;
    } else {
      actions = `<button class="btn" data-action="cooking" data-id="${esc(o.id)}">Back to cooking</button>`;
    }
    return `<tr${isNew ? ' class="flash"' : ''}>
      <td data-col="id"><span class="order-id">${esc(o.id)}</span></td>
      <td data-col="customer"><div class="cust-name">${esc(o.customer_name || 'Unknown caller')}</div>${o.customer_phone ? `<div class="cust-phone">${esc(o.customer_phone)}</div>` : ''}</td>
      <td data-col="dish"><ul class="dish-list">${dishes}</ul></td>
      <td data-col="qty" class="num"><ul class="qty-list">${qtys}</ul></td>
      <td data-col="type"><span class="type-tag">${esc(o.order_type || '–')}</span></td>
      <td data-col="total" class="num">${o.total ? rupees.format(o.total) : '–'}</td>
      <td data-col="placed" class="nowrap muted">${esc(placed(o.created_at))}</td>
      <td data-col="status"><span class="pill ${esc(o.status)}">${esc(STATUS_LABEL[o.status] || o.status)}</span></td>
      <td data-col="actions"><div class="actions">${actions}</div></td>
    </tr>`;
  }

  function bookingRow(b) {
    return `<tr>
      <td><span class="order-id">${esc(b.id)}</span></td>
      <td><div class="cust-name">${esc(b.customer_name || 'Unknown caller')}</div>${b.customer_phone ? `<div class="cust-phone">${esc(b.customer_phone)}</div>` : ''}</td>
      <td class="nowrap">${esc(b.booking_date)}</td>
      <td class="nowrap">${esc(b.booking_time)}</td>
      <td class="num">${esc(b.party_size ?? '–')}</td>
      <td><span class="pill ${esc(b.status)}">${esc(STATUS_LABEL[b.status] || b.status)}</span></td>
    </tr>`;
  }

  async function loadStats() {
    const s = await api('/api/stats');
    $('kpi-total').textContent = s.total_orders;
    $('kpi-today').textContent = s.orders_today;
    $('kpi-cooking').textContent = s.cooking;
    $('kpi-completed').textContent = s.completed;
    $('kpi-cancelled').textContent = s.cancelled;
    $('kpi-bookings').textContent = s.upcoming_bookings;
    $('kpi-bookings-today').textContent = s.bookings_today;
    $('kpi-calls').textContent = s.calls_received;
  }

  async function loadOrders() {
    const params = new URLSearchParams();
    if (state.status) params.set('status', state.status);
    if (state.q) params.set('q', state.q);
    const { orders } = await api(`/api/orders?${params}`);
    const first = state.knownIds === null;
    const known = state.knownIds || new Set();
    $('orders-body').innerHTML = orders.map((o) => orderRow(o, !first && !known.has(o.id))).join('');
    $('orders-empty').hidden = orders.length > 0;
    $('orders-empty').textContent = state.status || state.q ? 'No orders match this filter.' : 'No orders yet. They appear here as soon as a Sarvam call ends.';
    state.knownIds = new Set([...known, ...orders.map((o) => o.id)]);
  }

  async function loadBookings() {
    const { bookings } = await api('/api/bookings');
    $('bookings-body').innerHTML = bookings.map(bookingRow).join('');
    $('bookings-empty').hidden = bookings.length > 0;
  }

  async function refresh() {
    const live = $('live');
    try {
      await Promise.all([loadStats(), loadOrders(), loadBookings()]);
      live.className = 'live ok';
      $('live-text').textContent = `Live · updated ${timeFmt.format(new Date())}`;
    } catch (err) {
      live.className = 'live err';
      $('live-text').textContent = 'Offline, retrying…';
    }
  }

  refresh();
  setInterval(refresh, REFRESH_MS);
})();
