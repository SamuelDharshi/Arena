"use client";
/**
 * Hero intro: the reference clip (public/images/reference.mp4 — the winged-horse statue leaping off its plinth and
 * galloping at the camera) is played off-screen, the horse is cut out of the studio background frame by frame, and
 * it is redrawn as orange dots. The dotted horse starts small at the far end of the dot valley, grows as it charges
 * toward the viewer, and lands on the statue's spot, where the dots turn grey and the real statue image fades in.
 *
 * Tuning:
 *   PLAYBACK_RATE  – speed of the run (1 = the clip's own 5.4 s; 1.35 ≈ 4 s)
 *   START_SCALE    – how small the horse is at the far end (fraction of its final size)
 *   START_X/Y      – where it appears (fractions of the hero's width/height)
 *   FINAL_FIT      – how big the dotted horse is when it lands, relative to the statue image
 *   The final spot and size are the statue image's own box, so moving/resizing that <img> moves the landing.
 */
import { useEffect, useRef } from "react";

const SRC = "/images/sidebar-removebg-preview.png";
const CLIP = "/images/reference.mp4";
const PLAYBACK_RATE = 1.35;
const START_SCALE = 0.55;
const START_X = 0.5;
const START_Y = 0.78;
const FINAL_FIT = 1.25;
const FADE_MS = 1100; // dots → standing statue crossfade (starts at SETTLE_AT)
const SETTLE_AT = 0.86; // share of the run after which the horse starts settling into the statue

const GRID_W = 104; // analysis grid (1 cell = 1 dot); the clip is vertical (~0.58 wide:tall)
const GRID_H = 180;
// Inside the cropped picture: where the horse's hooves are at the start and at the end.
const FEET_START = 0.78;
const FEET_END = 0.92;
const HORSE_H_END = 0.72; // share of the picture height the horse fills at the end

function median(a: number[]): number {
  if (!a.length) return NaN;
  a.sort((x, y) => x - y);
  return a[a.length >> 1];
}
function smooth(v: Float32Array, n: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(v.length);
  const h = n >> 1;
  for (let i = 0; i < v.length; i++) {
    let s = 0;
    let c = 0;
    for (let k = -h; k <= h; k++) {
      s += v[Math.min(v.length - 1, Math.max(0, i + k))];
      c++;
    }
    out[i] = s / c;
  }
  return out;
}
function medianFilter(v: Float32Array, n: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(v.length);
  const h = n >> 1;
  for (let i = 0; i < v.length; i++) {
    const w: number[] = [];
    for (let k = -h; k <= h; k++) w.push(v[Math.min(v.length - 1, Math.max(0, i + k))]);
    out[i] = median(w);
  }
  return out;
}

/**
 * Cuts the horse out of one frame. The studio background is flat along each row, so each row's background level is
 * estimated (from the frame edges first, then from every pixel not yet claimed by the horse) and pixels that differ
 * enough are the horse. Returns per-cell contrast (0 = background).
 */
function cutOut(lum: Float32Array): Float32Array<ArrayBuffer> {
  const W = GRID_W;
  const H = GRID_H;
  let bg = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    const edge: number[] = [];
    for (let x = 1; x < 8; x++) edge.push(lum[y * W + x], lum[y * W + (W - 1 - x)]);
    bg[y] = median(edge);
  }
  bg = smooth(bg, 7);
  const mask = new Float32Array(W * H);
  for (let iter = 0; iter < 3; iter++) {
    const next = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      const th = bg[y] > 45 ? 30 : 12; // the bright floor is noisier: only strong contrast (hooves, not shadow)
      const rest: number[] = [];
      for (let x = 0; x < W; x++) {
        const d = Math.abs(lum[y * W + x] - bg[y]);
        mask[y * W + x] = d > th ? d : 0;
        if (d <= th) rest.push(lum[y * W + x]);
      }
      next[y] = rest.length > 8 ? median(rest) : NaN;
    }
    // Rows fully covered by the horse borrow their neighbours' level.
    for (let y = 0; y < H; y++) {
      if (!Number.isNaN(next[y])) continue;
      let a = y - 1;
      let b = y + 1;
      while (a >= 0 && Number.isNaN(next[a])) a--;
      while (b < H && Number.isNaN(next[b])) b++;
      next[y] = a >= 0 && b < H ? (next[a] + next[b]) / 2 : a >= 0 ? next[a] : b < H ? next[b] : bg[y];
    }
    bg = smooth(medianFilter(next, 9), 5);
  }
  // Drop the clip's watermark (top right) and isolated specks.
  for (let y = 0; y < 16; y++) for (let x = 60; x < W; x++) mask[y * W + x] = 0;
  const out = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      const n = (mask[i - 1] ? 1 : 0) + (mask[i + 1] ? 1 : 0) + (mask[i - W] ? 1 : 0) + (mask[i + W] ? 1 : 0);
      if (n >= 1) out[i] = mask[i];
    }
  }
  return out;
}

