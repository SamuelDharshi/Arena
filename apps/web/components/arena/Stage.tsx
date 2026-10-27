"use client";
/**
 * Lazy 3D stage: loads three.js only on the client, renders only while visible (IntersectionObserver +
 * page visibility), and falls back to a static backdrop when WebGL is unavailable.
 */
import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type ComponentProps } from "react";

const ArenaScene = dynamic(() => import("./ArenaScene"), { ssr: false, loading: () => <Backdrop label="Loading arena…" /> });
const DuelScene = dynamic(() => import("./DuelScene"), { ssr: false, loading: () => <Backdrop label="Loading duel…" /> });

function Backdrop({ label }: { label?: string }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-[radial-gradient(ellipse_at_center,#11182d_0%,#060403_70%)]">
      {label && <span className="font-mono text-xs text-ink-500">{label}</span>}
    </div>
  );
}

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

function useActive() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [pageVisible, setPageVisible] = useState(true);
  const [webgl, setWebgl] = useState<boolean | null>(null);
  useEffect(() => {
    setWebgl(hasWebGL());
    const el = ref.current;
    const io = el ? new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.01 }) : null;
    if (el && io) io.observe(el);
    const onVis = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => {
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  return { ref, active: visible && pageVisible, webgl };
}

export function ArenaStage(props: Omit<ComponentProps<typeof ArenaScene>, "active"> & { className?: string }) {
  const { ref, active, webgl } = useActive();
  const { className, ...rest } = props;
  return (
    <div ref={ref} className={`relative overflow-hidden ${className ?? ""}`}>
      {webgl === false ? <Backdrop label="WebGL unavailable — showing the table view" /> : webgl && <ArenaScene {...rest} active={active} />}
    </div>
  );
}

export function DuelStage(props: Omit<ComponentProps<typeof DuelScene>, "active"> & { className?: string }) {
  const { ref, active, webgl } = useActive();
  const { className, ...rest } = props;
  return (
    <div ref={ref} className={`relative overflow-hidden ${className ?? ""}`}>
      {webgl === false ? <Backdrop label="WebGL unavailable" /> : webgl && <DuelScene {...rest} active={active} />}
    </div>
  );
}
