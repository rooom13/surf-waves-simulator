import * as THREE from 'three';
import { WORLD_SIZE } from './bathymetry.js';
import { PARTICLE_TYPE_BOARD_SPRAY } from './spraySystem.js';
import { createSurfboardMesh, createSurferFigure } from './surferModel.js';

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Riding dynamics constants
const GRAVITY = 9.81;
// The PDE grid is smoothed (~3.3m cells), so sampled face slopes understate the real face.
const FACE_GRAVITY_GAIN = 1.9;
// Tightest carve radius (m) a shortboard can hold on rail at speed.
const CARVE_MIN_RADIUS = 4.2;
// Fraction of speed scrubbed per unit slip when the fins redirect sideways momentum.
const CARVE_SLIP_LOSS = 0.35;

/**
 * First-Person POV Surfing Controller (WASD + Space Take-Off + Mouse Look)
 * Rides the actual 3D displaced ocean surface with wave-slope gravity propulsion,
 * rail carving physics, barrel/tube detection, and a visible 1:1 scale 3D surfboard.
 */
export class SurferPovController {
  constructor(scene, camera, controls, waveSolver, btyManager, spraySystem) {
    this.scene = scene;
    this.camera = camera;
    this.controls = controls;
    this.waveSolver = waveSolver;
    this.bty = btyManager;
    this.spraySystem = spraySystem;

    this.active = false;

    // Surfer state in 1:1 metric world coordinates (meters)
    this.pos = new THREE.Vector3(12, 0.5, -18);
    this.vel = new THREE.Vector3(-4.5, 0, 3.2);
    this.yaw = Math.atan2(-4.5, 3.2); // Direction board nose points in XZ plane
    this.pitch = -0.06;
    this.roll = 0.0;

    // Head look offset relative to board yaw/pitch (controlled by mouse drag)
    this.lookYawOffset = 0.0;
    this.lookPitchOffset = -0.08;
    this.isPointerLooking = false;
    this.lastPointerX = 0;
    this.lastPointerY = 0;

    // Surfing status metrics for HUD
    this.speed = 0;
    this.isOnWave = false;
    this.isInBarrel = false;
    this.barrelTime = 0;
    this.rideTime = 0;
    this.statusLabel = 'Paddling in Lineup';
    this.paddlePhase = 0;
    this.mode = 'paddle';
    this.sitWeight = 1.0; // 1.0 = sitting on board, 0.0 = prone paddling
    this.simTimeTotal = 0;
    this.toast = '';
    this.toastTime = 0;
    this.slowTime = 0;

    // Sprint paddling via double-tap W (or Shift+W)
    this.lastWPressTime = 0;
    this.prevWDown = false;
    this.isSprinting = false;

    // Progressive rail engagement (smoothed A/D input; sign follows turnInput)
    this.carveInput = 0.0;
    this.turnRate = 0.0;

    // Duck dive state (submerging under oncoming wave crest/whitewater)
    this.duckDivePhase = 0.0; // 0 = surface, >0 = diving underwater (duration ~1.5s)
    this.duckDiveDepth = 0.0; // vertical offset in meters (negative underwater)

    // Camera view mode: 'third_person' (user-placed orbit view) or 'first_person' (surfer POV)
    this.viewMode = 'third_person';
    this.camPosSmoothed = null;
    this.camLookSmoothed = null;
    this.thirdPersonYaw = null;
    this.thirdPersonPitch = 0.38;
    this.thirdPersonDist = 6.2;

    // Build 1:1 metric 3D surfboard mesh (2.05m x 0.52m shortboard)
    this.boardGroup = createSurfboardMesh();
    this.boardGroup.visible = false;
    this.scene.add(this.boardGroup);

    // Build 1:1 metric 3D surfer figure (prone paddling, sitting straddle, & standing ride poses)
    const figure = createSurferFigure();
    this.surferFigureGroup = figure.group;
    this.surferProneGroup = figure.proneGroup;
    this.surferStandingGroup = figure.standingGroup;
    this.surferSittingGroup = figure.sittingGroup;
    this.standingUpperGroup = figure.standingUpperGroup;
    this.proneHead = figure.proneHead;
    this.proneArmL = figure.proneArmL;
    this.proneArmR = figure.proneArmR;
    this.standArmL = figure.standArmL;
    this.standArmR = figure.standArmR;
    this.sitHead = figure.sitHead;
    this.sitArmL = figure.sitArmL;
    this.sitArmR = figure.sitArmR;
    this.boardGroup.add(this.surferFigureGroup);
  }

  enable(oceanParams, viewMode = 'third_person') {
    this.active = true;
    this.controls.enabled = false;
    this.boardGroup.visible = true;
    this.camPosSmoothed = null;
    this.camLookSmoothed = null;
    this.setViewMode(viewMode);
    this.camera.near = 0.15;
    this.resetToLineup(oceanParams, true);
    if (this.thirdPersonYaw === null || this.thirdPersonYaw === undefined) {
      this.thirdPersonYaw = this.yaw;
    }
  }

  setViewMode(viewMode) {
    this.viewMode = viewMode === 'first_person' ? 'first_person' : 'third_person';
    if (this.viewMode === 'third_person') {
      this.camera.fov = 62;
      this.surferFigureGroup.visible = true;
      if (this.thirdPersonYaw === null || this.thirdPersonYaw === undefined) {
        this.thirdPersonYaw = this.yaw;
      }
    } else {
      this.camera.fov = 68;
      this.surferFigureGroup.visible = false;
    }
    this.camera.updateProjectionMatrix();
  }

  toggleViewMode() {
    this.setViewMode(this.viewMode === 'third_person' ? 'first_person' : 'third_person');
    return this.viewMode;
  }