export function RunningHorse({ className = "" }: { className?: string }) {
  const img = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const el = img.current;
    const section = el?.closest("section");
    if (!el || !section) return;
    const reveal = () => {
      el.style.opacity = "1";
      el.classList.add("animate-breathe");
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || el.getBoundingClientRect().width < 40) {
      reveal(); // reduced motion, or the statue is hidden on small screens
      return;
    }

    let raf = 0;
    let done = false;
    const video = document.createElement("video");
    video.src = CLIP;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";

    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none";
    // Behind the hero text/buttons, above the dot hills.
    const content = Array.from(section.children).find((c) => getComputedStyle(c).position === "relative") ?? null;
    section.insertBefore(canvas, content);
    const ctx = canvas.getContext("2d");
    const grid = document.createElement("canvas");
    grid.width = GRID_W;
    grid.height = GRID_H;
    const gctx = grid.getContext("2d", { willReadFrequently: true });

    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      reveal();
      video.pause();
      video.removeAttribute("src");
      video.load();
      canvas.remove();
    };
    if (!ctx || !gctx) {
      finish();
      return;
    }

    let hero = section.getBoundingClientRect();
    let box = el.getBoundingClientRect();
    const size = () => {
      hero = section.getBoundingClientRect();
      box = el.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = hero.width * dpr;
      canvas.height = hero.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();
    window.addEventListener("resize", size);

    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    let cut = new Float32Array(GRID_W * GRID_H);
    let lastTime = -1;
    let fadeStart = 0;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const dur = video.duration || 5.4;
      const p = Math.min(1, video.currentTime / dur);

      // New video frame → cut the horse out again.
      if (video.readyState >= 2 && video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        gctx.drawImage(video, 0, 0, vw, vh, 0, 0, GRID_W, GRID_H);
        const px = gctx.getImageData(0, 0, GRID_W, GRID_H).data;
        const lum = new Float32Array(GRID_W * GRID_H);
        for (let i = 0; i < lum.length; i++) lum[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
        cut = cutOut(lum);
      }

      // Where the clip's picture sits on screen: far, small and centred → near, full size, on the statue's spot.
      const e = ease(p);
      const rx = box.left - hero.left;
      const ry = box.top - hero.top;
      const h1 = (box.height / HORSE_H_END) * FINAL_FIT;
      const h0 = h1 * START_SCALE;
      const h = h0 + (h1 - h0) * e;
      const w = h * (video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : GRID_W / GRID_H);
      const feetY0 = hero.height * START_Y;
      const feetY1 = ry + box.height;
      const feet = FEET_START + (FEET_END - FEET_START) * e;
      const cx = hero.width * START_X + (rx + box.width / 2 - hero.width * START_X) * e;
      const top = feetY0 + (feetY1 - feetY0) * e - feet * h;
      const left = cx - w / 2;
      const cell = w / GRID_W;

      const fade = fadeStart ? Math.min(1, (now - fadeStart) / FADE_MS) : 0;
      ctx.clearRect(0, 0, hero.width, hero.height);

      // Soft ground shadow under the hooves.
      const sy = top + feet * h;
      ctx.save();
      ctx.translate(cx, sy);
      ctx.scale(1, 0.18);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, w * 0.45);
      g.addColorStop(0, `rgba(0,0,0,${0.55 * (1 - fade)})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(-w, -w, w * 2, w * 2);
      ctx.restore();

      // Dots: orange while running, turning to the statue's grey as it lands.
      const grey = Math.max(0, (p - (SETTLE_AT - 0.1)) / 0.1) * 0.5 + fade * 0.5;
      const r = Math.round(255 + (150 - 255) * grey);
      const gg = Math.round(106 + (150 - 106) * grey);
      const b = Math.round(26 + (150 - 26) * grey);
      ctx.fillStyle = `rgb(${r},${gg},${b})`;
      const dot = Math.max(1, cell * 0.72);
      for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
          const c = cut[y * GRID_W + x];
          if (!c) continue;
          ctx.globalAlpha = (0.45 + 0.55 * Math.min(1, c / 60)) * (1 - fade);
          ctx.fillRect(left + x * cell, top + y * cell, dot, dot);
        }
      }
      ctx.globalAlpha = 1;

      if (p >= SETTLE_AT && !fadeStart) {
        fadeStart = now;
        reveal(); // CSS transition fades the real statue in while the dots dissolve
      }
      if (fade >= 1) finish();
    };

    const begin = () => {
      video.playbackRate = PLAYBACK_RATE;
      video.play().then(
        () => (raf = requestAnimationFrame(draw)),
        () => finish(), // autoplay blocked → just show the statue
      );
    };
    video.addEventListener("ended", () => {
      if (!fadeStart) {
        fadeStart = performance.now();
        reveal();
      }
    });
    video.addEventListener("error", finish, { once: true });
    const failSafe = setTimeout(() => video.readyState < 2 && finish(), 4000);
    const hardStop = setTimeout(finish, 10000); // never leave the hero without its statue
    if (video.readyState >= 2) begin();
    else video.addEventListener("canplay", begin, { once: true });

    return () => {
      clearTimeout(failSafe);
      clearTimeout(hardStop);
      window.removeEventListener("resize", size);
      done = true;
      cancelAnimationFrame(raf);
      video.pause();
      canvas.remove();
      el.style.opacity = "1";
    };
  }, []);

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img ref={img} src={SRC} alt="" aria-hidden style={{ opacity: 0 }} className={`origin-bottom transition-opacity duration-1000 ${className}`} />
  );
}
