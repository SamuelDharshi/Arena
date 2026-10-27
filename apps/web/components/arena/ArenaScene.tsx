"use client";
/**
 * The Colosseum. Every registered agent is a champion on the arena floor:
 *   pillar height ∝ on-chain score · core color = proven tier (red = breached, grey = suspended)
 *   energy shield ∝ bounty at risk · red motes = live attack sessions
 * Ambient: intro camera flight, crowd stadium-wave, embers + beacon over the bounty pot, searchlights.
 * Event-driven (real chain events via SSE only): SessionOpened → attack arc from the stands into the shield;
 * Breach → shield glitch, particle burst, gold arc back out, crowd erupts red, camera shake;
 * SessionSurvived → green burst + cheer.
 * three.js usage & performance rules: docs/reference/threejs.md
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, OrbitControls, Stars, AdaptiveDpr, PerformanceMonitor } from "@react-three/drei";
import * as THREE from "three";
type OrbitControlsImpl = React.ElementRef<typeof OrbitControls>;
import { agentColor, BREACH, GOLD } from "./palette";
import { EnergyShield } from "./fx/EnergyShield";
import { Crowd } from "./fx/Crowd";
import { Burst, Embers } from "./fx/Embers";
import { AttackArc, Beacon, Searchlights } from "./fx/Beams";

export interface ArenaAgent {
  id: string;
  name: string;
  tier: number;
  score: number;
  status: number;
  bounty: number; // USDC (float)
  live: number;
}

export interface ArenaPulse {
  key: number;
  agentId: string;
  kind: "breach" | "survived" | "session";
}

const ARENA_R = 6.2;

function positionFor(i: number, n: number): [number, number, number] {
  if (n === 1) return [0, 0, 0];
  const a = (i / n) * Math.PI * 2 - Math.PI / 2;
  const r = n <= 4 ? ARENA_R * 0.55 : ARENA_R * 0.7;
  return [Math.cos(a) * r, 0, Math.sin(a) * r];
}

const heightFor = (score: number) => 0.5 + (score / 1000) * 3.2;

function standPoint(): [number, number, number] {
  const a = Math.random() * Math.PI * 2;
  const r = ARENA_R + 3.2 + Math.random() * 1.6;
  return [Math.cos(a) * r, 1.4 + Math.random() * 0.8, Math.sin(a) * r];
}

// ───────────────────────────── set pieces ─────────────────────────────

function Architecture() {
  const arches = useRef<THREE.InstancedMesh>(null);
  const count = 40;
  useEffect(() => {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    const s = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      p.set(Math.cos(a) * (ARENA_R + 5.6), 1.9, Math.sin(a) * (ARENA_R + 5.6));
      q.setFromAxisAngle(up, -a);
      m.compose(p, q, s);
      arches.current!.setMatrixAt(i, m);
    }
    arches.current!.instanceMatrix.needsUpdate = true;
  }, []);
  return (
    <group>
      <instancedMesh ref={arches} args={[undefined, undefined, count]} frustumCulled={false}>
        <boxGeometry args={[0.35, 3.8, 0.35]} />
        <meshStandardMaterial color="#3a2210" emissive="#331a08" roughness={0.7} />
      </instancedMesh>
      <mesh rotation-x={-Math.PI / 2} position-y={3.85}>
        <ringGeometry args={[ARENA_R + 5.35, ARENA_R + 5.55, 96]} />
        <meshBasicMaterial color="#ff6a1a" transparent opacity={0.35} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
    </group>
  );
}

function Floor({ atRisk, reduced }: { atRisk: number; reduced: boolean }) {
  const rings = useRef<THREE.Group>(null);
  const core = useRef<THREE.Mesh>(null);
  useFrame((state, dt) => {
    if (reduced) return;
    if (rings.current) rings.current.rotation.y += dt * 0.05;
    if (core.current) {
      core.current.rotation.z += dt * 0.4;
      const s = 1 + Math.sin(state.clock.elapsedTime * 2.2) * 0.04;
      core.current.scale.set(s, s, s);
    }
  });
  const coreSize = 0.6 + Math.min(1.4, Math.log10(1 + atRisk) * 0.6);
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.01}>
        <circleGeometry args={[ARENA_R + 1.6, 96]} />
        <meshStandardMaterial color="#120a05" roughness={0.95} />
      </mesh>
      <group ref={rings}>
        {[1.2, 2.6, 4.2, ARENA_R + 1.2].map((r, i) => (
          <mesh key={r} rotation-x={-Math.PI / 2} position-y={0.005}>
            <ringGeometry args={[r - 0.025, r + 0.025, 128]} />
            <meshBasicMaterial color={i === 3 ? "#ff6a1a" : "#ff6a1a"} transparent opacity={i === 3 ? 0.55 : 0.18} blending={THREE.AdditiveBlending} depthWrite={false} />
          </mesh>
        ))}
        {Array.from({ length: 12 }).map((_, i) => (
          <mesh key={i} rotation-x={-Math.PI / 2} rotation-z={(i / 12) * Math.PI * 2} position-y={0.004}>
            <planeGeometry args={[0.02, ARENA_R * 2 + 2.4]} />
            <meshBasicMaterial color="#ff6a1a" transparent opacity={0.06} depthWrite={false} />
          </mesh>
        ))}
      </group>
      <mesh ref={core} rotation-x={-Math.PI / 2} position-y={0.02}>
        <ringGeometry args={[coreSize * 0.55, coreSize, 6]} />
        <meshBasicMaterial color={GOLD} transparent opacity={0.5} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <Beacon radius={coreSize * 0.55} height={1.5 + Math.min(6, Math.log10(1 + atRisk) * 2.6)} reduced={reduced} />
      <Embers radius={coreSize} intensity={Math.min(1.5, 0.3 + Math.log10(1 + atRisk) * 0.5)} reduced={reduced} />
      <pointLight position={[0, 1.2, 0]} color={GOLD} intensity={4} distance={6} />
    </group>
  );
}

// ───────────────────────────── champions ─────────────────────────────

function Champion({
  agent,
  pos,
  reduced,
  hovered,
  onHover,
  onSelect,
  hit,
  labels = true,
}: {
  agent: ArenaAgent;
  pos: [number, number, number];
  reduced: boolean;
  hovered: boolean;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  hit: { signal: number; dir: [number, number, number] };
  labels?: boolean;
}) {
  const color = agentColor(agent.tier, agent.status);
  const height = heightFor(agent.score);
  const core = useRef<THREE.Mesh>(null);
  const pillar = useRef<THREE.Mesh>(null);
  const motes = useRef<THREE.Group>(null);
  const shieldR = 0.9 + Math.min(1.1, Math.log10(1 + agent.bounty) * 0.55);
  const shownHeight = useRef(0.2);

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    // Pillar grows smoothly to the on-chain score (also animates live score changes).
    shownHeight.current += (height - shownHeight.current) * Math.min(1, dt * (reduced ? 50 : 1.8));
    const h = shownHeight.current;
    if (pillar.current) {
      pillar.current.scale.y = h;
      pillar.current.position.y = 0.24 + h / 2;
    }
    if (core.current) {
      core.current.position.y = h + 0.55 + (reduced ? 0 : Math.sin(t * 1.6 + pos[0]) * 0.08);
      if (!reduced) core.current.rotation.y += dt * (agent.status === 2 ? 4 : 1.1);
    }
    if (motes.current && !reduced) motes.current.rotation.y += dt * 1.8;
  });

  const over = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    onHover(agent.id);
    document.body.style.cursor = "pointer";
  };
  const out = () => {
    onHover(null);
    document.body.style.cursor = "";
  };

  return (
    <group position={pos}>
      <mesh position-y={0.12}>
        <cylinderGeometry args={[0.75, 0.9, 0.24, 8]} />
        <meshStandardMaterial color="#24150a" metalness={0.4} roughness={0.5} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.245}>
        <ringGeometry args={[0.55, 0.72, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.8} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <mesh ref={pillar} onPointerOver={over} onPointerOut={out} onClick={() => onSelect(agent.id)}>
        <cylinderGeometry args={[0.16, 0.24, 1, 6]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={hovered ? 0.9 : 0.45} metalness={0.3} roughness={0.35} />
      </mesh>
      <mesh ref={core} onPointerOver={over} onPointerOut={out} onClick={() => onSelect(agent.id)}>
        <octahedronGeometry args={[0.38, 0]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.4} wireframe={agent.status === 2} flatShading />
      </mesh>
      <pointLight position-y={height + 0.6} color={color} intensity={hovered ? 3 : 1.6} distance={3.2} />
      <group position-y={height * 0.5 + 0.3} scale={[shieldR, (height + 1.4) / 2, shieldR]}>
        <EnergyShield
          color={color}
          opacity={hovered ? 0.75 : 0.45}
          breached={agent.status === 2}
          hitSignal={hit.signal}
          hitDir={hit.dir}
          reduced={reduced}
          segments={28}
        />
      </group>
      <group ref={motes} position-y={height * 0.5 + 0.4}>
        {Array.from({ length: Math.min(agent.live, 8) }).map((_, i) => {
          const a = (i / Math.max(1, agent.live)) * Math.PI * 2;
          return (
            <mesh key={i} position={[Math.cos(a) * (shieldR + 0.25), Math.sin(a * 2) * 0.4, Math.sin(a) * (shieldR + 0.25)]}>
              <sphereGeometry args={[0.07, 8, 6]} />
              <meshBasicMaterial color={BREACH} />
            </mesh>
          );
        })}
      </group>
      {labels && <Html position={[0, height + 1.25, 0]} center distanceFactor={11} zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
        <div className="select-none whitespace-nowrap text-center font-mono leading-tight">
          <div className="text-[13px] font-semibold text-white drop-shadow">{agent.name}</div>
          <div className="text-[11px]" style={{ color }}>
            {agent.status === 2 ? "BREACHED" : agent.status === 3 ? "SUSPENDED" : `T${agent.tier} · ${agent.score}`}
          </div>
        </div>
      </Html>}
    </group>
  );
}

// ───────────────────────────── cinematic director ─────────────────────────────

export const CINEMATIC_SHOT_SECONDS = 5.5;
type V3 = [number, number, number];
interface Shot {
  path: (k: number, out: THREE.Vector3) => void;
  look: (k: number, out: THREE.Vector3) => void;
}
const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const lerpV = (a: V3, b: V3) => (k: number, out: THREE.Vector3) => out.set(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k);

function buildShots(spots: { pos: V3; h: number }[]): Shot[] {
  const a = spots[0] ?? { pos: [0, 0, 0] as V3, h: 1 };
  const b = spots[1] ?? a;
  const head = (s: { pos: V3; h: number }): V3 => [s.pos[0], s.h * 0.6 + 0.8, s.pos[2]];
  const ha = head(a);
  const hb = head(b);
  // push-in direction: from the arena centre outwards through agent A
  const len = Math.hypot(a.pos[0], a.pos[2]) || 1;
  const dir: V3 = [a.pos[0] / len, 0, a.pos[2] / len];
  return [
    // 1 · establishing crane down into the colosseum
    { path: lerpV([0, 24, 24], [0, 8.5, 15]), look: lerpV([0, 0, 0], [0, 1.2, 0]) },
    // 2 · low dolly across the floor, crowd sweeping past
    { path: lerpV([-12, 1.3, 7.5], [12, 1.9, 7.5]), look: lerpV([-2, 1.4, 0], [2, 1.4, 0]) },
    // 3 · push-in on a champion's shield
    {
      path: lerpV([ha[0] + dir[0] * 9, ha[1] + 2.5, ha[2] + dir[2] * 9], [ha[0] + dir[0] * 3.2, ha[1] + 0.6, ha[2] + dir[2] * 3.2]),
      look: lerpV(ha, ha),
    },
    // 4 · orbit a second champion
    {
      path: (k, out) => {
        const ang = Math.atan2(hb[2], hb[0]) + Math.PI * 0.5 + k * Math.PI * 0.9;
        out.set(hb[0] + Math.cos(ang) * 4.6, hb[1] + 1.2, hb[2] + Math.sin(ang) * 4.6);
      },
      look: lerpV(hb, hb),
    },
    // 5 · crane up out of the bounty beacon
    { path: lerpV([0, 1.6, 5.5], [0, 15, 4]), look: lerpV([0, 2.5, 0], [0, 0.5, 0]) },
  ];
}

/** Scripted multi-shot camera that loops forever; reports the active shot for synced titles. */
function CinematicCamera({ spots, onShot }: { spots: { pos: V3; h: number }[]; onShot?: (i: number) => void }) {
  const camera = useThree((s) => s.camera);
  const shots = useMemo(() => buildShots(spots), [spots]);
  const t = useRef(0);
  const last = useRef(-1);
  const p = useMemo(() => new THREE.Vector3(), []);
  const l = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, dt) => {
    t.current += Math.min(dt, 0.1);
    const total = shots.length * CINEMATIC_SHOT_SECONDS;
    const tt = t.current % total;
    const i = Math.floor(tt / CINEMATIC_SHOT_SECONDS);
    const k = ease((tt % CINEMATIC_SHOT_SECONDS) / CINEMATIC_SHOT_SECONDS);
    shots[i].path(k, p);
    shots[i].look(k, l);
    camera.position.copy(p);
    camera.lookAt(l);
    if (i !== last.current) {
      last.current = i;
      onShot?.(i);
    }
  });
  return null;
}

