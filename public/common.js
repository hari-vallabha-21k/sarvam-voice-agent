'use strict';

// Shared by every dashboard page: API calls, formatting, the header and toasts.
window.Dash = (function () {
  const $ = (id) => document.getElementById(id);

  // YYYY-MM-DD for the browser's local day.
  const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const todayIso = () => isoDay(new Date());
  const addDays = (iso, n) => {
    const d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return isoDay(d);
  };

  // Error text safe to show staff: the server's own sentence for 4xx, a plain line otherwise.
  async function api(url, opts = {}) {
    let res;
    try {
      res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
    } catch (_) {
      throw new Error('No connection. Check the internet and try again.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(res.status < 500 && data.error ? data.error : 'Something went wrong on the server. Please try again.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const toMin = (t) => {
    const [h, m] = String(t).split(':').map(Number);
    return h * 60 + (m || 0);
  };
  const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  // "19:30" -> "7:30 PM"
  function clock(t) {
    const m = toMin(t);
    const h = Math.floor(m / 60) % 24;
    const mm = m % 60;
    return `${h % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`;
  }

  const fmt = {
    rupees: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }),
    time: new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' }),
    dayShort: new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }),
    dayLong: new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }),
    date: new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
    stamp: new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }),
  };

  // "Today", "Tomorrow", "Yesterday" or "Sat, 26 Sep".
  function dayName(iso) {
    const t = todayIso();
    if (iso === t) return 'Today';
    if (iso === addDays(t, 1)) return 'Tomorrow';
    if (iso === addDays(t, -1)) return 'Yesterday';
    return fmt.dayShort.format(new Date(iso + 'T00:00:00'));
  }

  // Timestamp -> "8:32 PM" today, otherwise "25 Sep, 8:32 PM".
  function placed(ts) {
    const d = new Date(ts);
    return isoDay(d) === todayIso() ? fmt.time.format(d) : fmt.stamp.format(d);
  }

  // "919812345678" or "9812345678" -> "+91 98123 45678"; anything else is shown as stored.
  function phone(p) {
    const d = String(p || '').replace(/\D/g, '');
    const local = d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 10 ? d : null;
    return local ? `+91 ${local.slice(0, 5)} ${local.slice(5)}` : String(p || '');
  }

  const SOURCE_LABEL = {
    sarvam_tool: 'Voice agent',
    sarvam_call_end: 'Voice agent',
    staff: 'Front desk',
  };

  // ---------- Header ----------

  function initHeader() {
    const today = $('today-label');
    if (today) today.textContent = fmt.dayLong.format(new Date());
    const root = document.documentElement;
    try {
      const saved = localStorage.getItem('theme');
      if (saved) root.dataset.theme = saved;
    } catch (_) {}
    const toggle = $('theme-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
        root.dataset.theme = dark ? 'light' : 'dark';
        try { localStorage.setItem('theme', root.dataset.theme); } catch (_) {}
      });
    }
  }

  function setLive(ok, text) {
    const el = $('live');
    if (!el) return;
    el.className = `live ${ok ? 'ok' : 'err'}`;
    $('live-text').textContent = text;
  }

  // ---------- Toast ----------

  let toastTimer;
  function toast(msg, kind = 'ok') {
    const el = $('toast');
    el.innerHTML = `<span class="toast-icon ${kind}" aria-hidden="true">${kind === 'ok' ? '✓' : '!'}</span><span>${esc(msg)}</span>`;
    el.hidden = false;
    el.classList.remove('show');
    void el.offsetWidth; // restart the entrance animation
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3200);
  }

  // ---------- Drawer ----------

  // A right-hand panel with a backdrop. Escape and the backdrop close it, and
  // focus returns to whatever opened it.
  function drawer({ panel, backdrop, onClose }) {
    let lastFocus = null;
    const api = {
      open(from) {
        lastFocus = from || document.activeElement;
        panel.hidden = false;
        backdrop.hidden = false;
        document.body.classList.add('no-scroll');
      },
      close() {
        if (panel.hidden) return;
        panel.hidden = true;
        backdrop.hidden = true;
        document.body.classList.remove('no-scroll');
        if (onClose) onClose();
        if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
      },
      get isOpen() {
        return !panel.hidden;
      },
    };
    backdrop.addEventListener('click', api.close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && api.isOpen) api.close();
    });
    return api;
  }

  // Empty, error and loading blocks share one look.
  function emptyState(title, text) {
    return `<div class="state-box"><p class="state-title">${esc(title)}</p><p class="state-text">${esc(text)}</p></div>`;
  }

  function errorState(title) {
    return `<div class="state-box error"><p class="state-title">${esc(title)}</p><p class="state-text">Check the internet connection, then try again.</p><button type="button" class="btn btn-primary" data-retry>Try again</button></div>`;
  }

  initHeader();

  return { $, api, esc, isoDay, todayIso, addDays, toMin, fromMin, clock, fmt, dayName, placed, phone, SOURCE_LABEL, setLive, toast, drawer, emptyState, errorState };
})();
