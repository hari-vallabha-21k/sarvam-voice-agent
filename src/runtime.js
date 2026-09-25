'use strict';

const { loadConfig } = require('./config');
const { Store } = require('./store');
const { SupabaseStore } = require('./supabase-store');
const { createApp } = require('./app');

// Builds the request handler shared by the local server (src/server.js) and the
// Vercel function (api/index.js). Supabase is used when SUPABASE_URL is set,
// otherwise the JSON file store.
function createHandler(env = process.env) {
  const config = loadConfig(env);
  const store = config.supabase.url
    ? new SupabaseStore(config.supabase)
    : new Store(config.dataFile, { bookingDurationMin: config.bookingDurationMin });
  return { config, store, handler: createApp({ store, config }) };
}

module.exports = { createHandler };
