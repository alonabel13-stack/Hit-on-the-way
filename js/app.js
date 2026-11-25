import { CONFIG, isConfigured } from './config.js';
import { rpc } from './db.js';
import * as sp from './spotify.js';
import { originalYear, sleep } from './musicbrainz.js';
import { confetti } from './confetti.js';

// ====================================================================== basics

const $app = document.getElementById('app');
const $banner = document.getElementById('banner');
const $ = id => document.getElementById(id);

const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: k => { try { localStorage.removeItem(k); } catch {} },
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const getSession = () => { try { return JSON.parse(store.get('hotw_session') || 'null'); } catch { return null; } };
const setSession = s => (s ? store.set('hotw_session', JSON.stringify(s)) : store.del('hotw_session'));
const libKey = () => store.get('hotw_library_key');

function setBanner(text) {
  $banner.textContent = text || '';
  $banner.classList.toggle('hidden', !text);
}

// Run an async action from a button: disable it, show errors under it.
async function act(btn, errEl, fn) {
  if (btn) btn.disabled = true;
  if (errEl) errEl.textContent = '';
  try { return await fn(); }
  catch (e) {
    if (/Wrong library passphrase/.test(e.message)) { store.del('hotw_library_key'); route(); return; }
    if (errEl) errEl.textContent = e.message || String(e);
    else alert(e.message || e);
  } finally { if (btn && btn.isConnected) btn.disabled = false; }
}

let cleanups = [];
const onLeave = fn => cleanups.push(fn);
function leaveView() { for (const f of cleanups) { try { f(); } catch {} } cleanups = []; setBanner(null); }

// Keep the host's screen on: a locked iPhone shows the song title on the lock screen.
let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && getSession()?.admin_token) keepAwake();
});

// ====================================================================== router

function route() {
  leaveView();
  const parts = (location.hash || '#/').slice(2).split('/');
  window.scrollTo(0, 0);
  switch (parts[0]) {
    case 'join': return home(decodeURIComponent(parts[1] || ''));
    case 'host': return hostSetup();
    case 'library': return parts[1] ? songList(parts[1]) : library();
    case 'game': return game();
    default: return home();
  }
}
window.addEventListener('hashchange', route);

(async () => {
  if (!isConfigured()) {
    $app.innerHTML = `<h1>Hit on the Way<span class="dot">.</span></h1>
      <section><h2>Almost ready</h2><p>The database isn’t connected yet. Add the Supabase URL and key to
      <code>js/config.js</code> (see the README).</p></section>`;
    return;
  }
  try {
    const back = await sp.handleRedirect();
    if (back && location.hash !== back) { location.hash = back; return; }
  } catch (e) { setTimeout(() => alert(e.message), 0); }
  route();
})();

// ====================================================================== home

function home(prefillCode = '') {
  const s = getSession();
  $app.innerHTML = `
    <h1>Hit on the Way<span class="dot">.</span></h1>
    <p class="quiet">The family music guessing game for the car.</p>
    ${s ? `<section><h2>Game ${esc(s.code)} is on</h2>
      <button class="primary" id="resume">Back to the game</button>
      <button class="link" id="forget">Leave that game</button></section>` : ''}
    <section>
      <h2>Join a game</h2>
      <label for="code">Game code</label>
      <input id="code" class="code" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(prefillCode.toUpperCase())}">
      <label for="name">Your name</label>
      <input id="name" dir="auto" maxlength="24" autocomplete="nickname" value="${esc(store.get('hotw_name') || '')}">
      <button class="primary" id="join">Join</button>
      <div class="err" id="joinErr"></div>
    </section>
    <section>
      <h2>Host a game</h2>
      <p class="quiet">On the phone connected to the car.</p>
      <button id="host">Host a game</button>
      <button class="link" id="lib">Song library</button>
    </section>`;
  if (s) {
    $('resume').onclick = () => { location.hash = '#/game'; };
    $('forget').onclick = () => { if (confirm('Leave this game on this phone?')) { setSession(null); home(prefillCode); } };
  }
  $('host').onclick = () => { location.hash = '#/host'; };
  $('lib').onclick = () => { location.hash = '#/library'; };
  const join = () => act($('join'), $('joinErr'), async () => {
    const code = $('code').value.trim().toUpperCase();
    const name = $('name').value.trim();
    if (code.length !== 4) throw new Error('The game code has 4 letters');
    if (!name) throw new Error('Type your name');
    store.set('hotw_name', name);
    const r = await rpc('hotw_join', { p_code: code, p_name: name });
    setSession({ code: r.code, player_id: r.player_id, player_token: r.player_token });
    location.hash = '#/game';
  });
  $('join').onclick = join;
  $('name').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
  if (prefillCode) $('name').focus();
}

// ====================================================================== library passphrase