  disable() {
    if (!this.active) return;
    this.active = false;
    this.controls.enabled = true;
    this.boardGroup.visible = false;
    this.camPosSmoothed = null;
    this.camLookSmoothed = null;
    this.camera.fov = 48;
    this.camera.near = 0.5;
    this.camera.updateProjectionMatrix();
    this.camera.up.set(0, 1, 0);
    document.body.style.cursor = '';
  }

  onPointerDown(e) {
    if (!this.active || (e.button !== 0 && e.button !== 2)) return;
    this.isPointerLooking = true;
    this.lastPointerX = e.clientX;
    this.lastPointerY = e.clientY;
    document.body.style.cursor = 'grabbing';
  }

  onPointerMove(e) {
    if (!this.active || !this.isPointerLooking) return;
    const dx = e.clientX - this.lastPointerX;
    const dy = e.clientY - this.lastPointerY;
    this.lastPointerX = e.clientX;
    this.lastPointerY = e.clientY;

    if (this.viewMode === 'third_person') {
      if (this.thirdPersonYaw === null || this.thirdPersonYaw === undefined) {
        this.thirdPersonYaw = this.yaw;
      }
      this.thirdPersonYaw -= dx * 0.005;
      this.thirdPersonPitch = Math.max(-0.15, Math.min(1.35, (this.thirdPersonPitch ?? 0.38) - dy * 0.004));
    } else {
      this.lookYawOffset -= dx * 0.0045;
      this.lookPitchOffset = Math.max(-0.55, Math.min(0.45, this.lookPitchOffset - dy * 0.0038));
    }
  }

  onPointerUp() {
    this.isPointerLooking = false;
    if (this.active) {
      document.body.style.cursor = '';
    }
  }

  onWheel(e) {
    if (!this.active || this.viewMode !== 'third_person') return;
    this.thirdPersonDist = Math.max(3.0, Math.min(22.0, (this.thirdPersonDist ?? 6.2) + e.deltaY * 0.006));
  }

  /**
   * Samples the bilinearly interpolated PDE wave state & exact 3D displaced surface elevation
   * at world coordinates (worldX, worldZ).
   */
  sampleSurface(worldX, worldZ, oceanParams) {
    const N = this.waveSolver.N;
    const data = this.waveSolver.simTexData;
    const elev = this.bty.elevation;
    const tide = oceanParams.tideLevel ?? 0.2;

    const sampleGrid = (wx, wz) => {
      const u = Math.max(0.001, Math.min(0.998, wx / WORLD_SIZE + 0.5));
      const v = Math.max(0.001, Math.min(0.998, wz / WORLD_SIZE + 0.5));
      const fx = u * (N - 1);
      const fz = v * (N - 1);
      const i0 = Math.floor(fx);
      const j0 = Math.floor(fz);
      const i1 = Math.min(N - 1, i0 + 1);
      const j1 = Math.min(N - 1, j0 + 1);
      const tx = fx - i0;
      const tz = fz - j0;

      const idx00 = j0 * N + i0;
      const idx10 = j0 * N + i1;
      const idx01 = j1 * N + i0;
      const idx11 = j1 * N + i1;

      const bilerp = (a00, a10, a01, a11) =>
        (a00 * (1 - tx) + a10 * tx) * (1 - tz) + (a01 * (1 - tx) + a11 * tx) * tz;

      const eta = bilerp(data[idx00 * 4], data[idx10 * 4], data[idx01 * 4], data[idx11 * 4]);
      const bx = bilerp(data[idx00 * 4 + 1], data[idx10 * 4 + 1], data[idx01 * 4 + 1], data[idx11 * 4 + 1]);
      const bz = bilerp(data[idx00 * 4 + 2], data[idx10 * 4 + 2], data[idx01 * 4 + 2], data[idx11 * 4 + 2]);
      const foam = bilerp(data[idx00 * 4 + 3], data[idx10 * 4 + 3], data[idx01 * 4 + 3], data[idx11 * 4 + 3]);
      const seabed = bilerp(elev[idx00], elev[idx10], elev[idx01], elev[idx11]);
      return { eta, bx, bz, foam, seabed, depth: tide - seabed };
    };

    const evalDisplacementAtBase = (bxCoord, bzCoord) => {
      const s0 = sampleGrid(bxCoord, bzCoord);
      const stepD = 2.85;
      const sPX = sampleGrid(bxCoord + stepD, bzCoord);
      const sMX = sampleGrid(bxCoord - stepD, bzCoord);
      const sPZ = sampleGrid(bxCoord, bzCoord + stepD);
      const sMZ = sampleGrid(bxCoord, bzCoord - stepD);

      const gradX = (sPX.eta - sMX.eta) / (2 * stepD);
      const gradZ = (sPZ.eta - sMZ.eta) / (2 * stepD);
      const smoothFoam = s0.foam * 0.36 + (sPX.foam + sMX.foam + sPZ.foam + sMZ.foam) * 0.16;

      const bTube = Math.hypot(s0.bx, s0.bz);
      const kHatX = bTube > 0.001 ? s0.bx / bTube : 0.0;
      const kHatZ = bTube > 0.001 ? s0.bz / bTube : 1.0;

      const frontSlope = -(gradX * kHatX + gradZ * kHatZ);
      const frontFace = smoothstep(0.01, 0.15, frontSlope);
      const upperCrest = smoothstep(-0.08, 0.12, frontSlope) * smoothstep(0.35, 2.05, s0.eta);
      const shoalWall = smoothstep(7.5, 1.6, s0.depth) * smoothstep(0.10, 0.70, s0.depth);
      const breakProgress = smoothstep(0.18, 0.82, smoothFoam);

      const sBehind = sampleGrid(bxCoord - kHatX * 2.85, bzCoord - kHatZ * 2.85);
      const localPeakEta = Math.max(s0.eta, sBehind.eta);
      const normFaceH = Math.max(0, Math.min(1, s0.eta / Math.max(0.45, localPeakEta)));
      const isTallBarrel = smoothstep(1.18, 1.72, localPeakEta) * smoothstep(0.24, 0.80, bTube);

      const steepScale = 1.55 + 1.10 * shoalWall;
      let dispX = Math.tanh(gradX * 1.35) * steepScale;
      let dispZ = Math.tanh(gradZ * 1.35) * steepScale;

      const steepPocketFace = smoothstep(0.05, 0.20, frontSlope) * isTallBarrel;
      const pocketBand = steepPocketFace * smoothstep(0.08, 0.28, normFaceH) * (1.0 - smoothstep(0.70, 0.90, normFaceH));
      const pocketStrength = pocketBand * Math.min(1.40, bTube);
      dispX -= kHatX * pocketStrength * 1.95;
      dispZ -= kHatZ * pocketStrength * 1.95;
      const pocketCarveY = -pocketStrength * 0.42;

      const crestRoof = smoothstep(-0.04, 0.12, frontSlope) * smoothstep(0.65, 0.92, normFaceH) * isTallBarrel;
      const crestThrow = crestRoof * Math.min(1.35, bTube) * (1.0 - breakProgress * 0.50);
      dispX += kHatX * crestThrow * 2.65;
      dispZ += kHatZ * crestThrow * 2.65;

      const crestLiftY = upperCrest * (1.0 - breakProgress * 0.95) * (0.46 * shoalWall + 0.30 * Math.min(1.2, bTube));
      const lipEdge = frontFace * smoothstep(0.72, 0.96, normFaceH) * isTallBarrel;
      dispX += kHatX * lipEdge * 0.85;
      dispZ += kHatZ * lipEdge * 0.85;
      const lipDropY = -lipEdge * 0.48;
      const collapseDropY = -breakProgress * Math.max(0.0, s0.eta - 0.15) * 0.85;

      const minFloorY = s0.seabed + 0.30;
      const surfaceY = Math.max(minFloorY, tide + s0.eta + crestLiftY + pocketCarveY + lipDropY + collapseDropY);

      return {
        dispX,
        dispZ,
        surfaceY,
        eta: s0.eta,
        seabed: s0.seabed,
        gradX,
        gradZ,
        bTube,
        kHatX,
        kHatZ,
        foam: s0.foam,
        depth: s0.depth,
        frontSlope,
        pocketStrength,
      };
    };

    // 2-step fixed-point inversion to find baseXZ whose displaced 3D position matches (worldX, worldZ)
    let baseX = worldX;
    let baseZ = worldZ;
    for (let iter = 0; iter < 2; iter++) {
      const d = evalDisplacementAtBase(baseX, baseZ);
      baseX = worldX - d.dispX * 0.65;
      baseZ = worldZ - d.dispZ * 0.65;
    }

    return evalDisplacementAtBase(baseX, baseZ);
  }

