// WhatsApp sender for the SpiceGarden dashboard.
//   POST /send   {to, text}     Bearer WA_SERVICE_SECRET   -> sends a WhatsApp message
//   GET  /status                Bearer WA_SERVICE_SECRET   -> {connected, hasQr}
//   GET  /link?key=SECRET       QR code page for linking the restaurant's number
//   POST /logout                Bearer WA_SERVICE_SECRET   -> unlinks and clears the saved login
import http from 'node:http';
import crypto from 'node:crypto';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { useSupabaseAuthState } from './auth-state.js';

const { PORT = '3001', WA_SERVICE_SECRET = '', SUPABASE_URL = '', SUPABASE_KEY = '', SUPABASE_APP_SECRET = '', AUTH_DIR = './auth' } = process.env;
if (WA_SERVICE_SECRET.length < 16) {
  console.error('Set WA_SERVICE_SECRET (16+ characters).');
  process.exit(1);
}
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

let sock = null;
let connected = false;
let qr = null;
let auth = null;

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

async function start() {
  auth = SUPABASE_URL
    ? await useSupabaseAuthState({ url: SUPABASE_URL, key: SUPABASE_KEY, appSecret: SUPABASE_APP_SECRET })
    : await useMultiFileAuthState(AUTH_DIR).then(({ state, saveCreds }) => ({ state, saveCreds, clear: async () => {} }));
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, auth: auth.state, logger, printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: false });
  sock.ev.on('creds.update', auth.saveCreds);
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr: newQr }) => {
    if (newQr) qr = newQr;
    if (connection === 'open') {
      connected = true;
      qr = null;
      console.log('WhatsApp connected');
    }
    if (connection === 'close') {
      connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log('Logged out from the phone; clearing saved login. Open /link to scan again.');
        await auth.clear();
      }
      setTimeout(() => start().catch((e) => console.error('restart failed', e)), 3000);
    }
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 20000) reject(new Error('too large'));
    });
    req.on('end', () => resolve(raw));
  });
}
const authorized = (req) => safeEqual((req.headers.authorization || '').replace(/^Bearer\s+/i, ''), WA_SERVICE_SECRET);

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/link') {
        if (!safeEqual(url.searchParams.get('key') || '', WA_SERVICE_SECRET)) return json(res, 401, { error: 'unauthorized' });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Refresh': '5' });
        if (connected) return res.end('<h2>WhatsApp is connected.</h2>');
        if (!qr) return res.end('<h2>Waiting for a QR code... this page refreshes itself.</h2>');
        const img = await QRCode.toDataURL(qr, { width: 320 });
        return res.end(`<h2>WhatsApp &rarr; Settings &rarr; Linked devices &rarr; Link a device</h2><img src="${img}" alt="QR">`);
      }
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      if (req.method === 'GET' && url.pathname === '/status') return json(res, 200, { connected, hasQr: Boolean(qr) });
      if (req.method === 'POST' && url.pathname === '/logout') {
        await sock?.logout().catch(() => {});
        await auth.clear();
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/send') {
        const { to, text } = JSON.parse((await readBody(req)) || '{}');
        if (!/^\d{11,15}$/.test(String(to || '')) || !text) return json(res, 400, { error: 'to (digits with country code) and text are required' });
        if (!connected) return json(res, 503, { error: 'whatsapp_not_connected' });
        const jid = `${to}@s.whatsapp.net`;
        const [exists] = await sock.onWhatsApp(jid);
        if (!exists?.exists) return json(res, 422, { error: 'number_not_on_whatsapp' });
        const sent = await sock.sendMessage(exists.jid, { text: String(text) });
        return json(res, 200, { ok: true, id: sent?.key?.id });
      }
      json(res, 404, { error: 'not_found' });
    } catch (err) {
      console.error(err);
      json(res, 500, { error: 'internal' });
    }
  })
  .listen(Number(PORT), () => console.log(`wa-service on :${PORT}`));

start().catch((e) => {
  console.error('startup failed', e);
  process.exit(1);
});
