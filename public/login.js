'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  // Only same-site paths, so a crafted link can't send people elsewhere after sign-in.
  const next = /^\/(?!\/)/.test(params.get('next') || '') ? params.get('next') : '/';

  try {
    const saved = localStorage.getItem('theme');
    if (saved) document.documentElement.dataset.theme = saved;
  } catch (_) {}

  fetch('/api/login-info')
    .then((r) => r.json())
    .then((info) => {
      $('rest-name').textContent = info.restaurant;
      if (!info.authRequired) location.replace(next);
      if (info.demo) {
        $('demo-user').textContent = info.demo.user;
        $('demo-pass').textContent = info.demo.password;
        $('demo-fill').onclick = () => {
          $('username').value = info.demo.user;
          $('password').value = info.demo.password;
        };
        $('demo-box').hidden = false;
      }
    })
    .catch(() => {});

  $('show').onclick = () => {
    const hidden = $('password').type === 'password';
    $('password').type = hidden ? 'text' : 'password';
    $('show').textContent = hidden ? 'Hide' : 'Show';
    $('show').setAttribute('aria-pressed', String(hidden));
  };

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('error');
    err.hidden = true;
    if (!$('password').value) {
      err.textContent = 'Enter your password.';
      err.hidden = false;
      return;
    }
    $('submit').disabled = true;
    $('submit').textContent = 'Signing in…';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('username').value, password: $('password').value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(res.status < 500 && data.error ? data.error : 'Something went wrong. Please try again.');
      location.replace(next);
    } catch (ex) {
      err.textContent = ex instanceof TypeError ? 'No connection. Check the internet and try again.' : ex.message;
      err.hidden = false;
      $('submit').disabled = false;
      $('submit').textContent = 'Sign in';
    }
  });
})();
