// Confetti falling behind the page. More points, more confetti.
const COLORS = ['#FFC5D3', '#ff8fab', '#ffffff', '#ffd6a5', '#caffbf', '#9bf6ff', '#bdb2ff'];

export function confetti(points = 1) {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const resize = () => {
    canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  addEventListener('resize', resize);

  const n = 60 + 50 * Math.min(points, 5);
  const bits = Array.from({ length: n }, () => ({
    x: Math.random() * innerWidth,
    y: -20 - Math.random() * innerHeight * 0.8,
    w: 6 + Math.random() * 6,
    h: 8 + Math.random() * 8,
    vx: (Math.random() - 0.5) * 1.6,
    vy: 2 + Math.random() * 3,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.25,
    sway: Math.random() * Math.PI * 2,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  }));

  const start = performance.now();
  const frame = now => {
    const t = now - start;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    let alive = 0;
    for (const b of bits) {
      b.sway += 0.05;
      b.x += b.vx + Math.sin(b.sway) * 0.8;
      b.y += b.vy;
      b.rot += b.vr;
      if (b.y < innerHeight + 20) alive++;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.globalAlpha = t > 3500 ? Math.max(0, 1 - (t - 3500) / 1000) : 1;
      ctx.fillStyle = b.color;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h * Math.abs(Math.cos(b.sway)));
      ctx.restore();
    }
    if (alive && t < 4500) requestAnimationFrame(frame);
    else { removeEventListener('resize', resize); canvas.remove(); }
  };
  requestAnimationFrame(frame);
}
