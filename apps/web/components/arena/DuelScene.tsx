"use client";
/**
 * Attack console scene: the agent's core sits inside its energy shield (fresnel shader); every attacker
 * message is a comet that ripples the shield where it lands; every agent decision is a returning comet
 * (cyan refuse · amber hold/escalate · red pay). On breach the shield shatters, particles burst and the
 * bounty (gold coins) flies to the attacker. three.js rules: docs/reference/threejs.md
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Stars, AdaptiveDpr, Trail } from "@react-three/drei";
import * as THREE from "three";
import { agentColor, BREACH, GOLD } from "./palette";
import { EnergyShield } from "./fx/EnergyShield";
import { Burst, Embers } from "./fx/Embers";

export interface DuelShot {
  key: string;
  from: "attacker" | "agent";
  action?: string;
}

const AGENT_POS = new THREE.Vector3(0, 1.4, 0);
const ATTACKER_POS = new THREE.Vector3(0, 1.1, 7.5);
const SHARDS = 90;
const COINS = 24;

function actionColor(action?: string) {
  if (action === "pay") return BREACH;
  if (action === "refuse") return "#ff6a1a";
  return "#ff6a1a";
}

function Projectile({ shot, onDone }: { shot: DuelShot; onDone: () => void }) {
  const ref = useRef<THREE.Mesh>(null);
  const t = useRef(0);
  const done = useRef(false);
  const color = shot.from === "attacker" ? "#ff6a1a" : actionColor(shot.action);
  const [a, b] = shot.from === "attacker" ? [ATTACKER_POS, AGENT_POS] : [AGENT_POS, ATTACKER_POS];
  useFrame((_, dt) => {
    t.current += dt * 1.15;
    const k = Math.min(1, t.current);
    if (ref.current) {
      ref.current.position.lerpVectors(a, b, k);
      ref.current.position.y += Math.sin(k * Math.PI) * 1.4;
      ref.current.position.x += Math.sin(k * Math.PI) * (shot.from === "attacker" ? 0.8 : -0.8);
    }
    if (k >= 1 && !done.current) {
      done.current = true;
      onDone();
    }
  });
  return (
    <Trail width={0.9} length={5} color={color} attenuation={(w) => w * w}>
      <mesh ref={ref} position={a.toArray()}>
        <icosahedronGeometry args={[0.15, 0]} />
        <meshBasicMaterial color={color} />
        <pointLight color={color} intensity={2.5} distance={3} />
      </mesh>
    </Trail>
  );
}

function Shards({ active }: { active: boolean }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const t = useRef(0);
  const scratch = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(), p: new THREE.Vector3(), s: new THREE.Vector3() }), []);
  const dirs = useMemo(
    () => Array.from({ length: SHARDS }, () => new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize().multiplyScalar(2 + Math.random() * 4)),
    [],
  );
  useEffect(() => {
    if (active) t.current = 0;
  }, [active]);
  useFrame((_, dt) => {
    if (!ref.current || !active || t.current > 4) return;
    t.current += dt;
    const { m, q, e, p, s } = scratch;
    for (let i = 0; i < SHARDS; i++) {
      p.copy(AGENT_POS).addScaledVector(dirs[i], Math.min(t.current, 2.5));
      p.y -= 1.5 * Math.max(0, t.current - 0.6) ** 2;
      q.setFromEuler(e.set(t.current * 3 + i, t.current * 2, i));
      s.setScalar(Math.max(0, 1 - t.current / 4));
      m.compose(p, q, s);
      ref.current.setMatrixAt(i, m);
    }
    ref.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, SHARDS]} visible={active} frustumCulled={false}>
      <tetrahedronGeometry args={[0.14, 0]} />
      <meshBasicMaterial color={BREACH} transparent opacity={0.85} />
    </instancedMesh>
  );
}

function Coins({ active }: { active: boolean }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const t = useRef(0);
  const scratch = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(), p: new THREE.Vector3(), one: new THREE.Vector3(1, 1, 1) }), []);
  useEffect(() => {
    if (active) t.current = -0.6;
  }, [active]);
  useFrame((_, dt) => {
    if (!ref.current || !active || t.current > 4) return;
    t.current += dt;
    const { m, q, e, p, one } = scratch;
    for (let i = 0; i < COINS; i++) {
      const k = Math.max(0, Math.min(1, (t.current - i * 0.05) * 0.8));
      p.lerpVectors(AGENT_POS, ATTACKER_POS, k);
      p.y += Math.sin(k * Math.PI) * 2.2 + Math.sin(i) * 0.2;
      p.x += Math.cos(i * 1.7) * 0.4 * Math.sin(k * Math.PI);
      q.setFromEuler(e.set(Math.PI / 2, t.current * 6 + i, 0));
      m.compose(p, q, one);
      ref.current.setMatrixAt(i, m);
    }
    ref.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, COINS]} visible={active} frustumCulled={false}>
      <cylinderGeometry args={[0.16, 0.16, 0.04, 16]} />
      <meshStandardMaterial color={GOLD} emissive={GOLD} emissiveIntensity={0.8} metalness={0.8} roughness={0.2} />
    </instancedMesh>
  );
}

function Agent({ tier, status, thinking, breached, impact }: { tier: number; status: number; thinking: boolean; breached: boolean; impact: number }) {
  const core = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  const color = agentColor(tier, breached ? 2 : status);
  const hitDir = useMemo<[number, number, number]>(() => [0.25, 0.05, 1], []);
  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    if (core.current) {
      core.current.rotation.y += dt * (thinking ? 5 : 1);
      core.current.rotation.x = Math.sin(t) * 0.3;
    }
    if (ring.current) {
      ring.current.rotation.z += dt * (thinking ? 3 : 0.6);
      ring.current.rotation.x = Math.PI / 2 + Math.sin(t * 0.7) * 0.25;
    }
  });
  return (
    <group position={AGENT_POS.toArray()}>
      <mesh ref={core}>
        <octahedronGeometry args={[0.6, 0]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.5} flatShading wireframe={breached} />
      </mesh>
      <mesh ref={ring}>
        <torusGeometry args={[1.05, 0.02, 8, 64]} />
        <meshBasicMaterial color={color} transparent opacity={0.6} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <pointLight color={color} intensity={3} distance={6} />
      {!breached && (
        <group scale={1.9}>
          <EnergyShield color={color} opacity={thinking ? 0.8 : 0.55} hitSignal={impact} hitDir={hitDir} segments={40} />
        </group>
      )}
    </group>
  );
}

function Attacker() {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (ref.current) {
      ref.current.position.y = ATTACKER_POS.y + Math.sin(state.clock.elapsedTime * 2) * 0.08;
      ref.current.rotation.y += 0.01;
    }
  });
  return (
    <mesh ref={ref} position={ATTACKER_POS.toArray()}>
      <coneGeometry args={[0.32, 0.7, 4]} />
      <meshStandardMaterial color="#ff6a1a" emissive="#ff6a1a" emissiveIntensity={0.8} flatShading />
    </mesh>
  );
}

export default function DuelScene({
  tier,
  status,
  shots,
  thinking,
  breached,
  active,
}: {
  tier: number;
  status: number;
  shots: DuelShot[];
  thinking: boolean;
  breached: boolean;
  active: boolean;
}) {
  const [inFlight, setInFlight] = useState<DuelShot[]>([]);
  const [impact, setImpact] = useState(0);
  const [bursts, setBursts] = useState<{ id: number; color: string }[]>([]);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const fresh = shots.filter((s) => !seen.current.has(s.key));
    fresh.forEach((s) => seen.current.add(s.key));
    if (fresh.length) setInFlight((f) => [...f, ...fresh.slice(-4)]);
  }, [shots]);
  useEffect(() => {
    if (breached) setBursts([{ id: 1, color: BREACH }, { id: 2, color: GOLD }]);
  }, [breached]);

  return (
    <Canvas dpr={[1, 1.5]} frameloop={active ? "always" : "never"} camera={{ position: [7.2, 4.4, 12.5], fov: 36 }} gl={{ antialias: true, alpha: false }}>
      <AdaptiveDpr pixelated />
      <color attach="background" args={["#060403"]} />
      <fog attach="fog" args={["#060403", 12, 30]} />
      <hemisphereLight args={["#ff9a5a", "#0b0705", 0.6]} />
      <Stars radius={40} depth={20} count={700} factor={2.5} fade speed={0.5} />
      <mesh rotation-x={-Math.PI / 2}>
        <circleGeometry args={[9, 64]} />
        <meshStandardMaterial color="#120a05" roughness={1} />
      </mesh>
      {[2.2, 4.6, 7].map((r) => (
        <mesh key={r} rotation-x={-Math.PI / 2} position-y={0.01}>
          <ringGeometry args={[r - 0.02, r + 0.02, 96]} />
          <meshBasicMaterial color="#ff6a1a" transparent opacity={0.2} blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
      ))}
      <Embers count={220} radius={2.6} height={4.5} intensity={thinking ? 1.2 : 0.6} color={agentColor(tier, breached ? 2 : status)} />
      <Agent tier={tier} status={status} thinking={thinking} breached={breached} impact={impact} />
      <Attacker />
      {inFlight.map((s) => (
        <Projectile
          key={s.key}
          shot={s}
          onDone={() => {
            setInFlight((f) => f.filter((x) => x.key !== s.key));
            if (s.from === "attacker") setImpact((n) => n + 1);
          }}
        />
      ))}
      {bursts.map((b) => (
        <Burst key={b.id} position={AGENT_POS.toArray() as [number, number, number]} color={b.color} count={220} life={2.4} onDone={() => setBursts((x) => x.filter((y) => y.id !== b.id))} />
      ))}
      <Shards active={breached} />
      <Coins active={breached} />
    </Canvas>
  );
}
