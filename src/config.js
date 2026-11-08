'use strict';

const path = require('node:path');

// "12:00-15:30,19:00-23:00" -> [["12:00","15:30"],["19:00","23:00"]]
function parseHours(s) {
  return s.split(',').map((range) => range.trim().split('-').map((t) => t.trim()));
}

// "test:pass1,manager:pass2" -> Map { test => pass1, manager => pass2 }
function parseUsers(s) {
  return new Map(
    s
      .split(',')
      .map((pair) => pair.trim())
      .filter((pair) => pair.includes(':'))
      .map((pair) => [pair.slice(0, pair.indexOf(':')).trim(), pair.slice(pair.indexOf(':') + 1).trim()])
  );
}

function loadConfig(env = process.env) {
  const dashboardUsers = parseUsers(env.DASHBOARD_USERS || '');
  // DEMO_LOGIN is a login in its own right, so it is the only setting a demo needs.
  const demoLogin = env.DEMO_LOGIN || '';
  const di = demoLogin.indexOf(':');
  if (di > 0) dashboardUsers.set(demoLogin.slice(0, di).trim(), demoLogin.slice(di + 1).trim());
  return {
    port: parseInt(env.PORT || '3000', 10),
    dataFile: env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json'),
    webhookSecret: env.WEBHOOK_SECRET || '',
    dashboardPassword: env.DASHBOARD_PASSWORD || '',
    dashboardUsers,
    // Signs the login cookie. Falls back to a value derived from the other secrets.
    sessionSecret: env.SESSION_SECRET || ['session', env.DASHBOARD_PASSWORD, env.DASHBOARD_USERS, env.WEBHOOK_SECRET].join('|'),
    // "user:password" shown on the login page for demos (also works as a login). Leave empty in production.
    demoLogin,
    supabase: {
      url: env.SUPABASE_URL || '',
      key: env.SUPABASE_KEY || '',
      appSecret: env.SUPABASE_APP_SECRET || '',
    },
    restaurantName: env.RESTAURANT_NAME || 'SpiceGarden',
    timeZone: env.TIME_ZONE || 'Asia/Kolkata',
    bookingDurationMin: parseInt(env.BOOKING_DURATION_MIN || '90', 10),
    openingHours: parseHours(env.OPENING_HOURS || '12:00-15:30,19:00-23:00'),
    rejectUnknownItems: env.REJECT_UNKNOWN_ITEMS === 'true',
    whatsapp: {
      url: env.WA_SERVICE_URL || '',
      secret: env.WA_SERVICE_SECRET || '',
    },
    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID || '',
      authToken: env.TWILIO_AUTH_TOKEN || '',
      from: env.TWILIO_FROM_NUMBER || '',
    },
  };
}

module.exports = { loadConfig };
