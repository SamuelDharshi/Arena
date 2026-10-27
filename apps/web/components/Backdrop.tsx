import type { ReactNode } from "react";

/** Colosseum image backdrop (public/images/5dc5dc5fe5c04e6e9102da17fa687da2.jpg) with dark overlays so text stays readable. */
export function ColosseumBackdrop({ className = "", children }: { className?: string; children?: ReactNode }) {
  return (
    <div className={`relative overflow-hidden bg-ink-950 ${className}`}>
      <div aria-hidden className="absolute inset-0 scale-105 bg-[url('/images/5dc5dc5fe5c04e6e9102da17fa687da2.jpg')] bg-cover bg-center blur-[1px]" />
      <div aria-hidden className="absolute inset-0 bg-gradient-to-b from-ink-950/30 via-ink-950/55 to-ink-950" />
      <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-ink-950/90 via-ink-950/40 to-ink-950/10" />
      <div className="relative h-full">{children}</div>
    </div>
  );
}
