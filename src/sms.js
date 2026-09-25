'use strict';

// Sends the confirmation SMS through Twilio when TWILIO_* env vars are set.
// Without them the message is only logged (and shows up in data/db.json), so
// the voice flow still works end to end in development.
async function sendSms(config, to, text) {
  const { accountSid, authToken, from } = config.twilio;
  if (!accountSid || !authToken || !from) {
    console.log(`[sms:log] to=${to} text=${JSON.stringify(text)}`);
    return { ok: true, provider: 'log', status: 'logged' };
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Body: text }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`SMS failed: ${data.message || res.status}`);
    err.status = 502;
    throw err;
  }
  return { ok: true, provider: 'twilio', status: data.status, sid: data.sid };
}

module.exports = { sendSms };