// ───────────────────────────── camera ─────────────────────────────

/** Eased fly-in from high above the colosseum, then hands over to OrbitControls. */
function CameraRig({ reduced, narrow }: { reduced: boolean; narrow: boolean }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera);
  const t = useRef(reduced ? 1 : 0);
  const rest = useMemo(() => new THREE.Vector3(...(narrow ? [0, 9.5, 19.5] : [0, 6.4, 13.2])), [narrow]);
  const start = useMemo(() => new THREE.Vector3(0, 30, 6), []);
  const target = useMemo(() => new THREE.Vector3(0, 0.9, 0), []);
  const tmp = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    camera.position.copy(reduced ? rest : start);
    camera.lookAt(target);
  }, [camera, reduced, rest, start, target]);

  useFrame((_, dt) => {
    const c = controls.current;
    if (!c || t.current >= 1) return;
    t.current = Math.min(1, t.current + dt / 3.2);
    const e = 1 - Math.pow(1 - t.current, 3);
    // swing around while descending for a cinematic entrance
    const angle = (1 - e) * Math.PI * 0.9;
    tmp.lerpVectors(start, rest, e);
    const r = Math.hypot(tmp.x, tmp.z);
    camera.position.set(Math.sin(angle) * r, tmp.y, Math.cos(angle) * r);
    camera.lookAt(target);
    c.enabled = t.current >= 1;
    if (t.current >= 1) c.update();
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enabled={reduced}
      target={[0, 0.9, 0]}
      enablePan={false}
      enableDamping
      autoRotate={!reduced}
      autoRotateSpeed={0.35}
      minDistance={7}
      maxDistance={narrow ? 24 : 17}
      minPolarAngle={0.35}
      maxPolarAngle={1.18}
    />
  );
}

