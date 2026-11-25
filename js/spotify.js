// Spotify sign-in (PKCE, no secret) and playback control of the admin's phone.
import { CONFIG } from './config.js';

const API = 'https://api.spotify.com/v1';
const SCOPES = [
  'user-read-playback-state', 'user-modify-playback-state',
  'playlist-read-private', 'playlist-read-collaborative',
  'streaming', 'user-read-private', 'user-read-email',
].join(' ');
const REDIRECT = location.origin + location.pathname;

const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: k => { try { localStorage.removeItem(k); } catch {} },
};

let token = store.get('hotw_token');
let deviceId = null;
let sdkPlayer = null;
let mode = store.get('hotw_play_mode') || 'app';
let currentUri = null;

export const isSignedIn = () => !!store.get('hotw_refresh');
export const getMode = () => mode;
export function setMode(m) { mode = m; deviceId = null; store.set('hotw_play_mode', m); }

// ---------- sign-in ----------
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function signIn() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  store.set('hotw_verifier', verifier);
  store.set('hotw_return_hash', location.hash || '#/');
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({
    client_id: CONFIG.spotifyClientId, response_type: 'code', redirect_uri: REDIRECT,
    code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES,
  });
  location.href = 'https://accounts.spotify.com/authorize?' + q;
}

export function signOut() {
  for (const k of ['hotw_token', 'hotw_refresh', 'hotw_expires']) store.del(k);
  token = null; deviceId = null;
}

async function tokenRequest(params) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error_description || data.error || 'Spotify sign-in failed');
  token = data.access_token;
  store.set('hotw_token', token);
  store.set('hotw_expires', String(Date.now() + (data.expires_in - 60) * 1000));
  if (data.refresh_token) store.set('hotw_refresh', data.refresh_token);
}

// Call once on page load. Returns the hash to go back to after a sign-in, or null.
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.get('code') && !q.get('error')) return null;
  const back = store.get('hotw_return_hash') || '#/';
  history.replaceState(null, '', REDIRECT + back);
  if (q.get('error')) throw new Error('Spotify sign-in was cancelled');
  await tokenRequest({
    client_id: CONFIG.spotifyClientId, grant_type: 'authorization_code',
    code: q.get('code'), redirect_uri: REDIRECT, code_verifier: store.get('hotw_verifier'),
  });
  return back;
}

async function ensureToken() {
  if (token && Number(store.get('hotw_expires')) > Date.now()) return;
  const refresh = store.get('hotw_refresh');
  if (!refresh) throw new Error('Sign in to Spotify first');
  await tokenRequest({ client_id: CONFIG.spotifyClientId, grant_type: 'refresh_token', refresh_token: refresh });
}

