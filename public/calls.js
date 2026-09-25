'use strict';

// Calls page: the call log that the Sarvam post-call webhook writes, from /api/calls.
(function () {
  const { $, api, esc, isoDay, todayIso, fmt, dayName, phone, setLive, emptyState, errorState } = Dash;
  const REFRESH_MS = 15000;
  const LIMIT = 500;

  const state = { calls: [], loaded: false, filter: 'all', selected: null };
  const wide = matchMedia('(min-width: 960px)');

  const dayOf = (c) => isoDay(new Date(c.received_at));
  const keyOf = (c) => `${c.call_id || ''}|${c.received_at}`;
  const pretty = (s) => cap(String(s || '').replace(/[_-]+/g, ' ').trim());
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // What the call led to, from the order and booking the webhook linked to it.
  function outcome(c) {
    if (c.order_id && c.booking_id) return { label: 'Order + booking', cls: 'order', dot: 'var(--brand)' };
    if (c.order_id) return { label: 'Order', cls: 'order', dot: 'var(--brand)' };
    if (c.booking_id) return { label: 'Table booking', cls: 'booking', dot: 'var(--ok)' };
    return { label: c.disposition ? pretty(c.disposition) : 'No order or booking', cls: '', dot: 'var(--faint)' };
  }

  // ---------- Filters ----------

  $('call-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    document.querySelectorAll('#call-chips .chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    render();
  });

  function visible() {
    const today = todayIso();
    return state.calls.filter((c) => {
      if (state.filter === 'today') return dayOf(c) === today;
      if (state.filter === 'order') return Boolean(c.order_id);
      if (state.filter === 'booking') return Boolean(c.booking_id);
      return true;
    });
  }

  // ---------- Rendering ----------

  function renderCounts() {
    const today = state.calls.filter((c) => dayOf(c) === todayIso());
    const orders = today.filter((c) => c.order_id).length;
    const bookings = today.filter((c) => c.booking_id).length;
    $('cc-today').textContent = today.length;
    $('cc-orders').textContent = `${orders} led to an order`;
    $('cc-bookings').textContent = `${bookings} led to a table booking`;
  }

  function row(c) {
    const o = outcome(c);
    const who = [c.customer_name, c.customer_phone && phone(c.customer_phone)].filter(Boolean).join(' · ') || 'Caller not identified';
    const selected = state.selected === keyOf(c) && wide.matches;
    return `<button type="button" class="crow" data-key="${esc(keyOf(c))}" aria-current="${selected}" style="--dot:${o.dot}">
      <span class="rail" aria-hidden="true"><i></i><b></b></span>
      <span class="main">
        <span class="top"><span class="when">${esc(fmt.time.format(new Date(c.received_at)))} <span>· ${esc(who)}</span></span><span class="tag ${o.cls}">${esc(o.label)}</span></span>
        <span class="summary${c.call_summary ? '' : ' none'}" style="display:block">${c.call_summary ? `“${esc(c.call_summary)}”` : 'No summary was sent for this call.'}</span>
        <span class="foot"><span>${[c.order_id, c.booking_id].filter(Boolean).map(esc).join(' · ') || '&nbsp;'}</span><span class="view">View</span></span>
      </span>
    </button>`;
  }

  function render() {
    const el = $('timeline');
    if (!state.loaded) return;
    el.setAttribute('aria-busy', 'false');
    renderCounts();
    const list = visible();
    if (!list.length) {
      el.innerHTML = state.calls.length
        ? emptyState('No calls match', 'Try another filter.')
        : emptyState('No calls yet', 'Calls your voice agent finishes will appear here, with a summary of each one.');
      $('call-panel').hidden = true;
      return;
    }
    const days = [...new Set(list.map(dayOf))];
    el.innerHTML = days
      .map((d) => {
        const label = `${dayName(d)}${['Today', 'Yesterday'].includes(dayName(d)) ? ' · ' + fmt.dayShort.format(new Date(d + 'T00:00:00')) : ''}`;
        return `<div class="group-label">${esc(label)}</div>${list.filter((c) => dayOf(c) === d).map(row).join('')}`;
      })
      .join('');
    // On wide screens the newest call is open beside the list.
    if (wide.matches && !list.some((c) => keyOf(c) === state.selected)) {
      state.selected = keyOf(list[0]);
      el.querySelector('.crow').setAttribute('aria-current', 'true');
    }
    renderPanel();
  }

  function detail(c, inDrawer) {
    const o = outcome(c);
    const d = dayOf(c);
    const links = [];
    if (c.order_id) {
      links.push(`<a href="/?date=${esc(d)}&q=${encodeURIComponent(c.order_id)}"><span>Order ${esc(c.order_id)}<small>Placed during this call</small></span><span class="go">Open order →</span></a>`);
    }
    if (c.booking_id) {
      links.push(`<a href="/tables"><span>Booking ${esc(c.booking_id)}<small>Table booked during this call</small></span><span class="go">Open tables →</span></a>`);
    }
    return `<div class="cp-head">
        ${inDrawer ? '<div style="display:flex;justify-content:flex-end;margin-bottom:6px"><button type="button" class="drawer-close" aria-label="Close">✕</button></div>' : ''}
        <h2 class="cp-title" id="${inDrawer ? 'drawer-title' : 'panel-title'}">Call · ${esc(fmt.time.format(new Date(c.received_at)))}</h2>
        <p class="cp-sub">${esc(dayName(d))} · ${esc([c.customer_name, c.customer_phone && phone(c.customer_phone)].filter(Boolean).join(' · ') || 'Caller not identified')}</p>
        <div class="cp-tags"><span class="tag ${o.cls}">${esc(o.label)}</span>${c.disposition ? `<span class="tag">${esc(pretty(c.disposition))}</span>` : ''}</div>
      </div>
      <div class="cp-body">
        <div class="memo"><span class="label-caps">Call summary</span>${c.call_summary ? esc(c.call_summary) : 'The voice agent did not send a summary for this call.'}</div>
        ${links.length ? `<p class="label-caps" style="margin:6px 0 0">What came of it</p><div class="outcome">${links.join('')}</div>` : ''}
        ${c.call_id ? `<p class="cp-id">Sarvam call ID ${esc(c.call_id)}</p>` : ''}
      </div>`;
  }

  function renderPanel() {
    const panel = $('call-panel');
    const c = state.calls.find((x) => keyOf(x) === state.selected);
    panel.hidden = !c || !wide.matches;
    if (c && wide.matches) panel.innerHTML = detail(c, false);
  }

  // ---------- Selecting a call ----------

  const drawerPanel = $('drawer');
  const drawer = Dash.drawer({ panel: drawerPanel, backdrop: $('backdrop') });
  drawerPanel.addEventListener('click', (e) => {
    if (e.target.closest('.drawer-close')) drawer.close();
  });

  $('timeline').addEventListener('click', (e) => {
    if (e.target.closest('[data-retry]')) {
      renderSkeleton();
      load();
      return;
    }
    const r = e.target.closest('.crow');
    if (!r) return;
    state.selected = r.dataset.key;
    const c = state.calls.find((x) => keyOf(x) === state.selected);
    if (wide.matches) {
      document.querySelectorAll('.crow').forEach((x) => x.setAttribute('aria-current', String(x === r)));
      renderPanel();
    } else if (c) {
      drawerPanel.innerHTML = `<div class="call-detail">${detail(c, true)}</div>`;
      drawer.open(r);
      drawerPanel.querySelector('.drawer-close').focus();
    }
  });
  wide.addEventListener('change', () => {
    if (wide.matches) drawer.close();
    render();
  });

  // ---------- Data ----------

  function renderSkeleton() {
    $('timeline').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><p class="loading-note">Loading calls…</p>';
  }

  async function load() {
    try {
      const { calls } = await api(`/api/calls?limit=${LIMIT}`);
      // Redraw only when something changed, so keyboard focus is not lost on every refresh.
      const changed = !state.loaded || JSON.stringify(calls) !== JSON.stringify(state.calls);
      state.calls = calls;
      state.loaded = true;
      if (changed) render();
      setLive(true, `Live · ${fmt.time.format(new Date())}`);
    } catch (err) {
      setLive(false, 'Offline, retrying…');
      if (!state.loaded) {
        $('timeline').setAttribute('aria-busy', 'false');
        $('timeline').innerHTML = errorState('Unable to load calls.');
      }
    }
  }

  renderSkeleton();
  load();
  setInterval(() => {
    if (!document.hidden) load();
  }, REFRESH_MS);
})();
