"use client";
/**
 * Fresnel energy shield (ShaderMaterial — docs/reference/threejs.md).
 * Rim glow + spherical lattice + scanlines; `hitSignal` increments trigger a directional impact ripple;
 * `breached` makes it glitch/flicker. All animation is in the fragment shader (one uniform write per frame).
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

const vertexShader = /* glsl */ `
  varying vec3 vN;
  varying vec3 vW;
  varying vec3 vL;
  void main() {
    vL = position;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uHit;
  uniform vec3 uHitDir;
  uniform float uBreach;
  varying vec3 vN;
  varying vec3 vW;
  varying vec3 vL;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    vec3 V = normalize(cameraPosition - vW);
    float fres = pow(1.0 - abs(dot(normalize(vN), V)), 2.2);

    vec3 n = normalize(vL);
    vec2 sph = vec2(atan(n.z, n.x) * 2.5, n.y * 5.0);
    vec2 g = abs(fract(sph * vec2(1.0, 1.15) + vec2(0.0, uTime * 0.05)) - 0.5);
    float lattice = smoothstep(0.44, 0.5, max(g.x, g.y));
    float scan = smoothstep(0.965, 1.0, sin(n.y * 22.0 - uTime * 3.0) * 0.5 + 0.5);
    float facing = dot(n, normalize(uHitDir)) * 0.5 + 0.5;
    float ring = smoothstep(0.08, 0.0, abs(facing - (1.0 - uHit * 0.9)));   // expanding ripple
    float hit = uHit * (pow(facing, 6.0) + ring);

    float a = fres * 0.85 + lattice * 0.16 + scan * 0.22 + hit * 1.4;
    vec3 col = uColor * (1.0 + hit * 2.5);
    if (uBreach > 0.5) {
      float flick = step(0.42, hash(floor(sph * 2.0) + floor(uTime * 14.0)));
      a *= flick * (0.55 + 0.45 * sin(uTime * 31.0));
      col = mix(col, vec3(1.0, 0.25, 0.3), 0.6);
    }
    gl_FragColor = vec4(col, a * uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function EnergyShield({
  color,
  opacity = 0.5,
  breached = false,
  hitSignal = 0,
  hitDir = [0, 0, 1],
  reduced = false,
  segments = 32,
}: {
  color: string;
  opacity?: number;
  breached?: boolean;
  hitSignal?: number;
  hitDir?: [number, number, number];
  reduced?: boolean;
  segments?: number;
}) {
  const uniforms = useMemo(
    () => ({
      uColor: { value: new THREE.Color(color) },
      uTime: { value: 0 },
      uOpacity: { value: opacity },
      uHit: { value: 0 },
      uHitDir: { value: new THREE.Vector3(...hitDir) },
      uBreach: { value: breached ? 1 : 0 },
    }),
    // uniforms object is created once; values are updated below
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const hit = useRef(0);

  useEffect(() => {
    uniforms.uColor.value.set(color);
    uniforms.uOpacity.value = opacity;
    uniforms.uBreach.value = breached ? 1 : 0;
    uniforms.uHitDir.value.set(...hitDir);
  }, [color, opacity, breached, hitDir, uniforms]);

  useEffect(() => {
    if (hitSignal > 0) hit.current = 1;
  }, [hitSignal]);

  useFrame((_, dt) => {
    if (!reduced) uniforms.uTime.value += dt;
    hit.current = Math.max(0, hit.current - dt * 1.6);
    uniforms.uHit.value = hit.current;
  });

  return (
    <mesh>
      <sphereGeometry args={[1, segments, Math.round(segments * 0.7)]} />
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}
