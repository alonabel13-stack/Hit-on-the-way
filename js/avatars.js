// Avatars: faces cut from the Vecteezy "people avatar set" picture (img/avatars.webp,
// 17 columns x 6 rows of 128px faces). The driver gets a drawn steering wheel.

const COLS = 17, ROWS = 6, CELL = 128;
const INK = '#2a1f1f';
export const AVATAR_IDS = Array.from({ length: COLS * ROWS }, (_, i) => 'p' + i);

// Kept under the old name so the rest of the app doesn't change.
export function avatarSvg(id, size = 40) {
  if (id === 'driver') {
    return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true" class="avatar">
      <circle cx="32" cy="32" r="32" fill="#FFC5D3"/>
      <g fill="none" stroke="${INK}" stroke-width="4"><circle cx="32" cy="32" r="17"/><path d="M15.5 30H48.5M32 34V49"/></g>
      <circle cx="32" cy="32" r="5" fill="${INK}"/></svg>`;
  }
  let i = AVATAR_IDS.indexOf(id);
  if (i < 0) i = 0; // ids from an older version
  const k = size / CELL;
  const x = (i % COLS) * size, y = Math.floor(i / COLS) * size;
  return `<span class="avatar img" aria-hidden="true" style="width:${size}px;height:${size}px;`
    + `background-position:-${x}px -${y}px;background-size:${COLS * CELL * k}px ${ROWS * CELL * k}px"></span>`;
}

// A grid of avatar buttons. The chosen one gets aria-pressed="true".
export function avatarPickerHtml(selected, taken = []) {
  return `<div class="avatars" role="group" aria-label="Choose your avatar">${AVATAR_IDS.map((id, n) => {
    const used = taken.includes(id);
    return `<button type="button" class="avpick" data-avatar="${id}" aria-label="Avatar ${n + 1}${used ? ', taken' : ''}" aria-pressed="${id === selected}"${used ? ' disabled' : ''}>${avatarSvg(id, 52)}</button>`;
  }).join('')}</div>`;
}

// Grey out avatars other players already have.
export function markTaken(root, taken) {
  root.querySelectorAll('[data-avatar]').forEach(b => {
    const used = taken.includes(b.dataset.avatar);
    b.disabled = used;
    if (used) b.setAttribute('aria-pressed', 'false');
  });
}

export function bindAvatarPicker(root, onPick) {
  root.querySelectorAll('[data-avatar]').forEach(b => {
    b.onclick = () => {
      if (b.disabled) return;
      root.querySelectorAll('[data-avatar]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      onPick(b.dataset.avatar);
    };
  });
}

export function randomAvatar(taken = []) {
  const free = AVATAR_IDS.filter(id => !taken.includes(id));
  const list = free.length ? free : AVATAR_IDS;
  return list[Math.floor(Math.random() * list.length)];
}
