'use strict';

(function () {
  const REFRESH_MS = 5000;
  const $ = (id) => document.getElementById(id);

  // YYYY-MM-DD for the browser's local day.
  const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const todayIso = () => isoDay(new Date());

  const state = { status: '', q: '', date: todayIso(), knownIds: null, orders: [], stats: null };

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

  // ---------- Day picker ----------

  const dayInput = $('day');
  dayInput.value = state.date;
  dayInput.max = state.date;
  dayInput.addEventListener('change', () => setDay(dayInput.value || todayIso()));
  $('day-today').addEventListener('click', () => setDay(todayIso()));

  function setDay(date) {
    state.date = date;
    dayInput.value = date;
    state.knownIds = null; // a different day's orders are not "new arrivals"
    refresh();
  }

  // ---------- Filters ----------

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

  // ---------- Status buttons ----------

  // What each button moves an order to, and how the cards change straight away.
  $('orders-body').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const order = state.orders.find((o) => o.id === btn.dataset.id);
    const next = btn.dataset.action;
    btn.closest('.actions').querySelectorAll('button').forEach((b) => (b.disabled = true));
    if (order) applyLocally(order, next);
    try {
      await api(`/api/orders/${encodeURIComponent(btn.dataset.id)}`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
    } catch (err) {
      alert(`Could not update order: ${err.message}`);
    }
    await refresh();
  });

  // Optimistic update: move the order and the card counts before the server replies.
  function applyLocally(order, next) {
    const s = state.stats;
    if (s && order.status in s && next in s) {
      s[order.status] -= 1;
      s[next] += 1;
      renderStats(s);
    }
    order.status = next;
    renderOrders(state.orders);
  }

  // ---------- CSV export ----------

  const exportForm = $('export-form');
  $('export-toggle').addEventListener('click', (e) => {
    const open = exportForm.hidden;
    exportForm.hidden = !open;
    e.currentTarget.setAttribute('aria-expanded', String(open));
    if (open) {
      const to = state.date;
      const from = new Date(to + 'T00:00:00');
      from.setDate(from.getDate() - 6);
      $('export-from').value ||= isoDay(from);
      $('export-to').value ||= to;
      $('export-from').max = $('export-to').max = todayIso();
      $('export-from').focus();
    }
  });

  exportForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const from = $('export-from').value;
    const to = $('export-to').value;
    const msg = $('export-msg');
    msg.className = 'export-msg';
    if (from > to) {
      msg.className = 'export-msg err';
      msg.textContent = 'The start date must be on or before the end date.';
      return;
    }
    const btn = $('export-submit');
    btn.disabled = true;
    msg.textContent = 'Preparing file…';
    try {
      const res = await fetch(`/api/orders/export?from=${from}&to=${to}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: `orders_${from}_to_${to}.csv` });
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      msg.textContent = 'Downloaded.';
    } catch (err) {
      msg.className = 'export-msg err';
      msg.textContent = `Could not download: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- Rendering ----------

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
  const longDayFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

  function placed(iso) {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return today ? timeFmt.format(d) : `${dayFmt.format(d)}, ${timeFmt.format(d)}`;
  }

  const STATUS_LABEL = { new: 'New', cooking: 'Cooking', completed: 'Completed', cancelled: 'Cancelled' };

  function actionButtons(o) {
    const id = esc(o.id);
    const cancel = `<button class="btn" data-action="cancelled" data-id="${id}">Cancel</button>`;
    switch (o.status) {
      case 'new':
        return `<button class="btn start" data-action="cooking" data-id="${id}">Start cooking</button>${cancel}`;
      case 'cooking':
        return `<button class="btn primary" data-action="completed" data-id="${id}">Mark completed</button>${cancel}`;
      case 'completed':
        return `<button class="btn" data-action="cooking" data-id="${id}">Back to cooking</button>`;
      default:
        return `<button class="btn" data-action="new" data-id="${id}">Restore</button>`;
    }
  }

  function orderRow(o, isNew) {
    const dishes = o.items.map((i) => `<li>${esc(i.name)}${i.on_menu === false ? '<span class="off-menu" title="Not matched to the menu">not on menu</span>' : ''}</li>`).join('');
    const qtys = o.items.map((i) => `<li>× ${esc(i.quantity)}</li>`).join('');
    return `<tr${isNew ? ' class="flash"' : ''}>
      <td data-col="id"><span class="order-id">${esc(o.id)}</span></td>
      <td data-col="customer"><div class="cust-name">${esc(o.customer_name || 'Unknown caller')}</div>${o.customer_phone ? `<div class="cust-phone">${esc(o.customer_phone)}</div>` : ''}</td>
      <td data-col="dish"><ul class="dish-list">${dishes}</ul></td>
      <td data-col="qty" class="num"><ul class="qty-list">${qtys}</ul></td>
      <td data-col="type"><span class="type-tag">${esc(o.order_type || '–')}</span></td>
      <td data-col="total" class="num">${o.total ? rupees.format(o.total) : '–'}</td>
      <td data-col="placed" class="nowrap muted">${esc(placed(o.created_at))}</td>
      <td data-col="status"><span class="pill ${esc(o.status)}">${esc(STATUS_LABEL[o.status] || o.status)}</span></td>
      <td data-col="actions"><div class="actions">${actionButtons(o)}</div></td>
    </tr>`;
  }

  function renderStats(s) {
    $('kpi-orders').textContent = s.orders;
    $('kpi-all-time').textContent = s.all_time_orders;
    $('kpi-new').textContent = s.new;
    $('kpi-cooking').textContent = s.cooking;
    $('kpi-completed').textContent = s.completed;
    $('kpi-cancelled').textContent = s.cancelled;
  }

  // Only the latest request for a view may render, so a slow reply for the
  // previous day never overwrites the day just picked.
  let statsSeq = 0;
  let ordersSeq = 0;

  async function loadStats() {
    const seq = ++statsSeq;
    const s = await api(`/api/stats?date=${state.date}`);
    if (seq !== statsSeq) return;
    state.stats = s;
    renderStats(s);
  }

  function renderOrders(orders) {
    const first = state.knownIds === null;
    const known = state.knownIds || new Set();
    const visible = state.status ? orders.filter((o) => o.status === state.status) : orders;
    $('orders-body').innerHTML = visible.map((o) => orderRow(o, !first && !known.has(o.id))).join('');
    $('orders-empty').hidden = visible.length > 0;
    const isToday = state.date === todayIso();
    $('orders-empty').textContent =
      state.status || state.q
        ? 'No orders match this filter.'
        : isToday
          ? 'No orders yet today. They appear here as soon as a caller places one.'
          : 'No orders on this day.';
    $('orders-day').textContent = `· ${isToday ? 'Today' : longDayFmt.format(new Date(state.date + 'T00:00:00'))}`;
    state.knownIds = new Set([...known, ...orders.map((o) => o.id)]);
  }

  async function loadOrders() {
    const seq = ++ordersSeq;
    const params = new URLSearchParams({ date: state.date });
    if (state.q) params.set('q', state.q);
    const { orders } = await api(`/api/orders?${params}`);
    if (seq !== ordersSeq) return;
    state.orders = orders;
    renderOrders(orders);
  }

  async function refresh() {
    const live = $('live');
    try {
      await Promise.all([loadStats(), loadOrders()]);
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