function keyGate(next) {
  $app.innerHTML = `
    <p><a href="#/">← Home</a></p>
    <h1>Library passphrase</h1>
    <section>
      <p>The passphrase protects your song library and lets this phone host games.</p>
      <p class="quiet">The first passphrase you ever enter becomes the passphrase. Use the same one on any phone you host from.</p>
      <label for="pass">Passphrase</label>
      <input id="pass" type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
      <button class="primary" id="unlock">Unlock</button>
      <div class="err" id="passErr"></div>
    </section>`;
  const go = () => act($('unlock'), $('passErr'), async () => {
    const k = $('pass').value;
    await rpc('hotw_library_login', { p_key: k });
    store.set('hotw_library_key', k);
    next();
  });
  $('unlock').onclick = go;
  $('pass').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

// ====================================================================== library

async function library() {
  if (!libKey()) return keyGate(library);
  $app.innerHTML = `
    <p><a href="#/">← Home</a></p>
    <h1>Song library</h1>
    <section>
      <h2>Game playlists</h2>
      <div id="pls" class="quiet">Loading…</div>
      <div class="err" id="plErr"></div>
      <button id="years">Check original years</button>
      <div id="yearsBox" class="hidden">
        <p class="quiet" id="yearsMsg"></p>
        <div class="progress"><div id="yearsBar"></div></div>
        <button id="yearsStop">Stop</button>
      </div>
      <p class="quiet">Spotify often lists the year of a remaster or a greatest-hits album. This looks up each song’s original year on MusicBrainz, about one song a second.</p>
    </section>
    <section>
      <h2>Add from Spotify</h2>
      <div id="spBox" class="quiet">Loading…</div>
      <div class="err" id="spErr"></div>
    </section>`;

  let imported = [];
  const loadPls = async () => {
    try {
      imported = await rpc('hotw_list_playlists', { p_key: libKey() });
      $('pls').innerHTML = imported.length ? imported.map(p => `
        <div class="songrow">
          <div class="row"><div class="grow"><b dir="auto">${esc(p.name)}</b>
            <div class="meta">${p.songs} songs${p.years_to_check ? ` · ${p.years_to_check} years to check` : ''}</div></div>
            <button class="small" data-songs="${p.id}">Songs</button>
            <button class="small" data-del="${p.id}">Remove</button></div>
        </div>`).join('') : '<p class="quiet">No playlists yet. Add one from Spotify below.</p>';
      $('pls').querySelectorAll('[data-songs]').forEach(b => { b.onclick = () => { location.hash = '#/library/' + b.dataset.songs; }; });
      $('pls').querySelectorAll('[data-del]').forEach(b => {
        b.onclick = () => {
          if (!confirm('Remove this playlist from the game? Its songs stay in your Spotify.')) return;
          act(b, $('plErr'), async () => { await rpc('hotw_delete_playlist', { p_key: libKey(), p_id: b.dataset.del }); await loadPls(); });
        };
      });
    } catch (e) {
      if (/Wrong library passphrase/.test(e.message)) { store.del('hotw_library_key'); return library(); }
      $('plErr').textContent = e.message;
    }
  };

  const loadSpotify = async () => {
    const box = $('spBox');
    if (!sp.isSignedIn()) {
      box.innerHTML = `<p>Sign in to Spotify to add your playlists.</p><button class="primary" id="spIn">Sign in with Spotify</button>`;
      $('spIn').onclick = () => sp.signIn();
      return;
    }
    try {
      const lists = await sp.myPlaylists();
      box.innerHTML = lists.length ? lists.map(p => {
        const done = imported.find(i => i.spotify_id === p.id);
        return `<div class="songrow"><div class="row"><div class="grow" dir="auto">${esc(p.name)}</div>
          <button class="small" data-imp="${esc(p.id)}" data-name="${esc(p.name)}">${done ? 'Update' : 'Add'}</button></div></div>`;
      }).join('') + `<p class="quiet">Only playlists you own or collaborate on can be read. Copy any Spotify-made playlist into your own first.</p>`
        : '<p class="quiet">No playlists found on this Spotify account.</p>';
      box.querySelectorAll('[data-imp]').forEach(b => {
        b.onclick = () => act(b, $('spErr'), async () => {
          const songs = await sp.playlistSongs(b.dataset.imp, n => { b.textContent = `Reading ${n}…`; });
          if (!songs.length) throw new Error('No songs could be read from that playlist.');
          b.textContent = 'Saving…';
          const r = await rpc('hotw_import_playlist', {
            p_key: libKey(), p_spotify_id: b.dataset.imp, p_name: b.dataset.name, p_songs: songs,
          });
          b.textContent = `Added ${r.songs}`;
          await loadPls();
        });
      });
    } catch (e) { box.innerHTML = ''; $('spErr').textContent = sp.friendlyError(e); }
  };

  // Original-year lookup, one song a second.
  let stop = false;
  onLeave(() => { stop = true; });
  $('years').onclick = () => act($('years'), $('plErr'), async () => {
    stop = false;
    $('yearsBox').classList.remove('hidden');
    $('years').classList.add('hidden');
    const total = Math.max(1, imported.reduce((n, p) => n + p.years_to_check, 0));
    let done = 0, failures = 0, changed = 0;
    const show = () => {
      $('yearsMsg').textContent = `Checked ${done} songs, fixed ${changed} years.`;
      $('yearsBar').style.width = Math.min(100, (100 * done) / total) + '%';
    };
    show();
    try {
      while (!stop) {
        const batch = await rpc('hotw_years_to_check', { p_key: libKey(), p_limit: 25 });
        if (!batch.length) break;
        for (const s of batch) {
          if (stop) break;
          let y;
          try { y = await originalYear(s.title, s.artists); failures = 0; }
          catch (e) {
            failures++;
            if (failures >= 5) throw new Error('Couldn’t reach MusicBrainz. Try again later.');
            await sleep(3000);
            continue;
          }
          await rpc('hotw_set_found_year', { p_key: libKey(), p_id: s.id, p_found: y });
          if (y && (!s.year || y < s.year)) changed++;
          done++; show();
          await sleep(1100);
        }
      }
      $('yearsMsg').textContent = stop ? `Stopped. Checked ${done} songs, fixed ${changed} years.` : `Done. Checked ${done} songs, fixed ${changed} years.`;
    } finally {
      if ($('years')) { $('years').classList.remove('hidden'); $('yearsBox').classList.add('hidden'); }
      if (!stop) await loadPls();
    }
  });
  $('yearsStop').onclick = () => { stop = true; };

  await loadPls();
  loadSpotify();
}

async function songList(playlistId) {
  if (!libKey()) return keyGate(() => songList(playlistId));
  $app.innerHTML = `
    <p><a href="#/library">← Library</a></p>
    <h1>Songs</h1>
    <p class="quiet">Fix a year, add other spellings (for example the Hebrew or English name), or hide a song from games.</p>
    <input id="q" type="search" placeholder="Search title, artist or album" dir="auto">
    <div class="err" id="slErr"></div>
    <section id="list"><p class="quiet">Loading…</p></section>`;
  let all = [];
  try { all = await rpc('hotw_list_songs', { p_key: libKey(), p_playlist_id: playlistId, p_search: '' }); }
  catch (e) { $('slErr').textContent = e.message; return; }

  const splitList = v => v.split(',').map(x => x.trim()).filter(Boolean);
  const render = () => {
    const q = $('q').value.trim().toLowerCase();
    const rows = all.filter(s => !q || [s.title, s.album, ...(s.artists || [])].join(' ').toLowerCase().includes(q));
    const shown = rows.slice(0, 150);
    $('list').innerHTML = (shown.map(s => `
      <div class="songrow ${s.hidden ? 'hiddensong' : ''}" data-id="${s.id}">
        <div class="row"><div class="grow"><b dir="auto">${esc(s.title)}</b>
          <div class="meta" dir="auto">${esc((s.artists || []).join(', '))} · ${esc(s.album)}</div>
          <div class="meta">Year ${s.year ?? '?'}${s.spotify_year && s.spotify_year !== s.year ? ` (Spotify says ${s.spotify_year})` : ''}${s.hidden ? ' · hidden' : ''}</div></div>
          <button class="small" data-edit>Edit</button></div>
        <div class="editor hidden">
          <div class="two"><div><label>Year</label><input data-f="year" inputmode="numeric" maxlength="4" value="${s.year ?? ''}"></div>
            <div><label>Album</label><input data-f="album" dir="auto" value="${esc(s.album)}"></div></div>
          <label>Other spellings of the song name (comma between)</label><input data-f="title_alts" dir="auto" value="${esc((s.title_alts || []).join(', '))}">
          <label>Other spellings of the artist</label><input data-f="artist_alts" dir="auto" value="${esc((s.artist_alts || []).join(', '))}">
          <label>Other spellings of the album</label><input data-f="album_alts" dir="auto" value="${esc((s.album_alts || []).join(', '))}">
          <label class="check"><input type="checkbox" data-f="hidden" ${s.hidden ? 'checked' : ''}> Hide from games</label>
          <button class="primary" data-save>Save</button><div class="err"></div>
        </div>
      </div>`).join('') || '<p class="quiet">No songs match.</p>')
      + (rows.length > shown.length ? `<p class="quiet">Showing 150 of ${rows.length}. Search to narrow it down.</p>` : '');
    $('list').querySelectorAll('.songrow').forEach(row => {
      const s = all.find(x => x.id === row.dataset.id);
      const f = n => row.querySelector(`[data-f="${n}"]`);
      row.querySelector('[data-edit]').onclick = () => row.querySelector('.editor').classList.toggle('hidden');
      row.querySelector('[data-save]').onclick = e => act(e.target, row.querySelector('.editor .err'), async () => {
        const y = parseInt(f('year').value, 10);
        const upd = {
          p_key: libKey(), p_id: s.id, p_year: Number.isFinite(y) ? y : null, p_album: f('album').value,
          p_title_alts: splitList(f('title_alts').value), p_artist_alts: splitList(f('artist_alts').value),
          p_album_alts: splitList(f('album_alts').value), p_hidden: f('hidden').checked,
        };
        await rpc('hotw_update_song', upd);
        Object.assign(s, { year: upd.p_year, album: upd.p_album.trim() || s.album, title_alts: upd.p_title_alts,
          artist_alts: upd.p_artist_alts, album_alts: upd.p_album_alts, hidden: upd.p_hidden });
        render();
      });
    });
  };
  $('q').addEventListener('input', render);
  render();
}

// ====================================================================== host setup

async function hostSetup() {
  if (!libKey()) return keyGate(hostSetup);
  const signedIn = sp.isSignedIn();
  $app.innerHTML = `
    <p><a href="#/">← Home</a></p>
    <h1>Host a game</h1>
    <section>
      <h2>Spotify</h2>
      ${signedIn ? `<p class="ok">Signed in to Spotify.</p>
        <label>Play songs through</label>
        <div class="seg" id="mode"><button data-m="app">Spotify app</button><button data-m="browser">This browser</button></div>
        <p class="quiet" id="modeHelp"></p>
        <label class="check"><input type="checkbox" id="skip" ${store.get('hotw_skip_intro') === '0' ? '' : 'checked'}> Start 30 seconds into each song</label>`
      : `<p>Sign in with the Premium account that will play the music.</p><button class="primary" id="spIn">Sign in with Spotify</button>`}
    </section>
    <section>
      <h2>Playlists</h2>
      <div id="pls" class="quiet">Loading…</div>
      <p><a href="#/library">Manage the song library</a></p>
    </section>
    <section>
      <div class="two">
        <div><label for="rounds">Songs in this game</label><input id="rounds" type="number" inputmode="numeric" min="1" max="100" value="${esc(store.get('hotw_rounds') || '10')}"></div>
        <div><label for="me">Your name</label><input id="me" dir="auto" maxlength="24" value="${esc(store.get('hotw_name') || '')}"></div>
      </div>
      <button class="primary" id="create" ${signedIn ? '' : 'disabled'}>Create game</button>
      <div class="err" id="createErr"></div>
    </section>`;

  if (!signedIn) $('spIn').onclick = () => sp.signIn();
  else {
    const paint = () => {
      $('mode').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.m === sp.getMode()));
      $('modeHelp').textContent = sp.getMode() === 'app'
        ? 'Recommended. Open the Spotify app once before starting; it then plays in the background.'
        : 'Plays inside Safari. Keep this page open.';
    };
    $('mode').querySelectorAll('button').forEach(b => { b.onclick = () => { sp.setMode(b.dataset.m); paint(); }; });
    paint();
  }

  let lists = [];
  try {
    lists = await rpc('hotw_list_playlists', { p_key: libKey() });
  } catch (e) {
    if (/Wrong library passphrase/.test(e.message)) { store.del('hotw_library_key'); return hostSetup(); }
    $('pls').textContent = e.message;
  }
  const chosen = new Set(JSON.parse(store.get('hotw_last_playlists') || '[]'));
  $('pls').innerHTML = lists.length ? lists.map(p => `
    <label class="check"><input type="checkbox" value="${p.id}" ${chosen.has(p.id) || lists.length === 1 ? 'checked' : ''}>
      <span dir="auto">${esc(p.name)}</span> <span class="quiet">${p.songs}</span></label>`).join('')
    : '<p>No playlists yet. <a href="#/library">Add one from Spotify</a> first.</p>';

  $('create').onclick = () => act($('create'), $('createErr'), async () => {
    const ids = [...$('pls').querySelectorAll('input:checked')].map(i => i.value);
    if (!ids.length) throw new Error('Pick at least one playlist');
    const rounds = parseInt($('rounds').value, 10) || 10;
    const name = $('me').value.trim() || 'Host';
    store.set('hotw_last_playlists', JSON.stringify(ids));
    store.set('hotw_rounds', String(rounds));
    store.set('hotw_name', name);
    store.set('hotw_skip_intro', $('skip') && !$('skip').checked ? '0' : '1');
    const r = await rpc('hotw_create_game', { p_key: libKey(), p_playlist_ids: ids, p_rounds: rounds, p_admin_name: name });
    setSession({ code: r.code, admin_token: r.admin_token, player_id: r.player_id, player_token: r.player_token });
    location.hash = '#/game';
  });
}

