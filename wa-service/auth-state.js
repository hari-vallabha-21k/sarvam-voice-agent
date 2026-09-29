// Baileys login state kept in Supabase (table public.wa_auth), so a redeploy on
// Render reconnects without a new QR scan. Same interface as useMultiFileAuthState.
import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';

export async function useSupabaseAuthState({ url, key, appSecret, prefix = 'main' }) {
  const base = `${url.replace(/\/+$/, '')}/rest/v1/wa_auth`;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'x-app-secret': appSecret, 'Content-Type': 'application/json' };
  const rowId = (name) => `${prefix}:${name}`;

  async function read(name) {
    const res = await fetch(`${base}?id=eq.${encodeURIComponent(rowId(name))}&select=data`, { headers });
    if (!res.ok) throw new Error(`wa_auth read failed: ${res.status}`);
    const rows = await res.json();
    return rows.length ? JSON.parse(JSON.stringify(rows[0].data), BufferJSON.reviver) : null;
  }
  async function write(name, value) {
    const res = await fetch(base, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ id: rowId(name), data: JSON.parse(JSON.stringify(value, BufferJSON.replacer)), updated_at: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`wa_auth write failed: ${res.status}`);
  }
  async function remove(name) {
    await fetch(`${base}?id=eq.${encodeURIComponent(rowId(name))}`, { method: 'DELETE', headers });
  }

  const creds = (await read('creds')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          await Promise.all(ids.map(async (id) => {
            let v = await read(`${type}-${id}`);
            if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
            out[id] = v;
          }));
          return out;
        },
        set: async (data) => {
          const jobs = [];
          for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries)) {
              jobs.push(value ? write(`${type}-${id}`, value) : remove(`${type}-${id}`));
            }
          }
          await Promise.all(jobs);
        },
      },
    },
    saveCreds: () => write('creds', creds),
    async clear() {
      await fetch(`${base}?id=like.${encodeURIComponent(prefix + ':')}*`, { method: 'DELETE', headers });
    },
  };
}
