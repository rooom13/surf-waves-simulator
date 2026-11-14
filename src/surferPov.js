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

export const DEFAULT_SURFER_MOBILITY = {
  paddleAccel: 3.4,      // Prone paddling acceleration (m/s²)
  paddleMaxSpeed: 2.4,   // Base flat-water paddle speed (m/s); sprint scales 1.625x
  paddleTurnRate: 0.90,  // Prone paddle turn speed (rad/s); sitting swivel scales 2.44x
  takeOffSpeed: 7.2,     // Minimum pop-up launch speed (m/s)
  faceGravityGain: 1.9,  // Wave slope downhill gravity multiplier
  curlPushGain: 1.0,     // Advancing wave & barrel curl push multiplier
  rideAccel: 2.4,        // Forward drive acceleration when pressing W on wave (m/s²)
  carveTurnSpeed: 1.0,   // Carve turn rate multiplier when pressing A/D
  carveMinRadius: 4.2,   // Tightest rail carve radius at speed (m)
  railPumpGain: 0.55,    // S-turn rail-to-rail pumping speed gain
  carveSlipLoss: 0.35,   // Fraction of speed scrubbed per unit slip in hard turns
  rideDrag: 0.17,        // Planing drag on the wave face (lower = faster glide)
  stallBrake: 2.2,       // Tail-stall braking strength when holding S on wave
};

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
    this.mobility = { ...DEFAULT_SURFER_MOBILITY };

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

    // Free-fall / air drop state when falling from camera position
    this.isFalling = false;
    this.fallVelY = 0.0;

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

  enable(oceanParams, viewMode = 'third_person', fromCamera = null) {
    this.active = true;
    this.controls.enabled = false;
    this.boardGroup.visible = true;
    this.camPosSmoothed = null;
    this.camLookSmoothed = null;
    this.setViewMode(viewMode);
    this.camera.near = 0.15;

    if (fromCamera) {
      this.dropSurferAtCamera(fromCamera, oceanParams);
    } else {
      this.resetToLineup(oceanParams, true);
    }

    if (this.thirdPersonYaw === null || this.thirdPersonYaw === undefined) {
      this.thirdPersonYaw = this.yaw;
    }
  }

  /**
   * Places the surfer at the exact camera position in mid-air and lets them free-fall
   * down into the water under gravity with a water splashdown upon landing.
   * Keeps the camera facing the exact same direction seamlessly.
   */
  dropSurferAtCamera(camInfo, oceanParams) {
    const camPos = camInfo.position || this.camera.position;
    const boundX = WORLD_SIZE * 0.45;
    const boundZ = WORLD_SIZE * 0.44;

    // Determine ray direction from camera forward vector
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);

    // Initial horizontal position directly at camera X and Z
    let dropX = camPos.x;
    let dropZ = camPos.z;

    // Clamp inside ocean boundaries
    dropX = Math.max(-boundX, Math.min(boundX, dropX));
    dropZ = Math.max(-boundZ, Math.min(boundZ, dropZ));

    const surfSample = this.sampleSurface(dropX, dropZ, oceanParams);
    const waterY = surfSample.surfaceY;

    // Spawn at camera altitude (minimum 1.5m above water surface so there is always a drop)
    const spawnY = Math.max(waterY + 1.5, camPos.y);

    let initYaw = Math.atan2(camDir.x, camDir.z);
    if (!Number.isFinite(initYaw)) initYaw = 0;

    // Compute camera pitch from gaze direction: camDir.y = sin(-pitch)
    const horizLen = Math.hypot(camDir.x, camDir.z);
    const initPitch = Math.max(-0.15, Math.min(1.25, -Math.atan2(camDir.y, Math.max(0.001, horizLen))));

    this.pos.set(dropX, spawnY, dropZ);
    this.yaw = initYaw;
    this.thirdPersonYaw = initYaw;
    this.thirdPersonPitch = initPitch;
    this.vel.set(camDir.x * 3.5, 0, camDir.z * 3.5);
    this.isFalling = spawnY > waterY + 0.15;
    this.fallVelY = -1.5; // Initial downward drop velocity
    this.mode = 'ride'; // Stand ready on the board for the drop-in
    this.sitWeight = 0.0;
    this.isSprinting = false;
    this.carveInput = 0.0;
    this.turnRate = 0.0;
    this.prevWDown = false;
    this.duckDivePhase = 0.0;
    this.duckDiveDepth = 0.0;
    this.lookYawOffset = 0.0;
    this.lookPitchOffset = Math.asin(Math.max(-0.95, Math.min(0.95, camDir.y)));
    this.camPosSmoothed = null;
    this.camLookSmoothed = null;
    this.camFollowY = spawnY;
    this.barrelTime = 0;
    this.slowTime = 0;
    this.isOnWave = false;
    this.isInBarrel = false;
    this.showToast('🪂 Airborne drop-in from camera altitude!');
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
      const ux = tx * tx * (3.0 - 2.0 * tx);
      const uz = tz * tz * (3.0 - 2.0 * tz);

      const idx00 = j0 * N + i0;
      const idx10 = j0 * N + i1;
      const idx01 = j1 * N + i0;
      const idx11 = j1 * N + i1;

      const bilerp = (a00, a10, a01, a11) =>
        (a00 * (1 - ux) + a10 * ux) * (1 - uz) + (a01 * (1 - ux) + a11 * ux) * uz;

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
          const maxDepth = preset === 'nazare' ? 8.5 : 4.6;
          if (d0 < 1.35 || d0 > maxDepth) continue;

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
    this.camFollowY = surfSample.surfaceY;
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
    const takeOffSpeed = Math.max(this.mobility.takeOffSpeed, currentSpeed * 1.4);
    this.vel.set(dirX * takeOffSpeed, 0, dirZ * takeOffSpeed);
    this.mode = 'ride';
    this.sitWeight = 0.0;
    this.carveInput = 0.0;
    this.slowTime = 0;
    this.showToast('Take-off! Carve with A / D');
  }

  resetMobility() {
    Object.assign(this.mobility, DEFAULT_SURFER_MOBILITY);
  }

  showToast(msg) {
    this.toast = msg;
    this.toastTime = 2.8;
  }

  update(dt, keyState, oceanParams, realDt = null) {
    if (!this.active || dt <= 0) return;
    const timeScale = Math.max(0.1, oceanParams?.timeScale ?? 1.0);
    const frameRealDt = realDt !== null ? realDt : dt / timeScale;

    if (this.toastTime > 0) this.toastTime -= frameRealDt;
    this.simTimeTotal = (this.simTimeTotal || 0) + dt;

    // 1. Read WASD / Arrow inputs & double-tap W sprint detection (once per frame)
    let throttle = 0;
    let turnInput = 0;
    if (keyState.KeyW || keyState.ArrowUp) throttle += 1;
    if (keyState.KeyS || keyState.ArrowDown) throttle -= 1;
    if (keyState.KeyA || keyState.ArrowLeft) turnInput += 1; // Turn left (+yaw)
    if (keyState.KeyD || keyState.ArrowRight) turnInput -= 1; // Turn right (-yaw)

    const wDown = Boolean(keyState.KeyW || keyState.ArrowUp);
    const shiftDown = Boolean(keyState.ShiftLeft || keyState.ShiftRight);

    if (this.mode === 'paddle') {
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

    // Sub-step physics at <= 0.014s so high sim speeds (e.g. 4.0x Fast-Forward) remain 100% smooth & stable
    const maxSubDt = 0.014;
    const numSteps = Math.min(20, Math.max(1, Math.ceil(dt / maxSubDt)));
    const subDt = dt / numSteps;
    const subRealDt = frameRealDt / numSteps;
    const m = this.mobility;

    let nextSample = null;
    let takeOffReady = false;
    let isDuckDiving = false;
    let isCarving = false;
    let downhillAlignment = 0;
    let slopeMag = 0;
    let onFrontFace = false;

    for (let step = 0; step < numSteps; step++) {
      const s = this.sampleSurface(this.pos.x, this.pos.z, oceanParams);
      const paddling = this.mode === 'paddle';
      takeOffReady = paddling && this.canTakeOff(s);

      // Duck dive mechanics
      if (paddling && throttle < 0) {
        this.duckDivePhase = Math.min(1.5, this.duckDivePhase + subDt);
      } else if (this.duckDivePhase > 0) {
        this.duckDivePhase = Math.max(0, this.duckDivePhase - subDt * 2.2);
      }
      isDuckDiving = this.duckDivePhase > 0.05;

      const curSpeed = Math.hypot(this.vel.x, this.vel.z);

      // Smooth transition between sitting (stopped/idle in lineup) and prone paddling
      if (paddling && !isDuckDiving) {
        if (throttle > 0 || this.isSprinting) {
          this.sitWeight = Math.max(0.0, this.sitWeight - subDt * 4.5);
        } else if (curSpeed < 0.95) {
          this.sitWeight = Math.min(1.0, this.sitWeight + subDt * 2.8);
        } else {
          this.sitWeight = Math.max(0.0, this.sitWeight - subDt * 1.5);
        }
      } else {
        this.sitWeight = Math.max(0.0, this.sitWeight - subDt * 5.0);
      }
      const isSitting = paddling && !isDuckDiving && this.sitWeight > 0.45;

      // 3. Rail engagement & steering
      const prevCarve = this.carveInput;
      const engageRate = (Math.abs(turnInput) > Math.abs(this.carveInput) ? 5.5 : 8.0) * Math.max(0.5, m.carveTurnSpeed);
      this.carveInput += (turnInput - this.carveInput) * (1.0 - Math.exp(-subDt * engageRate));
      const carve = this.carveInput;
      const carveRate = (carve - prevCarve) / Math.max(0.0001, subDt);

      let turnRate;
      if (isDuckDiving) {
        turnRate = 0.35 * m.paddleTurnRate * turnInput;
      } else if (paddling) {
        turnRate = (isSitting ? m.paddleTurnRate * 2.44 : m.paddleTurnRate) * turnInput;
      } else {
        const yawRateMax = Math.min(2.9, Math.max(1.0, curSpeed / Math.max(0.5, m.carveMinRadius))) * m.carveTurnSpeed;
        turnRate = yawRateMax * carve;
      }
      this.yaw += turnRate * subDt;
      this.turnRate = turnRate;

      if (this.viewMode === 'first_person' && !this.isPointerLooking && Math.abs(turnInput) > 0.1) {
        this.lookYawOffset *= Math.exp(-subDt * 2.2);
      }

      const dirX = Math.sin(this.yaw);
      const dirZ = Math.cos(this.yaw);

      // 4. Forces: gravity on the moving wave surface + wave/curl push + pumping + drag.
      slopeMag = Math.hypot(s.gradX, s.gradZ);
      const downSlopeX = slopeMag > 0.001 ? -s.gradX / slopeMag : 0.0;
      const downSlopeZ = slopeMag > 0.001 ? -s.gradZ / slopeMag : 1.0;
      onFrontFace = s.frontSlope > 0.012 && s.eta > 0.18;
      const faceMask = smoothstep(0.02, 0.18, s.frontSlope);
      downhillAlignment = Math.max(0.0, dirX * downSlopeX + dirZ * downSlopeZ);

      const isActivelyPaddling = paddling && (throttle > 0 || (curSpeed > 1.1 && downhillAlignment > 0.25));
      const engageWaveSlope = !paddling || isActivelyPaddling;

      let ax = 0;
      let az = 0;

      if (engageWaveSlope) {
        const gravScale = (GRAVITY * (paddling ? 2.4 : m.faceGravityGain)) / Math.sqrt(1.0 + slopeMag * slopeMag);
        ax = -s.gradX * gravScale;
        az = -s.gradZ * gravScale;
      }

      if (onFrontFace && engageWaveSlope) {
        const curlPush = (1.1 + s.bTube * 2.6) * faceMask * m.curlPushGain * (paddling ? 0.90 : 1.0);
        ax += s.kHatX * curlPush;
        az += s.kHatZ * curlPush;

        if (!paddling) {
          const railPump = Math.min(4.5, Math.abs(carveRate) * m.railPumpGain) * faceMask;
          ax += dirX * railPump;
          az += dirZ * railPump;
        }
      } else if (paddling && !isActivelyPaddling && s.foam > 0.88) {
        const foamPush = (s.foam - 0.88) * 3.5;
        ax += s.kHatX * foamPush;
        az += s.kHatZ * foamPush;
      }

      if (paddling) {
        if (isDuckDiving) {
          ax += dirX * 1.8;
          az += dirZ * 1.8;
        } else if (throttle > 0) {
          const sprintMult = this.isSprinting ? 2.15 : 1.0;
          ax += dirX * (m.paddleAccel * sprintMult);
          az += dirZ * (m.paddleAccel * sprintMult);
          this.paddlePhase += subDt * (this.isSprinting ? 12.0 : 6.5);
        } else {
          this.paddlePhase += subDt * 1.2;
        }
      } else if (throttle > 0) {
        const boost = onFrontFace ? m.rideAccel : m.rideAccel * 0.42;
        ax += dirX * boost;
        az += dirZ * boost;
        this.paddlePhase += subDt * (onFrontFace ? 3.0 : 7.5);
      } else if (throttle < 0) {
        ax -= this.vel.x * m.stallBrake;
        az -= this.vel.z * m.stallBrake;
      } else {
        this.paddlePhase += subDt * 1.8;
      }

      // Integrate horizontal velocity
      this.vel.x += ax * subDt;
      this.vel.z += az * subDt;

      // Fins & rails
      {
        const forwardSpeed = this.vel.x * dirX + this.vel.z * dirZ;
        const lateralX = this.vel.x - dirX * forwardSpeed;
        const lateralZ = this.vel.z - dirZ * forwardSpeed;
        const lateralMag = Math.hypot(lateralX, lateralZ);
        const speedNow = Math.hypot(this.vel.x, this.vel.z);
        const grip = 1.0 - Math.exp(-subDt * (speedNow > 2.5 ? 10.0 : 5.0));
        const keepLat = 1.0 - grip;

        if (!paddling && forwardSpeed > 0.5) {
          const slip = lateralMag / Math.max(0.001, speedNow);
          const slipLoss = 1.0 - Math.min(0.65, m.carveSlipLoss * slip * grip);
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

      // Hydrodynamic drag
      isCarving = onFrontFace && Math.abs(carve) > 0.35;
      const isPlaning = onFrontFace && (isActivelyPaddling || !paddling);
      const dragScale = m.rideDrag / 0.17;
      const linDrag = paddling 
        ? (isPlaning ? 0.35 : 2.2) 
        : (onFrontFace ? m.rideDrag : 0.48 * dragScale);
      const quadDrag = paddling ? (isPlaning ? 0.004 : 0.0) : 0.006 * dragScale;
      const sp = Math.hypot(this.vel.x, this.vel.z);
      const dragFactor = Math.exp(-subDt * (linDrag + quadDrag * sp));
      this.vel.x *= dragFactor;
      this.vel.z *= dragFactor;

      if (paddling && throttle <= 0 && curSpeed < 0.95) {
        const stopDamp = Math.exp(-subDt * 3.5);
        this.vel.x *= stopDamp;
        this.vel.z *= stopDamp;
      }

      const waveCatchSurge = (paddling && onFrontFace && isActivelyPaddling) ? Math.min(6.2, s.frontSlope * 26.0 + s.eta * 1.8) : 0.0;
      const topSpeedLimit = this.bty?.preset === 'nazare' ? 22.5 : 16.5;
      const maxSpeed = paddling ? m.paddleMaxSpeed * (this.isSprinting ? 1.625 : 1.0) + waveCatchSurge : topSpeedLimit;
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
      let nextX = Math.max(-boundX, Math.min(boundX, this.pos.x + this.vel.x * subDt));
      let nextZ = Math.max(boundZMin, Math.min(boundZMax, this.pos.z + this.vel.z * subDt));

      nextSample = this.sampleSurface(nextX, nextZ, oceanParams);
      if (nextSample.depth < 0.22) {
        this.vel.z = Math.min(0, this.vel.z) - 2.0;
        nextZ = this.pos.z - 0.5;
      }

      this.pos.x = nextX;
      this.pos.z = nextZ;

      // Smoothly track vertical wave surface elevation or simulate airborne free-fall
      const targetY = nextSample.surfaceY;
      const finalSurfY = Math.max(nextSample.seabed + 0.35, targetY + this.duckDiveDepth);

      if (this.isFalling) {
        // Accelerate downward under gravity
        this.fallVelY -= GRAVITY * 1.35 * subDt;
        this.pos.y += this.fallVelY * subDt;

        if (this.pos.y <= finalSurfY + 0.05) {
          // Splashdown on water surface!
          this.pos.y = finalSurfY;
          this.isFalling = false;
          this.fallVelY = 0.0;

          // Splash particles upon landing
          if (this.spraySystem && (oceanParams?.particlesWhitewater ?? true)) {
            for (let sp = 0; sp < 12; sp++) {
              const ang = Math.random() * Math.PI * 2;
              const spd = 2.0 + Math.random() * 3.5;
              this.spraySystem.spawnParticle(
                this.pos.x + (Math.random() - 0.5) * 0.8,
                this.pos.y + 0.15,
                this.pos.z + (Math.random() - 0.5) * 0.8,
                Math.cos(ang) * spd,
                1.8 + Math.random() * 2.2,
                Math.sin(ang) * spd,
                0.35 + Math.random() * 0.3,
                1.4,
                PARTICLE_TYPE_BOARD_SPRAY
              );
            }
          }

          // Land on feet riding with pop-up momentum
          this.mode = 'ride';
          this.sitWeight = 0.0;
          this.showToast('🌊 Landed on the wave!');
        }
      } else {
        if (isDuckDiving) {
          const diveProgress = Math.min(1.0, this.duckDivePhase / 0.85);
          const targetSubmerge = -1.45 * Math.sin(diveProgress * Math.PI);
          this.duckDiveDepth += (targetSubmerge - this.duckDiveDepth) * (1.0 - Math.exp(-subDt * 8.0));
        } else {
          this.duckDiveDepth += (0.0 - this.duckDiveDepth) * (1.0 - Math.exp(-subDt * 10.0));
        }
        const ySmoothAlpha = 1.0 - Math.exp(-subRealDt * 16.0);
        this.pos.y += (finalSurfY - this.pos.y) * ySmoothAlpha;
      }

      // 5. Evaluate Surfing & Barrel State for HUD
      this.isOnWave = onFrontFace && this.speed > 3.2;
      this.isInBarrel =
        onFrontFace && nextSample.bTube > 0.34 && nextSample.eta > 0.65 && nextSample.foam < 0.88 && this.speed > 2.6;

      if (this.mode === 'ride') {
        const lostSpeed = this.speed < 2.5 || (this.speed < 3.2 && !onFrontFace);
        this.slowTime = lostSpeed || nextSample.foam > 0.94 ? this.slowTime + subDt : 0;
        if (this.slowTime > 0.45) {
          this.mode = 'paddle';
          this.sitWeight = 0.0;
          this.isOnWave = false;
          this.isInBarrel = false;
          this.slowTime = 0;
          this.showToast('Speed dropped — back to paddle position');
        }
      }
    }

    const dirX = Math.sin(this.yaw);
    const dirZ = Math.cos(this.yaw);
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
        this.statusLabel = (takeOffReady && this.speed > 3.6)
          ? '🚀 Wave caught! Accelerating down the face — press SPACE to pop up!'
          : takeOffReady
          ? '✅ On a wave face — press SPACE to take off!'
          : this.isSprinting
            ? '⚡ SPRINT PADDLING! (Double-Tap W)'
            : throttle > 0
              ? '🏊 Paddling — line up with an approaching wave'
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

    // 7. Update 3D Surfboard & First-Person Camera Pose (smoothed in real wall-clock time so fast-forward never chatters)
    let wavePitch = Math.max(-0.38, Math.min(0.38, -(nextSample.gradX * dirX + nextSample.gradZ * dirZ) * 0.65));
    if (isDuckDiving) {
      const diveT = Math.min(1.0, this.duckDivePhase / 0.85);
      const divePitch = -0.65 * (1.0 - diveT * 1.6);
      wavePitch = THREE.MathUtils.lerp(wavePitch, divePitch, 0.85);
    } else if (isPaddling && this.sitWeight > 0.05) {
      wavePitch += 0.13 * this.sitWeight;
    }
    const lateralG = isPaddling ? 0.0 : (this.speed * this.turnRate) / GRAVITY;
    const targetRoll = isPaddling
      ? -turnInput * 0.12
      : -Math.max(-0.85, Math.min(0.85, Math.atan(lateralG) * 0.8));
    this.lateralG = lateralG;

    const rotAlpha = 1.0 - Math.exp(-frameRealDt * 10.0);
    this.pitch += (wavePitch - this.pitch) * rotAlpha;
    this.roll += (targetRoll - this.roll) * rotAlpha;

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

        const idleBob = Math.sin((this.simTimeTotal ?? 0) * 1.6) * 0.018;
        this.sitHead.rotation.x = -0.04 + idleBob * 0.4;
        this.sitHead.rotation.y = turnInput * -0.22;
        this.sitArmL.rotation.x = idleBob * 0.25;
        this.sitArmR.rotation.x = idleBob * 0.25;
        this.sitArmL.rotation.z = idleBob * 0.15;
        this.sitArmR.rotation.z = -idleBob * 0.15;
      } else {
        this.surferProneGroup.visible = true;
        this.surferStandingGroup.visible = false;
        this.surferSittingGroup.visible = false;
        if (isDuckDiving) {
          this.proneArmL.rotation.set(0.48, 0, 0.42);
          this.proneArmR.rotation.set(0.48, 0, -0.42);
          this.proneHead.rotation.x = -0.32;
        } else if (throttle > 0) {
          this.proneArmL.rotation.set(Math.sin(this.paddlePhase) * 1.15, 0, 0.25);
          this.proneArmR.rotation.set(-Math.sin(this.paddlePhase) * 1.15, 0, -0.25);
          this.proneHead.rotation.x = 0.22;
        } else {
          this.proneArmL.rotation.set(0.12, 0, 0.32);
          this.proneArmR.rotation.set(0.12, 0, -0.32);
          this.proneHead.rotation.x = 0.12;
        }
      }
    } else {
      this.surferProneGroup.visible = false;
      this.surferStandingGroup.visible = true;
      this.surferSittingGroup.visible = false;

      const barrelCrouch = this.isInBarrel ? 0.10 : 0.0;
      const speedCrouch = Math.min(0.06, (this.speed / 10) * 0.06);
      const gLoadCrouch = Math.min(0.08, Math.abs(this.lateralG ?? 0) * 0.04);
      const totalCrouch = barrelCrouch + speedCrouch + gLoadCrouch;

      this.surferStandingGroup.position.y = 0.0;
      if (this.standingUpperGroup) {
        this.standingUpperGroup.position.y = -totalCrouch * 0.35;
        this.standingUpperGroup.rotation.x = totalCrouch * 0.45;
      }

      this.surferStandingGroup.rotation.z = this.roll * 0.8;
      this.surferStandingGroup.rotation.x = this.speed > 5.5 ? 0.06 : 0.0;

      if (this.isInBarrel) {
        this.standArmL.rotation.set(-0.25, 0.15, -0.15);
        this.standArmR.rotation.set(0.18, -0.15, 0.25);
      } else {
        const c = this.carveInput ?? 0;
        this.standArmL.rotation.set(-c * 0.22, c * 0.12, -c * 0.18);
        this.standArmR.rotation.set(c * 0.22, -c * 0.12, c * 0.18);
      }
    }

    // 9. Camera Pose (1st-Person POV vs 3rd-Person Low Bird-View)
    if (this.viewMode === 'first_person') {
      this.surferFigureGroup.visible = false;

      const targetStanceHeight = isDuckDiving ? 0.38 : isSittingNow ? 0.90 : isPaddling ? 0.72 : this.isInBarrel ? 1.18 : 1.46;
      this.currentEyeH = (this.currentEyeH ?? 1.4) + (targetStanceHeight - (this.currentEyeH ?? 1.4)) * (1.0 - Math.exp(-frameRealDt * 6.0));
      const paddleBob = isPaddling && !isDuckDiving && throttle > 0 ? Math.sin(this.paddlePhase * 2.0) * (0.045 / Math.sqrt(timeScale)) : 0.0;

      const camX = this.pos.x - dirX * 0.18;
      const camY = this.pos.y + this.currentEyeH + paddleBob;
      const camZ = this.pos.z - dirZ * 0.18;
      this.camera.position.set(camX, camY, camZ);
      this.camera.up.set(0, 1, 0);

      const totalYaw = this.yaw + this.lookYawOffset;
      const totalPitch = this.pitch * (0.45 / Math.sqrt(timeScale)) + this.lookPitchOffset;
      const lookDist = 12.0;
      const lookX = camX + Math.sin(totalYaw) * Math.cos(totalPitch) * lookDist;
      const lookY = camY + Math.sin(totalPitch) * lookDist;
      const lookZ = camZ + Math.cos(totalYaw) * Math.cos(totalPitch) * lookDist;

      this.camera.lookAt(lookX, lookY, lookZ);
      this.controls.target.set(lookX, lookY, lookZ);
    } else {
      // --- THIRD-PERSON VIEW (Steady horizon, zero differential lag at any sim speed) ---
      this.surferFigureGroup.visible = true;

      const camDist = this.thirdPersonDist ?? (isPaddling ? 5.2 : 5.8);
      const pitch = this.thirdPersonPitch ?? 0.38;
      const yaw = this.thirdPersonYaw ?? this.yaw;

      const camDistHoriz = camDist * Math.cos(pitch);
      const camOffsetY = 0.05 + camDist * Math.sin(pitch);

      const camTargetX = this.pos.x - Math.sin(yaw) * camDistHoriz;
      const camTargetZ = this.pos.z - Math.cos(yaw) * camDistHoriz;

      // Ensure camera stays above water behind the surfer while preserving a strictly constant camera pitch
      const camWaterSample = this.sampleSurface(camTargetX, camTargetZ, oceanParams);
      const minFollowY = (camWaterSample.surfaceY ?? 0) + 0.65 - (0.85 + camOffsetY);
      const targetFollowY = Math.max(this.pos.y, minFollowY);

      if (this.camFollowY === null || this.camFollowY === undefined) {
        this.camFollowY = targetFollowY;
      } else {
        const yRate = targetFollowY > this.camFollowY ? 6.0 : 3.5;
        this.camFollowY += (targetFollowY - this.camFollowY) * (1.0 - Math.exp(-frameRealDt * yRate));
      }

      const lookY = this.camFollowY + 0.85;
      const camY = lookY + camOffsetY;

      this.camera.position.set(camTargetX, camY, camTargetZ);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(this.pos.x, lookY, this.pos.z);
      this.controls.target.set(this.pos.x, lookY, this.pos.z);
    }
  }
}