// ====================================================================== game screens

const pointsOf = a => (a ? a.year_pts + (a.title_ok ? 1 : 0) + (a.artist_ok ? 1 : 0) + (a.album_ok ? 1 : 0) : 0);

function boardHtml(d) {
  const ps = [...d.players].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const showGain = d.state === 'reveal' || d.state === 'finished';
  return `<ul class="board">${ps.map(p => {
    const rank = 1 + ps.filter(q => q.total > p.total).length;
    return `<li class="${rank === 1 && p.total > 0 ? 'first' : ''}"><span class="rank">${rank}</span>
      <span class="name" dir="auto">${esc(p.name)}${p.is_driver ? ' <span class="tag">driver</span>' : ''}</span>
      <span class="gain">${showGain && p.last ? '+' + p.last : ''}</span><span class="pts">${p.total}</span></li>`;
  }).join('')}</ul>`;
}

function playersHtml(d, { ticks = false, removable = false } = {}) {
  return `<ul class="players">${d.players.map(p => `
    <li>${ticks ? `<span class="tick">${p.is_driver ? '🚗' : p.submitted ? '✅' : '…'}</span>` : ''}
      <span class="name" dir="auto">${esc(p.name)}</span>
      ${p.is_admin ? '<span class="tag">host</span>' : ''}${p.is_driver ? '<span class="tag">driver</span>' : ''}
      ${removable && !p.is_admin ? `<button class="small" data-remove="${p.id}">✕</button>` : ''}
    </li>`).join('')}</ul>`;
}

