'use strict';

const path = require('node:path');

// "12:00-15:30,19:00-23:00" -> [["12:00","15:30"],["19:00","23:00"]]
function parseHours(s) {
  return s.split(',').map((range) => range.trim().split('-').map((t) => t.trim()));
}

function loadConfig(env = process.env) {
  return {
    port: parseInt(env.PORT || '3000', 10),
    dataFile: env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json'),
    webhookSecret: env.WEBHOOK_SECRET || '',
    dashboardPassword: env.DASHBOARD_PASSWORD || '',
    supabase: {
      url: env.SUPABASE_URL || '',
      key: env.SUPABASE_KEY || '',
      appSecret: env.SUPABASE_APP_SECRET || '',
    },
    restaurantName: env.RESTAURANT_NAME || 'SpiceGarden',
    timeZone: env.TIME_ZONE || 'Asia/Kolkata',
    seatCapacity: parseInt(env.SEAT_CAPACITY || '40', 10),
    bookingDurationMin: parseInt(env.BOOKING_DURATION_MIN || '90', 10),
    openingHours: parseHours(env.OPENING_HOURS || '12:00-15:30,19:00-23:00'),
    rejectUnknownItems: env.REJECT_UNKNOWN_ITEMS === 'true',
    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID || '',
      authToken: env.TWILIO_AUTH_TOKEN || '',
      from: env.TWILIO_FROM_NUMBER || '',
    },
  };
}

module.exports = { loadConfig };