  /**
   * Finds the best active peaking wave in the surf zone and parks the surfer
   * in the lineup just seaward of it (prone, paddling).
   */
  resetToLineup(oceanParams, allowWarmup = true) {
    const N = this.waveSolver.N;
    const data = this.waveSolver.simTexData;
    const elev = this.bty.elevation;
    const tide = oceanParams.tideLevel ?? 0.2;
    const preset = this.bty.preset;

    // Peel direction sign: right_point peels toward -X, left_point peels toward +X
    const peelSign = preset === 'left_point' ? 1.0 : -1.0;

    const findBestPeak = () => {
      let bestScore = -1e9;
      let bestX = 156 * -peelSign;
      let bestZ = -150;
      let bestDirX = 0.72 * peelSign;
      let bestDirZ = 0.68;

      for (let j = Math.floor(N * 0.12); j < Math.floor(N * 0.75); j += 2) {
        const wz = (j / (N - 1) - 0.5) * WORLD_SIZE;
        for (let i = Math.floor(N * 0.08); i < Math.floor(N * 0.92); i += 2) {
          const wx = (i / (N - 1) - 0.5) * WORLD_SIZE;
          const idx = j * N + i;
          const d0 = tide - elev[idx];
          if (d0 < 1.35 || d0 > 4.6) continue;

          const k4 = idx * 4;
          const eta = data[k4];
          const bx = data[k4 + 1];
          const bz = data[k4 + 2];
          const foam = data[k4 + 3];
          const bTube = Math.hypot(bx, bz);

          if (eta < 0.70) continue;
          // Prioritize the outer take-off peak so surfers can ride the full length of the point break
          const seawardBonus = preset.includes('point') ? Math.max(0, -wz * 0.04) : 0.0;
          const pocketScore = eta * 2.2 + bTube * 3.0 - Math.max(0, foam - 0.48) * 3.5 + seawardBonus;
          if (pocketScore > bestScore) {
            bestScore = pocketScore;
            const propX = bTube > 0.05 ? bx / bTube : 0.0;
            const propZ = bTube > 0.05 ? bz / bTube : 1.0;
            // Place surfer on the steep front wall right at the mouth of the peeling barrel pocket
            bestX = wx + peelSign * 2.8 + propX * 1.8;
            bestZ = wz + propZ * 1.8;
            bestDirX = propX * 0.55 + peelSign * 0.83;
            bestDirZ = propZ * 0.55 + 0.22;
          }
        }
      }
      return { bestScore, bestX, bestZ, bestDirX, bestDirZ };
    };

    let peak = findBestPeak();
    // If the ocean is in a lull between sets, bring in a fresh set so there is a wave to wait for
    if (allowWarmup && peak.bestScore < 2.4) {
      this.waveSolver.warmup(oceanParams, 300);
      if (this.spraySystem) {
        this.spraySystem.warmup(oceanParams, this.waveSolver, 45);
      }
      peak = findBestPeak();
    }

    // Park the surfer prone on the board in the lineup, seaward of the breaking peak,
    // facing the shore. The surfer must paddle into a wave and take off - no teleporting onto the face.
    const lineupX = peak.bestX;
    const lineupZ = Math.max(-WORLD_SIZE * 0.44, peak.bestZ - 28);
    const surfSample = this.sampleSurface(lineupX, lineupZ, oceanParams);
    this.pos.set(lineupX, surfSample.surfaceY, lineupZ);
    this.yaw = Math.atan2(peelSign * 0.28, 1.0);
    this.vel.set(0, 0, 0);
    this.mode = 'paddle';
    this.sitWeight = 1.0;
    this.isSprinting = false;
    this.carveInput = 0.0;
    this.turnRate = 0.0;
    this.prevWDown = false;
    this.duckDivePhase = 0.0;
    this.duckDiveDepth = 0.0;
    this.lookYawOffset = 0.0;
    this.lookPitchOffset = -0.05;
    this.camPosSmoothed = null;
    this.camLookSmoothed = null;
    this.barrelTime = 0;
    this.slowTime = 0;
    this.isOnWave = false;
    this.isInBarrel = false;
  }