// "Bohemian Rhapsody - Remastered 2011" -> "Bohemian Rhapsody" for display.
const EXTRAS = '(remaster|version|edit|mono|stereo|mix|live|deluxe|anniversary|expanded|edition)';
const tidy = t => String(t || '')
  .replace(new RegExp(`\\s[-–—]\\s[^-–—]*${EXTRAS}.*$`, 'i'), '')
  .replace(new RegExp(`\\s*[(\\[][^)\\]]*${EXTRAS}[^)\\]]*[)\\]]`, 'ig'), '')
  .trim();

function songHtml(song) {
  return `<div class="song"><div class="t" dir="auto">${esc(tidy(song.title))}</div>
    <div class="a" dir="auto">${esc((song.artists || []).join(', '))}</div>
    <div class="meta" dir="auto">${esc(tidy(song.album))} · ${song.year ?? '?'}</div></div>`;
}

function chipsHtml(a, editable) {
  const c = (field, label, val, cls, pts) =>
    `<button class="chip ${cls}" ${editable ? `data-field="${field}" data-pts="${pts}"` : 'disabled'}>
       <b>${label}</b><span dir="auto">${esc(val || '—')}</span></button>`;
  return `<div class="chips">
    ${c('year', `Year ${a.year_pts ? '+' + a.year_pts : ''}`, a.year, a.year_pts === 2 ? 'ok' : a.year_pts === 1 ? 'half' : 'no', a.year_pts)}
    ${c('title', 'Song', a.title, a.title_ok ? 'ok' : 'no', a.title_ok ? 1 : 0)}
    ${c('artist', 'Artist', a.artist, a.artist_ok ? 'ok' : 'no', a.artist_ok ? 1 : 0)}
    ${c('album', 'Album', a.album, a.album_ok ? 'ok' : 'no', a.album_ok ? 1 : 0)}
  </div>`;
}

