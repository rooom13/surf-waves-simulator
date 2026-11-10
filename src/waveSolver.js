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
 * Coupled with a Phase-Advected Surface Roller (Bore) & Peeling Pocket Detector.
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

    // Surface roller (broken mass of water pushing with wave celerity) & residual foam trail
    this.roller = new Float32Array(total);
    this.rollerNext = new Float32Array(total);
    this.foam = new Float32Array(total);
    this.foamNext = new Float32Array(total);
    this.plunge = new Float32Array(total);

    // Scratch buffers for smooth 3D surface reconstruction
    this.shapedBuf = new Float32Array(total);
    this.dispXBuf = new Float32Array(total);
    this.dispZBuf = new Float32Array(total);
    this.foamBuf = new Float32Array(total);

    // RGBA Float texture uploaded to GPU Vertex/Fragment Shader
    // R = shaped surface elevation (eta), G = barrelVec.x, B = barrelVec.z, A = foam
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
    this.timeAccumulator = 0;
  }

  reset() {
    this.eta.fill(0);
    this.etaNext.fill(0);
    this.dEtaDt.fill(0);
    this.u.fill(0);
    this.v.fill(0);
    this.roller.fill(0);
    this.rollerNext.fill(0);
    this.foam.fill(0);
    this.foamNext.fill(0);
    this.plunge.fill(0);
    this.simTime = 0;
    this.timeAccumulator = 0;
  }

  /**
   * Seeds the entire 300m x 300m ocean domain with a refracted, shoaling wave train
   * so waves are immediately present from offshore (z=-150m) to the beach (z=+100m).
   */
  seedWaveField(oceanParams) {
    const N = this.N;
    const tide = oceanParams.tideLevel;
    const elev = this.bty.elevation;
    const phaseDelay = this.bty.phaseDelay;
    const refDepth = 10.5;
    const refC = Math.sqrt(GRAVITY * refDepth);
    const t = this.simTime;

    for (let j = 0; j < N; j++) {
      const z = (j / (N - 1) - 0.5) * WORLD_SIZE;
      for (let i = 0; i < N; i++) {
        const idx = j * N + i;
        const d0 = tide - elev[idx];
        if (d0 <= 0.12) {
          this.eta[idx] = 0;
          this.u[idx] = 0;
          this.v[idx] = 0;
          continue;
        }

        const x = (i / (N - 1) - 0.5) * WORLD_SIZE;
        // Mild refraction phase offset so wave crests enter as connected swell lines
        const effZ = z + phaseDelay[idx] * 0.25;
        const inc = this.evalIncidentSwell(x, effZ, t, oceanParams, refC);

        // Taper amplitude gently in ultra-shallow swash while keeping full energy in surf zone
        const depthTaper = smoothstep(0.12, 1.1, d0);
        const shoalFactor = Math.min(1.25, Math.pow(refDepth / Math.max(1.8, d0), 0.18));

        this.eta[idx] = inc.eta * shoalFactor * depthTaper;
        this.u[idx] = inc.u * depthTaper;
        this.v[idx] = inc.v * depthTaper;
      }
    }
  }

  warmup(oceanParams, steps = 300) {
    this.reset();
    this.seedWaveField(oceanParams);
    const dtSub = 0.020;
    for (let s = 0; s < steps; s++) {
      this.stepPDE(dtSub, oceanParams);
    }
    this.buildRenderFields(oceanParams);
  }

  /**
   * Evaluates the travelling wave-group envelope at position s1 along the swell direction.
   * Produces a distinct pulse of large set waves (setPacket -> 1) separated by calm lulls
   * where wave height drops to lullMin (e.g. ~14% of set height at 65% grouping).
   */
  evalGroupEnvelope(s1, t, oceanParams, refC, kz1 = 1.0) {
    const T1 = Math.max(5.0, oceanParams.swellPeriod ?? 14.0);
    const wavesPerSet = Math.max(2.0, oceanParams.wavesPerSet ?? 6.0);
    const setPeriodSec = wavesPerSet * T1;
    const groupFactor = Math.max(0.0, Math.min(1.0, (oceanParams.swellGrouping ?? 10) / 100));

    if (groupFactor <= 0.05) {
      return { groupEnv: 1.0, setPacket: 1.0, groupPhase: 0.0, setPeriodSec };
    }

    const omegaGroup = (2.0 * Math.PI) / setPeriodSec;
    const cGroup = 0.78 * refC;
    const kGroup = omegaGroup / cGroup;
    const sSurfZone = -60.0 * kz1;
    // Offset by 6.0s so right after the 6s PDE warmup, the set peak is centered right across the surf zone
    const groupPhase = kGroup * (s1 - sSurfZone) - omegaGroup * (t - 6.0);

    const rawCos = 0.5 + 0.5 * Math.cos(groupPhase);
    // Sharp packet exponent so sets are distinct 3-5 wave pulses and lulls are genuinely small & calm
    const setPacket = Math.pow(rawCos, 2.8);
    const lullMin = Math.pow(Math.max(0.0, 1.0 - groupFactor), 1.85);
    const peakMax = 1.0 + groupFactor * 0.12;
    const groupEnv = lullMin + (peakMax - lullMin) * setPacket;

    return { groupEnv, setPacket, groupPhase, setPeriodSec };
  }

  evalIncidentSwell(x, z, t, oceanParams, refC) {
    const H1 = oceanParams.swellHeight * 0.85;
    const T1 = oceanParams.swellPeriod;
    const dir1 = (oceanParams.swellDir * Math.PI) / 180;
    const kx1 = Math.sin(dir1);
    const kz1 = Math.cos(dir1);

    const wavelength1 = 44.0 + (T1 - 5.0) * 3.0;
    const k1 = (2.0 * Math.PI) / wavelength1;
    const omega1 = k1 * refC;

    const s1 = x * kx1 + z * kz1;
    const phase1 = k1 * s1 - omega1 * t;
    const { groupEnv } = this.evalGroupEnvelope(s1, t, oceanParams, refC, kz1);

    const c1 = Math.cos(phase1);
    let etaInc = H1 * groupEnv * c1;
    let uInc = (GRAVITY / refC) * etaInc * kx1;
    let vInc = (GRAVITY / refC) * etaInc * kz1;

    if (oceanParams.secEnabled && oceanParams.secHeight > 0.05) {
      const H2 = oceanParams.secHeight * 0.45 * (0.35 + 0.65 * groupEnv);
      const T2 = oceanParams.secPeriod;
      const dir2 = (oceanParams.secDir * Math.PI) / 180;
      const kx2 = Math.sin(dir2);
      const kz2 = Math.cos(dir2);
      const wavelength2 = 38.0 + (T2 - 5.0) * 2.8;
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
      const offshoreWeight = j < 16 ? Math.pow(1.0 - j / 16.0, 1.7) : 0.0;

      for (let i = 0; i < N; i++) {
        const sideDist = Math.min(i, N - 1 - i);
        const sideWeight =
          sideDist < 8 && z < 120 ? Math.pow(1.0 - sideDist / 8.0, 2.0) * smoothstep(120, -50, z) : 0.0;
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
        // Near-zero damping in open/shoaling water so waves carry full energy all the way to the break & shore
        let damp = 0.0012;
        if (dHere < 0.95) {
          const isSteepWall = localSlope > 0.15 || z < 35;
          const reflectFactor = isSteepWall
            ? Math.min(0.95, 0.45 + structureReflect * 0.4)
            : Math.min(0.92, backwashReflect * 0.55);
          damp = (0.03 + 0.65 * Math.pow(Math.max(0, 1.0 - dHere / 0.95), 1.5)) * (1.0 - reflectFactor * 0.82);
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

    // 3. Update Water Surface Elevation (eta), Phase-Advected Surface Roller (Bore), and Foam
    const windAlignment = Math.cos((oceanParams.windDir * Math.PI) / 180);
    const offshoreHold = windAlignment * Math.min(1.0, oceanParams.windSpeed / 18.0);
    // Breaking threshold gamma_b: waves shoal to a tall, steep wall before breaking
    const breakRatioThreshold = 0.68 + offshoreHold * 0.08;

    const H0 = Math.max(0.3, oceanParams.swellHeight);
    const T1 = Math.max(5.0, oceanParams.swellPeriod);
    const L0 = (GRAVITY * T1 * T1) / (2.0 * Math.PI);
    const deepSteepnessSqrt = Math.sqrt(Math.max(0.002, H0 / L0));
    const swellRad = (oceanParams.swellDir * Math.PI) / 180;
    const incDirX = Math.sin(swellRad);
    const incDirZ = Math.cos(swellRad);
    const phaseDelay = this.bty.phaseDelay;

    this.etaNext.set(this.eta);

    for (let j = 1; j < N - 1; j++) {
      const z = (j / (N - 1) - 0.5) * WORLD_SIZE;
      for (let i = 1; i < N - 1; i++) {
        const idx = j * N + i;
        const d0 = tide - elev[idx];

        if (d0 <= 0.08) {
          this.etaNext[idx] = 0;
          this.dEtaDt[idx] = 0;
          this.rollerNext[idx] = 0;
          this.foamNext[idx] = 0;
          this.plunge[idx] = 0;
          continue;
        }

        const x = (i / (N - 1) - 0.5) * WORLD_SIZE;
        const s1 = x * incDirX + (z + phaseDelay[idx] * 0.25) * incDirZ;
        const { groupEnv, setPacket } = this.evalGroupEnvelope(s1, t, oceanParams, refC, incDirZ);

        // Nonlinear dispersive effective depth c = sqrt(g * (d + H)):
        // Prevents unrealistic 4x phase-speed shearing while producing natural 18°-25° wave refraction around points/reefs
        const effDepth = (d) => Math.max(3.6, Math.min(9.2, d * 0.62 + 2.6));
        const dCenter = effDepth(d0);
        const dLeft = effDepth(tide - elev[idx - 1]);
        const dRight = effDepth(tide - elev[idx + 1]);
        const dUp = effDepth(tide - elev[idx - N]);
        const dDown = effDepth(tide - elev[idx + N]);

        const fluxRight = 0.5 * (dCenter + dRight) * this.u[idx];
        const fluxLeft = 0.5 * (dCenter + dLeft) * this.u[idx - 1];
        const fluxDown = 0.5 * (dCenter + dDown) * this.v[idx];
        const fluxUp = 0.5 * (dCenter + dUp) * this.v[idx - N];

        const divFlux = (fluxRight - fluxLeft + fluxDown - fluxUp) * invDx;

        const prevEta = this.eta[idx];
        let nextEta = prevEta - divFlux * dt;

        // During a lull between sets, gently damp residual basin sloshing so waves become genuinely small
        const targetEnvCap = H0 * 0.95 * groupEnv;
        if (Math.abs(nextEta) > targetEnvCap && setPacket < 0.45) {
          const lullRelax = Math.min(0.18, (1.0 - setPacket * 2.0) * 1.8 * dt);
          nextEta -= (nextEta - Math.sign(nextEta) * targetEnvCap) * lullRelax;
        }

        // Vertical surface rate d(eta)/dt = -divFlux (positive on advancing front face!)
        const rawRate = -divFlux;
        const smoothedRate = this.dEtaDt[idx] * 0.62 + rawRate * 0.38;
        this.dEtaDt[idx] = smoothedRate;

        // Local wave propagation direction (refracted by seabed gradient)
        const dElevDx = (elev[idx + 1] - elev[idx - 1]) * 0.5 * invDx;
        const dElevDz = (elev[idx + N] - elev[idx - N]) * 0.5 * invDx;
        const refractW = smoothstep(8.0, 1.4, d0) * 0.55;
        let dirX = incDirX + dElevDx * refractW * 3.2;
        let dirZ = incDirZ + dElevDz * refractW * 3.2;
        const dirNorm = Math.hypot(dirX, dirZ) || 1.0;
        dirX /= dirNorm;
        dirZ /= dirNorm;

        // Wave phase celerity c = sqrt(g * d_eff) for advecting the breaking surface roller WITH the wave crest!
        const celerity = Math.sqrt(GRAVITY * dCenter);
        const cStepX = dirX * celerity * dt * invDx;
        const cStepZ = dirZ * celerity * dt * invDx;

        // Semi-Lagrangian bilinear advection of the surface roller along wave phase velocity
        const srcX = Math.max(1.0, Math.min(N - 2.001, i - cStepX));
        const srcZ = Math.max(1.0, Math.min(N - 2.001, j - cStepZ));
        const i0 = Math.floor(srcX);
        const j0 = Math.floor(srcZ);
        const fx = srcX - i0;
        const fz = srcZ - j0;
        const r00 = this.roller[j0 * N + i0];
        const r10 = this.roller[j0 * N + (i0 + 1)];
        const r01 = this.roller[(j0 + 1) * N + i0];
        const r11 = this.roller[(j0 + 1) * N + (i0 + 1)];
        const rawAdvRoller = (r00 * (1 - fx) + r10 * fx) * (1 - fz) + (r01 * (1 - fx) + r11 * fx) * fz;
        const neighborRollerAvg =
          0.25 * (this.roller[idx - 1] + this.roller[idx + 1] + this.roller[idx - N] + this.roller[idx + N]);
        const advRoller = rawAdvRoller * 0.72 + neighborRollerAvg * 0.28;

        // The surface roller only lives on the positive crest & advancing front face of a wave in shallow water;
        // it vanishes in the trough behind the wave AND if the wave reforms into deeper water (>2.8m)
        const onWaveFront = smoothstep(-0.08, 0.32, nextEta) * smoothstep(-0.4, 0.35, smoothedRate);
        const shallowSupport = smoothstep(3.1, 1.85, d0);
        const rollerSupport = onWaveFront * shallowSupport;
        const rollerDecayRate = 0.85 + (1.0 - rollerSupport) * 18.0;
        let nextRoller = advRoller * Math.exp(-dt * rollerDecayRate);

        const ratio = nextEta / Math.max(0.65, d0);
        let targetPlunge = 0.0;

        // Wave breaks ONLY when crest height-to-depth ratio exceeds breaking threshold in shallow water (d0 < 2.85m)
        if (ratio > breakRatioThreshold && d0 < 2.85) {
          const excess = ratio - breakRatioThreshold;
          // Smooth nonlinear dissipation lowers the wave crest naturally once it breaks into whitewater
          const breakDissip = Math.min(0.14, excess * 0.65 * dt);
          nextEta -= nextEta * breakDissip;

          // Orthogonal Seabed Gradient s_orth (Mead & Black 2001)
          const sOrth = Math.max(0.008, Math.max(0, dElevDx * dirX + dElevDz * dirZ) + slope[idx] * 0.65);
          const xiLocal = (sOrth / deepSteepnessSqrt) * (1.0 + offshoreHold * 0.32);
          const plungeFactor = smoothstep(0.32, 0.88, xiLocal);
          const frontFaceMask = smoothstep(-0.08, 0.65, smoothedRate);

          // Active breaking feeds the surface roller (the mass of whitewater pushing toward shore)
          const rollerGen = Math.min(1.0, excess * 3.8 * (0.40 + 0.60 * frontFaceMask));
          nextRoller = Math.max(nextRoller, rollerGen);

          targetPlunge = Math.min(1.45, excess * 3.8 * plungeFactor * (0.50 + 0.50 * frontFaceMask));
        }

        this.etaNext[idx] = Math.max(-d0 * 0.78, Math.min(6.2, nextEta));
        this.rollerNext[idx] = Math.min(1.0, nextRoller);

        const neighborPlunge = Math.max(
          this.plunge[idx],
          this.plunge[idx - N] * 0.90,
          this.plunge[idx + N] * 0.90
        );
        const plungeDecay = Math.exp(-dt * 8.5);
        this.plunge[idx] = Math.max(neighborPlunge * plungeDecay, targetPlunge);

        // Residual bubble trail in the water (fades quickly behind the roller)
        const trailDecay = Math.exp(-dt * 1.45);
        this.foamNext[idx] = Math.min(1.0, Math.max(this.foam[idx] * trailDecay, nextRoller * 0.42));
      }
    }

    this.eta.set(this.etaNext);
    this.roller.set(this.rollerNext);
    this.foam.set(this.foamNext);
  }

  buildRenderFields(oceanParams) {
    const N = this.N;
    const invDx = 1.0 / this.dx;
    const tide = oceanParams.tideLevel;
    const elev = this.bty.elevation;
    const slope = this.bty.slope;

    const windAlignment = Math.cos((oceanParams.windDir * Math.PI) / 180);
    const offshoreHold = windAlignment * Math.min(1.0, oceanParams.windSpeed / 18.0);

    const H0 = Math.max(0.3, oceanParams.swellHeight);
    const T1 = Math.max(5.0, oceanParams.swellPeriod);
    const L0 = (GRAVITY * T1 * T1) / (2.0 * Math.PI);
    const deepSteepnessSqrt = Math.sqrt(Math.max(0.002, H0 / L0));
    const wavelength1 = 44.0 + (T1 - 5.0) * 3.0;
    const k1 = (2.0 * Math.PI) / wavelength1;

    const swellRad = (oceanParams.swellDir * Math.PI) / 180;
    const incDirX = Math.sin(swellRad);
    const incDirZ = Math.cos(swellRad);
    const phaseDelay = this.bty.phaseDelay;
    const refC = Math.sqrt(GRAVITY * 10.5);

    for (let j = 0; j < N; j++) {
      const z = (j / (N - 1) - 0.5) * WORLD_SIZE;
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
          this.foamBuf[idx] = 0.0;
          continue;
        }

        const x = (i / (N - 1) - 0.5) * WORLD_SIZE;
        const s1 = x * incDirX + (z + phaseDelay[idx] * 0.25) * incDirZ;
        const { groupEnv, setPacket } = this.evalGroupEnvelope(s1, this.simTime, oceanParams, refC, incDirZ);

        // Isotropic 9-point neighborhood average of raw Eta & Roller to prevent diagonal grid stairsteps
        const rawEta =
          this.eta[idx] * 0.52 +
          (this.eta[j * N + im] + this.eta[j * N + ip] + this.eta[jm * N + i] + this.eta[jp * N + i]) * 0.085 +
          (this.eta[jm * N + im] + this.eta[jm * N + ip] + this.eta[jp * N + im] + this.eta[jp * N + ip]) * 0.035;

        const smRoller =
          this.roller[idx] * 0.44 +
          (this.roller[j * N + im] + this.roller[j * N + ip] + this.roller[jm * N + i] + this.roller[jp * N + i]) * 0.10 +
          (this.roller[jm * N + im] + this.roller[jm * N + ip] + this.roller[jp * N + im] + this.roller[jp * N + ip]) * 0.04;

        // Komar & Gaughan (1972) Shoaling Amplification: peaks at the outer breakpoint (d0 ~ 1.8m - 2.6m)
        // and tapers inside the broken surf zone so already-broken crests fall/collapse naturally!
        const periodShoal = Math.pow(T1 / 10.0, 0.38);
        const setShoalScale = 0.20 + 0.80 * setPacket;
        const shoalMask = smoothstep(7.5, 1.75, d0) * smoothstep(0.45, 1.80, d0) * setShoalScale;
        const slopeBoost = 1.0 + Math.min(0.45, slope[idx] * 2.2) * shoalMask;

        let shapedEta = rawEta * (1.0 + 0.58 * shoalMask * periodShoal) * slopeBoost;
        if (shapedEta > 0.0) {
          // Cnoidal / solitary crest peaking at the breakpoint
          shapedEta += 0.45 * shoalMask * shapedEta * Math.min(1.40, shapedEta / Math.max(0.55, H0 * 0.45));
          shapedEta = Math.min(H0 * 1.95 * Math.max(0.22, groupEnv), shapedEta);

          // Post-break bore collapse (Thornton & Guza 1983): once the wave moves inside the breakpoint
          // into shallower water (d0 < 2.05m) with an active roller, its crest falls down into a lower bore!
          const insideShallow = smoothstep(2.05, 0.80, d0);
          const boreCollapse = insideShallow * smoothstep(0.12, 0.70, smRoller);
          const boreCap = 0.34 + 0.60 * d0;
          shapedEta = shapedEta * (1.0 - boreCollapse * 0.65) + Math.min(shapedEta, boreCap) * (boreCollapse * 0.65);
        } else {
          // Keep wave troughs strictly above submerged reefs/bars so the seabed never pokes through the trough
          const maxTroughDrop = Math.max(0.08, (d0 - 0.55) * 0.52);
          shapedEta = Math.max(-maxTroughDrop, shapedEta * (1.0 - 0.38 * shoalMask));
        }

        const dEtaDx = (this.eta[j * N + ip] - this.eta[j * N + im]) * 0.5 * invDx;
        const dEtaDz = (this.eta[jp * N + i] - this.eta[jm * N + i]) * 0.5 * invDx;
        const gradEtaMag = Math.hypot(dEtaDx, dEtaDz);

        // Phase-independent local wave amplitude envelope A_env = sqrt(eta^2 + (|gradEta|/k)^2)
        const posEta = Math.max(0.0, shapedEta);
        const envAmp = Math.hypot(posEta, gradEtaMag / k1);

        // Smooth refracted wave propagation & lateral peel direction (purely from smooth bathymetry refraction)
        const dElevDx = (elev[j * N + ip] - elev[j * N + im]) * 0.5 * invDx;
        const dElevDz = (elev[jp * N + i] - elev[jm * N + i]) * 0.5 * invDx;

        const refractWeight = smoothstep(7.5, 1.4, d0) * 0.62;
        let dirX = incDirX + dElevDx * refractWeight * 3.4;
        let dirZ = incDirZ + dElevDz * refractWeight * 3.4;
        const dirLen = Math.hypot(dirX, dirZ) || 1.0;
        dirX /= dirLen;
        dirZ /= dirLen;

        // Local Orthogonal Seabed Gradient & Iribarren Barrel Factor
        const sOrth = Math.max(0.008, Math.max(0, dElevDx * dirX + dElevDz * dirZ) + slope[idx] * 0.65);
        const xiLocal = (sOrth / deepSteepnessSqrt) * (1.0 + offshoreHold * 0.32);
        const plungeFactor = smoothstep(0.28, 0.82, xiLocal);

        // Active breaking & peeling pocket zone over the reef/bar breakpoint (d0 between 1.15m and 2.90m),
        // leaving the deeper shoulder (d0 > 2.90m) as an unbroken clean green wall and the inner shallow zone
        // (d0 < 1.15m) as a collapsed tumbling whitewater bore!
        const depthWindow = smoothstep(2.95, 1.60, d0) * smoothstep(0.75, 1.55, d0);
        const breakerLoad = smoothstep(0.36, 0.72, envAmp / Math.max(0.65, d0)) * depthWindow;

        const barrelIntensity = Math.min(
          1.45,
          Math.max(this.plunge[idx] * 0.92, breakerLoad * 1.35) *
            plungeFactor *
            (1.0 + Math.max(0, offshoreHold) * 0.25)
        );

        // Combine the active breaking wave-front roller with shoreline swash & faint bubble trail
        const onPositiveWave = smoothstep(-0.04, 0.32, shapedEta);
        const frontFaceActive = smoothstep(-0.25, 0.35, this.dEtaDt[idx]) * onPositiveWave;
        const activeRollerFoam = smRoller * (0.52 + 0.48 * frontFaceActive);
        const swashFoam = smoothstep(0.75, 0.08, d0) * smoothstep(-0.08, 0.25, shapedEta) * 0.75;
        const trailFoam = this.foam[idx] * onPositiveWave * 0.48;
        const totalFoam = Math.min(1.0, Math.max(activeRollerFoam, Math.max(trailFoam, swashFoam)));

        this.shapedBuf[idx] = shapedEta;
        this.dispXBuf[idx] = dirX * barrelIntensity;
        this.dispZBuf[idx] = dirZ * barrelIntensity;
        this.foamBuf[idx] = totalFoam;
      }
    }

    // Upload isotropic 9-point smoothed surface elevation (R), barrel vector (G, B), and foam (A) to GPU
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

        const c00 = jm * N + im;
        const c10 = jm * N + i;
        const c20 = jm * N + ip;
        const c01 = j * N + im;
        const c21 = j * N + ip;
        const c02 = jp * N + im;
        const c12 = jp * N + i;
        const c22 = jp * N + ip;

        const smEta =
          this.shapedBuf[idx] * 0.44 +
          (this.shapedBuf[c01] + this.shapedBuf[c21] + this.shapedBuf[c10] + this.shapedBuf[c12]) * 0.10 +
          (this.shapedBuf[c00] + this.shapedBuf[c20] + this.shapedBuf[c02] + this.shapedBuf[c22]) * 0.04;

        const smBarrelX =
          this.dispXBuf[idx] * 0.36 +
          (this.dispXBuf[c01] + this.dispXBuf[c21] + this.dispXBuf[c10] + this.dispXBuf[c12]) * 0.11 +
          (this.dispXBuf[c00] + this.dispXBuf[c20] + this.dispXBuf[c02] + this.dispXBuf[c22]) * 0.05;

        const smBarrelZ =
          this.dispZBuf[idx] * 0.36 +
          (this.dispZBuf[c01] + this.dispZBuf[c21] + this.dispZBuf[c10] + this.dispZBuf[c12]) * 0.11 +
          (this.dispZBuf[c00] + this.dispZBuf[c20] + this.dispZBuf[c02] + this.dispZBuf[c22]) * 0.05;

        const smFoam =
          this.foamBuf[idx] * 0.36 +
          (this.foamBuf[c01] + this.foamBuf[c21] + this.foamBuf[c10] + this.foamBuf[c12]) * 0.11 +
          (this.foamBuf[c00] + this.foamBuf[c20] + this.foamBuf[c02] + this.foamBuf[c22]) * 0.05;

        this.simTexData[k4 + 0] = Number.isFinite(smEta) ? smEta : 0.0;
        this.simTexData[k4 + 1] = Number.isFinite(smBarrelX) ? smBarrelX : 0.0;
        this.simTexData[k4 + 2] = Number.isFinite(smBarrelZ) ? smBarrelZ : 0.0;
        this.simTexData[k4 + 3] = Number.isFinite(smFoam) ? smFoam : 0.0;
      }
    }

    this.simTexture.needsUpdate = true;
  }

  update(dt, oceanParams) {
    // Advance PDE solver in exact 1:1 wall-clock seconds (scaled by oceanParams.timeScale)
    // using a fixed Courant-stable physics sub-step (0.015s)
    const timeScale = oceanParams.timeScale ?? 1.0;
    const scaledDt = Math.min(0.15, Math.max(0.0, (dt || 0.016) * timeScale));
    this.timeAccumulator += scaledDt;

    const dtSub = 0.015;
    let stepsRun = 0;
    const maxSubSteps = 12;
    while (this.timeAccumulator >= dtSub && stepsRun < maxSubSteps) {
      this.stepPDE(dtSub, oceanParams);
      this.timeAccumulator -= dtSub;
      stepsRun++;
    }
    if (stepsRun > 0) {
      this.buildRenderFields(oceanParams);
    }
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

  /**
   * Computes the live group-envelope phase and countdown (in seconds) until the next set
   * reaches the outer take-off peak (z = -38m).
   */
  getSetCountdown(oceanParams) {
    const T1 = Math.max(5.0, oceanParams.swellPeriod ?? 14.0);
    const wavesPerSet = Math.max(2.0, oceanParams.wavesPerSet ?? 6.0);
    const setCycleSec = Math.round(wavesPerSet * T1);
    const grouping = oceanParams.swellGrouping ?? 10.0;

    if (grouping <= 5.0) {
      return {
        isContinuous: true,
        isSetActive: true,
        secondsRemaining: 0,
        setCycleSec,
        envelopeVal: 1.0,
      };
    }

    const refDepth = 10.5;
    const refC = Math.sqrt(GRAVITY * refDepth);
    const dir1 = ((oceanParams.swellDir ?? 0.0) * Math.PI) / 180;
    const kz1 = Math.cos(dir1);
    const sTakeoff = -140.0 * kz1;
    const { groupPhase, setPacket } = this.evalGroupEnvelope(sTakeoff, this.simTime, oceanParams, refC, kz1);

    // Normalize advancing cycle angle psi in [0, 2*PI), where 0 (and 2*PI) is the exact Set Peak
    const twoPi = 2.0 * Math.PI;
    const psi = ((-groupPhase % twoPi) + twoPi) % twoPi;

    // A set is actively rolling through the take-off zone when psi is within +-0.32*PI of the peak (setPacket >= 0.40)
    const setHalfWidthRad = 0.32 * Math.PI;
    const setStartRad = twoPi - setHalfWidthRad;
    const isSetActive = psi <= setHalfWidthRad || psi >= setStartRad;

    if (isSetActive) {
      const radLeftInSet = psi >= setStartRad ? (twoPi - psi) + setHalfWidthRad : setHalfWidthRad - psi;
      const secondsRemaining = Math.max(1, Math.ceil((radLeftInSet / twoPi) * setCycleSec));
      return {
        isContinuous: false,
        isSetActive: true,
        secondsRemaining,
        setCycleSec,
        envelopeVal: setPacket,
      };
    } else {
      const radToNextSet = setStartRad - psi;
      const secondsRemaining = Math.max(1, Math.ceil((radToNextSet / twoPi) * setCycleSec));
      return {
        isContinuous: false,
        isSetActive: false,
        secondsRemaining,
        setCycleSec,
        envelopeVal: setPacket,
      };
    }
  }
}
