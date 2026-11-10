import * as THREE from 'three';
import { WORLD_SIZE } from './bathymetry.js';

export const PARTICLE_TYPE_BARREL = 1;
export const PARTICLE_TYPE_WHITEWATER = 2;
export const PARTICLE_TYPE_BOARD_SPRAY = 3;

export class SprayParticleSystem {
  constructor(scene) {
    this.scene = scene;
    this.count = 16000;

    this.positions = new Float32Array(this.count * 3);
    this.velocities = new Float32Array(this.count * 3);
    this.life = new Float32Array(this.count);
    this.maxLife = new Float32Array(this.count);
    this.sizes = new Float32Array(this.count);
    this.alphas = new Float32Array(this.count);
    this.types = new Uint8Array(this.count);

    for (let i = 0; i < this.count; i++) {
      this.life[i] = 0;
      this.maxLife[i] = 1.0;
      this.positions[i * 3 + 1] = -200;
      this.sizes[i] = 1.0;
      this.alphas[i] = 0.0;
      this.types[i] = 0;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geom.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    geom.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aAlpha;
        varying float vAlpha;
        varying float vSeed;
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          float camDistFade = smoothstep(5.5, 11.5, -mvPosition.z);
          vAlpha = aAlpha * camDistFade;
          vSeed = fract(sin(dot(position.xz, vec2(12.9898, 78.233))) * 43758.5453);
          // Perspective-attenuated foam puff size
          gl_PointSize = clamp(aSize * (260.0 / max(6.5, -mvPosition.z)), 2.0, 14.5);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        varying float vSeed;
        void main() {
          if (vAlpha <= 0.01) discard;
          vec2 uv = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot(uv, uv);
          if (r2 > 1.0) discard;
          // Organic multi-lobe foam cluster shape so overlapping particles look like dissolving whitewater spray
          float angle = atan(uv.y, uv.x) + vSeed * 6.2831;
          float lobe = 0.88 + 0.12 * sin(angle * 3.0) * cos(angle * 2.0 - vSeed * 4.0);
          float radial = pow(clamp(1.0 - r2 / (lobe * lobe), 0.0, 1.0), 0.95);
          gl_FragColor = vec4(0.98, 0.995, 1.0, vAlpha * radial);
        }
      `,
    });

    this.points = new THREE.Points(geom, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.scene.add(this.points);
    this.spawnCursor = 0;
  }

  clear() {
    for (let i = 0; i < this.count; i++) {
      this.life[i] = 0;
      this.positions[i * 3 + 1] = -200;
      this.alphas[i] = 0;
      this.types[i] = 0;
    }
    this.points.visible = false;
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.aAlpha.needsUpdate = true;
  }

  clearType(targetType) {
    let changed = false;
    for (let i = 0; i < this.count; i++) {
      if (this.types[i] === targetType) {
        this.life[i] = 0;
        this.positions[i * 3 + 1] = -200;
        this.alphas[i] = 0;
        this.types[i] = 0;
        changed = true;
      }
    }
    if (changed) {
      this.points.geometry.attributes.position.needsUpdate = true;
      this.points.geometry.attributes.aAlpha.needsUpdate = true;
    }
  }

  spawnParticle(x, y, z, vx, vy, vz, maxL, size = 1.6, type = PARTICLE_TYPE_BARREL) {
    const idx = this.spawnCursor;
    this.spawnCursor = (this.spawnCursor + 1) % this.count;
    this.positions[idx * 3 + 0] = x;
    this.positions[idx * 3 + 1] = y;
    this.positions[idx * 3 + 2] = z;
    this.velocities[idx * 3 + 0] = vx;
    this.velocities[idx * 3 + 1] = vy;
    this.velocities[idx * 3 + 2] = vz;
    this.life[idx] = 0.001;
    this.maxLife[idx] = maxL;
    this.sizes[idx] = size;
    this.alphas[idx] = 0.85;
    this.types[idx] = type;
  }

  warmup(oceanParams, waveSolver, steps = 40) {
    this.clear();
    const enableBarrel = oceanParams?.particlesBarrel ?? false;
    const enableWhitewater = oceanParams?.particlesWhitewater ?? false;
    const density = oceanParams?.particleDensity ?? 0.0;
    if ((!enableBarrel && !enableWhitewater) || density <= 0.005) return;

    const dt = 0.03;
    for (let s = 0; s < steps; s++) {
      this.update(dt, oceanParams, waveSolver);
    }
  }

  update(dt, oceanParams, waveSolver) {
    if (dt <= 0) return;
    const tide = oceanParams.tideLevel ?? 0.2;
    const N = waveSolver.N;
    const simTexData = waveSolver.simTexData;

    const enableBarrel = oceanParams.particlesBarrel ?? false;
    const enableWhitewater = oceanParams.particlesWhitewater ?? false;
    const density = oceanParams.particleDensity !== undefined ? oceanParams.particleDensity : 0.0;
    const canSpawn = (enableBarrel || enableWhitewater) && density > 0.005;

    // 1. Scan active breaking & pitching-lip cells across the surf zone to dissolve the falling lip into white foam particles
    if (canSpawn) {
      const stride = 1;
      for (let j = 16; j < N - 16; j += stride) {
        const wz = (j / (N - 1) - 0.5) * WORLD_SIZE;
        if (wz < -58 || wz > 68) continue;

        for (let i = 14; i < N - 14; i += stride) {
          const idx = j * N + i;
          const k4 = idx * 4;
          const eta = simTexData[k4 + 0];
          if (eta < 0.50) continue;

          const dispX = simTexData[k4 + 1];
          const dispZ = simTexData[k4 + 2];
          const foam = simTexData[k4 + 3];
          const bTube = Math.hypot(dispX, dispZ);

          if (bTube < 0.20 && foam < 0.35) continue;

          const wx = (i / (N - 1) - 0.5) * WORLD_SIZE;
          const dirX = bTube > 0.01 ? dispX / bTube : 0.0;
          const dirZ = bTube > 0.01 ? dispZ / bTube : 1.0;

          // A. Dissolving & Falling Barrel Lip Curtain (closes the barrel cylinder over the cavity!)
          // Matches the 3D vertex displacement of the overhanging lip (+1.8m at crest tip arching out to +4.2m at base)
          if (enableBarrel && bTube > 0.24 && eta > 0.62 && foam < 0.86) {
            const baseCount = bTube > 0.50 ? 5 : 3;
            const particlesPerCell = Math.max(1, Math.round(baseCount * Math.min(1.0, density)));
            for (let p = 0; p < particlesPerCell; p++) {
              if (Math.random() > 0.84) continue;

              // Spawn along the parabolic arc from the pitching lip tip (arcT=0) down to the closing curtain (arcT=1)
              const arcT = Math.pow(Math.random(), 0.78);
              const jitterAlongCrest = (Math.random() - 0.5) * 1.85;
              const perpX = -dirZ * jitterAlongCrest;
              const perpZ = dirX * jitterAlongCrest;

              // Starts right at the overhanging lip edge (+1.7m to +2.8m) and arches forward (+3.2m to +4.5m) in front of the recessed cavity
              const forwardThrow = 1.65 + bTube * (1.15 + 1.65 * Math.sin(arcT * Math.PI * 0.56));
              const px = wx + dirX * forwardThrow + perpX;
              const pz = wz + dirZ * forwardThrow + perpZ;

              // Parabolic vertical arch from the curling lip down to close the tube at water level
              const crestTopY = tide + eta * (1.12 - 0.38 * foam);
              const archY = Math.cos(arcT * Math.PI * 0.48);
              const py = Math.max(tide + 0.16, tide + (crestTopY - tide) * archY + (Math.random() - 0.5) * 0.20);

              // Forward + downward velocity along the closing barrel trajectory
              const speedFwd = 2.8 + bTube * 1.6 + Math.random() * 0.85;
              const vx = dirX * speedFwd + (Math.random() - 0.5) * 0.75;
              const vz = dirZ * speedFwd + (Math.random() - 0.5) * 0.75;
              const vy = -1.5 - arcT * 3.5 - Math.random() * 1.0;

              this.spawnParticle(
                px,
                py,
                pz,
                vx,
                vy,
                vz,
                0.45 + Math.random() * 0.45,
                1.60 + bTube * 0.85 + Math.random() * 0.65,
                PARTICLE_TYPE_BARREL
              );
            }
          }

          // B. Churning Whitewater Impact & Barrel Spit at the base of the closing barrel
          if (enableWhitewater && bTube > 0.22 && foam > 0.28 && eta > 0.55 && Math.random() < 0.42 * Math.min(1.0, density)) {
            const forwardBore = 2.0 + bTube * 2.2 + (Math.random() - 0.5) * 2.0;
            const px = wx + dirX * forwardBore + (Math.random() - 0.5) * 1.8;
            const pz = wz + dirZ * forwardBore + (Math.random() - 0.5) * 1.8;
            const py = tide + Math.min(1.20, eta * 0.52) * Math.random() + 0.14;

            const vx = dirX * (3.6 + Math.random() * 1.8) + (Math.random() - 0.5) * 1.3;
            const vz = dirZ * (3.6 + Math.random() * 1.8) + (Math.random() - 0.5) * 1.3;
            const vy = 0.28 + Math.random() * 1.20;

            this.spawnParticle(
              px,
              py,
              pz,
              vx,
              vy,
              vz,
              0.46 + Math.random() * 0.48,
              1.55 + Math.random() * 0.75,
              PARTICLE_TYPE_WHITEWATER
            );
          }
        }
      }
    }

    // 2. Step particle kinematics & water-surface splash/churn
    const gravity = 11.2;
    const minWaterY = tide + 0.14;
    let activeCount = 0;

    for (let i = 0; i < this.count; i++) {
      let l = this.life[i];
      if (l <= 0) continue;

      // Clean up particle if its type was disabled
      const t = this.types[i];
      if ((!enableBarrel && t === PARTICLE_TYPE_BARREL) ||
          (!enableWhitewater && (t === PARTICLE_TYPE_WHITEWATER || t === PARTICLE_TYPE_BOARD_SPRAY))) {
        this.life[i] = 0;
        this.positions[i * 3 + 1] = -200;
        this.alphas[i] = 0.0;
        continue;
      }

      l += dt;
      const maxL = this.maxLife[i];
      if (l >= maxL) {
        this.life[i] = 0;
        this.positions[i * 3 + 1] = -200;
        this.alphas[i] = 0.0;
        continue;
      }
      this.life[i] = l;
      activeCount++;

      const i3 = i * 3;
      this.velocities[i3 + 1] -= gravity * dt;

      let nx = this.positions[i3 + 0] + this.velocities[i3 + 0] * dt;
      let ny = this.positions[i3 + 1] + this.velocities[i3 + 1] * dt;
      let nz = this.positions[i3 + 2] + this.velocities[i3 + 2] * dt;

      // When falling lip particles impact the water trough in front of the cavity,
      // they splash and churn forward along the surface as white foam instead of sinking!
      if (ny < minWaterY) {
        ny = minWaterY + Math.random() * 0.18;
        this.velocities[i3 + 1] = Math.abs(this.velocities[i3 + 1]) * 0.28 + 0.35;
        this.velocities[i3 + 0] *= 0.88;
        this.velocities[i3 + 2] *= 0.88;
      }

      this.positions[i3 + 0] = nx;
      this.positions[i3 + 1] = ny;
      this.positions[i3 + 2] = nz;

      const lifeNorm = l / maxL;
      const fadeIn = Math.min(1.0, lifeNorm * 6.0);
      const fadeOut = 1.0 - Math.pow(lifeNorm, 1.7);
      this.alphas[i] = 0.90 * fadeIn * fadeOut;
    }

    this.points.visible = activeCount > 0;
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.aSize.needsUpdate = true;
    this.points.geometry.attributes.aAlpha.needsUpdate = true;
  }
}