// Everyone's answers for the round, right or wrong. Only the host can tap to change points.
function resultsHtml(d, editable) {
  return d.players.map(p => {
    const a = (d.answers || []).find(x => x.player_id === p.id);
    if (!a) return '';
    const me = d.me && d.me.id === p.id;
    return `<div class="result${me ? ' me' : ''}" data-player="${p.id}"><div class="row">
      <b class="grow" dir="auto">${esc(p.name)}${me ? ' <span class="tag">you</span>' : ''}${p.is_driver ? ' <span class="tag">driver</span>' : ''}</b>
      <span>+${pointsOf(a)}</span></div>${chipsHtml(a, editable)}</div>`;
  }).join('');
}

function formHtml(prefix, a) {
  a = a || {};
  return `
    <label for="${prefix}year">Year</label>
    <input id="${prefix}year" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" value="${esc(a.year ?? '')}">
    <label for="${prefix}title">Song</label>
    <input id="${prefix}title" dir="auto" autocomplete="off" autocorrect="off" value="${esc(a.title || '')}">
    <label for="${prefix}artist">Artist</label>
    <input id="${prefix}artist" dir="auto" autocomplete="off" autocorrect="off" value="${esc(a.artist || '')}">
    <label for="${prefix}album">Album</label>
    <input id="${prefix}album" dir="auto" autocomplete="off" autocorrect="off" value="${esc(a.album || '')}">`;
}

function readForm(prefix) {
  const y = parseInt(($(prefix + 'year').value || '').trim(), 10);
  return {
    year: Number.isFinite(y) && y >= 1900 && y <= 2100 ? y : null,
    title: $(prefix + 'title').value.trim(),
    artist: $(prefix + 'artist').value.trim(),
    album: $(prefix + 'album').value.trim(),
  };
}