  /**
   * Take-off is only allowed while the surfer is on the rising front face of a real wave.
   */
  canTakeOff(sample) {
    return sample.eta > 0.45 && sample.frontSlope > 0.03 && sample.depth > 0.9;
  }

  takeOff(oceanParams) {
    if (!this.active || this.mode !== 'paddle') return;
    const s = this.sampleSurface(this.pos.x, this.pos.z, oceanParams);
    if (!this.canTakeOff(s)) {
      this.showToast('No wave under you - paddle (W) into an approaching wave face, then press SPACE');
      return;
    }
    // Pop up directly in the direction the surfer is currently pointing (no direction jump)
    const dirX = Math.sin(this.yaw);
    const dirZ = Math.cos(this.yaw);
    const currentSpeed = Math.hypot(this.vel.x, this.vel.z);
    const takeOffSpeed = Math.max(7.2, currentSpeed * 1.4);
    this.vel.set(dirX * takeOffSpeed, 0, dirZ * takeOffSpeed);
    this.mode = 'ride';
    this.sitWeight = 0.0;
    this.carveInput = 0.0;
    this.slowTime = 0;
    this.showToast('Take-off! Carve with A / D');
  }

  showToast(msg) {
    this.toast = msg;
    this.toastTime = 2.8;
  }

