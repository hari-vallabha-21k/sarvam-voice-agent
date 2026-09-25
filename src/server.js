'use strict';

const http = require('node:http');
const { createHandler } = require('./runtime');

const { config, store, handler } = createHandler();
const server = http.createServer(handler);

server.listen(config.port, () => {
  console.log(`${config.restaurantName} dashboard: http://localhost:${config.port}`);
  console.log(`Storage: ${store.constructor.name === 'SupabaseStore' ? 'Supabase' : config.dataFile}`);
  console.log(`Sarvam post-call webhook: POST /api/sarvam/webhook${config.webhookSecret ? ' (API key required)' : ''}`);
});
