"use client";
/**
 * Colosseum crowd: seats + ~288 spectators on one InstancedMesh with a custom ShaderMaterial.
 * The stadium wave and "cheer" bounce run in the vertex shader from per-instance attributes
 * (InstancedBufferAttribute aAngle/aSeed/aColor) + uTime/uCheer, so the CPU does no per-frame work.
 * `cheerSignal` increments make the crowd erupt (tinted by `cheerColor`) and decay.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

const ROWS = 3;
const PER_ROW = 96;
const COUNT = ROWS * PER_ROW;

const vertexShader = /* glsl */ `
  attribute float aAngle;
  attribute float aSeed;
  attribute vec3 aColor;
  uniform float uTime;
  uniform float uWave;
  uniform float uCheer;
  uniform vec3 uCheerColor;
  varying vec3 vColor;
  void main() {
    float wave = smoothstep(0.82, 1.0, sin(aAngle - uTime * 1.4) * 0.5 + 0.5) * uWave;
    float bounce = uCheer * abs(sin(uTime * 10.0 + aSeed * 6.2831));
    float lift = wave * 0.42 + bounce * 0.32;
    vec3 p = position;
    p.y += lift;
    p.xz *= 1.0 + bounce * 0.15;
    #ifdef USE_INSTANCING
      vec4 world = modelMatrix * instanceMatrix * vec4(p, 1.0);
    #else
      vec4 world = modelMatrix * vec4(p, 1.0);
    #endif
    vColor = mix(aColor, uCheerColor, uCheer * 0.65) * (0.6 + lift * 1.8 + uCheer * 0.5);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const PALETTE = ["#ff6a1a", "#ff6a1a", "#ff6a1a", "#ff6a1a", "#ff6a1a", "#ff8a3d", "#c2500f"];

export function Crowd({
  innerRadius,
  cheerSignal,
  cheerColor,
  reduced,
}: {
  innerRadius: number;
  cheerSignal: number;
  cheerColor: string;
  reduced: boolean;
}) {
  const crowd = useRef<THREE.InstancedMesh>(null);
  const seats = useRef<THREE.InstancedMesh>(null);
  const cheer = useRef(0);

  const geometry = useMemo(() => {
    const g = new THREE.CapsuleGeometry(0.09, 0.17, 2, 6);
    g.translate(0, 0.22, 0);
    const angle = new Float32Array(COUNT);
    const seed = new Float32Array(COUNT);
    const color = new Float32Array(COUNT * 3);
    const c = new THREE.Color();
    for (let row = 0; row < ROWS; row++) {
      for (let i = 0; i < PER_ROW; i++) {
        const k = row * PER_ROW + i;
        angle[k] = (i / PER_ROW) * Math.PI * 2;
        seed[k] = Math.random();
        c.set(PALETTE[Math.floor(Math.random() * PALETTE.length)]).multiplyScalar(0.55);
        color.set([c.r, c.g, c.b], k * 3);
      }
    }
    g.setAttribute("aAngle", new THREE.InstancedBufferAttribute(angle, 1));
    g.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seed, 1));
    g.setAttribute("aColor", new THREE.InstancedBufferAttribute(color, 3));
    return g;
  }, []);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uWave: { value: reduced ? 0 : 1 },
      uCheer: { value: 0 },
      uCheerColor: { value: new THREE.Color(cheerColor) },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Static placement (written once): spectators stand on stepped rows of seats.
  useEffect(() => {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    const s = new THREE.Vector3(1, 1, 1);
    for (let row = 0; row < ROWS; row++) {
      const r = innerRadius + 2.2 + row * 1.05;
      const y = 0.35 + row * 0.62;
      for (let i = 0; i < PER_ROW; i++) {
        const k = row * PER_ROW + i;
        const a = (i / PER_ROW) * Math.PI * 2;
        q.setFromAxisAngle(up, -a);
        p.set(Math.cos(a) * r, y - 0.1, Math.sin(a) * r);
        m.compose(p, q, s.set(1, 1, 1));
        seats.current!.setMatrixAt(k, m);
        p.set(Math.cos(a) * (r + 0.05), y + 0.05, Math.sin(a) * (r + 0.05));
        m.compose(p, q, s.set(1, 0.9 + ((k * 13) % 7) * 0.05, 1));
        crowd.current!.setMatrixAt(k, m);
      }
    }
    seats.current!.instanceMatrix.needsUpdate = true;
    crowd.current!.instanceMatrix.needsUpdate = true;
  }, [innerRadius]);

  useEffect(() => {
    uniforms.uCheerColor.value.set(cheerColor);
    if (cheerSignal > 0) cheer.current = 1;
  }, [cheerSignal, cheerColor, uniforms]);

  useFrame((_, dt) => {
    if (!reduced) uniforms.uTime.value += dt;
    cheer.current = Math.max(0, cheer.current - dt * 0.45);
    uniforms.uCheer.value = reduced ? 0 : cheer.current;
  });

  return (
    <group>
      <instancedMesh ref={seats} args={[undefined, undefined, COUNT]} frustumCulled={false}>
        <boxGeometry args={[0.5, 0.2, 0.8]} />
        <meshStandardMaterial color="#2a170a" roughness={0.9} metalness={0.1} />
      </instancedMesh>
      <instancedMesh ref={crowd} args={[geometry, undefined, COUNT]} frustumCulled={false}>
        <shaderMaterial uniforms={uniforms} vertexShader={vertexShader} fragmentShader={fragmentShader} />
      </instancedMesh>
    </group>
  );
}