  update(dt, keyState, oceanParams) {
    if (!this.active || dt <= 0) return;
    if (this.toastTime > 0) this.toastTime -= dt;
    this.simTimeTotal = (this.simTimeTotal || 0) + dt;

    // 1. Sample wave surface at current surfer XZ
    const s = this.sampleSurface(this.pos.x, this.pos.z, oceanParams);
    const paddling = this.mode === 'paddle';
    const takeOffReady = paddling && this.canTakeOff(s);

    // 2. Read WASD / Arrow inputs & double-tap W sprint detection
    let throttle = 0;
    let turnInput = 0;
    if (keyState.KeyW || keyState.ArrowUp) throttle += 1;
    if (keyState.KeyS || keyState.ArrowDown) throttle -= 1;
    if (keyState.KeyA || keyState.ArrowLeft) turnInput += 1; // Turn left (+yaw)
    if (keyState.KeyD || keyState.ArrowRight) turnInput -= 1; // Turn right (-yaw)

    const wDown = Boolean(keyState.KeyW || keyState.ArrowUp);
    const shiftDown = Boolean(keyState.ShiftLeft || keyState.ShiftRight);

    // Double-tap W detection (within 350ms) or Shift hold triggers sprint paddling
    if (paddling) {
      if (wDown && !this.prevWDown) {
        const now = performance.now();
        if (now - this.lastWPressTime < 350) {
          this.isSprinting = true;
          this.showToast('⚡ SPRINT PADDLING!');
        }
        this.lastWPressTime = now;
      }
      if (!wDown) {
        this.isSprinting = false;
      }
      if (shiftDown && wDown) {
        this.isSprinting = true;
      }
    } else {
      this.isSprinting = false;
    }
    this.prevWDown = wDown;

    // Duck dive mechanics:
    // When paddling/waiting in the lineup or paddling for waves, pressing S initiates or maintains a duck dive
    // under oncoming waves / broken whitewater!
    if (paddling && throttle < 0) {
      this.duckDivePhase = Math.min(1.5, this.duckDivePhase + dt);
    } else if (this.duckDivePhase > 0) {
      // Smoothly resurface once S is released or time limit expires
      this.duckDivePhase = Math.max(0, this.duckDivePhase - dt * 2.2);
    }
    const isDuckDiving = this.duckDivePhase > 0.05;

    const curSpeed = Math.hypot(this.vel.x, this.vel.z);

    // Smooth transition between sitting (stopped/idle in lineup) and prone paddling
    if (paddling && !isDuckDiving) {
      if (throttle > 0 || this.isSprinting) {
        // Drop down quickly onto stomach to paddle
        this.sitWeight = Math.max(0.0, this.sitWeight - dt * 4.5);
      } else if (curSpeed < 0.95) {
        // Stopped or drifting slowly in lineup -> sit upright straddling board
        this.sitWeight = Math.min(1.0, this.sitWeight + dt * 2.8);
      } else {
        // Coasting down before settling into sitting
        this.sitWeight = Math.max(0.0, this.sitWeight - dt * 1.5);
      }
    } else {
      this.sitWeight = Math.max(0.0, this.sitWeight - dt * 5.0);
    }
    const isSitting = paddling && !isDuckDiving && this.sitWeight > 0.45;

    // 3. Rail engagement & steering
    // The rail engages progressively (≈0.2s) instead of snapping, and releases a bit faster.
    const prevCarve = this.carveInput;
    const engageRate = Math.abs(turnInput) > Math.abs(this.carveInput) ? 5.5 : 8.0;
    this.carveInput += (turnInput - this.carveInput) * Math.min(1.0, dt * engageRate);
    const carve = this.carveInput;
    const carveRate = (carve - prevCarve) / dt;

    let turnRate;
    if (isDuckDiving) {
      turnRate = 0.35 * turnInput;
    } else if (paddling) {
      // When sitting straddling the board, surfer can rapidly pivot/swivel the board (egg-beater kick) to catch sets
      turnRate = (isSitting ? 2.2 : 0.90) * turnInput;
    } else {
      // A planing board turns on its rail with a minimum radius R, so yaw rate = v / R.
      // Fast surfers carve tight arcs; a bogged-down board can only pivot slowly.
      const yawRateMax = Math.min(2.9, Math.max(1.0, curSpeed / CARVE_MIN_RADIUS));
      turnRate = yawRateMax * carve;
    }
    this.yaw += turnRate * dt;
    this.turnRate = turnRate;

    // Gently recenter head-look yaw when carving in 1st person unless actively dragging mouse
    if (this.viewMode === 'first_person' && !this.isPointerLooking && Math.abs(turnInput) > 0.1) {
      this.lookYawOffset *= Math.exp(-dt * 2.2);
    }

    const dirX = Math.sin(this.yaw);
    const dirZ = Math.cos(this.yaw);

    // 4. Forces: gravity on the moving wave surface + wave/curl push + pumping + drag.
    // Speed is EARNED by converting height into velocity (dropping down the face) and lost
    // when climbing back up. Carving does not create speed by itself - it redirects momentum.
    const slopeMag = Math.hypot(s.gradX, s.gradZ);
    const downSlopeX = slopeMag > 0.001 ? -s.gradX / slopeMag : 0.0;
    const downSlopeZ = slopeMag > 0.001 ? -s.gradZ / slopeMag : 1.0;
    const onFrontFace = !paddling && s.frontSlope > 0.012 && s.eta > 0.18;
    const faceMask = smoothstep(0.02, 0.18, s.frontSlope);

    // Tangential component of gravity along the height field (same law uphill and downhill,
    // so climbing to the lip costs exactly the speed a drop gives back).
    const gravScale = paddling ? 4.5 : (GRAVITY * FACE_GRAVITY_GAIN) / Math.sqrt(1.0 + slopeMag * slopeMag);
    let ax = -s.gradX * gravScale;
    let az = -s.gradZ * gravScale;

    const downhillAlignment = Math.max(0.0, dirX * downSlopeX + dirZ * downSlopeZ);

    if (onFrontFace) {
      // The advancing wave and its curl shove the board shoreward (along the wave direction).
      // The fins turn that shove into down-the-line speed when the board is angled across the face.
      const curlPush = (1.1 + s.bTube * 2.6) * faceMask;
      ax += s.kHatX * curlPush;
      az += s.kHatZ * curlPush;

      // Rail-to-rail pumping: weighting/unweighting when switching rails adds a little energy.
      // Rewards rhythmic S-turns on the face (not just holding a key).
      const railPump = Math.min(2.8, Math.abs(carveRate) * 0.55) * faceMask;
      ax += dirX * railPump;
      az += dirZ * railPump;
    }

    // Surfer W/S input:
    // Paddling: W = paddle forward, S = duck dive under waves.
    // Riding: W = pump (modest leg drive), S = stall into the barrel
    if (paddling) {
      if (isDuckDiving) {
        // Momentum pushes forward underwater through the wave
        ax += dirX * 1.8;
        az += dirZ * 1.8;
      } else if (throttle > 0) {
        const sprintMult = this.isSprinting ? 2.15 : 1.0;
        ax += dirX * (3.4 * sprintMult);
        az += dirZ * (3.4 * sprintMult);
        this.paddlePhase += dt * (this.isSprinting ? 12.0 : 6.5);
      } else {
        this.paddlePhase += dt * 1.2;
      }
    } else if (throttle > 0) {
      const boost = onFrontFace ? 2.4 : 1.0;
      ax += dirX * boost;
      az += dirZ * boost;
      this.paddlePhase += dt * (onFrontFace ? 3.0 : 7.5);
    } else if (throttle < 0) {
      // Stalling tail brake lets the tube catch up to you!
      ax -= this.vel.x * 2.2;
      az -= this.vel.z * 2.2;
    } else {
      this.paddlePhase += dt * 1.8;
    }

    // Integrate horizontal velocity
    this.vel.x += ax * dt;
    this.vel.z += az * dt;

    // Fins & rails: lateral (sideways) velocity is redirected into the board's heading rather
    // than thrown away. Speed magnitude is preserved minus a slip loss proportional to the
    // slip angle - hard, skidding turns scrub speed; clean carves keep it.
    {
      const forwardSpeed = this.vel.x * dirX + this.vel.z * dirZ;
      const lateralX = this.vel.x - dirX * forwardSpeed;
      const lateralZ = this.vel.z - dirZ * forwardSpeed;
      const lateralMag = Math.hypot(lateralX, lateralZ);
      const speedNow = Math.hypot(this.vel.x, this.vel.z);
      const grip = 1.0 - Math.exp(-dt * (speedNow > 2.5 ? 10.0 : 5.0));
      const keepLat = 1.0 - grip;

      if (!paddling && forwardSpeed > 0.5) {
        const slip = lateralMag / Math.max(0.001, speedNow); // sin(slip angle)
        const slipLoss = 1.0 - Math.min(0.5, CARVE_SLIP_LOSS * slip * grip);
        const newLat = lateralMag * keepLat;
        const newFwd = Math.sqrt(Math.max(0, forwardSpeed * forwardSpeed + lateralMag * lateralMag - newLat * newLat)) * slipLoss;
        this.vel.x = dirX * newFwd + lateralX * keepLat;
        this.vel.z = dirZ * newFwd + lateralZ * keepLat;
      } else {
        const alignedSpeed = Math.max(-1.8, forwardSpeed);
        this.vel.x = dirX * alignedSpeed + lateralX * keepLat;
        this.vel.z = dirZ * alignedSpeed + lateralZ * keepLat;
      }
    }

    // Hydrodynamic drag: linear skin friction + quadratic form drag (planing board).
    const isCarving = onFrontFace && Math.abs(carve) > 0.35;
    const linDrag = paddling ? 1.5 : onFrontFace ? 0.17 : 0.5;
    const quadDrag = paddling ? 0.0 : 0.006;
    const sp = Math.hypot(this.vel.x, this.vel.z);
    const dragFactor = Math.exp(-dt * (linDrag + quadDrag * sp));
    this.vel.x *= dragFactor;
    this.vel.z *= dragFactor;

    const maxSpeed = paddling ? (this.isSprinting ? 3.85 : 2.3) : 15.5;
    const newSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (newSpeed > maxSpeed) {
      this.vel.x = (this.vel.x / newSpeed) * maxSpeed;
      this.vel.z = (this.vel.z / newSpeed) * maxSpeed;
    }
    this.speed = Math.hypot(this.vel.x, this.vel.z);

    // Advance position and keep within ocean bounds & off dry land
    const boundX = WORLD_SIZE * 0.46;
    const boundZMin = -WORLD_SIZE * 0.46;
    const boundZMax = WORLD_SIZE * 0.42;
    let nextX = Math.max(-boundX, Math.min(boundX, this.pos.x + this.vel.x * dt));
    let nextZ = Math.max(boundZMin, Math.min(boundZMax, this.pos.z + this.vel.z * dt));

    const nextSample = this.sampleSurface(nextX, nextZ, oceanParams);
    if (nextSample.depth < 0.22) {
      // Gently bounce off dry shoreline / jetty rocks back toward deeper water
      this.vel.z = Math.min(0, this.vel.z) - 2.0;
      nextZ = this.pos.z - 0.5;
    }

    this.pos.x = nextX;
    this.pos.z = nextZ;

    // Smoothly track vertical wave surface elevation & apply duck dive submarine immersion
    const targetY = nextSample.surfaceY;
    if (isDuckDiving) {
      // Submerge nose down up to 1.45m below water level
      const diveProgress = Math.min(1.0, this.duckDivePhase / 0.85);
      const targetSubmerge = -1.45 * Math.sin(diveProgress * Math.PI);
      this.duckDiveDepth += (targetSubmerge - this.duckDiveDepth) * Math.min(1.0, dt * 8.0);
    } else {
      this.duckDiveDepth += (0.0 - this.duckDiveDepth) * Math.min(1.0, dt * 10.0);
    }
    const finalSurfY = Math.max(nextSample.seabed + 0.35, targetY + this.duckDiveDepth);
    this.pos.y += (finalSurfY - this.pos.y) * Math.min(1.0, dt * 18.0);

    // 5. Evaluate Surfing & Barrel State for HUD
    this.isOnWave = onFrontFace && this.speed > 3.2;
    this.isInBarrel =
      onFrontFace && nextSample.bTube > 0.34 && nextSample.eta > 0.65 && nextSample.foam < 0.88 && this.speed > 2.6;

    // Automatic drop down to paddle position when speed drops below planing threshold
    if (this.mode === 'ride') {
      const lostSpeed = this.speed < 2.5 || (this.speed < 3.2 && !onFrontFace);
      this.slowTime = lostSpeed || nextSample.foam > 0.94 ? this.slowTime + dt : 0;
      if (this.slowTime > 0.45) {
        this.mode = 'paddle';
        this.sitWeight = 0.0; // Prone paddling position on the deck
        this.isOnWave = false;
        this.isInBarrel = false;
        this.slowTime = 0;
        this.showToast('Speed dropped — back to paddle position');
      }
    }

    const isPaddling = this.mode === 'paddle';
    const isSittingNow = isPaddling && !isDuckDiving && this.sitWeight > 0.45;

    if (isPaddling) {
      if (isDuckDiving) {
        this.statusLabel = '🤿 DUCK DIVE! Punching Under Oncoming Wave Crest';
      } else if (isSittingNow) {
        this.statusLabel = takeOffReady
          ? '✅ Wave approaching! Press W to paddle into it, then SPACE'
          : '🌊 Sitting on board in lineup (W to paddle • Double-tap W to Sprint • S to Duck Dive)';
      } else {
        this.statusLabel = takeOffReady
          ? '✅ On a wave face - press SPACE to take off!'
          : this.isSprinting
            ? '⚡ SPRINT PADDLING! (Double-Tap W)'
            : throttle > 0
              ? '🏊 Paddling - line up with an approaching wave'
              : '🌊 Waiting in the lineup (W to paddle • Double-tap W to Sprint • S to Duck Dive)';
      }
    } else if (this.isInBarrel) {
      this.barrelTime += dt;
      this.rideTime += dt;
      this.statusLabel = `🌀 INSIDE THE BARREL! (${this.barrelTime.toFixed(1)}s Tube)`;
    } else if (this.isOnWave) {
      this.rideTime += dt;
      this.statusLabel = isCarving
        ? '⚡ Hard Rail Carve! Pumping for Speed'
        : downhillAlignment > 0.25
        ? '🚀 Dropping Down Wave Face!'
        : slopeMag > 0.18
        ? '⚡ Carving Steep Pocket Wall'
        : '🏄 Planing on Open Wave Face';
    } else {
      this.statusLabel = '🏄 Riding - keep your speed up';
    }
    if (this.toastTime > 0 && this.toast) this.statusLabel = `⚠ ${this.toast}`;

    // 6. Spawn Surfboard Rail Spray Particles when planing & carving
    if (!isPaddling && this.speed > 3.4 && this.spraySystem && (oceanParams?.particlesWhitewater ?? false)) {
      const sprayCount = Math.abs(turnInput) > 0.1 ? 3 : 1;
      const rightX = -dirZ;
      const rightZ = dirX;
      const railSide = turnInput !== 0 ? Math.sign(turnInput) : 1;
      for (let p = 0; p < sprayCount; p++) {
        this.spraySystem.spawnParticle(
          this.pos.x - dirX * 0.65 + rightX * railSide * 0.22 + (Math.random() - 0.5) * 0.25,
          this.pos.y + 0.08,
          this.pos.z - dirZ * 0.65 + rightZ * railSide * 0.22 + (Math.random() - 0.5) * 0.25,
          -this.vel.x * 0.25 + rightX * railSide * (1.8 + Math.random() * 1.4),
          1.1 + Math.random() * 1.4,
          -this.vel.z * 0.25 + rightZ * railSide * (1.8 + Math.random() * 1.4),
          0.32 + Math.random() * 0.25,
          1.15 + Math.random() * 0.45,
          PARTICLE_TYPE_BOARD_SPRAY
        );
      }
    }

    // 7. Update 3D Surfboard & First-Person Camera Pose
    let wavePitch = Math.max(-0.38, Math.min(0.38, -(nextSample.gradX * dirX + nextSample.gradZ * dirZ) * 0.65));
    if (isDuckDiving) {
      // Board pitches nose steeply down into the water on entry (-0.65 rad), then levels out and levels up on exit (+0.40 rad)
      const diveT = Math.min(1.0, this.duckDivePhase / 0.85);
      const divePitch = -0.65 * (1.0 - diveT * 1.6);
      wavePitch = THREE.MathUtils.lerp(wavePitch, divePitch, 0.85);
    } else if (isPaddling && this.sitWeight > 0.05) {
      // When sitting straddling the board, surfer center of mass is near rear:
      // Board naturally trims nose up ~7.5° (+0.13 rad) out of the water
      wavePitch += 0.13 * this.sitWeight;
    }
    // Bank angle balances the centripetal load of the carve: tan(phi) = v * omega / g.
    // (Positive turnRate = left turn -> negative roll, matching the screen-space convention.)
    const lateralG = isPaddling ? 0.0 : (this.speed * this.turnRate) / GRAVITY;
    const targetRoll = isPaddling
      ? -turnInput * 0.12
      : -Math.max(-0.85, Math.min(0.85, Math.atan(lateralG) * 0.8));
    this.lateralG = lateralG;
    this.pitch += (wavePitch - this.pitch) * Math.min(1.0, dt * 10.0);
    this.roll += (targetRoll - this.roll) * Math.min(1.0, dt * 10.0);

    // Position surfboard right on the water surface (slight sink under sitting surfer mass)
    const sitSink = isPaddling ? this.sitWeight * 0.025 : 0.0;
    this.boardGroup.position.set(this.pos.x, this.pos.y + 0.04 - sitSink, this.pos.z);
    this.boardGroup.rotation.order = 'YXZ';
    this.boardGroup.rotation.y = this.yaw;
    this.boardGroup.rotation.x = this.pitch;
    this.boardGroup.rotation.z = this.roll;

    // 8. Animate 3D Surfer Figure & Poses
    if (isPaddling) {
      if (isSittingNow) {
        this.surferProneGroup.visible = false;
        this.surferStandingGroup.visible = false;
        this.surferSittingGroup.visible = true;

        // Subtle idle ocean breathing & relaxed head tracking
        const idleBob = Math.sin((this.simTimeTotal ?? 0) * 1.6) * 0.018;
        this.sitHead.rotation.x = -0.04 + idleBob * 0.4;
        this.sitHead.rotation.y = turnInput * -0.22; // Look into swiveling turn
        this.sitArmL.rotation.x = idleBob * 0.25;
        this.sitArmR.rotation.x = idleBob * 0.25;
        this.sitArmL.rotation.z = idleBob * 0.15;
        this.sitArmR.rotation.z = -idleBob * 0.15;
      } else {
        this.surferProneGroup.visible = true;
        this.surferStandingGroup.visible = false;
        this.surferSittingGroup.visible = false;
        if (isDuckDiving) {
          // Hands gripping rails, head low to duck under oncoming crest
          this.proneArmL.rotation.set(0.48, 0, 0.42);
          this.proneArmR.rotation.set(0.48, 0, -0.42);
          this.proneHead.rotation.x = -0.32;
        } else if (throttle > 0) {
          // Alternating freestyle paddling arm strokes
          this.proneArmL.rotation.set(Math.sin(this.paddlePhase) * 1.15, 0, 0.25);
          this.proneArmR.rotation.set(-Math.sin(this.paddlePhase) * 1.15, 0, -0.25);
          this.proneHead.rotation.x = 0.22; // chin up looking ahead for sets
        } else {
          // Resting arms along the rails
          this.proneArmL.rotation.set(0.12, 0, 0.32);
          this.proneArmR.rotation.set(0.12, 0, -0.32);
          this.proneHead.rotation.x = 0.12;
        }
      }
    } else {
      this.surferProneGroup.visible = false;
      this.surferStandingGroup.visible = true;
      this.surferSittingGroup.visible = false;

      // Dynamic athletic crouch: compress upper body naturally without joint separation
      const barrelCrouch = this.isInBarrel ? 0.10 : 0.0;
      const speedCrouch = Math.min(0.06, (this.speed / 10) * 0.06);
      const gLoadCrouch = Math.min(0.08, Math.abs(this.lateralG ?? 0) * 0.04);
      const totalCrouch = barrelCrouch + speedCrouch + gLoadCrouch;

      this.surferStandingGroup.position.y = 0.0; // Feet stay pinned to the deck
      if (this.standingUpperGroup) {
        this.standingUpperGroup.position.y = -totalCrouch * 0.35;
        this.standingUpperGroup.rotation.x = totalCrouch * 0.45;
      }

      // Body leans with the board's bank (slightly less, upper body stays over the rail)
      this.surferStandingGroup.rotation.z = this.roll * 0.8;
      this.surferStandingGroup.rotation.x = this.speed > 5.5 ? 0.06 : 0.0;

      if (this.isInBarrel) {
        // Deep tube crouch: lead arm reaching along the barrel wall, trailing arm tucked low
        this.standArmL.rotation.set(-0.25, 0.15, -0.15);
        this.standArmR.rotation.set(0.18, -0.15, 0.25);
      } else {
        // Athletic regular style: subtle response to rail carves
        const c = this.carveInput ?? 0;
        this.standArmL.rotation.set(-c * 0.22, c * 0.12, -c * 0.18);
        this.standArmR.rotation.set(c * 0.22, -c * 0.12, c * 0.18);
      }
    }

    // 9. Camera Pose (1st-Person POV vs 3rd-Person Low Bird-View)
    if (this.viewMode === 'first_person') {
      // In 1st-person POV, hide the surfer figure so the camera doesn't clip into its own head/body
      this.surferFigureGroup.visible = false;

      // Surfer eye height: crouched lower (1.18m) when tucked inside the barrel, 1.48m when carving, 0.90m when sitting, 0.72m when paddling prone, 0.38m during duck dive
      const targetStanceHeight = isDuckDiving ? 0.38 : isSittingNow ? 0.90 : isPaddling ? 0.72 : this.isInBarrel ? 1.18 : 1.46;
      this.currentEyeH = (this.currentEyeH ?? 1.4) + (targetStanceHeight - (this.currentEyeH ?? 1.4)) * Math.min(1.0, dt * 6.0);
      const paddleBob = isPaddling && !isDuckDiving && throttle > 0 ? Math.sin(this.paddlePhase * 2.0) * 0.045 : 0.0;

      const camX = this.pos.x - dirX * 0.18;
      const camY = this.pos.y + this.currentEyeH + paddleBob;
      const camZ = this.pos.z - dirZ * 0.18;
      this.camera.position.set(camX, camY, camZ);

      // Keep camera upright in first-person POV (no roll/bank inclination when turning)
      this.camera.up.set(0, 1, 0);

      const totalYaw = this.yaw + this.lookYawOffset;
      const totalPitch = this.pitch * 0.45 + this.lookPitchOffset;
      const lookDist = 12.0;
      const lookX = camX + Math.sin(totalYaw) * Math.cos(totalPitch) * lookDist;
      const lookY = camY + Math.sin(totalPitch) * lookDist;
      const lookZ = camZ + Math.cos(totalYaw) * Math.cos(totalPitch) * lookDist;

      this.camera.lookAt(lookX, lookY, lookZ);
      this.controls.target.set(lookX, lookY, lookZ);
    } else {
      // --- THIRD-PERSON VIEW (Camera stays where the user places it, does not turn with the surfer) ---
      this.surferFigureGroup.visible = true;

      const camDist = this.thirdPersonDist ?? (paddling ? 5.2 : 5.8);
      const pitch = this.thirdPersonPitch ?? 0.38;
      const yaw = this.thirdPersonYaw ?? this.yaw;

      const camDistHoriz = camDist * Math.cos(pitch);
      const camTargetX = this.pos.x - Math.sin(yaw) * camDistHoriz;
      let camTargetY = this.pos.y + 0.9 + camDist * Math.sin(pitch);
      const camTargetZ = this.pos.z - Math.cos(yaw) * camDistHoriz;

      // Prevent camera from clipping under the displaced ocean surface
      const camWaterSample = this.sampleSurface(camTargetX, camTargetZ, oceanParams);
      const minCamY = (camWaterSample.surfaceY ?? 0) + 0.65;
      if (camTargetY < minCamY) {
        camTargetY = minCamY;
      }

      // Smooth camera trailing with lerp
      if (!this.camPosSmoothed) {
        this.camPosSmoothed = new THREE.Vector3(camTargetX, camTargetY, camTargetZ);
        this.camLookSmoothed = new THREE.Vector3(this.pos.x, this.pos.y + 0.85, this.pos.z);
      }
      this.camPosSmoothed.lerp(new THREE.Vector3(camTargetX, camTargetY, camTargetZ), Math.min(1.0, dt * 14.0));
      this.camera.position.copy(this.camPosSmoothed);

      // Camera stays upright (level horizon)
      this.camera.up.set(0, 1, 0);

      // Look target: always tracks the surfer
      const targetLookX = this.pos.x;
      const targetLookY = this.pos.y + 0.85;
      const targetLookZ = this.pos.z;

      this.camLookSmoothed.lerp(new THREE.Vector3(targetLookX, targetLookY, targetLookZ), Math.min(1.0, dt * 16.0));
      this.camera.lookAt(this.camLookSmoothed);
      this.controls.target.copy(this.camLookSmoothed);
    }
  }
}
