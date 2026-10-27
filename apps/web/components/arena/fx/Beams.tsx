"use client";
/**
 * Light work around the arena (ShaderMaterial + additive blending):
 *  - <Searchlights/>: sweeping volumetric cones from the rim.
 *  - <Beacon/>: vertical light column above the bounty pot; height follows USDC at risk.
 *  - <AttackArc/>: comet beam along a QuadraticBezierCurve3 (TubeGeometry), revealed by uProgress
 *    along uv.x, with a glowing head; calls onArrive at impact and onDone when faded.
 */
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

const outColor = /* glsl */ `
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
`;

// ───────────────────────────── searchlights ─────────────────────────────

const coneVertex = /* glsl */ `
  uniform float uLength;
  varying float vAlong;
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vAlong = clamp(-position.y / uLength, 0.0, 1.0);
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const coneFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vAlong;
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    float edge = abs(dot(normalize(vN), normalize(cameraPosition - vW)));
    float a = pow(1.0 - vAlong, 1.6) * pow(edge, 1.5) * uOpacity;
    gl_FragColor = vec4(uColor, a);
    ${outColor}
  }
`;

function Searchlight({ origin, color, phase, length, reduced }: { origin: THREE.Vector3; color: string; phase: number; length: number; reduced: boolean }) {
  const pivot = useRef<THREE.Group>(null);
  const geometry = useMemo(() => {
    const g = new THREE.ConeGeometry(2.4, length, 24, 1, true);
    g.translate(0, -length / 2, 0); // apex at the origin, opening downward along -Y
    return g;
  }, [length]);
  const uniforms = useMemo(
    () => ({ uColor: { value: new THREE.Color(color) }, uOpacity: { value: 0.16 }, uLength: { value: length } }),
    [color, length],
  );
  const base = useMemo(() => Math.atan2(-origin.x, -origin.z), [origin]);
  useFrame((state) => {
    if (!pivot.current) return;
    const t = reduced ? 0 : state.clock.elapsedTime;
    pivot.current.rotation.set(0, base + Math.sin(t * 0.35 + phase) * 0.55, 0);
    pivot.current.children[0].rotation.x = -1.05 + Math.sin(t * 0.5 + phase * 2) * 0.12;
  });
  return (
    <group ref={pivot} position={origin}>
      <mesh geometry={geometry}>
        <shaderMaterial uniforms={uniforms} vertexShader={coneVertex} fragmentShader={coneFragment} transparent depthWrite={false} blending={THREE.AdditiveBlending} side={THREE.DoubleSide} />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.18, 12, 8]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </group>
  );
}

export function Searchlights({ radius, height, reduced }: { radius: number; height: number; reduced: boolean }) {
  const lights = useMemo(
    () =>
      [
        ["#ff6a1a", 0.0],
        ["#ff6a1a", 1.7],
        ["#ff6a1a", 3.4],
        ["#ff6a1a", 5.1],
      ].map(([color, phase], i) => {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        return { color: color as string, phase: phase as number, origin: new THREE.Vector3(Math.cos(a) * radius, height, Math.sin(a) * radius) };
      }),
    [radius, height],
  );
  return (
    <group>
      {lights.map((l) => (
        <Searchlight key={l.color} origin={l.origin} color={l.color} phase={l.phase} length={height * 2.6} reduced={reduced} />
      ))}
    </group>
  );
}

// ───────────────────────────── beacon ─────────────────────────────

const beaconVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const beaconFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    float fade = pow(1.0 - vUv.y, 1.8);
    float stripes = 0.6 + 0.4 * smoothstep(0.7, 1.0, sin(vUv.y * 40.0 - uTime * 4.0) * 0.5 + 0.5);
    float sides = 0.65 + 0.35 * sin(vUv.x * 6.2831 * 6.0 + uTime);
    gl_FragColor = vec4(uColor, fade * stripes * sides * uOpacity);
    ${outColor}
  }
