'use strict';

// Tables page: the floor at one moment from /api/tables, the day's
// reservations, and staff bookings through /api/bookings.
(function () {
  const { $, api, esc, todayIso, addDays, toMin, clock, fmt, dayName, phone, SOURCE_LABEL, setLive, toast, emptyState, errorState } = Dash;
  const REFRESH_MS = 10000;
  const ACTIVE = ['confirmed', 'seated'];

  const state = {
    date: todayIso(),
    time: '', // '' = now
    q: '',
    status: '',
    area: '',
    view: 'floor',
    data: null,
    failed: false,
    drawer: null, // { mode: 'table', tableId } | { mode: 'new' }
    formOpen: false, // booking form on a reserved or occupied table
    form: { day: '', slot: '', pax: 2 },
    dayCache: new Map(), // date -> /api/tables for that day, used to grey out taken times
    flashTable: null,
  };

  const STATUS_LABEL = { available: 'Available', reserved: 'Reserved', occupied: 'Occupied' };
  const BOOKING_LABEL = { confirmed: 'Reserved', seated: 'Seated', completed: 'Left', cancelled: 'Cancelled', no_show: 'No show' };
  const BOOKING_CLASS = { confirmed: 'confirmed', seated: 'seated', completed: 'left', cancelled: 'cancelled', no_show: 'no_show' };
  const ACTION_TOAST = { seated: 'Guests seated', completed: 'Table is free again', cancelled: 'Booking cancelled', no_show: 'Marked as no show' };
  // Each reservation gets its own colour so neighbouring bookings are easy to tell apart.
  const PALETTE = ['#C68A2E', '#2E6E73', '#7A3E6B', '#3D5A8A', '#B5475C', '#6F7A2E', '#A3542A', '#4F4A8C'];

  // ---------- Colours and drawing ----------

  const isDark = () => getComputedStyle(document.documentElement).colorScheme === 'dark';

  function mix(hex, t, base) {
    const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const a = p(hex);
    const b = p(base);
    return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
  }

  function bookingColor(b) {
    let h = 0;
    for (const ch of String(b.id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  // CSS variables for a table card in its current state.
  function look(t) {
    if (t.status === 'available') return {};
    if (t.status === 'occupied') {
      return {
        '--tc-floor': 'var(--brand-soft)', '--tc-top': '#9D1C20', '--tc-chair': isDark() ? '#7a3a33' : '#E3A095',
        '--tc-ink': 'var(--brand-ink)', '--tc-pill-bg': '#9D1C20', '--tc-pill-fg': '#FCFAF5',
        '--tc-border': isDark() ? '#5a2a27' : '#EBC4BC', '--tc-plate': '#C69A4B', '--tc-note': 'var(--brand-ink)',
      };
    }
    const c = bookingColor(t.current);
    const base = isDark() ? '#211d18' : '#ffffff';
    const ink = isDark() ? mix(c, 0.4, '#ffffff') : c;
    return {
      '--tc-floor': mix(c, 0.86, base), '--tc-top': c, '--tc-chair': mix(c, 0.55, base), '--tc-ink': ink,
      '--tc-pill-bg': c, '--tc-pill-fg': '#FFFFFF', '--tc-border': mix(c, 0.6, base), '--tc-plate': mix(c, 0.7, '#ffffff'), '--tc-note': ink,
    };
  }

  const styleVars = (vars) => Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');

  // Top view: chairs along the long sides, one at each end, a plate at every seat.
  function tableDrawing(seats) {
    const g = seats <= 2 ? { tw: 58, th: 58, top: 0, round: true } : seats <= 4 ? { tw: 64, th: 64, top: 1 } : seats <= 6 ? { tw: 104, th: 62, top: 2 } : { tw: 140, th: 62, top: 3 };
    const parts = [];
    const plates = [];
    for (let i = 0; i < g.top; i++) {
      const cx = 17 + (g.tw * (i + 0.5)) / g.top;
      parts.push(`<span class="chair" style="left:${cx - 11}px;top:0;width:22px;height:12px;border-radius:8px 8px 3px 3px"></span>`);
      parts.push(`<span class="chair" style="left:${cx - 11}px;top:${g.th + 22}px;width:22px;height:12px;border-radius:3px 3px 8px 8px"></span>`);
      plates.push(`<span class="plate" style="left:${cx - 24}px;top:5px"></span>`, `<span class="plate" style="left:${cx - 24}px;top:${g.th - 19}px"></span>`);
    }
    const midY = 17 + g.th / 2 - 11;
    parts.push(`<span class="chair" style="left:0;top:${midY}px;width:12px;height:22px;border-radius:8px 3px 3px 8px"></span>`);
    parts.push(`<span class="chair" style="left:${g.tw + 22}px;top:${midY}px;width:12px;height:22px;border-radius:3px 8px 8px 3px"></span>`);
    plates.push(`<span class="plate" style="left:6px;top:${g.th / 2 - 7}px"></span>`, `<span class="plate" style="left:${g.tw - 20}px;top:${g.th / 2 - 7}px"></span>`);
    return `<div class="tdraw" style="width:${g.tw + 34}px;height:${g.th + 34}px" aria-hidden="true">${parts.join('')}<div class="top" style="width:${g.tw}px;height:${g.th}px;border-radius:${g.round ? '50%' : '12px'}">${plates.join('')}</div></div>`;
  }

  const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
  const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

  // ---------- Toolbar ----------

  $('search').addEventListener('input', (e) => { state.q = e.target.value.trim().toLowerCase(); renderViews(); });
  $('status-filter').addEventListener('change', (e) => setStatus(e.target.value));
  $('area-filter').addEventListener('change', (e) => { state.area = e.target.value; renderViews(); });
  document.querySelectorAll('.sum-card').forEach((b) =>
    b.addEventListener('click', () => setStatus(state.status === b.dataset.sum ? '' : b.dataset.sum))
  );

  function setStatus(s) {
    state.status = s;
    $('status-filter').value = s;
    document.querySelectorAll('.sum-card').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sum === s)));
    renderViews();
  }

  $('view-switch').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    state.view = b.dataset.view;
    document.querySelectorAll('#view-switch button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $('floor').hidden = state.view !== 'floor';
    $('list').hidden = state.view !== 'list';
    // Reservations are per booking, so the table status filter does not apply there.
    $('status-filter').hidden = state.view === 'list';
    // The list covers the whole day, so the time picker only matters on the floor plan.
    $('view-time').parentElement.hidden = state.view === 'list';
    renderViews();
  });

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
  $('new-booking').addEventListener('click', (e) => openDrawer({ mode: 'new' }, e.currentTarget));

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (e.key === '/' && !typing && !drawer.isOpen) { e.preventDefault(); $('search').focus(); }
  });

  // Redraw the reservation colours when the theme changes.
  $('theme-toggle').addEventListener('click', () => setTimeout(renderViews));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderViews);

  const slots = () => (state.data ? state.data.slots : []);
  const defaultSlot = () => (slots().includes('19:30') ? '19:30' : slots()[0] || '19:00');

  function syncTimeSelect() {
    const sel = $('view-time');
    const isToday = state.date === todayIso();
    const opts = (isToday ? ['<option value="">Now</option>'] : []).concat(slots().map((t) => `<option value="${t}">${clock(t)}</option>`));
    sel.innerHTML = opts.join('');
    if (state.time && !slots().includes(state.time)) sel.insertAdjacentHTML('beforeend', `<option value="${state.time}">${clock(state.time)}</option>`);
    sel.value = state.time;
    $('view-now').hidden = isToday && !state.time;
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
      const first = !state.data;
      state.data = data;
      state.failed = false;
      state.dayCache.set(data.date, data);
      if (first) {
        $('area-filter').insertAdjacentHTML('beforeend', data.areas.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join(''));
        syncTimeSelect();
      }
      render();
      setLive(true, `Live · ${fmt.time.format(new Date())}`);
    } catch (err) {
      if (mine !== seq) return;
      setLive(false, 'Offline, retrying…');
      if (!state.data) {
        state.failed = true;
        $('floor').setAttribute('aria-busy', 'false');
        $('floor').innerHTML = errorState('Unable to load tables.');
      }
    }
  }

  function renderSkeleton() {
    $('floor').innerHTML = `<div class="area-head"><h2 class="skeleton" style="width:160px;height:32px;border-radius:10px"></h2></div>
      <div class="tgrid">${'<div class="skeleton"></div>'.repeat(4)}<p class="loading-note">Loading tables…</p></div>`;
  }

  function render() {
    const d = state.data;
    const when = d.is_now ? 'right now' : `${dayName(d.date)}, ${clock(d.time)}`;
    $('floor-when').textContent = `Floor · ${when}`;
    $('sum-available').textContent = d.summary.available;
    $('sum-reserved').textContent = d.summary.reserved;
    $('sum-occupied').textContent = d.summary.occupied;
    $('sub-available').textContent = d.is_now ? 'free right now' : `free at ${clock(d.time)}`;
    $('sub-reserved').textContent = d.is_now ? 'booked for now' : `booked at ${clock(d.time)}`;
    renderViews();
    renderWaiting();
    if (drawer.isOpen) renderDrawer(false);
  }

  function renderViews() {
    if (!state.data) return;
    if (state.view === 'floor') renderFloor();
    else renderList();
  }

  // ---------- Floor plan ----------

  function matches(t) {
    if (state.status && t.status !== state.status) return false;
    if (state.area && t.area !== state.area) return false;
    if (!state.q) return true;
    const hay = [t.id, t.area, t.size, ...t.bookings.flatMap((b) => [b.customer_name, b.customer_phone, b.id])].join(' ').toLowerCase();
    return hay.includes(state.q);
  }

  function card(t) {
    const b = t.current;
    const d = state.data;
    let note;
    if (t.status === 'occupied') note = `Seated ${clock(b.booking_time)} · ${b.customer_name || 'Guest'}`;
    else if (t.status === 'reserved') note = `${clock(b.booking_time)} · ${b.customer_name || 'Guest'}`;
    else if (t.next) note = `Free · next ${clock(t.next.booking_time)}, ${t.next.customer_name || 'guest'}`;
    else note = d.is_now ? 'Free now' : `Free at ${clock(d.time)}`;
    const label = `Table ${t.id}, ${t.seats} seats, ${STATUS_LABEL[t.status]}. ${note}`;
    return `<button type="button" class="tcard${state.flashTable === t.id ? ' flash' : ''}" data-table="${esc(t.id)}" style="${styleVars(look(t))}" aria-label="${esc(label)}">
      <div class="tfloor"><span class="tid">${esc(t.id)}</span><span class="tpill">${STATUS_LABEL[t.status]}</span>${tableDrawing(t.seats)}</div>
      <div class="tinfo">
        <div class="tnote">${esc(note)}</div>
        <div class="tfoot"><span class="size">${esc(t.size)}</span><span>${esc(t.seats)} seats</span><span class="when">${b ? `${esc(b.party_size)} guests` : '—'}</span></div>
      </div>
    </button>`;
  }

  function renderFloor() {
    const el = $('floor');
    el.setAttribute('aria-busy', 'false');
    const shown = state.data.tables.filter(matches);
    if (!shown.length) {
      el.innerHTML = emptyState('No tables match', 'Try another area or status, or clear the search.');
      return;
    }
    el.innerHTML = state.data.areas
      .map((area) => {
        const list = shown.filter((t) => t.area === area);
        if (!list.length) return '';
        const all = state.data.tables.filter((t) => t.area === area);
        const free = all.filter((t) => t.status === 'available').length;
        return `<div class="area-head"><h2>${esc(area)}</h2><span>${all.length} tables · ${free} free</span></div><div class="tgrid">${list.map(card).join('')}</div>`;
      })
      .join('');
    state.flashTable = null;
  }

  $('floor').addEventListener('click', (e) => {
    if (e.target.closest('[data-retry]')) { renderSkeleton(); load(); return; }
    const c = e.target.closest('.tcard');
    if (c) openDrawer({ mode: 'table', tableId: c.dataset.table }, c);
  });

  // ---------- Reservations list ----------

  function dayBookings() {
    const d = state.data;
    const byTable = new Map(d.tables.map((t) => [t.id, t]));
    return d.tables
      .flatMap((t) => t.bookings)
      .concat(d.unassigned)
      .map((b) => ({ ...b, table: byTable.get(b.table_id) || null }))
      .sort((a, b) => Number(!ACTIVE.includes(a.status)) - Number(!ACTIVE.includes(b.status)) || a.booking_time.localeCompare(b.booking_time));
  }

  function bookingMatches(b) {
    if (state.area && (!b.table || b.table.area !== state.area)) return false;
    if (!state.q) return true;
    return [b.id, b.table_id, b.customer_name, b.customer_phone].join(' ').toLowerCase().includes(state.q);
  }

  function rowAction(b) {
    const id = esc(b.id);
    if (b.status === 'confirmed' && b.table_id) return `<button type="button" class="btn btn-primary" data-booking="${id}" data-status="seated">Seat now</button>`;
    if (b.status === 'seated') return `<button type="button" class="btn btn-dark" data-booking="${id}" data-status="completed">Free table</button>`;
    if (b.status === 'confirmed') return '<span class="badge confirmed">Needs table</span>';
    return `<span class="badge ${BOOKING_CLASS[b.status] || ''}">${esc(BOOKING_LABEL[b.status] || b.status)}</span>`;
  }

  function renderList() {
    const el = $('list');
    const all = dayBookings();
    const list = all.filter(bookingMatches);
    const day = dayName(state.data.date);
    if (!list.length) {
      el.innerHTML = all.length
        ? emptyState('No reservations match', 'Try another area, or clear the search.')
        : emptyState(`No bookings ${day === 'Today' || day === 'Tomorrow' ? day.toLowerCase() : 'on ' + day}`, 'Table bookings created through the voice agent will appear here.');
      return;
    }
    el.innerHTML = `<div class="rlist">
      <div class="rrow head"><span>Time</span><span>Guest</span><span>Pax</span><span>Table</span><span>Source</span><span></span></div>
      ${list
        .map((b) => {
          const swatch = b.status === 'seated' ? '#9D1C20' : b.status === 'confirmed' ? bookingColor(b) : 'var(--faint)';
          const src = SOURCE_LABEL[b.source] || 'Other';
          return `<div class="rrow${ACTIVE.includes(b.status) ? '' : ' inactive'}">
            <span class="time"><span class="swatch" style="background:${swatch}" aria-hidden="true"></span>${clock(b.booking_time)}</span>
            <span class="guest">${b.table_id ? `<button type="button" class="open-row" data-table="${esc(b.table_id)}">` : '<span>'}<b>${esc(b.customer_name || 'Guest')}</b><span>${esc(b.customer_phone ? phone(b.customer_phone) : b.id)}</span>${b.table_id ? '</button>' : '</span>'}</span>
            <span class="pax" aria-label="${esc(b.party_size)} guests">${esc(b.party_size || '?')}</span>
            <span class="table">${b.table ? `${esc(b.table.id)} · <span class="muted">${esc(b.table.area)}</span>` : '<span class="muted">No table yet</span>'}</span>
            <span class="source"><span class="tag ${b.source === 'staff' ? 'staff' : 'voice'}">${esc(src)}</span></span>
            <span class="act">${rowAction(b)}</span>
          </div>`;
        })
        .join('')}
    </div>`;
  }

  $('list').addEventListener('click', (e) => {
    const r = e.target.closest('.open-row');
    if (r) openDrawer({ mode: 'table', tableId: r.dataset.table }, r);
  });

  // ---------- Waiting for a table ----------

  function renderWaiting() {
    const list = state.data.unassigned;
    $('waiting').hidden = !list.length;
    $('waiting-list').innerHTML = list
      .map((b) => {
        const fits = state.data.tables.filter((t) => t.seats >= (b.party_size || 1));
        return `<li>
          <span class="who">${esc(b.customer_name || 'Guest')}</span>
          <span class="meta">${clock(b.booking_time)} · ${esc(b.party_size || '?')} guests${b.customer_phone ? ' · ' + esc(phone(b.customer_phone)) : ''}</span>
          <span class="assign">
            <select class="select select-sm" aria-label="Table for ${esc(b.customer_name || 'guest')}">${fits.map((t) => `<option value="${esc(t.id)}">${esc(t.id)} · ${t.seats} seats</option>`).join('')}</select>
            <button type="button" class="btn btn-primary" data-assign="${esc(b.id)}">Assign</button>
            <button type="button" class="btn" data-booking="${esc(b.id)}" data-status="cancelled">Cancel</button>
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
      state.flashTable = table;
      toast(`Booking confirmed at table ${table}`);
    } catch (err) {
      toast(err.message, 'err');
    }
    load();
  });

  // ---------- Booking actions (drawer, list and waiting list) ----------

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-booking][data-status]');
    if (!btn) return;
    const status = btn.dataset.status;
    if (status === 'cancelled' && !confirm('Cancel this booking?')) return;
    btn.disabled = true;
    try {
      const b = await api(`/api/bookings/${encodeURIComponent(btn.dataset.booking)}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      state.flashTable = b.table_id;
      toast(`${ACTION_TOAST[status] || 'Updated'}${b.table_id ? ` · ${b.table_id}` : ''}`);
    } catch (err) {
      btn.disabled = false;
      toast(`Could not update. ${err.message}`, 'err');
    }
    load();
  });

  function actionsFor(b) {
    const id = esc(b.id);
    if (b.status === 'confirmed') {
      return `<button type="button" class="btn btn-primary" data-booking="${id}" data-status="seated">Seat</button>
        <button type="button" class="btn" data-booking="${id}" data-status="no_show">No show</button>
        <button type="button" class="btn btn-quiet" data-booking="${id}" data-status="cancelled">Cancel</button>`;
    }
    if (b.status === 'seated') return `<button type="button" class="btn btn-dark" data-booking="${id}" data-status="completed">Free table</button>`;
    return '';
  }

  // ---------- Drawer ----------

  const panel = $('drawer');
  const form = $('book-form');
  const drawer = Dash.drawer({ panel, backdrop: $('backdrop'), onClose: () => { state.drawer = null; } });
  panel.addEventListener('click', (e) => {
    if (e.target.closest('.drawer-close')) drawer.close();
    if (e.target.closest('[data-open-form]')) {
      state.formOpen = true;
      renderDrawer(true);
      form.customer_name.focus();
    }
    if (e.target.closest('[data-close-form]')) {
      state.formOpen = false;
      renderDrawer(true);
    }
  });

  function openDrawer(target, from) {
    state.drawer = target;
    state.formOpen = false;
    renderDrawer(true);
    drawer.open(from);
    panel.querySelector('.drawer-close').focus();
  }

  const currentTable = () => (state.drawer && state.drawer.mode === 'table' ? state.data.tables.find((t) => t.id === state.drawer.tableId) : null);

  // Background refreshes redraw only when something changed, and never touch
  // what staff are typing into the form.
  let drawerKey = '';
  function renderDrawer(force) {
    if (!state.drawer) return;
    const t = currentTable();
    const d = state.data;
    const key = JSON.stringify([state.drawer, state.formOpen, d.date, d.time, t]);
    if (!force && key === drawerKey) return;
    drawerKey = key;
    const showForm = !t || t.status === 'available' || state.formOpen;
    const wasHidden = form.hidden;
    form.hidden = !showForm;
    if (force || (showForm && wasHidden)) setupForm(t);
    $('d-head').className = `drawer-head ${t ? t.status : 'new'}`;
    $('d-head').setAttribute('style', t ? styleVars(look(t)) : '');
    $('d-head').innerHTML = t
      ? `<div class="row"><span class="d-pill" style="--pill-fg:${t.status === 'available' ? 'var(--ok)' : t.status === 'occupied' ? '#9D1C20' : 'var(--tc-top)'}">${STATUS_LABEL[t.status]}</span><button type="button" class="drawer-close" aria-label="Close">✕</button></div>
         <div class="d-idrow"><span class="d-id" id="drawer-title">${esc(t.id)}</span><span class="d-meta-line">${esc(t.area)} · ${esc(cap(t.size))} · ${t.seats} seats</span></div>`
      : `<div class="row"><span class="d-pill">Front desk</span><button type="button" class="drawer-close" aria-label="Close">✕</button></div>
         <div class="d-idrow"><span class="d-id" id="drawer-title" style="font-size:48px">New booking</span></div>
         <p style="margin:8px 0 0;opacity:.85;font-size:14px">The smallest free table that fits is picked, or choose one.</p>`;
    $('d-current').innerHTML = t ? currentBlock(t) : '';
    $('d-day').innerHTML = t ? dayBlock(t) : '';
    $('d-foot').innerHTML = footFor(t, showForm);
  }

  function currentBlock(t) {
    const b = t.current;
    const d = state.data;
    if (!b) {
      const when = d.is_now ? 'right now' : `at ${clock(d.time)} ${dayName(d.date).toLowerCase()}`;
      return `<p class="d-meta" style="margin-top:0">Free ${esc(when)}.${t.next ? ` Next booking ${clock(t.next.booking_time)} · ${esc(t.next.customer_name || 'guest')} (${esc(t.next.party_size)}).` : ''}</p>`;
    }
    const seated = t.status === 'occupied';
    const src = SOURCE_LABEL[b.source] || 'the dashboard';
    return `<p class="label-caps">${seated ? 'Seated now' : 'Reservation'}</p>
      <p class="d-guest">${esc(b.customer_name || 'Guest')}</p>
      ${b.customer_phone ? `<p class="d-phone">${esc(phone(b.customer_phone))}</p>` : ''}
      <div class="facts">
        <div><div class="k">${seated ? 'Booked for' : 'Arriving'}</div><div class="v big accent">${clock(b.booking_time)}</div></div>
        <div><div class="k">Guests</div><div class="v big">${esc(b.party_size)} ${b.party_size === 1 ? 'person' : 'people'}</div></div>
      </div>
      <div class="memo"><span class="label-caps">Booked via ${esc(src)}</span>${b.notes ? esc(b.notes) : 'No special requests.'}</div>
      <p class="d-meta">${esc(b.id)} · ${esc(dayName(b.booking_date))}${b.created_at ? ` · booked ${esc(fmt.stamp.format(new Date(b.created_at)))}` : ''}</p>`;
  }

  function dayBlock(t) {
    const others = t.bookings.filter((b) => !t.current || b.id !== t.current.id);
    const day = dayName(state.data.date);
    const title = `Other bookings ${day === 'Today' || day === 'Tomorrow' ? day.toLowerCase() : 'on ' + day}`;
    if (!others.length) return `<p class="label-caps section-gap" style="margin-top:22px">${esc(title)}</p><p class="d-meta" style="margin-top:6px">None for this table.</p>`;
    return `<p class="label-caps" style="margin-top:22px">${esc(title)}</p><ul class="day-list">${others
      .map((b) => {
        const acts = actionsFor(b);
        return `<li class="${ACTIVE.includes(b.status) ? '' : 'inactive'}">
          <span class="t">${clock(b.booking_time)}</span>
          <span><div class="n">${esc(b.customer_name || 'Guest')}</div><div class="m">${esc(b.party_size)} guests · ${esc(b.id)}${b.customer_phone ? ' · ' + esc(phone(b.customer_phone)) : ''}</div></span>
          <span class="badge ${BOOKING_CLASS[b.status] || ''}">${esc(BOOKING_LABEL[b.status] || b.status)}</span>
          ${acts ? `<span class="acts">${acts}</span>` : ''}
        </li>`;
      })
      .join('')}</ul>`;
  }

  function footFor(t, showForm) {
    if (showForm) {
      const back = t && t.status !== 'available' ? '<button type="button" class="link-btn" data-close-form>Back to this booking</button>' : '';
      return `<button type="submit" form="book-form" class="btn btn-primary btn-big" id="form-submit">${t ? `Book ${esc(t.id)}` : 'Confirm booking'}</button>${back}`;
    }
    const b = t.current;
    const later = '<button type="button" class="link-btn" data-open-form>Book this table for another time</button>';
    if (t.status === 'reserved') {
      return `<button type="button" class="btn btn-primary btn-big" data-booking="${esc(b.id)}" data-status="seated">Guests arrived · Seat</button>
        <div class="pair"><button type="button" class="btn" data-booking="${esc(b.id)}" data-status="no_show" style="height:50px">No show</button><button type="button" class="btn btn-quiet" data-booking="${esc(b.id)}" data-status="cancelled" style="height:50px">Cancel booking</button></div>${later}`;
    }
    return `<button type="button" class="btn btn-dark btn-big" data-booking="${esc(b.id)}" data-status="completed">Guests left · Free table</button>${later}`;
  }

  // ---------- Booking form ----------

  function setupForm(t) {
    form.reset();
    const errBox = $('form-error');
    errBox.hidden = true;
    form.customer_name.removeAttribute('aria-invalid');
    $('form-title').textContent = t ? (t.status === 'available' ? 'Book this table' : `Book ${t.id} for another time`) : 'Guest details';
    const today = todayIso();
    state.form.day = state.data.date >= today ? state.data.date : today;
    state.form.pax = Math.min(2, maxSeats(t));
    state.form.slot = '';
    $('day-other').min = today;
    $('table-field').hidden = Boolean(t);
    form.table_id.innerHTML = ''; // start from "Best free table"
    renderTableSelect(t);
    renderPax(t);
    renderDays();
    renderSlots(t, true);
  }

  const maxSeats = (t) => (t ? t.seats : Math.max(...state.data.tables.map((x) => x.seats)));

  function renderTableSelect(t) {
    if (t) {
      form.table_id.innerHTML = `<option value="${esc(t.id)}">${esc(t.id)}</option>`;
      return;
    }
    const keep = form.table_id.value;
    form.table_id.innerHTML =
      '<option value="">Best free table</option>' +
      state.data.tables.map((x) => `<option value="${esc(x.id)}"${x.seats < state.form.pax ? ' disabled' : ''}>${esc(x.id)} · ${x.seats} seats · ${esc(x.area)}</option>`).join('');
    const opt = [...form.table_id.options].find((o) => o.value === keep && !o.disabled);
    form.table_id.value = opt ? keep : '';
  }

  function renderPax(t) {
    const max = maxSeats(t);
    $('pax').textContent = state.form.pax;
    form.querySelector('[data-step="-1"]').disabled = state.form.pax <= 1;
    form.querySelector('[data-step="1"]').disabled = state.form.pax >= max;
    $('pax-hint').textContent = t ? `${t.id} seats up to ${t.seats}` : `Tables seat up to ${max}`;
  }

  function renderDays() {
    const today = todayIso();
    const d = state.form.day;
    form.querySelector('[data-day="today"]').classList.toggle('on', d === today);
    form.querySelector('[data-day="tomorrow"]').classList.toggle('on', d === addDays(today, 1));
    const other = $('day-other');
    const isOther = d !== today && d !== addDays(today, 1);
    other.classList.toggle('on', isOther);
    other.value = isOther ? d : '';
  }

  form.addEventListener('click', (e) => {
    const t = currentTable();
    const step = e.target.closest('[data-step]');
    if (step) {
      state.form.pax = Math.max(1, Math.min(maxSeats(t), state.form.pax + Number(step.dataset.step)));
      renderPax(t);
      if (!t) renderTableSelect(t);
      renderSlots(t);
    }
    const day = e.target.closest('[data-day]');
    if (day) {
      state.form.day = day.dataset.day === 'today' ? todayIso() : addDays(todayIso(), 1);
      renderDays();
      renderSlots(t);
    }
    const slot = e.target.closest('[data-slot]');
    if (slot && !slot.disabled) {
      state.form.slot = slot.dataset.slot;
      form.querySelectorAll('[data-slot]').forEach((b) => b.setAttribute('aria-pressed', String(b === slot)));
      $('form-error').hidden = true;
    }
  });
  $('day-other').addEventListener('change', (e) => {
    if (!e.target.value) return;
    state.form.day = e.target.value < todayIso() ? todayIso() : e.target.value;
    renderDays();
    renderSlots(currentTable());
  });
  form.table_id.addEventListener('change', () => renderSlots(currentTable()));

  async function dayData(date) {
    if (state.dayCache.has(date)) return state.dayCache.get(date);
    const data = await api(`/api/tables?date=${date}`);
    state.dayCache.set(date, data);
    return data;
  }

  // Can `table` take a booking at `slot` on the given day?
  function tableFree(dayTables, tableId, slot) {
    const t = dayTables.find((x) => x.id === tableId);
    const dur = state.data.booking_duration_min;
    return t && !t.bookings.some((b) => ACTIVE.includes(b.status) && Math.abs(toMin(b.booking_time) - toMin(slot)) < dur);
  }

  // Time buttons for the chosen day, with times that are past or fully booked struck through.
  let slotSeq = 0;
  async function renderSlots(t, pickSuggested) {
    const mine = ++slotSeq;
    const box = $('slots');
    const hint = $('slot-hint');
    const day = state.form.day;
    let data = state.dayCache.get(day);
    if (!data) {
      box.innerHTML = '<span class="none">Checking free times…</span>';
      try {
        data = await dayData(day);
      } catch (err) {
        if (mine === slotSeq) box.innerHTML = '<span class="none">Could not check free times. Close and try again.</span>';
        return;
      }
      if (mine !== slotSeq) return;
    }
    const isToday = day === todayIso();
    const tableId = t ? t.id : form.table_id.value;
    const free = (s) => {
      if (isToday && toMin(s) <= nowMin()) return false;
      if (tableId) return tableFree(data.tables, tableId, s);
      return data.tables.some((x) => x.seats >= state.form.pax && tableFree(data.tables, x.id, s));
    };
    const list = slots().map((s) => ({ s, ok: free(s) }));
    if (pickSuggested && !state.form.slot) {
      const want = state.time && list.find((x) => x.s === state.time && x.ok);
      if (want) state.form.slot = want.s;
    }
    if (state.form.slot && !list.some((x) => x.s === state.form.slot && x.ok)) state.form.slot = '';
    const open = list.filter((x) => x.ok).length;
    hint.textContent = open ? '' : '· nothing free this day';
    box.innerHTML = list
      .map((x) => `<button type="button" data-slot="${x.s}" aria-pressed="${x.s === state.form.slot}"${x.ok ? '' : ' disabled'} aria-label="${clock(x.s)}${x.ok ? '' : ', not available'}">${clock(x.s).replace(' ', ' ')}</button>`)
      .join('');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = $('form-error');
    const name = form.customer_name.value.trim();
    const digits = form.customer_phone.value.replace(/\D/g, '');
    let problem = '';
    if (!name || !state.form.slot) problem = 'Add the guest’s name and pick a time.';
    else if (digits && digits.length !== 10 && !(digits.length === 12 && digits.startsWith('91'))) problem = 'Enter a 10-digit mobile number, or leave the phone empty.';
    if (name) form.customer_name.removeAttribute('aria-invalid');
    else form.customer_name.setAttribute('aria-invalid', 'true');
    if (problem) {
      errBox.textContent = problem;
      errBox.hidden = false;
      if (!name) form.customer_name.focus();
      return;
    }
    const t = currentTable();
    const body = {
      customer_name: name,
      customer_phone: digits ? `+91${digits.slice(-10)}` : '',
      booking_date: state.form.day,
      booking_time: state.form.slot,
      party_size: state.form.pax,
      notes: form.notes.value.trim(),
      table_id: t ? t.id : form.table_id.value,
    };
    const submit = $('form-submit');
    submit.disabled = true;
    try {
      const b = await api('/api/bookings', { method: 'POST', body: JSON.stringify(body) });
      toast(`${b.table_id} booked for ${b.customer_name} · ${dayName(b.booking_date)}, ${clock(b.booking_time)}`);
      // Jump the floor to the booking so staff see the table change colour.
      state.date = b.booking_date;
      state.time = b.booking_time;
      state.flashTable = b.table_id;
      state.dayCache.clear();
      dateInput.value = state.date;
      syncTimeSelect();
      drawer.close();
      load();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
      state.dayCache.delete(body.booking_date);
      renderSlots(t);
    } finally {
      submit.disabled = false;
    }
  });

  renderSkeleton();
  load();
  setInterval(() => {
    if (!document.hidden) {
      state.dayCache.clear();
      load();
    }
  }, REFRESH_MS);
})();
