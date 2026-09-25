'use strict';

const http = require('node:http');
const { loadConfig } = require('./config');
const { Store } = require('./store');
const { createApp } = require('./app');

const config = loadConfig();
const store = new Store(config.dataFile);
const server = http.createServer(createApp({ store, config }));

server.listen(config.port, () => {
  console.log(`${config.restaurantName} dashboard: http://localhost:${config.port}`);
  console.log(`Sarvam post-call webhook: POST /api/sarvam/webhook${config.webhookSecret ? ' (API key required)' : ''}`);
});