/** Shakes the world (not the camera) so OrbitControls state is never disturbed. */
function Shaker({ signal, children }: { signal: number; children: React.ReactNode }) {
  const group = useRef<THREE.Group>(null);
  const amp = useRef(0);
  useEffect(() => {
    if (signal > 0) amp.current = 0.22;
  }, [signal]);
  useFrame((state, dt) => {
    amp.current = Math.max(0, amp.current - dt * 0.35);
    if (!group.current) return;
    const t = state.clock.elapsedTime * 60;
    group.current.position.set(Math.sin(t * 1.3) * amp.current, Math.sin(t * 1.7) * amp.current * 0.5, Math.cos(t * 1.1) * amp.current);
  });
  return <group ref={group}>{children}</group>;
}

// ───────────────────────────── effects ─────────────────────────────

type Effect =
  | { id: number; type: "arc"; from: [number, number, number]; to: [number, number, number]; colorA: string; colorB: string; agentId?: string }
  | { id: number; type: "burst"; at: [number, number, number]; color: string; count: number };

export default function ArenaScene({
  agents,
  pulses,
  onSelect,
  active,
  cinematic = false,
  onShot,
}: {
  agents: ArenaAgent[];
  pulses: ArenaPulse[];
  onSelect: (id: string) => void;
  active: boolean;
  /** Scripted film mode for the landing hero (no orbit controls). */
  cinematic?: boolean;
  onShot?: (i: number) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [dpr, setDpr] = useState(1.5);
  const [effects, setEffects] = useState<Effect[]>([]);
  const [hits, setHits] = useState<Record<string, { signal: number; dir: [number, number, number] }>>({});
  const [cheer, setCheer] = useState({ signal: 0, color: "#ff6a1a" });
  const [shake, setShake] = useState(0);
  const seen = useRef(new Set<number>());
  const nextId = useRef(1);

  const reduced = useMemo(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);
  const narrow = useMemo(() => typeof window !== "undefined" && window.innerWidth < 640, []);
  const atRisk = agents.reduce((s, a) => s + (a.status === 1 ? a.bounty : 0), 0);

  const placed = useMemo(() => {
    const m = new Map<string, { pos: [number, number, number]; agent: ArenaAgent }>();
    agents.forEach((a, i) => m.set(a.id, { pos: positionFor(i, agents.length), agent: a }));
    return m;
  }, [agents]);

  const spots = useMemo(() => agents.map((a) => ({ pos: placed.get(a.id)!.pos, h: heightFor(a.score) })), [agents, placed]);

  const hitAgent = useCallback(
    (agentId: string, from: [number, number, number]) => {
      const p = placed.get(agentId);
      if (!p) return;
      const d = new THREE.Vector3(from[0] - p.pos[0], from[1] - heightFor(p.agent.score) * 0.5, from[2] - p.pos[2]).normalize();
      setHits((h) => ({ ...h, [agentId]: { signal: (h[agentId]?.signal ?? 0) + 1, dir: [d.x, d.y, d.z] } }));
    },
    [placed],
  );

  // Real on-chain events → effects. Nothing here fires without a chain event.
  useEffect(() => {
    if (reduced) return;
    const add: Effect[] = [];
    for (const p of pulses) {
      if (seen.current.has(p.key)) continue;
      seen.current.add(p.key);
      const target = placed.get(p.agentId);
      if (!target) continue;
      const [x, , z] = target.pos;
      const h = heightFor(target.agent.score);
      const chest: [number, number, number] = [x, h * 0.6 + 0.4, z];
      if (p.kind === "session") {
        add.push({ id: nextId.current++, type: "arc", from: standPoint(), to: chest, colorA: "#ff6a1a", colorB: BREACH, agentId: p.agentId });
      } else if (p.kind === "breach") {
        add.push({ id: nextId.current++, type: "burst", at: chest, color: BREACH, count: 260 });
        add.push({ id: nextId.current++, type: "burst", at: chest, color: GOLD, count: 140 });
        add.push({ id: nextId.current++, type: "arc", from: chest, to: standPoint(), colorA: GOLD, colorB: GOLD });
        setCheer((c) => ({ signal: c.signal + 1, color: BREACH }));
        setShake((s) => s + 1);
      } else if (p.kind === "survived") {
        add.push({ id: nextId.current++, type: "burst", at: chest, color: "#ff6a1a", count: 120 });
        setCheer((c) => ({ signal: c.signal + 1, color: "#ff6a1a" }));
      }
    }
    if (add.length) setEffects((e) => [...e, ...add].slice(-24));
  }, [pulses, placed, reduced]);

  const removeEffect = useCallback((id: number) => setEffects((e) => e.filter((x) => x.id !== id)), []);

  return (
    <Canvas
      dpr={dpr}
      frameloop={active ? "always" : "never"}
      camera={{ position: [0, 30, 6], fov: 44, near: 0.1, far: 140 }}
      gl={{ antialias: true, powerPreference: "high-performance", alpha: false }}
      onPointerMissed={() => setHovered(null)}
    >
      <PerformanceMonitor onDecline={() => setDpr(1)} onIncline={() => setDpr(1.5)} />
      <AdaptiveDpr pixelated />
      <color attach="background" args={["#060403"]} />
      <fog attach="fog" args={["#060403", 18, 44]} />
      <hemisphereLight args={["#ff9a5a", "#0b0705", 0.55]} />
      <directionalLight position={[6, 12, 4]} intensity={0.6} color="#ffd2b0" />
      <Stars radius={70} depth={30} count={1400} factor={3} fade speed={reduced ? 0 : 0.6} />
      <Shaker signal={shake}>
        <Floor atRisk={atRisk} reduced={reduced} />
        <Crowd innerRadius={ARENA_R} cheerSignal={cheer.signal} cheerColor={cheer.color} reduced={reduced} />
        <Architecture />
        <Searchlights radius={ARENA_R + 5.6} height={4.4} reduced={reduced} />
        {agents.map((a) => (
          <Champion
            key={a.id}
            agent={a}
            pos={placed.get(a.id)!.pos}
            reduced={reduced}
            hovered={hovered === a.id}
            onHover={setHovered}
            onSelect={onSelect}
            hit={hits[a.id] ?? { signal: 0, dir: [0, 0, 1] }}
            labels={!(cinematic && !reduced)}
          />
        ))}
        {effects.map((fx) =>
          fx.type === "arc" ? (
            <AttackArc
              key={fx.id}
              from={fx.from}
              to={fx.to}
              colorA={fx.colorA}
              colorB={fx.colorB}
              onArrive={fx.agentId ? () => hitAgent(fx.agentId!, fx.from) : undefined}
              onDone={() => removeEffect(fx.id)}
            />
          ) : (
            <Burst key={fx.id} position={fx.at} color={fx.color} count={fx.count} onDone={() => removeEffect(fx.id)} />
          ),
        )}
      </Shaker>
      {cinematic && !reduced ? (
        <CinematicCamera
          spots={spots}
          onShot={onShot}
        />
      ) : (
        <CameraRig reduced={reduced} narrow={narrow} />
      )}
    </Canvas>
  );
}
