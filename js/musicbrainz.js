// Look up a song's original release year on MusicBrainz, to fix Spotify years that
// belong to a remaster or a greatest-hits album. MusicBrainz allows about 1 request a second.

const clean = s => (s || '')
  .replace(/\s[-–—]\s.*$/, '')
  .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
  .replace(/["\\]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const norm = s => (s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f\u0591-\u05c7]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, '');

export async function originalYear(title, artists) {
  const artist = (artists && artists[0]) || '';
  const q = `recording:"${clean(title)}" AND artist:"${clean(artist)}"`;
  const url = 'https://musicbrainz.org/ws/2/recording?fmt=json&limit=25&query=' + encodeURIComponent(q);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 503 || res.status === 429) {
    const e = new Error('MusicBrainz is busy'); e.retry = true; throw e;
  }
  if (!res.ok) return null;
  const data = await res.json();
  const wantArtist = norm(artist);
  const wantTitle = norm(clean(title));
  let best = null;
  for (const r of data.recordings || []) {
    if ((r.score || 0) < 85) continue;
    if (norm(r.title) !== wantTitle) continue;
    const credit = norm((r['artist-credit'] || []).map(c => c.name).join(''));
    if (wantArtist && !credit.includes(wantArtist) && !wantArtist.includes(credit)) continue;
    const y = parseInt((r['first-release-date'] || '').slice(0, 4), 10);
    if (Number.isFinite(y) && y > 1900 && (best === null || y < best)) best = y;
  }
  return best;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