async function api(path, opts = {}) {
  await ensureToken();
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 204 || res.status === 202) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const e = new Error((data && data.error && data.error.message) || `Spotify error ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

// ---------- library import ----------
export async function myPlaylists() {
  const out = [];
  let url = '/me/playlists?limit=50';
  while (url) {
    const page = await api(url);
    for (const p of (page && page.items) || []) if (p) out.push({ id: p.id, name: p.name });
    url = page && page.next;
  }
  return out;
}

export async function playlistSongs(playlistId, onProgress) {
  const songs = [];
  let url = `/playlists/${playlistId}/items?limit=50`;
  while (url) {
    const page = await api(url);
    for (const it of (page && page.items) || []) {
      const t = it && (it.item || it.track);
      if (!t || t.type !== 'track' || !t.uri || t.is_local) continue;
      const y = t.album && t.album.release_date ? parseInt(t.album.release_date.slice(0, 4), 10) : null;
      songs.push({
        uri: t.uri, title: t.name,
        artists: (t.artists || []).map(a => a.name),
        album: t.album ? t.album.name : '',
        spotify_year: Number.isFinite(y) ? y : null,
        duration_ms: t.duration_ms || 0,
      });
    }
    if (onProgress) onProgress(songs.length);
    url = page && page.next;
  }
  return songs;
}

// ---------- playback ----------
async function findAppDevice() {
  const data = await api('/me/player/devices');
  const list = (data && data.devices) || [];
  const d = list.find(x => x.type === 'Smartphone') || list.find(x => x.is_active) || list[0];
  if (!d) {
    const e = new Error('Spotify isn’t ready on this phone. Open the Spotify app, play any song for a second, pause it, come back, and tap Reconnect.');
    e.noDevice = true;
    throw e;
  }
  return d.id;
}

function loadSdk() {
  return new Promise((resolve, reject) => {
    if (sdkPlayer && deviceId) return resolve(deviceId);
    window.onSpotifyWebPlaybackSDKReady = () => {
      sdkPlayer = new window.Spotify.Player({
        name: 'Hit on the Way', volume: 0.9,
        getOAuthToken: cb => ensureToken().then(() => cb(token)),
      });
      sdkPlayer.addListener('ready', ({ device_id }) => { deviceId = device_id; resolve(device_id); });
      sdkPlayer.addListener('initialization_error', e => reject(new Error(e.message)));
      sdkPlayer.addListener('authentication_error', e => reject(new Error(e.message)));
      sdkPlayer.addListener('account_error', e => reject(new Error('Spotify Premium is needed: ' + e.message)));
      sdkPlayer.connect();
    };
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    s.onerror = () => reject(new Error('Could not load the Spotify player'));
    document.head.appendChild(s);
  });
}

export async function connect() {
  if (mode === 'app') deviceId = await findAppDevice();
  else {
    deviceId = await loadSdk();
    if (sdkPlayer.activateElement) await sdkPlayer.activateElement();
  }
  return deviceId;
}

const devQ = () => (deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '');

async function playerState() {
  try { return await api('/me/player'); } catch { return null; }
}

// Retry once after reconnecting when Spotify refuses (403) or lost the device (404).
async function command(fn) {
  try { return await fn(); } catch (e) {
    if (![403, 404, 502, 503].includes(e.status)) throw e;
    const st = await playerState();
    if (!st || !st.device) { deviceId = null; await connect(); } else deviceId = st.device.id;
    return await fn();
  }
}

export async function playSong(uri, durationMs, skipIntro) {
  if (!deviceId) await connect();
  if (mode === 'browser' && sdkPlayer && sdkPlayer.activateElement) await sdkPlayer.activateElement();
  currentUri = uri;
  const offset = skipIntro && durationMs > 90000 ? 30000 : 0;
  await command(() => api('/me/player/play' + devQ(), {
    method: 'PUT', body: JSON.stringify({ uris: [uri], position_ms: offset }),
  }));
  return true;
}

// Returns the new playing state. Checks Spotify's real state first, because pausing
// something already paused (from the lock screen, say) makes Spotify answer "Forbidden".
export async function togglePlay(uri) {
  if (!deviceId) await connect();
  if (uri) currentUri = uri;
  const st = await playerState();
  const playing = !!(st && st.is_playing);
  const onOurSong = st && st.item && st.item.uri === currentUri;
  if (playing && onOurSong) {
    await command(() => api('/me/player/pause' + devQ(), { method: 'PUT' }));
    return false;
  }
  if (onOurSong) {
    await command(() => api('/me/player/play' + devQ(), { method: 'PUT' }));
  } else if (currentUri) {
    await command(() => api('/me/player/play' + devQ(), {
      method: 'PUT', body: JSON.stringify({ uris: [currentUri], position_ms: 0 }),
    }));
  }
  return true;
}

export async function pause() {
  const st = await playerState();
  if (st && st.is_playing) await command(() => api('/me/player/pause' + devQ(), { method: 'PUT' }));
}

export async function isPlaying() {
  const st = await playerState();
  return !!(st && st.is_playing && (!currentUri || (st.item && st.item.uri === currentUri)));
}

export function friendlyError(e) {
  if (e && e.status === 403) return 'Spotify refused that. Tap Reconnect, then try again.';
  if (e && e.status === 404) return 'Spotify lost this phone. Open the Spotify app for a second, come back, and tap Reconnect.';
  return (e && e.message) || String(e);
}
