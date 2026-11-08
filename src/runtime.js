'use strict';

const { loadConfig } = require('./config');
const { Store } = require('./store');
const { SupabaseStore } = require('./supabase-store');
const { createApp } = require('./app');

const DEFAULT_DEMO_LOGIN = 'test:spicegarden2026';

// Builds the request handler shared by the local server (src/server.js) and the
// Vercel function (api/index.js). Supabase is used when SUPABASE_URL is set,
// otherwise the JSON file store.
function createHandler(env = process.env) {
  // Built-in demo login, shown on the login page. Set DEMO_LOGIN to change it, or DEMO_LOGIN=off to remove it.
  const demoLogin = env.DEMO_LOGIN === undefined || env.DEMO_LOGIN === '' ? DEFAULT_DEMO_LOGIN : env.DEMO_LOGIN;
  const config = loadConfig({ ...env, DEMO_LOGIN: demoLogin === 'off' ? '' : demoLogin });
  const store = config.supabase.url
    ? new SupabaseStore(config.supabase)
    : new Store(config.dataFile, { bookingDurationMin: config.bookingDurationMin });
  return { config, store, handler: createApp({ store, config }) };
}

module.exports = { createHandler };
