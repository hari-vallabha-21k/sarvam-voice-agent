'use strict';

// Orders page: the day's KPIs from /api/stats and its orders from /api/orders,
// refreshed every few seconds so orders from the voice agent appear on their own.
(function () {
  const { $, api, esc, todayIso, addDays, fmt, dayName, placed, phone, SOURCE_LABEL, setLive, toast, emptyState, errorState } = Dash;
  const REFRESH_MS = 5000;

  const params = new URLSearchParams(location.search);
  const state = {
    date: /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '') ? params.get('date') : todayIso(),
    status: '',
    q: params.get('q') || '',
    orders: [],
    stats: null,
    loaded: false,
    failed: false,
    knownIds: null, // ids already seen, so new arrivals can be highlighted
    flashIds: new Set(),
    openId: null,
  };

  const STATUS_LABEL = { new: 'New', cooking: 'Cooking', completed: 'Completed', cancelled: 'Cancelled' };
  const TYPE_LABEL = { delivery: 'Delivery', pickup: 'Pickup', dine_in: 'Dine-in', takeaway: 'Takeaway' };
  const MOVE_TOAST = { cooking: 'is cooking', completed: 'is completed', cancelled: 'was cancelled', new: 'is back to New' };

  // ---------- Day picker ----------

  const dayInput = $('day');
  dayInput.value = state.date;
  dayInput.max = todayIso();
  dayInput.addEventListener('change', () => setDay(dayInput.value || todayIso()));
  $('day-today').addEventListener('click', () => setDay(todayIso()));

  function setDay(date) {
    state.date = date;
    dayInput.value = date;
    state.knownIds = null; // another day's orders are not "new arrivals"
    state.loaded = false;
    renderSkeleton();
    refresh();
  }

  // ---------- Filters ----------

  $('status-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.status = chip.dataset.status;
    document.querySelectorAll('#status-chips .chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    renderOrders();
  });

  const search = $('search');
  search.value = state.q;
  let searchTimer;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = search.value.trim();
      loadOrders().catch(() => {});
    }, 200);
  });
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (e.key === '/' && !typing && !drawer.isOpen) {
      e.preventDefault();
      search.focus();
    }
  });

  // ---------- Status changes ----------

  // The next step for each status, and the way back.
  function actions(o) {
    switch (o.status) {
      case 'new':
        return [{ to: 'cooking', label: 'Start cooking', cls: 'go' }, { to: 'cancelled', label: 'Cancel', cls: '' }];
      case 'cooking':
        return [{ to: 'completed', label: 'Mark completed', cls: 'done' }, { to: 'cancelled', label: 'Cancel', cls: '' }];
      case 'completed':
        return [{ to: 'cooking', label: 'Back to cooking', cls: '' }];
      default:
        return [{ to: 'new', label: 'Restore order', cls: '' }];
    }
  }

  function actionButtons(o) {
    return actions(o)
      .map((a) => `<button type="button" class="${a.cls}" data-id="${esc(o.id)}" data-to="${a.to}">${esc(a.label)}</button>`)
      .join('');
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-to][data-id]');
    if (!btn) return;
    const order = state.orders.find((o) => o.id === btn.dataset.id);
    const next = btn.dataset.to;
    if (!order) return;
    if (next === 'cancelled' && !confirm(`Cancel order ${order.id}?`)) return;
    document.querySelectorAll(`button[data-id="${CSS.escape(order.id)}"]`).forEach((b) => (b.disabled = true));
    const before = order.status;
    moveLocally(order, next); // cards and counts change straight away
    try {
      await api(`/api/orders/${encodeURIComponent(order.id)}`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
      toast(`${order.id} ${MOVE_TOAST[next]}`);
    } catch (err) {
      moveLocally(order, before);
      toast(`Could not update ${order.id}. ${err.message}`, 'err');
    }
    refresh();
  });

  function moveLocally(order, next) {
    const s = state.stats;
    if (s && order.status in s && next in s) {
      s[order.status] -= 1;
      s[next] += 1;
      renderStats();
    }
    order.status = next;
    renderOrders();
  }

  // ---------- CSV export ----------

  const exportForm = $('export-form');
  $('export-toggle').addEventListener('click', (e) => {
    const open = exportForm.hidden;
    exportForm.hidden = !open;
    e.currentTarget.setAttribute('aria-expanded', String(open));
    if (open) {
      $('export-from').value ||= addDays(state.date, -6);
      $('export-to').value ||= state.date;
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
    if (!from || !to || from > to) {
      msg.className = 'export-msg err';
      msg.textContent = 'Pick a start date on or before the end date.';
      return;
    }
    const btn = $('export-submit');
    btn.disabled = true;
    msg.textContent = 'Preparing file…';
    try {
      const res = await fetch(`/api/orders/export?from=${from}&to=${to}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(res.status < 500 && data.error ? data.error : 'The server could not build the file.');
      }
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: `orders_${from}_to_${to}.csv` });
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      msg.textContent = 'Downloaded.';
    } catch (err) {
      msg.className = 'export-msg err';
      msg.textContent = `Could not download. ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- Rendering ----------

  function renderStats() {
    const s = state.stats;
    if (!s) return;
    const isToday = state.date === todayIso();
    $('hero-eyebrow').textContent = isToday ? 'Today, so far' : fmt.dayLong.format(new Date(state.date + 'T00:00:00'));
    $('kpi-orders').textContent = s.orders;
    $('kpi-all-time').textContent = s.all_time_orders;
    $('kpi-new').textContent = s.new;
    $('kpi-cooking').textContent = s.cooking;
    $('kpi-completed').textContent = s.completed;
    $('kpi-cancelled').textContent = s.cancelled;
  }

  function renderSkeleton() {
    const grid = $('orders');
    grid.setAttribute('aria-busy', 'true');
    grid.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><p class="loading-note">Loading orders…</p>';
  }

  function itemsList(o) {
    if (!o.items.length) return '<p class="muted" style="margin:12px 0 0;font-size:13.5px">No dishes recorded</p>';
    return `<ul class="items">${o.items
      .map(
        (i) => `<li><span class="dish">${esc(i.name)}${i.on_menu === false ? '<span class="off-menu">Not on the menu</span>' : ''}</span><span class="qty">× ${esc(i.quantity)}</span></li>`
      )
      .join('')}</ul>`;
  }

  function orderCard(o) {
    const acts = actions(o);
    return `<article class="ocard${o.status === 'cancelled' ? ' is-cancelled' : ''}${state.flashIds.has(o.id) ? ' flash' : ''}">
      <button type="button" class="ocard-open" data-open="${esc(o.id)}" aria-label="View order ${esc(o.id)}">
        <div class="ocard-top"><span class="badge ${esc(o.status)}">${esc(STATUS_LABEL[o.status] || o.status)}</span><span class="ocard-total">${o.total ? fmt.rupees.format(o.total) : ''}</span></div>
        <div class="ocard-id">${esc(o.id)} · ${esc(placed(o.created_at))}</div>
        <div class="ocard-name">${esc(o.customer_name || 'Unknown caller')}</div>
        ${o.customer_phone ? `<div class="ocard-phone">${esc(phone(o.customer_phone))}</div>` : ''}
        ${itemsList(o)}
        ${o.order_type ? `<div class="ocard-meta"><span class="tag">${esc(TYPE_LABEL[o.order_type] || o.order_type)}</span>${o.delivery_address ? `<span>${esc(o.delivery_address)}</span>` : ''}</div>` : ''}
      </button>
      <div class="ocard-actions${acts.length === 1 ? ' single' : ''}">${actionButtons(o)}</div>
    </article>`;
  }

  function visibleOrders() {
    return state.status ? state.orders.filter((o) => o.status === state.status) : state.orders;
  }

  function renderOrders() {
    const grid = $('orders');
    const isToday = state.date === todayIso();
    $('list-title').textContent = isToday ? 'Today’s orders' : `Orders on ${fmt.dayLong.format(new Date(state.date + 'T00:00:00'))}`;
    // Chip counts follow the list on screen, including any search.
    document.querySelectorAll('#status-chips [data-count]').forEach((el) => {
      const k = el.dataset.count;
      el.textContent = k ? state.orders.filter((o) => o.status === k).length : state.orders.length;
    });
    if (!state.loaded) return;
    grid.setAttribute('aria-busy', 'false');
    const list = visibleOrders();
    if (list.length) {
      grid.innerHTML = list.map(orderCard).join('');
    } else if (state.q || state.status) {
      grid.innerHTML = emptyState('Nothing matches', state.q ? `No orders match “${state.q}”.` : `No ${STATUS_LABEL[state.status].toLowerCase()} orders ${isToday ? 'today' : 'on this day'}.`);
    } else if (isToday) {
      grid.innerHTML = emptyState('No orders yet', 'Orders placed through your voice agent will appear here.');
    } else {
      grid.innerHTML = emptyState('No orders on this day', 'Pick another date, or go back to today.');
    }
    if (drawer.isOpen) renderDrawer();
  }

  // ---------- Order drawer ----------

  const panel = $('drawer');
  const drawer = Dash.drawer({ panel, backdrop: $('backdrop'), onClose: () => (state.openId = null) });

  $('orders').addEventListener('click', (e) => {
    const card = e.target.closest('[data-open]');
    if (!card) return;
    state.openId = card.dataset.open;
    renderDrawer(true);
    drawer.open(card);
    panel.querySelector('.drawer-close').focus();
  });
  panel.addEventListener('click', (e) => {
    if (e.target.closest('.drawer-close')) drawer.close();
  });

  // Background refreshes redraw the drawer only when the order changed, so
  // focus inside it is not lost every few seconds.
  let drawerKey = '';
  function renderDrawer(force) {
    const o = state.orders.find((x) => x.id === state.openId);
    const key = JSON.stringify(o || null);
    if (!force && key === drawerKey) return;
    drawerKey = key;
    if (!o) {
      panel.innerHTML = `<div class="drawer-head"><div class="row"><span></span><button type="button" class="drawer-close" aria-label="Close">✕</button></div><h2 class="o-title" id="drawer-title">Order not in this view</h2></div>`;
      return;
    }
    const priced = o.items.some((i) => i.unit_price);
    const lines = o.items
      .map((i) => {
        const line = i.unit_price ? i.unit_price * i.quantity : null;
        return `<li><span class="n">${esc(i.name)}</span><span class="t">${line !== null ? fmt.rupees.format(line) : '–'}</span><span class="p">${esc(i.quantity)} × ${i.unit_price ? fmt.rupees.format(i.unit_price) : 'price not on menu'}</span></li>`;
      })
      .join('');
    const acts = actions(o);
    panel.innerHTML = `
      <div class="drawer-head">
        <div class="row"><span class="badge ${esc(o.status)}">${esc(STATUS_LABEL[o.status] || o.status)}</span><button type="button" class="drawer-close" aria-label="Close">✕</button></div>
        <h2 class="o-title" id="drawer-title">${esc(o.customer_name || 'Unknown caller')}</h2>
        <p class="o-sub">Order ${esc(o.id)}${o.customer_phone ? ` · ${esc(phone(o.customer_phone))}` : ''}</p>
      </div>
      <div class="drawer-body">
        <div class="facts" style="margin-top:0">
          <div><div class="k">Total</div><div class="v big accent">${o.total ? fmt.rupees.format(o.total) : '–'}</div></div>
          <div><div class="k">Order type</div><div class="v big">${esc(TYPE_LABEL[o.order_type] || o.order_type || '–')}</div></div>
          <div><div class="k">Placed</div><div class="v">${esc(fmt.stamp.format(new Date(o.created_at)))}</div></div>
          <div><div class="k">${o.completed_at ? 'Completed' : 'Came from'}</div><div class="v">${o.completed_at ? esc(fmt.stamp.format(new Date(o.completed_at))) : esc(SOURCE_LABEL[o.source] || o.source || '–')}</div></div>
        </div>
        ${o.delivery_address ? `<div class="memo"><span class="label-caps">Deliver to</span>${esc(o.delivery_address)}</div>` : ''}
        <p class="label-caps section-gap">Items</p>
        ${o.items.length ? `<ul class="lines">${lines}</ul>` : '<p class="muted">No dishes recorded.</p>'}
        ${priced ? `<div class="sums"><div><span>Subtotal</span><span>${fmt.rupees.format(o.subtotal)}</span></div><div><span>GST</span><span>${fmt.rupees.format(o.tax)}</span></div><div class="grand"><span>Total</span><span>${fmt.rupees.format(o.total)}</span></div></div>` : ''}
        ${o.notes ? `<div class="memo"><span class="label-caps">Notes</span>${esc(o.notes)}</div>` : ''}
        ${o.call_summary ? `<div class="memo"><span class="label-caps">Call summary</span>${esc(o.call_summary)}</div>` : ''}
      </div>
      <div class="drawer-foot">
        ${acts
          .map((a, i) =>
            i === 0
              ? `<button type="button" class="btn ${a.cls === 'go' ? 'btn-primary btn-big' : a.cls === 'done' ? 'btn-primary btn-big' : 'btn-big'}" data-id="${esc(o.id)}" data-to="${a.to}">${esc(a.label)}</button>`
              : `<button type="button" class="btn btn-quiet" data-id="${esc(o.id)}" data-to="${a.to}" style="height:50px">${esc(a.label)} order</button>`
          )
          .join('')}
      </div>`;
  }

  // ---------- Data ----------

  // Only the latest request may render, so a slow reply for the previous day
  // never overwrites the day just picked.
  let statsSeq = 0;
  let ordersSeq = 0;

  async function loadStats() {
    const seq = ++statsSeq;
    const s = await api(`/api/stats?date=${state.date}`);
    if (seq !== statsSeq) return;
    state.stats = s;
    renderStats();
  }

  async function loadOrders() {
    const seq = ++ordersSeq;
    const q = new URLSearchParams({ date: state.date });
    if (state.q) q.set('q', state.q);
    const { orders } = await api(`/api/orders?${q}`);
    if (seq !== ordersSeq) return;
    noteArrivals(orders);
    state.orders = orders;
    state.loaded = true;
    state.failed = false;
    renderOrders();
  }

  // Highlight orders that arrived since the last refresh, and say so.
  function noteArrivals(orders) {
    const fresh = state.knownIds && !state.q ? orders.filter((o) => !state.knownIds.has(o.id)) : [];
    state.knownIds = new Set([...(state.knownIds || []), ...orders.map((o) => o.id)]);
    state.flashIds = new Set(fresh.map((o) => o.id));
    if (fresh.length === 1) toast(`New order ${fresh[0].id} from ${fresh[0].customer_name || 'a caller'}`);
    else if (fresh.length > 1) toast(`${fresh.length} new orders`);
  }

  async function refresh() {
    try {
      await Promise.all([loadStats(), loadOrders()]);
      setLive(true, `Live · ${fmt.time.format(new Date())}`);
    } catch (err) {
      setLive(false, 'Offline, retrying…');
      if (!state.loaded) {
        state.failed = true;
        $('orders').setAttribute('aria-busy', 'false');
        $('orders').innerHTML = errorState('Unable to load orders.');
      }
    }
  }

  $('orders').addEventListener('click', (e) => {
    if (e.target.closest('[data-retry]')) {
      renderSkeleton();
      refresh();
    }
  });

  renderSkeleton();
  refresh();
  setInterval(() => {
    if (!document.hidden) refresh();
  }, REFRESH_MS);
})();
