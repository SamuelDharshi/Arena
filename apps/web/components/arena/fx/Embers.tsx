"use client";
/**
 * GPU particles (Points + ShaderMaterial — docs/reference/threejs.md):
 *  - <Embers/>: gold motes spiralling up from the bounty pot; density/size follow USDC at risk.
 *  - <Burst/>:  one-shot explosion (breach / survival) with gravity, self-removing via onDone.
 * Positions are computed in the vertex shader from uTime + per-particle seeds (no CPU per frame).
 */
import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

const softDot = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d) * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor * (1.0 + (1.0 - d * 2.0)), a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const embersVertex = /* glsl */ `
  attribute vec3 aSeed;           // x: phase, y: radius, z: speed
  uniform float uTime;
  uniform float uIntensity;
  uniform float uPixelRatio;
  uniform float uHeight;
  varying float vAlpha;
  void main() {
    float life = fract(uTime * aSeed.z + aSeed.x);
    float ang = aSeed.x * 6.2831 + life * 3.0;
    float r = aSeed.y * (1.0 - life * 0.55);
    vec3 p = vec3(cos(ang) * r, life * uHeight, sin(ang) * r);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = (1.0 - life) * 34.0 * uPixelRatio * (0.5 + uIntensity * 0.5) / -mv.z;
    gl_Position = projectionMatrix * mv;
    vAlpha = smoothstep(0.0, 0.08, life) * (1.0 - life) * (0.35 + uIntensity * 0.65);
  }
`;

export function Embers({ count = 700, radius = 1.4, height = 7, intensity = 1, color = "#ff9a5a", reduced = false }: {
  count?: number;
  radius?: number;
  height?: number;
  intensity?: number;
  color?: string;
  reduced?: boolean;
}) {
  const dpr = useThree((s) => s.viewport.dpr);
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) seeds.set([Math.random(), 0.15 + Math.random() * radius, 0.06 + Math.random() * 0.12], i * 3);
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 3));
    return g;
  }, [count, radius]);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uIntensity: { value: intensity },
      uPixelRatio: { value: dpr },
      uHeight: { value: height },
      uColor: { value: new THREE.Color(color) },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useFrame((_, dt) => {
    if (!reduced) uniforms.uTime.value += dt;
    uniforms.uIntensity.value += (intensity - uniforms.uIntensity.value) * Math.min(1, dt * 2);
    uniforms.uPixelRatio.value = dpr;
  });
  return (
    <points geometry={geometry} frustumCulled={false}>
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={embersVertex}
        fragmentShader={softDot}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

const burstVertex = /* glsl */ `
  attribute vec3 aDir;
  attribute float aSpeed;
  uniform float uT;
  uniform float uPixelRatio;
  uniform float uLife;
  varying float vAlpha;
  void main() {
    float t = uT;
    vec3 p = aDir * aSpeed * (1.0 - exp(-t * 3.0)) / 3.0 * 4.0;
    p.y -= 1.6 * t * t;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float k = clamp(1.0 - t / uLife, 0.0, 1.0);
    gl_PointSize = (8.0 + aSpeed * 4.0) * k * uPixelRatio * 6.0 / -mv.z;
    gl_Position = projectionMatrix * mv;
    vAlpha = k;
  }
`;

export function Burst({ position, color, count = 180, life = 1.8, onDone }: {
  position: [number, number, number];
  color: string;
  count?: number;
  life?: number;
  onDone: () => void;
}) {
  const dpr = useThree((s) => s.viewport.dpr);
  const done = useRef(false);
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const dir = new Float32Array(count * 3);
    const speed = new Float32Array(count);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      v.set(Math.random() - 0.5, Math.random() * 0.9 + 0.1, Math.random() - 0.5).normalize();
      dir.set([v.x, v.y, v.z], i * 3);
      speed[i] = 0.6 + Math.random() * 1.6;
    }
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute("aDir", new THREE.BufferAttribute(dir, 3));
    g.setAttribute("aSpeed", new THREE.BufferAttribute(speed, 1));
    return g;
  }, [count]);
  const uniforms = useMemo(
    () => ({ uT: { value: 0 }, uPixelRatio: { value: dpr }, uLife: { value: life }, uColor: { value: new THREE.Color(color) } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useFrame((_, dt) => {
    uniforms.uT.value += dt;
    if (!done.current && uniforms.uT.value > life) {
      done.current = true;
      onDone();
    }
  });
  return (
    <points geometry={geometry} position={position} frustumCulled={false}>
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={burstVertex}
        fragmentShader={softDot}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}