`;

export function Beacon({ radius, height, reduced }: { radius: number; height: number; reduced: boolean }) {
  const mesh = useRef<THREE.Mesh>(null);
  const uniforms = useMemo(() => ({ uColor: { value: new THREE.Color("#ff9a5a") }, uTime: { value: 0 }, uOpacity: { value: 0.32 } }), []);
  useFrame((_, dt) => {
    if (!reduced) uniforms.uTime.value += dt;
    if (mesh.current) {
      const s = mesh.current.scale;
      s.y += (height - s.y) * Math.min(1, dt * 1.5);
      mesh.current.position.y = s.y / 2;
    }
  });
  return (
    <mesh ref={mesh} scale={[1, 0.01, 1]}>
      <cylinderGeometry args={[radius * 0.55, radius, 1, 32, 1, true]} />
      <shaderMaterial uniforms={uniforms} vertexShader={beaconVertex} fragmentShader={beaconFragment} transparent depthWrite={false} blending={THREE.AdditiveBlending} side={THREE.DoubleSide} />
    </mesh>
  );
}

// ───────────────────────────── attack arcs ─────────────────────────────

const arcVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const arcFragment = /* glsl */ `
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform float uProgress;
  uniform float uFade;
  varying vec2 vUv;
  void main() {
    float head = uProgress;
    float tail = uProgress - 0.4;
    float a = smoothstep(tail, head, vUv.x) * step(vUv.x, head) * uFade;
    vec3 c = mix(uColorA, uColorB, vUv.x) * (1.0 + smoothstep(head - 0.05, head, vUv.x) * 2.0);
    gl_FragColor = vec4(c, a);
    ${outColor}
  }
`;

export function AttackArc({
  from,
  to,
  colorA,
  colorB,
  duration = 1.4,
  lift = 3.5,
  onArrive,
  onDone,
}: {
  from: [number, number, number];
  to: [number, number, number];
  colorA: string;
  colorB: string;
  duration?: number;
  lift?: number;
  onArrive?: () => void;
  onDone: () => void;
}) {
  const head = useRef<THREE.Mesh>(null);
  const t = useRef(0);
  const arrived = useRef(false);
  const finished = useRef(false);
  const { curve, geometry } = useMemo(() => {
    const a = new THREE.Vector3(...from);
    const b = new THREE.Vector3(...to);
    const mid = a.clone().lerp(b, 0.5);
    mid.y += lift + a.distanceTo(b) * 0.15;
    const c = new THREE.QuadraticBezierCurve3(a, mid, b);
    return { curve: c, geometry: new THREE.TubeGeometry(c, 64, 0.035, 6, false) };
  }, [from, to, lift]);
  const uniforms = useMemo(
    () => ({
      uColorA: { value: new THREE.Color(colorA) },
      uColorB: { value: new THREE.Color(colorB) },
      uProgress: { value: 0 },
      uFade: { value: 1 },
    }),
    [colorA, colorB],
  );
  useFrame((_, dt) => {
    t.current += dt;
    const p = Math.min(1, t.current / duration);
    const eased = 1 - Math.pow(1 - p, 2);
    uniforms.uProgress.value = eased * 1.05;
    if (head.current) {
      curve.getPoint(Math.min(1, eased), head.current.position);
      head.current.visible = p < 1;
    }
    if (p >= 1 && !arrived.current) {
      arrived.current = true;
      onArrive?.();
    }
    if (p >= 1) uniforms.uFade.value = Math.max(0, uniforms.uFade.value - dt * 1.8);
    if (uniforms.uFade.value <= 0 && !finished.current) {
      finished.current = true;
      geometry.dispose();
      onDone();
    }
  });
  return (
    <group>
      <mesh geometry={geometry}>
        <shaderMaterial uniforms={uniforms} vertexShader={arcVertex} fragmentShader={arcFragment} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <mesh ref={head}>
        <sphereGeometry args={[0.12, 12, 8]} />
        <meshBasicMaterial color={colorB} />
        <pointLight color={colorB} intensity={3} distance={3} />
      </mesh>
    </group>
  );
}