function game() {
  const s = getSession();
  if (!s) { location.hash = '#/'; return; }
  const isHost = !!s.admin_token;
  const ctx = { key: null, d: null, uri: null, playing: false, pendingSave: null, saveTimer: null };
  let alive = true;
  onLeave(() => { alive = false; });

  const draftKey = d => `hotw_draft_${s.code}_${d.round_no}`;

  // Confetti behind the page once per round, when this phone's player scored.
  function celebrate(d) {
    if (d.state !== 'reveal' || !d.me) return;
    const a = (d.answers || []).find(x => x.player_id === d.me.id);
    const pts = pointsOf(a);
    const k = `hotw_confetti_${s.code}_${d.round_no}`;
    if (pts > 0 && !store.get(k)) { store.set(k, '1'); confetti(pts); }
  }

  async function tick() {
    if (!alive) return;
    try {
      if (ctx.pendingSave) await flushSave();
      const d = await rpc('hotw_state', { p_code: s.code, p_player_token: s.player_token, p_admin_token: s.admin_token || null });
      if (!alive) return;
      setBanner(null);
      render(d);
    } catch (e) {
      if (e.offline) setBanner('No signal. Your answers are saved and will send when you’re back online.');
      else if (/not in this game|No game with that code/.test(e.message)) {
        setSession(null);
        $app.innerHTML = `<section><h2>This game is gone</h2><p>${esc(e.message)}</p><button class="primary" onclick="location.hash='#/'">Home</button></section>`;
        alive = false;
      } else setBanner(e.message);
    }
  }
  const iv = setInterval(tick, 1500);
  onLeave(() => clearInterval(iv));
  if (isHost) {
    keepAwake();
    // Follow pauses made outside the page (lock screen, car buttons). Spotify's answer can lag,
    // so only change the button after two readings in a row disagree with it, and not right after a tap.
    let disagree = 0;
    const sync = setInterval(async () => {
      if (!ctx.uri || !['guessing', 'driver', 'reveal'].includes(ctx.d?.state)) return;
      if (Date.now() - (ctx.lastTap || 0) < 6000) { disagree = 0; return; }
      const p = await sp.isPlaying().catch(() => null);
      if (p === null || p === ctx.playing) { disagree = 0; return; }
      if (++disagree >= 2) { ctx.playing = p; disagree = 0; paintPlay(); }
    }, 4000);
    onLeave(() => clearInterval(sync));
  }
  $app.innerHTML = '<p class="quiet center">Connecting…</p>';
  tick();

  // ---------------- answers (phone players and the host)
  function scheduleSave(d, submit) {
    const a = readForm('a_');
    store.set(draftKey(d), JSON.stringify(a));
    ctx.pendingSave = { ...a, submit: !!submit };
    clearTimeout(ctx.saveTimer);
    if (submit) return flushSave();
    ctx.saveTimer = setTimeout(() => flushSave().catch(() => {}), 700);
  }
  async function flushSave() {
    const p = ctx.pendingSave;
    if (!p) return;
    const r = await rpc('hotw_save_answer', {
      p_player_token: s.player_token, p_year: p.year, p_title: p.title, p_artist: p.artist, p_album: p.album, p_submit: p.submit,
    });
    if (ctx.pendingSave === p) ctx.pendingSave = null;
    return r;
  }
  function bindForm(d) {
    let draft = null;
    try { draft = JSON.parse(store.get(draftKey(d)) || 'null'); } catch {}
    if (draft) for (const f of ['year', 'title', 'artist', 'album']) if (draft[f] != null && $('a_' + f)) $('a_' + f).value = draft[f];
    for (const f of ['year', 'title', 'artist', 'album']) $('a_' + f).addEventListener('input', () => scheduleSave(d, false));
    $('submit').onclick = () => act($('submit'), $('formErr'), async () => {
      try { await scheduleSave(d, true); }
      catch (e) { if (e.offline) { setBanner('No signal. Your answer will send when you’re back online.'); return; } throw e; }
      await tick();
    });
  }

  // ---------------- host playback bar
  function playbarHtml() {
    return `<button class="playbtn" id="play" aria-label="Play">▶</button>
      <p class="quiet center" id="playStatus"></p>
      <div class="row"><button class="small grow" id="reconnect">Reconnect Spotify</button></div>
      <div class="err" id="playErr"></div>`;
  }
  function paintPlay() {
    const b = $('play');
    if (!b) return;
    b.textContent = ctx.playing ? '❚❚' : '▶';
    b.classList.toggle('paused', !ctx.playing);
    b.setAttribute('aria-label', ctx.playing ? 'Pause' : 'Play');
    $('playStatus').textContent = ctx.playing ? 'Playing' : 'Paused';
  }
  function bindPlaybar() {
    paintPlay();
    $('play').onclick = () => act($('play'), $('playErr'), async () => {
      try {
        if (!ctx.uri) { const c = await rpc('hotw_current_uri', { p_admin_token: s.admin_token }); ctx.uri = c && c.spotify_uri; }
        ctx.lastTap = Date.now();
        ctx.playing = await sp.togglePlay(ctx.uri, ctx.playing);
        paintPlay();
        keepAwake();
      } catch (e) { throw new Error(sp.friendlyError(e)); }
    });
    $('reconnect').onclick = () => act($('reconnect'), $('playErr'), async () => {
      try { await sp.connect(); $('playStatus').textContent = 'Spotify connected'; }
      catch (e) { throw new Error(sp.friendlyError(e)); }
    });
  }
  async function startNextSong(btn, errEl) {
    return act(btn, errEl, async () => {
      const r = await rpc('hotw_next_round', { p_admin_token: s.admin_token });
      if (!r.finished) {
        ctx.uri = r.spotify_uri;
        store.del(`hotw_draft_${s.code}_${r.round_no}`);
        try {
          await sp.playSong(r.spotify_uri, r.duration_ms, store.get('hotw_skip_intro') !== '0');
          ctx.playing = true;
          ctx.lastTap = Date.now();
        } catch (e) {
          ctx.playing = false;
          await tick();
          if ($('playErr')) $('playErr').textContent = sp.friendlyError(e) + ' Then tap play.';
          return;
        }
      }
      keepAwake();
      await tick();
    });
  }

  // ---------------- render
  function render(d) {
    ctx.d = d;
    const mine = d.my_answer || {};
    const key = `${d.state}:${d.round_no}:${mine.submitted ? 1 : 0}`;
    if (key !== ctx.key) { ctx.key = key; (isHost ? hostFull : playerFull)(d); }
    (isHost ? hostUpdate : playerUpdate)(d);
  }

  const head = d => `<div class="roundtag">Game ${esc(d.code)}${d.round_no ? ` · song ${d.round_no} of ${d.total_rounds}` : ''}</div>`;

  // ---------------- player screens
  function playerFull(d) {
    const mine = d.my_answer || {};
    if (d.state === 'lobby') {
      $app.innerHTML = `${head(d)}<section><h2>You’re in, <span dir="auto">${esc(d.me?.name)}</span>!</h2>
        <p class="quiet">Waiting for the host to start the first song.</p><div id="plist"></div></section>`;
    } else if (d.state === 'guessing' && !mine.submitted) {
      $app.innerHTML = `${head(d)}<section><h2>What’s this song?</h2>
        <p class="quiet">Fill in what you know. Blanks are fine. Exact year = 2 points, within 2 years = 1.</p>
        ${formHtml('a_', mine)}
        <button class="primary" id="submit">Lock in my answer</button><div class="err" id="formErr"></div></section>`;
      bindForm(d);
    } else if (d.state === 'guessing' || d.state === 'driver') {
      $app.innerHTML = `${head(d)}<section class="center"><h2>Locked in ✅</h2>
        <p class="quiet">${d.state === 'driver' ? 'The driver is answering now.' : 'Waiting for everyone else.'}</p></section>
        <section><div id="plist"></div></section>`;
    } else if (d.state === 'reveal' || d.state === 'finished') {
      const a = (d.answers || []).find(x => x.player_id === d.me?.id);
      const final = d.state === 'finished';
      $app.innerHTML = `${head(d)}
        ${final ? `<section class="center"><h2>Final results</h2><p id="winner"></p></section>` : ''}
        ${d.song ? `<section>${songHtml(d.song)}${a ? `<p class="center" id="mypts"></p>` : ''}</section>
        <section><h2>This round</h2><div id="results"></div></section>` : ''}
        <section><h2>Leaderboard</h2><div id="board"></div></section>
        ${final ? historyHtml(d) + `<button id="home">Home</button>` : '<p class="quiet center">Next song coming up…</p>'}`;
      if (final) $('home').onclick = () => { setSession(null); location.hash = '#/'; };
    }
  }
  function playerUpdate(d) {
    if ($('plist')) $('plist').innerHTML = playersHtml(d, { ticks: d.state !== 'lobby' });
    if ($('board')) $('board').innerHTML = boardHtml(d);
    if ($('winner')) $('winner').innerHTML = winnerText(d);
    const a = (d.answers || []).find(x => x.player_id === d.me?.id);
    if ($('mypts') && a) $('mypts').innerHTML = `You got <b>${pointsOf(a)}</b> point${pointsOf(a) === 1 ? '' : 's'}`;
    if ($('results') && d.answers) $('results').innerHTML = resultsHtml(d, false);
    celebrate(d);
  }

  function winnerText(d) {
    const top = Math.max(0, ...d.players.map(p => p.total));
    const w = d.players.filter(p => p.total === top);
    return `🏆 <b dir="auto">${w.map(p => esc(p.name)).join(' & ')}</b> ${w.length > 1 ? 'tie' : 'wins'} with ${top} points`;
  }
  function historyHtml(d) {
    return `<section><h2>Songs played</h2>${(d.history || []).map(h => `
      <div class="songrow"><b dir="auto">${esc(tidy(h.title))}</b><div class="meta" dir="auto">${esc((h.artists || []).join(', '))} · ${h.year ?? '?'}</div></div>`).join('')}</section>`;
  }

  // ---------------- host screens
  function hostFull(d) {
    const mine = d.my_answer || {};
    const joinUrl = location.origin + location.pathname + '#/join/' + d.code;
    if (d.state === 'lobby') {
      $app.innerHTML = `${head(d)}
        <section class="center"><p class="quiet">Join at this code</p><div class="bigcode">${esc(d.code)}</div>
          <div class="qr" id="qr"></div><p class="quiet">Scan with the phone camera, or open the game and type the code.</p></section>
        <section><h2>Players</h2><div id="plist"></div>
          <label for="driver">Add the driver (no phone needed)</label>
          <div class="row"><input id="driver" class="grow" dir="auto" maxlength="24" placeholder="Driver’s name"><button class="small" id="addDriver">Add</button></div>
          <div class="err" id="lobbyErr"></div></section>
        <button class="primary" id="start">Start the first song</button><div class="err" id="startErr"></div>`;
      const drawQr = () => {
        if (!window.qrcode) return setTimeout(drawQr, 200);
        const qr = window.qrcode(0, 'M'); qr.addData(joinUrl); qr.make();
        $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      };
      drawQr();
      $('addDriver').onclick = () => act($('addDriver'), $('lobbyErr'), async () => {
        await rpc('hotw_add_driver', { p_admin_token: s.admin_token, p_name: $('driver').value.trim() || 'Driver' });
        $('driver').value = '';
        await tick();
      });
      $('start').onclick = () => startNextSong($('start'), $('startErr'));
    } else if (d.state === 'guessing') {
      $app.innerHTML = `${head(d)}<section>${playbarHtml()}</section>
        <section><h2>Answers</h2><div id="plist"></div>
          <button id="close">Close guesses now</button><div class="err" id="closeErr"></div></section>
        ${mine.submitted ? `<section class="center"><h3>You’re locked in ✅</h3></section>`
          : `<section><h2>Your guess</h2>${formHtml('a_', mine)}
             <button class="primary" id="submit">Lock in my answer</button><div class="err" id="formErr"></div></section>`}`;
      bindPlaybar();
      if (!mine.submitted) bindForm(d);
      $('close').onclick = () => act($('close'), $('closeErr'), async () => {
        await rpc('hotw_close_guessing', { p_admin_token: s.admin_token }); await tick();
      });
    } else if (d.state === 'driver') {
      const drivers = d.players.filter(p => p.is_driver && !p.submitted);
      $app.innerHTML = `${head(d)}<section>${playbarHtml()}</section>
        ${drivers.map(p => `<section><h2>Driver’s turn: <span dir="auto">${esc(p.name)}</span></h2>
          <p class="quiet">Ask out loud and type the answers. Blanks are fine.</p>
          ${formHtml('d_' + p.id + '_', {})}
          <button class="primary" data-driver="${p.id}">Save and reveal</button><div class="err" id="drvErr_${p.id}"></div></section>`).join('')}
        <button class="link" id="skipDriver">Skip the driver and reveal</button>`;
      bindPlaybar();
      $app.querySelectorAll('[data-driver]').forEach(b => {
        b.onclick = () => act(b, $('drvErr_' + b.dataset.driver), async () => {
          const a = readForm('d_' + b.dataset.driver + '_');
          await rpc('hotw_driver_answer', { p_admin_token: s.admin_token, p_player_id: b.dataset.driver,
            p_year: a.year, p_title: a.title, p_artist: a.artist, p_album: a.album });
          await tick();
        });
      });
      $('skipDriver').onclick = () => act($('skipDriver'), null, async () => {
        await rpc('hotw_reveal', { p_admin_token: s.admin_token }); await tick();
      });
    } else if (d.state === 'reveal') {
      const last = d.round_no >= d.total_rounds;
      $app.innerHTML = `${head(d)}
        <section>${d.song ? songHtml(d.song) : ''}</section>
        <section><h2>This round</h2><p class="quiet">Tap a box to fix a close call.</p><div id="results"></div><div class="err" id="ovErr"></div></section>
        <section><h2>Leaderboard</h2><div id="board"></div></section>
        <button class="primary" id="next">${last ? 'See final results' : 'Next song'}</button><div class="err" id="nextErr"></div>
        <section>${playbarHtml()}</section>
        <button class="link" id="end">End the game now</button>`;
      bindPlaybar();
      $('next').onclick = () => startNextSong($('next'), $('nextErr'));
      $('end').onclick = () => { if (confirm('End the game now?')) act($('end'), null, async () => { await rpc('hotw_end_game', { p_admin_token: s.admin_token }); await sp.pause().catch(() => {}); await tick(); }); };
    } else if (d.state === 'finished') {
      sp.pause().catch(() => {});
      $app.innerHTML = `${head(d)}<section class="center"><h2>Final results</h2><p id="winner"></p></section>
        <section><h2>Leaderboard</h2><div id="board"></div></section>
        ${historyHtml(d)}
        <button class="primary" id="again">New game</button><button class="link" id="home">Home</button>`;
      $('again').onclick = () => { setSession(null); location.hash = '#/host'; };
      $('home').onclick = () => { setSession(null); location.hash = '#/'; };
    }
  }

  function hostUpdate(d) {
    celebrate(d);
    if ($('plist')) {
      $('plist').innerHTML = playersHtml(d, { ticks: d.state !== 'lobby', removable: d.state === 'lobby' });
      $('plist').querySelectorAll('[data-remove]').forEach(b => {
        b.onclick = () => act(b, $('lobbyErr'), async () => {
          await rpc('hotw_remove_player', { p_admin_token: s.admin_token, p_player_id: b.dataset.remove }); await tick();
        });
      });
    }
    if ($('board')) $('board').innerHTML = boardHtml(d);
    if ($('winner')) $('winner').innerHTML = winnerText(d);
    if ($('results') && d.answers) {
      $('results').innerHTML = resultsHtml(d, true);
      $('results').querySelectorAll('.result').forEach(row => {
        row.querySelectorAll('[data-field]').forEach(chip => {
          chip.onclick = () => act(chip, $('ovErr'), async () => {
            const f = chip.dataset.field, cur = parseInt(chip.dataset.pts, 10);
            const next = f === 'year' ? (cur + 1) % 3 : cur ? 0 : 1;
            await rpc('hotw_override', { p_admin_token: s.admin_token, p_player_id: row.dataset.player, p_field: f, p_points: next });
            await tick();
          });
        });
      });
    }
  }
}
