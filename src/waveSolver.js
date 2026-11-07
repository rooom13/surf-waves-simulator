import * as THREE from 'three';
import { WORLD_SIZE, BTY_RES } from './bathymetry.js';

const GRAVITY = 9.81;

function smoothstep(edge0, edge1, x) {
  if (!Number.isFinite(x)) return 0.0;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Real-Time 2D Hydrodynamic Shallow-Water Wave PDE Solver (Staggered Arakawa C-Grid)
 */
export class HydroWaveSolver {
  constructor(btyManager) {
    this.bty = btyManager;
    this.N = BTY_RES; // 160x160 grid
    this.dx = WORLD_SIZE / (this.N - 1); // ~1.8868m cell spacing

    const total = this.N * this.N;

    // PDE State Fields
    this.eta = new Float32Array(total);
    this.etaNext = new Float32Array(total);
    this.dEtaDt = new Float32Array(total);
    this.u = new Float32Array(total);
    this.v = new Float32Array(total);
    this.foam = new Float32Array(total);
    this.foamNext = new Float32Array(total);
    this.plunge = new Float32Array(total);

    // Scratch buffers for smooth 3D surface reconstruction
    this.shapedBuf = new Float32Array(total);
    this.dispXBuf = new Float32Array(total);
    this.dispZBuf = new Float32Array(total);

    // RGBA Float texture uploaded to GPU Vertex/Fragment Shader
    // R = shaped surface elevation (eta), G = 3D horiz dispX, B = 3D horiz dispZ, A = foam
    this.simTexData = new Float32Array(total * 4);
    this.simTexture = new THREE.DataTexture(
      this.simTexData,
      this.N,
      this.N,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    this.simTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.simTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.simTexture.magFilter = THREE.NearestFilter;
    this.simTexture.minFilter = THREE.NearestFilter;

    this.simTime = 0;
  }

  reset() {
    this.eta.fill(0);
    this.etaNext.fill(0);
    this.dEtaDt.fill(0);
    this.u.fill(0);
    this.v.fill(0);
    this.foam.fill(0);
    this.foamNext.fill(0);
    this.plunge.fill(0);
  }

  warmup(oceanParams, steps = 240) {
    this.reset();
    const dtSub = 0.020;
    for (let s = 0; s < steps; s++) {
      this.stepPDE(dtSub, oceanParams);
    }
    this.buildRenderFields(oceanParams);
  }

  evalIncidentSwell(x, z, t, oceanParams, refC) {
    const H1 = oceanParams.swellHeight * 0.48;
    const T1 = oceanParams.swellPeriod;
    const dir1 = (oceanParams.swellDir * Math.PI) / 180;
    const kx1 = Math.sin(dir1);
    const kz1 = Math.cos(dir1);

    const wavelength1 = 42.0 + (T1 - 5.0) * 3.1;
    const k1 = (2.0 * Math.PI) / wavelength1;
    const omega1 = k1 * refC;

    const s1 = x * kx1 + z * kz1;
    const phase1 = k1 * s1 - omega1 * t;
    const groupEnv = 1.0 - (oceanParams.swellGrouping / 100) * 0.35 * (0.5 - 0.5 * Math.cos(phase1 * 0.25));

    const c1 = Math.cos(phase1);
    let etaInc = H1 * groupEnv * c1;
    let uInc = (GRAVITY / refC) * etaInc * kx1;
    let vInc = (GRAVITY / refC) * etaInc * kz1;

    if (oceanParams.secEnabled && oceanParams.secHeight > 0.05) {
      const H2 = oceanParams.secHeight * 0.44;
      const T2 = oceanParams.secPeriod;
      const dir2 = (oceanParams.secDir * Math.PI) / 180;
      const kx2 = Math.sin(dir2);
      const kz2 = Math.cos(dir2);
      const wavelength2 = 36.0 + (T2 - 5.0) * 2.8;
      const k2 = (2.0 * Math.PI) / wavelength2;
      const omega2 = k2 * refC;
      const phase2 = k2 * (x * kx2 + z * kz2) - omega2 * t + 1.2;

      const eta2 = H2 * Math.cos(phase2);
      etaInc += eta2;
      uInc += (GRAVITY / refC) * eta2 * kx2;
      vInc += (GRAVITY / refC) * eta2 * kz2;
    }

    return { eta: etaInc, u: uInc, v: vInc };
  }

  stepPDE(dtInput, oceanParams) {
    const dt = Math.max(0.005, Math.min(0.024, dtInput || 0.018));
    const N = this.N;
    const dx = this.dx;
    const invDx = 1.0 / dx;
    const tide = oceanParams.tideLevel;
    const elev = this.bty.elevation;
    const slope = this.bty.slope;

    this.simTime += dt;
    const t = this.simTime;

    const refDepth = 10.5;
    const refC = Math.sqrt(GRAVITY * refDepth);

    // 1. Boundary Wave-Maker & Sponge Relaxation Zone
    for (let j = 0; j < N; j++) {
      const z = (j / (N - 1) - 0.5) * WORLD_SIZE;
      const offshoreWeight = j < 15 ? Math.pow(1.0 - j / 15.0, 1.8) : 0.0;

      for (let i = 0; i < N; i++) {
        const sideDist = Math.min(i, N - 1 - i);
        const sideWeight = sideDist < 8 && z < 45 ? Math.pow(1.0 - sideDist / 8.0, 2.0) * smoothstep(45, -10, z) : 0.0;
        const alpha = Math.max(offshoreWeight, sideWeight);
        if (alpha <= 0.0001) continue;

        const idx = j * N + i;
        const d0 = tide - elev[idx];
        if (d0 <= 0.1) {
          this.eta[idx] = 0;
          this.u[idx] = 0;
          this.v[idx] = 0;
          continue;
        }

        const x = (i / (N - 1) - 0.5) * WORLD_SIZE;
        const inc = this.evalIncidentSwell(x, z, t, oceanParams, refC);

        this.eta[idx] = (1.0 - alpha) * this.eta[idx] + alpha * inc.eta;
        this.u[idx] = (1.0 - alpha) * this.u[idx] + alpha * inc.u;
        this.v[idx] = (1.0 - alpha) * this.v[idx] + alpha * inc.v;
      }
    }

    // 2. Update Horizontal Velocities (u, v) from Surface Gradient -g * grad(eta)
    const gDtDx = GRAVITY * dt * invDx;
    const backwashReflect = oceanParams.backwashStrength ?? 0.45;
    const structureReflect = oceanParams.sideWaveStrength ?? 0.85;

    for (let j = 0; j < N - 1; j++) {
      const z = (j / (N - 1) - 0.5) * WORLD_SIZE;

      for (let i = 0; i < N - 1; i++) {
        const idx = j * N + i;
        const dHere = tide - elev[idx];
        const dRight = tide - elev[idx + 1];
        const dDown = tide - elev[idx + N];

        const localSlope = slope[idx];
        let damp = 0.014;
        if (dHere < 1.15) {
          const isSteepWall = localSlope > 0.16 || z < 35;
          const reflectFactor = isSteepWall
            ? Math.min(0.95, 0.45 + structureReflect * 0.4)
            : Math.min(0.92, backwashReflect * 0.55);
          damp = (0.04 + 0.85 * Math.pow(Math.max(0, 1.0 - dHere / 1.15), 1.5)) * (1.0 - reflectFactor * 0.82);
        }
        const velDecay = Math.max(0.5, 1.0 - damp * dt);

        if (dHere > 0.08 && dRight > 0.08) {
          this.u[idx] = (this.u[idx] - gDtDx * (this.eta[idx + 1] - this.eta[idx])) * velDecay;
        } else {
          this.u[idx] = 0.0;
        }

        if (dHere > 0.08 && dDown > 0.08) {
          this.v[idx] = (this.v[idx] - gDtDx * (this.eta[idx + N] - this.eta[idx])) * velDecay;
        } else {
          this.v[idx] = 0.0;
        }
      }
    }

    // 3. Update Water Surface Elevation (eta) from Flux Divergence -div(d_eff * u)
    const windAlignment = Math.cos((oceanParams.windDir * Math.PI) / 180);
    const offshoreHold = windAlignment * Math.min(1.0, oceanParams.windSpeed / 18.0);
    const breakRatioThreshold = 0.36 + offshoreHold * 0.05;

    this.etaNext.set(this.eta);

    for (let j = 1; j < N - 1; j++) {
      for (let i = 1; i < N - 1; i++) {
        const idx = j * N + i;
        const d0 = tide - elev[idx];

        if (d0 <= 0.08) {
          this.etaNext[idx] = 0;
          this.dEtaDt[idx] = 0;
          this.foamNext[idx] = 0;
          this.plunge[idx] = 0;
          continue;
        }

        const dCenter = Math.max(0.45, Math.min(refDepth, d0));
        const dLeft = Math.max(0.45, Math.min(refDepth, tide - elev[idx - 1]));
        const dRight = Math.max(0.45, Math.min(refDepth, tide - elev[idx + 1]));
        const dUp = Math.max(0.45, Math.min(refDepth, tide - elev[idx - N]));
        const dDown = Math.max(0.45, Math.min(refDepth, tide - elev[idx + N]));

        const fluxRight = 0.5 * (dCenter + dRight) * this.u[idx];
        const fluxLeft = 0.5 * (dCenter + dLeft) * this.u[idx - 1];
        const fluxDown = 0.5 * (dCenter + dDown) * this.v[idx];
        const fluxUp = 0.5 * (dCenter + dUp) * this.v[idx - N];

        const divFlux = (fluxRight - fluxLeft + fluxDown - fluxUp) * invDx;

        const prevEta = this.eta[idx];
        let nextEta = prevEta - divFlux * dt;

        // Vertical surface rate d(eta)/dt = -divFlux (never divides by zero!)
        const rawRate = -divFlux;
        const smoothedRate = this.dEtaDt[idx] * 0.65 + rawRate * 0.35;
        this.dEtaDt[idx] = smoothedRate;

        const ratio = nextEta / Math.max(0.55, d0);
        let foamGen = 0.0;
        let targetPlunge = 0.0;

        if (ratio > breakRatioThreshold && d0 < 5.2) {
          const excess = ratio - breakRatioThreshold;
          const breakDissip = Math.min(0.16, excess * 0.85 * dt);
          nextEta -= nextEta * breakDissip;

          const frontFaceMask = smoothstep(-0.2, 0.8, smoothedRate);
          foamGen = Math.min(1.0, excess * 3.0 * (0.45 + 0.55 * frontFaceMask));
          targetPlunge = Math.min(1.30, excess * 2.8 * (0.7 + slope[idx] * 2.5) * frontFaceMask);
        }

        this.etaNext[idx] = Math.max(-d0 * 0.80, Math.min(4.8, nextEta));
        this.plunge[idx] = this.plunge[idx] * 0.82 + targetPlunge * 0.18;

        const uAdv = 0.5 * (this.u[idx] + this.u[idx - 1]);
        const vAdv = 0.5 * (this.v[idx] + this.v[idx - N]);
        const srcI = Math.max(1, Math.min(N - 2, Math.round(i - (uAdv * dt * invDx) * 1.3)));
        const srcJ = Math.max(1, Math.min(N - 2, Math.round(j - (vAdv * dt * invDx) * 1.3)));
        const advectedFoam = this.foam[srcJ * N + srcI] * 0.7 + this.foam[idx] * 0.3;

        const foamDecay = Math.exp(-dt * 0.52);
        this.foamNext[idx] = Math.min(1.0, Math.max(advectedFoam * foamDecay, foamGen));
      }
    }

    this.eta.set(this.etaNext);
    this.foam.set(this.foamNext);
  }

  buildRenderFields(oceanParams) {
    const N = this.N;
    const tide = oceanParams.tideLevel;
    const elev = this.bty.elevation;
    const slope = this.bty.slope;

    const windAlignment = Math.cos((oceanParams.windDir * Math.PI) / 180);
    const offshoreHold = windAlignment * Math.min(1.0, oceanParams.windSpeed / 18.0);

    for (let j = 0; j < N; j++) {
      const jm = Math.max(0, j - 1);
      const jp = Math.min(N - 1, j + 1);

      for (let i = 0; i < N; i++) {
        const im = Math.max(0, i - 1);
        const ip = Math.min(N - 1, i + 1);
        const idx = j * N + i;

        const d0 = tide - elev[idx];
        if (d0 <= 0.05) {
          this.shapedBuf[idx] = 0.0;
          this.dispXBuf[idx] = 0.0;
          this.dispZBuf[idx] = 0.0;
          continue;
        }

        const rawEta =
          this.eta[idx] * 0.52 +
          (this.eta[j * N + im] + this.eta[j * N + ip] + this.eta[jm * N + i] + this.eta[jp * N + i]) * 0.12;

        const shoalMask = smoothstep(5.5, 1.8, d0) * smoothstep(0.15, 0.85, d0);
        const slopeBoost = 1.0 + Math.min(0.42, slope[idx] * 2.0) * shoalMask;

        let shapedEta = rawEta * (1.0 + 0.32 * shoalMask) * slopeBoost;
        if (shapedEta > 0.0) {
          shapedEta += 0.25 * shoalMask * shapedEta * Math.min(1.4, shapedEta / Math.max(0.8, oceanParams.swellHeight * 0.5));
        } else {
          shapedEta *= 1.0 - 0.30 * shoalMask;
        }

        const dEtaDx = (this.eta[j * N + ip] - this.eta[j * N + im]) / (2.0 * this.dx);
        const dEtaDz = (this.eta[jp * N + i] - this.eta[jm * N + i]) / (2.0 * this.dx);

        const gerstnerPull = 1.25 + 0.75 * shoalMask;
        let dispX = dEtaDx * gerstnerPull;
        let dispZ = dEtaDz * gerstnerPull;

        const uLoc = this.u[idx];
        const vLoc = this.v[idx];
        const speed = Math.hypot(uLoc, vLoc);
        if (speed > 0.05 && shapedEta > 0.05) {
          const dirX = uLoc / speed;
          const dirZ = vLoc / speed;

          const plungeAmt = this.plunge[idx] * (1.0 + Math.max(0, offshoreHold) * 0.3);
          const crestHeightMask = smoothstep(0.05, oceanParams.swellHeight * 0.55, shapedEta);
          const pitchForward = plungeAmt * crestHeightMask * 1.95;

          dispX += dirX * pitchForward;
          dispZ += dirZ * pitchForward;

          const frontFace = smoothstep(0.1, 1.2, this.dEtaDt[idx]);
          shapedEta -= plungeAmt * crestHeightMask * frontFace * 0.20;
        }

        this.shapedBuf[idx] = shapedEta;
        this.dispXBuf[idx] = Math.max(-2.8, Math.min(2.8, dispX));
        this.dispZBuf[idx] = Math.max(-2.8, Math.min(2.8, dispZ));
      }
    }

    // Smooth pass before uploading to GPU texture so 3D surface normals are silky smooth
    for (let j = 0; j < N; j++) {
      const jm = Math.max(0, j - 1);
      const jp = Math.min(N - 1, j + 1);
      for (let i = 0; i < N; i++) {
        const im = Math.max(0, i - 1);
        const ip = Math.min(N - 1, i + 1);
        const idx = j * N + i;
        const k4 = idx * 4;
        const d0 = tide - elev[idx];

        if (d0 <= 0.05) {
          this.simTexData[k4 + 0] = 0.0;
          this.simTexData[k4 + 1] = 0.0;
          this.simTexData[k4 + 2] = 0.0;
          this.simTexData[k4 + 3] = 0.0;
          continue;
        }

        const smEta =
          this.shapedBuf[idx] * 0.6 +
          (this.shapedBuf[j * N + im] +
            this.shapedBuf[j * N + ip] +
            this.shapedBuf[jm * N + i] +
            this.shapedBuf[jp * N + i]) *
            0.1;

        const smDX =
          this.dispXBuf[idx] * 0.6 +
          (this.dispXBuf[j * N + im] +
            this.dispXBuf[j * N + ip] +
            this.dispXBuf[jm * N + i] +
            this.dispXBuf[jp * N + i]) *
            0.1;

        const smDZ =
          this.dispZBuf[idx] * 0.6 +
          (this.dispZBuf[j * N + im] +
            this.dispZBuf[j * N + ip] +
            this.dispZBuf[jm * N + i] +
            this.dispZBuf[jp * N + i]) *
            0.1;

        const swashFoam = smoothstep(0.65, 0.08, d0) * smoothstep(-0.1, 0.3, smEta) * 0.55;
        const totalFoam = Math.min(1.0, this.foam[idx] + swashFoam);

        this.simTexData[k4 + 0] = Number.isFinite(smEta) ? smEta : 0.0;
        this.simTexData[k4 + 1] = Number.isFinite(smDX) ? smDX : 0.0;
        this.simTexData[k4 + 2] = Number.isFinite(smDZ) ? smDZ : 0.0;
        this.simTexData[k4 + 3] = Number.isFinite(totalFoam) ? totalFoam : 0.0;
      }
    }

    this.simTexture.needsUpdate = true;
  }

  update(_dt, oceanParams) {
    // Fixed stable Courant timestep (3 sub-steps per frame)
    const subSteps = 3;
    const dtSub = 0.018;
    for (let s = 0; s < subSteps; s++) {
      this.stepPDE(dtSub, oceanParams);
    }
    this.buildRenderFields(oceanParams);
  }

  sampleAt(worldX, worldZ) {
    const N = this.N;
    const u = Math.max(0, Math.min(0.999, worldX / WORLD_SIZE + 0.5));
    const v = Math.max(0, Math.min(0.999, worldZ / WORLD_SIZE + 0.5));
    const i = Math.min(N - 1, Math.floor(u * N));
    const j = Math.min(N - 1, Math.floor(v * N));
    const idx = j * N + i;
    const k4 = idx * 4;

    return {
      eta: this.simTexData[k4 + 0],
      dispX: this.simTexData[k4 + 1],
      dispZ: this.simTexData[k4 + 2],
      foam: this.simTexData[k4 + 3],
      plunge: this.plunge[idx],
      dEtaDt: this.dEtaDt[idx],
    };
  }
}
