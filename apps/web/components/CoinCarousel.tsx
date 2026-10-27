"use client";
/**
 * Scroll-driven looping carousel: a 3D coin spins in the centre while the cards orbit around it.
 * The section is tall and its stage is sticky, so scrolling advances the spin and the loop (one full turn = all four cards).
 */
import { useEffect, useRef } from "react";

export interface CarouselItem {
  n: string;
  title: string;
  body: string;
}

const EDGE_LAYERS = 15;

export function CoinCarousel({ items, kicker, title }: { items: CarouselItem[]; kicker: string; title: string }) {
  const outer = useRef<HTMLElement>(null);
  const coin = useRef<HTMLDivElement>(null);
  const cards = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const el = outer.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const span = Math.max(1, rect.height - window.innerHeight);
      const p = Math.min(1, Math.max(0, -rect.top / span));
      const w = window.innerWidth;
      const gap = w < 640 ? 270 : w < 1024 ? 340 : 400;
      const n = items.length;
      if (coin.current) coin.current.style.transform = `rotateX(-6deg) rotateY(${p * 1080}deg)`;
      cards.current.forEach((c, i) => {
        if (!c) return;
        // Position in card-slots from the centre, wrapped so the row loops endlessly.
        let pos = (i - p * n * 0.999 + n * 4) % n;
        if (pos > n / 2) pos -= n;
        const dist = Math.abs(pos);
        const x = pos * gap;
        c.style.transform = `translate(calc(-50% + ${x}px), -50%) rotateY(${-pos * 14}deg) rotateZ(${pos * -1.2}deg) scale(${1 - Math.min(dist, 2) * 0.08})`;
        c.style.opacity = String(Math.max(0.25, 1 - dist * 0.28));
        c.style.zIndex = String(10 - Math.round(dist * 2));
      });
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [items.length]);

  /** Arrows nudge the page by one card's worth of scroll. */
  const step = (dir: 1 | -1) => {
    const el = outer.current;
    if (!el) return;
    const span = el.offsetHeight - window.innerHeight;
    window.scrollBy({ top: (dir * span) / items.length, behavior: "smooth" });
  };

  return (
    <section ref={outer} className="relative" style={{ height: `${items.length * 110 + 100}vh`, width: "100vw", marginLeft: "calc(50% - 50vw)" }}>
      <div className="sticky top-14 flex h-[calc(100vh-56px)] flex-col overflow-hidden bg-[radial-gradient(ellipse_at_center,#2a1405_0%,#0a0a0a_65%)]">
        <div className="mx-auto w-full max-w-[1500px] px-6 pt-10 sm:px-12 sm:pt-14">
          <p className="font-mono text-sm uppercase tracking-[0.35em] text-accent">{kicker}</p>
          <h2 className="mt-3 max-w-4xl font-heading text-4xl font-black leading-[1.05] text-accent sm:text-6xl">{title}</h2>
        </div>

        <div className="relative flex-1" style={{ perspective: "1600px" }}>
          {/* Coin */}
          <div className="pointer-events-none absolute left-1/2 top-1/2 z-[30] -translate-x-1/2 -translate-y-1/2" style={{ perspective: "1200px" }}>
            <div ref={coin} className="relative h-[200px] w-[200px] sm:h-[320px] sm:w-[320px]" style={{ transformStyle: "preserve-3d", willChange: "transform" }}>
              {Array.from({ length: EDGE_LAYERS }, (_, i) => (
                <div
                  key={i}
                  className="absolute inset-0 rounded-full"
                  style={{ background: i % 2 ? "#4a3a2a" : "#6b5238", transform: `translateZ(${(i - (EDGE_LAYERS - 1) / 2) * 1.1}px)` }}
                />
              ))}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/images/coin.png" alt="" className="absolute inset-0 h-full w-full rounded-full object-cover" style={{ transform: "translateZ(9px)", backfaceVisibility: "hidden" }} />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/images/coin.png" alt="" className="absolute inset-0 h-full w-full rounded-full object-cover" style={{ transform: "rotateY(180deg) translateZ(9px)", backfaceVisibility: "hidden" }} />
            </div>
          </div>

          {/* Orbiting cards */}
          {items.map((s, i) => (
            <div
              key={s.n}
              ref={(el) => {
                cards.current[i] = el;
              }}
              className="absolute left-1/2 top-1/2 w-[240px] rounded-3xl border border-accent/30 bg-[#120a04]/80 p-6 shadow-2xl shadow-black/60 backdrop-blur-md sm:w-[330px] sm:p-8"
              style={{ willChange: "transform, opacity" }}
            >
              <div className="font-heading text-4xl font-black text-accent sm:text-5xl">{s.n}</div>
              <h3 className="mt-3 font-heading text-xl font-bold text-accent sm:mt-4 sm:text-2xl">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-orange-200/60 sm:mt-3 sm:text-base">{s.body}</p>
            </div>
          ))}

          <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3">
            <button onClick={() => step(-1)} aria-label="Previous" className="grid h-11 w-11 place-items-center rounded-full border border-accent bg-black text-xl text-accent transition hover:bg-accent hover:text-black">←</button>
            <span className="font-mono text-xs uppercase tracking-widest text-accent/70">Scroll to spin</span>
            <button onClick={() => step(1)} aria-label="Next" className="grid h-11 w-11 place-items-center rounded-full border border-accent bg-black text-xl text-accent transition hover:bg-accent hover:text-black">→</button>
          </div>
        </div>
      </div>
    </section>
  );
}
