import { CONFIG } from './config.js';

// Call one of the game's database functions (see supabase/schema.sql).
export async function rpc(fn, args = {}) {
  let res;
  try {
    res = await fetch(`${CONFIG.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: CONFIG.supabaseAnonKey,
        // Older "anon" keys are JWTs and also go in Authorization; newer "sb_publishable_" keys don't.
        ...(CONFIG.supabaseAnonKey.startsWith('eyJ') ? { Authorization: 'Bearer ' + CONFIG.supabaseAnonKey } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
  } catch {
    const e = new Error('No connection. Retrying…');
    e.offline = true;
    throw e;
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const e = new Error((data && data.message) || `Database error ${res.status}`);
    e.status = res.status;
    e.code = data && data.code;
    throw e;
  }
  return data;
}
