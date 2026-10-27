# three.js — reference for the arena scenes

Pinned: `three@0.170.0` (r170) with `@react-three/fiber@8.18` and `@react-three/drei@9.122` (`apps/web/package.json`).
Docs: <https://threejs.org/docs/> (always latest). Version-exact pages live in the repo: `https://github.com/mrdoob/three.js/tree/r170/docs/api/en/…` — e.g. [ShaderMaterial](https://github.com/mrdoob/three.js/blob/r170/docs/api/en/materials/ShaderMaterial.html), [InstancedMesh](https://github.com/mrdoob/three.js/blob/r170/docs/api/en/objects/InstancedMesh.html), [Points](https://github.com/mrdoob/three.js/blob/r170/docs/api/en/objects/Points.html), [WebGLProgram](https://github.com/mrdoob/three.js/blob/r170/docs/api/en/renderers/webgl/WebGLProgram.html), [QuadraticBezierCurve3](https://github.com/mrdoob/three.js/blob/r170/docs/api/en/extras/curves/QuadraticBezierCurve3.html).

## APIs used and the rules we follow

### ShaderMaterial (energy shields, embers, searchlights, beams)
- `uniforms` is `{ name: { value } }`; names must match GLSL. Update with `material.uniforms.uTime.value = t` — picked up on the next frame. When a material is shared, update in `onBeforeRender`/`useFrame`.
- WebGLProgram **prepends built-ins**, don't redeclare them: vertex — `modelMatrix, modelViewMatrix, projectionMatrix, viewMatrix, normalMatrix, cameraPosition`, attributes `position, normal, uv`; `#ifdef USE_INSTANCING` → `attribute mat4 instanceMatrix`. Fragment — `viewMatrix, cameraPosition`.
- Custom attributes come from `BufferGeometry.setAttribute(name, new BufferAttribute(array, itemSize))`; array length = vertexCount × itemSize. After CPU edits set `attribute.needsUpdate = true`.
- `transparent`, `blending` (`AdditiveBlending` for glow), `depthWrite: false`, `side` are inherited from `Material`.
- `fog: true` only if the shader includes fog chunks (we don't; glow is unlit).

### InstancedMesh (stands/crowd, shards, coins)
- `new InstancedMesh(geometry, material, count)`; `count` is the max and can be lowered at runtime.
- `setMatrixAt(i, m)` / `setColorAt(i, c)` then `instanceMatrix.needsUpdate = true` / `instanceColor.needsUpdate = true`.
- `boundingSphere` is computed lazily for culling and may be stale after moving instances → we set `frustumCulled={false}` on animated instanced meshes (or recompute).
- Call `dispose()` when unmounted (R3F does this for declarative objects).

### Points (+ ShaderMaterial for GPU particles)
- `new Points(geometry, material)`; with ShaderMaterial set `gl_PointSize` in the vertex shader (scale by `1.0 / -mvPosition.z` for size attenuation).
- Particle motion is computed **in the vertex shader from `uTime` + per-particle seeds**, so the CPU does no per-frame work.

### Curves (attack arcs)
- `new QuadraticBezierCurve3(v0, v1, v2)`; `curve.getPoints(n)` → `BufferGeometry().setFromPoints(points)`. Arcs reveal by animating `geometry.setDrawRange(0, n)`.

## Performance rules for this repo

1. No per-frame allocations in `useFrame` — reuse `Vector3`/`Matrix4`/`Color` instances held in refs.
2. Prefer GPU animation (shader uniforms) over CPU loops; CPU loops only over instanced buffers with `needsUpdate`.
3. One draw call per repeated thing (InstancedMesh / Points). No shadows, no post-processing; glow = additive blending + fresnel.
4. Render only when visible: `frameloop="never"` when off-screen or tab hidden (`components/arena/Stage.tsx`), DPR capped and adaptive (`PerformanceMonitor`, `AdaptiveDpr`).
5. Respect `prefers-reduced-motion` (static camera, no intro flight, no crowd wave).
