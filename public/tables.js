'use strict';

(function () {
  const REFRESH_MS = 10000;
  const $ = (id) => document.getElementById(id);

  const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const todayIso = () => isoDay(new Date());

  const state = {
    date: todayIso(),
    time: '', // '' = now
    q: '',
    status: '',
    area: '',
    data: null,
    drawer: null, // { mode: 'table', tableId } | { mode: 'new' }
    lastFocus: null,
  };

  // ---------- Theme ----------

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

  // ---------- Helpers ----------

  async function api(url, opts = {}) {
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
  const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  function clock(t) {
    const m = toMin(t);
    const h = Math.floor(m / 60) % 24;
    const mm = m % 60;
    return `${h % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`;
  }

  const dayLong = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  const stamp = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const prettyDay = (iso) => (iso === todayIso() ? 'today' : dayLong.format(new Date(iso + 'T00:00:00')));

  const STATUS_LABEL = { available: 'Available', reserved: 'Reserved', occupied: 'Occupied' };
  const BOOKING_LABEL = { confirmed: 'Reserved', seated: 'Seated', completed: 'Left', cancelled: 'Cancelled', no_show: 'No show' };
  const BOOKING_CLASS = { confirmed: 'confirmed', seated: 'seated', completed: 'left', cancelled: 'cancelled', no_show: 'no_show' };
  const SOURCE_LABEL = { sarvam_tool: 'Phone call · Sarvam agent', sarvam_call_end: 'Phone call · after the call', staff: 'Front desk' };

  let toastTimer;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3200);
  }

  // Top view of a table with its chairs: one at each end, the rest split along the long sides.
  function tableSvg(table, scale = 1) {
    const perSide = Math.max(1, (table.seats - 2) / 2);
    const chairW = 12, chairH = 6, sideW = 6, sideH = 14, pad = 3, gap = 5;
    const w = Math.max(44, perSide * (chairW + gap) + gap + 4);
    const h = 28;
    const tx = sideW + pad, ty = chairH + pad;
    const W = tx * 2 + w, H = ty * 2 + h;
    const chairs = [];
    for (let i = 0; i < perSide; i++) {
      const x = tx + (w / perSide) * (i + 0.5) - chairW / 2;
      chairs.push(`<rect class="chair" x="${x}" y="0" width="${chairW}" height="${chairH}" rx="2.5"/>`);
      chairs.push(`<rect class="chair" x="${x}" y="${ty + h + pad}" width="${chairW}" height="${chairH}" rx="2.5"/>`);
    }
    chairs.push(`<rect class="chair" x="0" y="${ty + (h - sideH) / 2}" width="${sideW}" height="${sideH}" rx="2.5"/>`);
    chairs.push(`<rect class="chair" x="${W - sideW}" y="${ty + (h - sideH) / 2}" width="${sideW}" height="${sideH}" rx="2.5"/>`);
    return `<svg class="table-svg" viewBox="0 0 ${W} ${H}" width="${W * scale}" height="${H * scale}" aria-hidden="true">
      ${chairs.join('')}
      <rect class="top" x="${tx}" y="${ty}" width="${w}" height="${h}" rx="5"/>
      <text x="${W / 2}" y="${ty + h / 2 + 4}" text-anchor="middle">${esc(table.id)}</text>
    </svg>`;
  }

  // ---------- Toolbar ----------

  $('search').addEventListener('input', (e) => { state.q = e.target.value.trim().toLowerCase(); renderGrid(); });
  $('status-filter').addEventListener('change', (e) => { state.status = e.target.value; renderGrid(); });
  $('area-filter').addEventListener('change', (e) => { state.area = e.target.value; renderGrid(); });

  const dateInput = $('view-date');
  dateInput.value = state.date;
  dateInput.addEventListener('change', () => {
    state.date = dateInput.value || todayIso();
    // "Now" only means something for today; other days open on the dinner service.
    if (state.date !== todayIso() && !state.time) state.time = defaultSlot();
    syncTimeSelect();
    load();
  });
  $('view-time').addEventListener('change', (e) => { state.time = e.target.value; load(); });
  $('view-now').addEventListener('click', () => {
    state.date = todayIso();
    state.time = '';
    dateInput.value = state.date;
    syncTimeSelect();
    load();
  });

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); $('search').focus(); }
    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('search').focus(); }
    if (e.key === 'Escape' && state.drawer) closeDrawer();
  });

  function slots() {
    return state.data ? state.data.slots : [];
  }

  function defaultSlot() {
    const s = slots();
    return s.includes('19:30') ? '19:30' : s[0] || '19:00';
  }

  function syncTimeSelect() {
    const sel = $('view-time');
    const isToday = state.date === todayIso();
    const opts = (isToday ? ['<option value="">Now</option>'] : []).concat(slots().map((t) => `<option value="${t}">${clock(t)}</option>`));
    sel.innerHTML = opts.join('');
    if (state.time && !slots().includes(state.time)) sel.insertAdjacentHTML('beforeend', `<option value="${state.time}">${clock(state.time)}</option>`);
    sel.value = state.time;
  }

  // ---------- Data ----------

  let seq = 0;
  async function load() {
    const mine = ++seq;
    const params = new URLSearchParams({ date: state.date });
    if (state.time) params.set('time', state.time);
    try {
      const data = await api(`/api/tables?${params}`);
      if (mine !== seq) return;
      const firstLoad = !state.data;
      state.data = data;
      if (firstLoad) {
        $('area-filter').insertAdjacentHTML('beforeend', data.areas.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join(''));
        syncTimeSelect();
      }
      render();
      $('live').className = 'live ok';
      $('live-text').textContent = `Live · ${data.is_now ? 'now' : `${prettyDay(data.date)}, ${clock(data.time)}`}`;
    } catch (err) {
      $('live').className = 'live err';
      $('live-text').textContent = 'Offline, retrying…';
    }
  }

  function render() {
    const d = state.data;
    $('sum-available').textContent = d.summary.available;
    $('sum-reserved').textContent = d.summary.reserved;
    $('sum-occupied').textContent = d.summary.occupied;
    renderGrid();
    renderWaiting();
    if (state.drawer) renderDrawer(false);
  }

  // ---------- Grid ----------

  function matches(t) {
    if (state.status && t.status !== state.status) return false;
    if (state.area && t.area !== state.area) return false;
    if (!state.q) return true;
    const hay = [t.id, t.area, t.size, ...t.bookings.flatMap((b) => [b.customer_name, b.customer_phone, b.id])].join(' ').toLowerCase();
    return hay.includes(state.q);
  }

  function guestBlock(t) {
    const b = t.current;
    if (t.status === 'occupied') {
      return `<span class="name">${esc(b.customer_name || 'Walk-in')}</span><span class="meta">Seated · ${esc(b.party_size)} guests · since ${clock(b.booking_time)}</span>`;
    }
    if (t.status === 'reserved') {
      return `<span class="name">${esc(b.customer_name || 'Guest')}</span><span class="meta">${clock(b.booking_time)} · ${esc(b.party_size)} guests · ${esc(b.id)}</span>`;
    }
    if (t.next) return `<span class="soft">Next: ${clock(t.next.booking_time)} · ${esc(t.next.customer_name || 'Guest')} (${esc(t.next.party_size)})</span>`;
    return `<span class="soft">No more bookings ${esc(prettyDay(state.data.date))}</span>`;
  }

  function card(t) {
    const tag = t.current ? clock(t.current.booking_time) : 'Free';
    const label = `Table ${t.id}, ${t.seats} seats, ${STATUS_LABEL[t.status]}${t.current ? `, ${t.current.customer_name || 'guest'} at ${clock(t.current.booking_time)}` : ''}`;
    return `<button type="button" class="tcard ${t.status}" data-table="${esc(t.id)}" aria-label="${esc(label)}">
      <div class="tcard-top">${tableSvg(t)}<span class="pill ${t.status}">${STATUS_LABEL[t.status]}</span></div>
      <div class="tcard-guest">${guestBlock(t)}</div>
      <div class="tcard-foot"><span class="size">${esc(t.size)}</span><span>${esc(t.seats)} Person</span><span class="when-tag">${esc(tag)}</span></div>
    </button>`;
  }

  function renderGrid() {
    if (!state.data) return;
    const list = state.data.tables.filter(matches);
    $('grid').innerHTML = list.map(card).join('');
    $('grid-empty').hidden = list.length > 0;
  }

  $('grid').addEventListener('click', (e) => {
    const c = e.target.closest('.tcard');
    if (c) openDrawer({ mode: 'table', tableId: c.dataset.table }, c);
  });
  $('new-booking').addEventListener('click', (e) => openDrawer({ mode: 'new' }, e.currentTarget));

  // ---------- Waiting for a table ----------

  function renderWaiting() {
    const list = state.data.unassigned;
    $('waiting').hidden = !list.length;
    $('waiting-list').innerHTML = list
      .map((b) => {
        const fits = state.data.tables.filter((t) => t.seats >= (b.party_size || 1));
        return `<li>
          <span class="who">${esc(b.customer_name || 'Guest')}</span>
          <span class="meta">${clock(b.booking_time)} · ${esc(b.party_size || '?')} guests${b.customer_phone ? ' · ' + esc(b.customer_phone) : ''}</span>
          <span class="assign">
            <select class="select select-sm" aria-label="Table for ${esc(b.customer_name || 'guest')}">${fits.map((t) => `<option value="${esc(t.id)}">${esc(t.id)} · ${t.seats} seats</option>`).join('')}</select>
            <button type="button" class="btn" data-assign="${esc(b.id)}">Assign</button>
            <button type="button" class="btn ghost-danger" data-booking="${esc(b.id)}" data-status="cancelled">Cancel</button>
          </span>
        </li>`;
      })
      .join('');
  }

  $('waiting-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-assign]');
    if (!btn) return;
    const table = btn.parentElement.querySelector('select').value;
    btn.disabled = true;
    try {
      await api(`/api/bookings/${encodeURIComponent(btn.dataset.assign)}`, { method: 'PATCH', body: JSON.stringify({ table_id: table }) });
      toast(`Booking moved to table ${table}.`);
    } catch (err) {
      toast(err.message);
    }
    load();
  });

  // ---------- Booking actions (drawer and waiting list) ----------

  const ACTION_TOAST = { seated: 'Guests seated', completed: 'Table is free again', cancelled: 'Booking cancelled', no_show: 'Marked as no show' };

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-booking][data-status]');
    if (!btn) return;
    const status = btn.dataset.status;
    if (status === 'cancelled' && !confirm('Cancel this booking?')) return;
    btn.disabled = true;
    try {
      await api(`/api/bookings/${encodeURIComponent(btn.dataset.booking)}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      toast(ACTION_TOAST[status] || 'Updated');
    } catch (err) {
      toast(`Could not update: ${err.message}`);
    }
    load();
  });

  function actionsFor(b) {
    const id = esc(b.id);
    if (b.status === 'confirmed') {
      return `<button type="button" class="btn busy" data-booking="${id}" data-status="seated">Seat guests</button>
        <button type="button" class="btn" data-booking="${id}" data-status="no_show">No show</button>
        <button type="button" class="btn ghost-danger" data-booking="${id}" data-status="cancelled">Cancel</button>`;
    }
    if (b.status === 'seated') {
      return `<button type="button" class="btn primary" data-booking="${id}" data-status="completed">Free table</button>`;
    }
    return '';
  }

  // ---------- Drawer ----------

  const drawer = $('drawer');
  const form = $('book-form');

  function openDrawer(target, from) {
    state.drawer = target;
    state.lastFocus = from || document.activeElement;
    drawer.hidden = false;
    $('backdrop').hidden = false;
    document.body.style.overflow = 'hidden';
    renderDrawer(true);
    $('drawer-close').focus();
  }

  function closeDrawer() {
    state.drawer = null;
    drawer.hidden = true;
    $('backdrop').hidden = true;
    document.body.style.overflow = '';
    if (state.lastFocus && document.contains(state.lastFocus)) state.lastFocus.focus();
  }

  $('drawer-close').addEventListener('click', closeDrawer);
  $('backdrop').addEventListener('click', closeDrawer);

  function currentTable() {
    return state.drawer && state.drawer.mode === 'table' ? state.data.tables.find((t) => t.id === state.drawer.tableId) : null;
  }

  // resetForm is true when the drawer opens; background refreshes leave the form alone.
  function renderDrawer(resetForm) {
    const t = currentTable();
    drawer.className = `drawer ${t ? t.status : ''}`;
    if (t) {
      $('drawer-head').innerHTML = `${tableSvg(t, 1.35)}<div><h2 id="drawer-title">Table ${esc(t.id)}</h2><p>${esc(t.size[0].toUpperCase() + t.size.slice(1))} · ${t.seats} seats · ${esc(t.area)}</p></div>`;
      $('drawer-current').innerHTML = currentBlock(t);
      $('drawer-day').innerHTML = dayBlock(t);
    } else {
      $('drawer-head').innerHTML = `<div><h2 id="drawer-title">New booking</h2><p>The smallest free table that fits is picked, or choose one.</p></div>`;
      $('drawer-current').innerHTML = '';
      $('drawer-day').innerHTML = '';
    }
    if (resetForm) setupForm(t);
  }

  function currentBlock(t) {
    const when = state.data.is_now ? 'right now' : `at ${clock(state.data.time)} ${prettyDay(state.data.date)}`;
    const b = t.current;
    if (!b) {
      return `<div class="booking-card available">
        <div class="bc-head"><span class="bc-name">Free ${esc(when)}</span><span class="pill available">Available</span></div>
        <p>${t.next ? `Next booking at ${clock(t.next.booking_time)} for ${esc(t.next.customer_name || 'a guest')} (${esc(t.next.party_size)} guests).` : `No more bookings ${esc(prettyDay(state.data.date))}.`}</p>
      </div>`;
    }
    const end = fromMin(toMin(b.booking_time) + state.data.booking_duration_min);
    return `<div class="booking-card ${t.status}">
      <div class="bc-head"><span class="bc-name">${esc(b.customer_name || 'Guest')}</span><span class="pill ${t.status}">${STATUS_LABEL[t.status]}</span></div>
      <dl>
        <dt>Time</dt><dd>${clock(b.booking_time)} – ${clock(end)}, ${esc(prettyDay(b.booking_date))}</dd>
        <dt>Guests</dt><dd>${esc(b.party_size)}</dd>
        ${b.customer_phone ? `<dt>Phone</dt><dd><a href="tel:${esc(b.customer_phone)}">${esc(b.customer_phone)}</a></dd>` : ''}
        <dt>Booking</dt><dd>${esc(b.id)}</dd>
        <dt>Booked via</dt><dd>${esc(SOURCE_LABEL[b.source] || b.source || '–')}</dd>
        <dt>Booked at</dt><dd>${b.created_at ? esc(stamp.format(new Date(b.created_at))) : '–'}</dd>
        ${b.notes ? `<dt>Notes</dt><dd>${esc(b.notes)}</dd>` : ''}
      </dl>
      <div class="bc-actions">${actionsFor(b)}</div>
    </div>`;
  }

  function dayBlock(t) {
    const rows = t.bookings
      .map((b) => {
        const active = b.status === 'confirmed' || b.status === 'seated';
        const isCurrent = t.current && t.current.id === b.id;
        return `<li class="${active ? '' : 'inactive'} ${isCurrent ? 'is-current' : ''}">
          <span class="t">${clock(b.booking_time)}</span>
          <span class="g"><div class="n">${esc(b.customer_name || 'Guest')}</div><div class="m">${esc(b.party_size)} guests · ${esc(b.id)}${b.customer_phone ? ' · ' + esc(b.customer_phone) : ''}</div></span>
          <span class="pill ${BOOKING_CLASS[b.status] || ''}">${esc(BOOKING_LABEL[b.status] || b.status)}</span>
          ${isCurrent ? '' : `<span class="acts">${actionsFor(b)}</span>`}
        </li>`;
      })
      .join('');
    return `<h3>Bookings ${esc(prettyDay(state.data.date))}</h3>${rows ? `<ul class="day-list">${rows}</ul>` : '<p class="muted-note">No bookings for this table.</p>'}`;
  }

  function setupForm(t) {
    form.reset();
    $('form-msg').textContent = '';
    $('form-msg').className = 'form-msg';
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    $('form-title').textContent = t ? `Book table ${t.id}` : 'Guest details';
    form.booking_date.value = state.data.date;
    form.booking_date.min = todayIso();
    form.booking_time.innerHTML = slots().map((s) => `<option value="${s}">${clock(s)}</option>`).join('');
    form.booking_time.value = suggestedTime();
    const maxSeats = t ? t.seats : Math.max(...state.data.tables.map((x) => x.seats));
    form.party_size.max = maxSeats;
    form.party_size.value = Math.min(2, maxSeats);
    $('table-field').hidden = Boolean(t);
    form.table_id.innerHTML = t
      ? `<option value="${esc(t.id)}">${esc(t.id)}</option>`
      : '<option value="">Best free table</option>' + state.data.tables.map((x) => `<option value="${esc(x.id)}">${esc(x.id)} · ${x.seats} seats · ${esc(x.area)}</option>`).join('');
    form.table_id.value = t ? t.id : '';
  }

  // The viewed time if it is a bookable slot, otherwise the next slot from now.
  function suggestedTime() {
    const s = slots();
    if (state.time && s.includes(state.time)) return state.time;
    if (state.data.date === todayIso()) {
      const next = s.find((x) => toMin(x) >= toMin(state.data.time));
      if (next) return next;
    }
    return defaultSlot();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('form-msg');
    const name = form.customer_name;
    if (name.value.trim()) name.removeAttribute('aria-invalid');
    else name.setAttribute('aria-invalid', 'true');
    if (!name.value.trim()) {
      msg.className = 'form-msg err';
      msg.textContent = 'Please enter the guest name.';
      name.focus();
      return;
    }
    const body = Object.fromEntries(new FormData(form));
    body.party_size = Number(body.party_size);
    $('form-submit').disabled = true;
    msg.className = 'form-msg';
    msg.textContent = 'Booking…';
    try {
      const b = await api('/api/bookings', { method: 'POST', body: JSON.stringify(body) });
      toast(`${b.id} confirmed · Table ${b.table_id} · ${clock(b.booking_time)}`);
      // Jump the floor to the booking so staff see the card change colour.
      state.date = b.booking_date;
      state.time = b.booking_time;
      dateInput.value = state.date;
      syncTimeSelect();
      closeDrawer();
      load();
    } catch (err) {
      msg.className = 'form-msg err';
      msg.textContent = err.message;
    } finally {
      $('form-submit').disabled = false;
    }
  });

  load();
  setInterval(load, REFRESH_MS);
})();
