"use client";
import { useEffect, useRef } from "react";

/** Muted autoplaying video that loops only the [start, end] segment (seconds). */
export function LoopVideo({ src, start, end, className }: { src: string; start: number; end: number; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const toStart = () => {
      v.currentTime = start;
      void v.play().catch(() => undefined);
    };
    const onTime = () => {
      if (v.currentTime >= end || v.currentTime < start - 0.5) toStart();
    };
    v.addEventListener("loadedmetadata", toStart);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("ended", toStart);
    if (v.readyState >= 1) toStart();
    return () => {
      v.removeEventListener("loadedmetadata", toStart);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("ended", toStart);
    };
  }, [start, end]);
  return <video ref={ref} className={className} src={src} autoPlay muted loop playsInline preload="auto" aria-hidden />;
}
