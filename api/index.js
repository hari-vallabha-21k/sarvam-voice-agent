'use strict';

// Vercel entry point. vercel.json rewrites every path here, so the dashboard,
// its static files and the Sarvam API all go through the same handler.
const { createHandler } = require('../src/runtime');

module.exports = createHandler().handler;
