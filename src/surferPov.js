import * as THREE from 'three';
import { WORLD_SIZE } from './bathymetry.js';
import { PARTICLE_TYPE_BOARD_SPRAY } from './spraySystem.js';

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

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
    this.toast = '';
    this.toastTime = 0;
    this.slowTime = 0;

    // Sprint paddling via double-tap W (or Shift+W)
    this.lastWPressTime = 0;
    this.prevWDown = false;
    this.isSprinting = false;

    // Duck dive state (submerging under oncoming wave crest/whitewater)
    this.duckDivePhase = 0.0; // 0 = surface, >0 = diving underwater (duration ~1.5s)
    this.duckDiveDepth = 0.0; // vertical offset in meters (negative underwater)

    // Camera view mode: 'third_person' (low bird-view drone chase) or 'first_person' (surfer POV)
    this.viewMode = 'third_person';
    this.camPosSmoothed = null;
    this.camLookSmoothed = null;

    // Build 1:1 metric 3D surfboard mesh (2.05m x 0.52m shortboard)
    this.boardGroup = this.createSurfboardMesh();
    this.boardGroup.visible = false;
    this.scene.add(this.boardGroup);

    // Build 1:1 metric 3D surfer figure (prone paddling & standing ride poses)
    this.surferFigureGroup = this.createSurferFigure();
    this.boardGroup.add(this.surferFigureGroup);
  }

  createSurferFigure() {
    const group = new THREE.Group();
    group.name = 'SurferFigure';

    // Stylized high-performance surf materials
    const wetsuitMat = new THREE.MeshStandardMaterial({
      color: 0x111827, // dark charcoal neoprene
      roughness: 0.40,
      metalness: 0.08,
    });
    const wetsuitAccentMat = new THREE.MeshStandardMaterial({
      color: 0x06b6d4, // bright cyan stripes/panels
      roughness: 0.32,
      metalness: 0.12,
    });
    const skinMat = new THREE.MeshStandardMaterial({
      color: 0xd49568, // tanned skin tone
      roughness: 0.65,
      metalness: 0.04,
    });
    const hairMat = new THREE.MeshStandardMaterial({
      color: 0x221712, // dark brown surf hair
      roughness: 0.85,
      metalness: 0.02,
    });

    // 1. PRONE GROUP (Lying down paddling or duck diving)
    const prone = new THREE.Group();
    prone.name = 'SurferProne';

    // Prone Torso (arched upward chest)
    const proneTorsoGeom = new THREE.CapsuleGeometry(0.13, 0.42, 4, 8);
    const proneTorso = new THREE.Mesh(proneTorsoGeom, wetsuitMat);
    proneTorso.position.set(0, 0.14, 0.02);
    proneTorso.rotation.x = 0.18; // chest lifted
    prone.add(proneTorso);

    // Wetsuit back accent panel
    const proneAccentGeom = new THREE.BoxGeometry(0.20, 0.04, 0.22);
    const proneAccent = new THREE.Mesh(proneAccentGeom, wetsuitAccentMat);
    proneAccent.position.set(0, 0.21, 0.05);
    proneAccent.rotation.x = 0.18;
    prone.add(proneAccent);

    // Prone Head
    const proneHeadGeom = new THREE.SphereGeometry(0.11, 10, 8);
    this.proneHead = new THREE.Mesh(proneHeadGeom, skinMat);
    this.proneHead.position.set(0, 0.26, 0.32);
    prone.add(this.proneHead);

    const proneHairGeom = new THREE.SphereGeometry(0.115, 8, 6);
    proneHairGeom.scale(1.0, 0.55, 1.05);
    const proneHair = new THREE.Mesh(proneHairGeom, hairMat);
    proneHair.position.set(0, 0.05, -0.02);
    this.proneHead.add(proneHair);

    // Prone Legs (extended back toward tail)
    const proneLegGeom = new THREE.CapsuleGeometry(0.065, 0.55, 4, 8);
    proneLegGeom.rotateX(Math.PI / 2);
    const proneLegL = new THREE.Mesh(proneLegGeom, wetsuitMat);
    proneLegL.position.set(-0.09, 0.08, -0.44);
    const proneLegR = new THREE.Mesh(proneLegGeom, wetsuitMat);
    proneLegR.position.set(0.09, 0.08, -0.44);
    prone.add(proneLegL, proneLegR);

    // Prone Arms (paddling shoulder pivots)
    const armGeom = new THREE.CapsuleGeometry(0.052, 0.42, 4, 8);
    armGeom.translate(0, -0.19, 0);

    this.proneArmL = new THREE.Group();
    this.proneArmL.position.set(-0.19, 0.17, 0.18);
    const armLMesh = new THREE.Mesh(armGeom, skinMat);
    this.proneArmL.add(armLMesh);

    this.proneArmR = new THREE.Group();
    this.proneArmR.position.set(0.19, 0.17, 0.18);
    const armRMesh = new THREE.Mesh(armGeom, skinMat);
    this.proneArmR.add(armRMesh);

    prone.add(this.proneArmL, this.proneArmR);
    group.add(prone);
    this.surferProneGroup = prone;

    // 2. STANDING GROUP (Athletic wave riding stance)
    const standing = new THREE.Group();
    standing.name = 'SurferStanding';

    // Pelvis / Hips
    const hipGeom = new THREE.BoxGeometry(0.28, 0.16, 0.22);
    const hips = new THREE.Mesh(hipGeom, wetsuitMat);
    hips.position.set(-0.02, 0.65, -0.16);
    standing.add(hips);

    // Torso (angled slightly forward & turned towards wave face)
    const standTorsoGeom = new THREE.CapsuleGeometry(0.155, 0.44, 4, 10);
    const standTorso = new THREE.Mesh(standTorsoGeom, wetsuitMat);
    standTorso.position.set(-0.03, 0.98, -0.14);
    standTorso.rotation.x = -0.08;
    standTorso.rotation.y = 0.32;
    standing.add(standTorso);

    // Wetsuit chest/shoulder cyan accent
    const standAccentGeom = new THREE.BoxGeometry(0.24, 0.18, 0.18);
    const standAccent = new THREE.Mesh(standAccentGeom, wetsuitAccentMat);
    standAccent.position.set(-0.03, 1.08, -0.14);
    standAccent.rotation.y = 0.32;
    standing.add(standAccent);

    // Standing Head & Hair
    const standHeadGeom = new THREE.SphereGeometry(0.12, 10, 8);
    const standHead = new THREE.Mesh(standHeadGeom, skinMat);
    standHead.position.set(-0.02, 1.34, -0.11);
    standHead.rotation.y = 0.48; // looking down the line
    standing.add(standHead);

    const standHairGeom = new THREE.SphereGeometry(0.125, 8, 6);
    standHairGeom.scale(1.0, 0.58, 1.05);
    const standHair = new THREE.Mesh(standHairGeom, hairMat);
    standHair.position.set(0, 0.05, -0.01);
    standHead.add(standHair);

    // Front Left Leg (flexed athletic knee, foot angled forward on deck)
    const legThighGeom = new THREE.CapsuleGeometry(0.072, 0.38, 4, 8);
    legThighGeom.translate(0, -0.16, 0);

    const legCalfGeom = new THREE.CapsuleGeometry(0.065, 0.36, 4, 8);
    legCalfGeom.translate(0, -0.15, 0);

    // Left Thigh
    const leftThigh = new THREE.Mesh(legThighGeom, wetsuitMat);
    leftThigh.position.set(-0.11, 0.62, -0.08);
    leftThigh.rotation.x = -0.52;
    leftThigh.rotation.z = -0.18;
    standing.add(leftThigh);

    // Left Shin / Calf
    const leftCalf = new THREE.Mesh(legCalfGeom, wetsuitMat);
    leftCalf.position.set(-0.08, 0.34, 0.08);
    leftCalf.rotation.x = 0.38;
    leftCalf.rotation.z = -0.06;
    standing.add(leftCalf);

    // Left Foot (angled forward ~35°)
    const footGeom = new THREE.BoxGeometry(0.10, 0.05, 0.22);
    const leftFoot = new THREE.Mesh(footGeom, skinMat);
    leftFoot.position.set(-0.06, 0.035, 0.22);
    leftFoot.rotation.y = 0.58;
    standing.add(leftFoot);

    // Back Right Leg (driving power over rear traction pad)
    const rightThigh = new THREE.Mesh(legThighGeom, wetsuitMat);
    rightThigh.position.set(0.08, 0.62, -0.24);
    rightThigh.rotation.x = 0.42;
    rightThigh.rotation.z = 0.16;
    standing.add(rightThigh);

    const rightCalf = new THREE.Mesh(legCalfGeom, wetsuitMat);
    rightCalf.position.set(0.06, 0.35, -0.46);
    rightCalf.rotation.x = -0.32;
    rightCalf.rotation.z = 0.08;
    standing.add(rightCalf);

    const rightFoot = new THREE.Mesh(footGeom, skinMat);
    rightFoot.position.set(0.02, 0.035, -0.62);
    rightFoot.rotation.y = 1.35; // nearly perpendicular across traction pad
    standing.add(rightFoot);

    // Arms: Shoulders with pivots for dynamic balance & carving counter-rotation
    const standArmGeom = new THREE.CapsuleGeometry(0.056, 0.44, 4, 8);
    standArmGeom.translate(0, -0.20, 0);

    // Leading Left Arm (pointing down the line into the barrel)
    this.standArmL = new THREE.Group();
    this.standArmL.position.set(-0.21, 1.15, -0.05);
    const standArmLMesh = new THREE.Mesh(standArmGeom, wetsuitMat);
    this.standArmL.add(standArmLMesh);
    const handLGeom = new THREE.SphereGeometry(0.045, 6, 6);
    const handL = new THREE.Mesh(handLGeom, skinMat);
    handL.position.set(0, -0.42, 0);
    this.standArmL.add(handL);
    standing.add(this.standArmL);

    // Trailing Right Arm (held out and back for balance)
    this.standArmR = new THREE.Group();
    this.standArmR.position.set(0.18, 1.15, -0.22);
    const standArmRMesh = new THREE.Mesh(standArmGeom, wetsuitMat);
    this.standArmR.add(standArmRMesh);
    const handR = new THREE.Mesh(handLGeom, skinMat);
    handR.position.set(0, -0.42, 0);
    this.standArmR.add(handR);
    standing.add(this.standArmR);

    group.add(standing);
    this.surferStandingGroup = standing;

    // Initially show prone
    this.surferProneGroup.visible = true;
    this.surferStandingGroup.visible = false;

    return group;
  }

  createSurfboardMesh() {
    const group = new THREE.Group();

    // Shaped surfboard deck (elongated tapered hull along +Z nose to -Z tail)
    const shape = new THREE.Shape();
    shape.moveTo(0, 1.08); // Pointed nose (+Z)
    shape.bezierCurveTo(0.22, 0.72, 0.27, 0.20, 0.25, -0.35);
    shape.bezierCurveTo(0.23, -0.72, 0.16, -0.95, 0.11, -1.02); // Squash tail
    shape.lineTo(-0.11, -1.02);
    shape.bezierCurveTo(-0.16, -0.95, -0.23, -0.72, -0.25, -0.35);
    shape.bezierCurveTo(-0.27, 0.20, -0.22, 0.72, 0, 1.08);

    const extrudeGeom = new THREE.ExtrudeGeometry(shape, {
      depth: 0.048,
      bevelEnabled: true,
      bevelSegments: 3,
      steps: 1,
      bevelSize: 0.022,
      bevelThickness: 0.018,
    });
    extrudeGeom.rotateX(Math.PI / 2);

    // Subtle nose rocker lift
    const posAttr = extrudeGeom.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      const z = posAttr.getZ(i);
      const y = posAttr.getY(i);
      const noseRocker = z > 0.2 ? Math.pow(z - 0.2, 2.0) * 0.11 : Math.pow(Math.max(0, -z - 0.35), 2.0) * 0.04;
      posAttr.setY(i, y + noseRocker);
    }
    extrudeGeom.computeVertexNormals();

    const boardMat = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      roughness: 0.22,
      metalness: 0.05,
    });
    const boardMesh = new THREE.Mesh(extrudeGeom, boardMat);
    boardMesh.renderOrder = 3;
    group.add(boardMesh);

    // Center cedar stringer stripe
    const stringerGeom = new THREE.BoxGeometry(0.012, 0.056, 2.02);
    const stringerMat = new THREE.MeshBasicMaterial({ color: 0x92400e });
    const stringer = new THREE.Mesh(stringerGeom, stringerMat);
    stringer.position.set(0, 0.012, 0.02);
    group.add(stringer);

    // Cyan/teal racing rail graphic near nose
    const stripeGeom = new THREE.BoxGeometry(0.42, 0.054, 0.16);
    const stripeMat = new THREE.MeshBasicMaterial({ color: 0x06b6d4 });
    const stripe = new THREE.Mesh(stripeGeom, stripeMat);
    stripe.position.set(0, 0.02, 0.42);
    group.add(stripe);

    // Rear traction pad (EVA grip pad)
    const padGeom = new THREE.BoxGeometry(0.28, 0.055, 0.34);
    const padMat = new THREE.MeshBasicMaterial({ color: 0x1e293b });
    const pad = new THREE.Mesh(padGeom, padMat);
    pad.position.set(0, 0.014, -0.68);
    group.add(pad);

    return group;
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
  }

  setViewMode(viewMode) {
    this.viewMode = viewMode === 'first_person' ? 'first_person' : 'third_person';
    if (this.viewMode === 'third_person') {
      this.camera.fov = 62;
      this.surferFigureGroup.visible = true;
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
  }

  onPointerDown(e) {
    if (!this.active || e.button !== 0) return;
    this.isPointerLooking = true;
    this.lastPointerX = e.clientX;
    this.lastPointerY = e.clientY;
  }

  onPointerMove(e) {
    if (!this.active || !this.isPointerLooking) return;
    const dx = e.clientX - this.lastPointerX;
    const dy = e.clientY - this.lastPointerY;
    this.lastPointerX = e.clientX;
    this.lastPointerY = e.clientY;

    this.lookYawOffset -= dx * 0.0045;
    this.lookPitchOffset = Math.max(-0.55, Math.min(0.45, this.lookPitchOffset - dy * 0.0038));
  }

  onPointerUp() {
    this.isPointerLooking = false;
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
    this.isSprinting = false;
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
    const peelSign = this.bty.preset === 'left_point' ? 1.0 : -1.0;
    // Pop up and angle down the line along the peel direction
    const dirX = s.kHatX * 0.55 + peelSign * 0.83;
    const dirZ = s.kHatZ * 0.55 + 0.22;
    const n = Math.hypot(dirX, dirZ) || 1.0;
    this.yaw = Math.atan2(dirX / n, dirZ / n);
    this.vel.set((dirX / n) * 6.2, 0, (dirZ / n) * 6.2);
    this.mode = 'ride';
    this.slowTime = 0;
    this.lookYawOffset = -peelSign * 0.2;
    this.showToast('Take-off! Carve with A / D');
  }

  showToast(msg) {
    this.toast = msg;
    this.toastTime = 2.8;
  }

  update(dt, keyState, oceanParams) {
    if (!this.active || dt <= 0) return;
    if (this.toastTime > 0) this.toastTime -= dt;

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

    // 3. Steering / Rail Carving (responsive at both paddling and planing speeds)
    const turnRate = (isDuckDiving ? 0.35 : this.mode === 'paddle' ? 0.9 : 1.65 + Math.min(1.1, curSpeed * 0.12)) * turnInput;
    this.yaw += turnRate * dt;

    // Gently recenter head-look yaw when carving unless actively dragging mouse
    if (!this.isPointerLooking && Math.abs(turnInput) > 0.1) {
      this.lookYawOffset *= Math.exp(-dt * 2.2);
    }

    const dirX = Math.sin(this.yaw);
    const dirZ = Math.cos(this.yaw);

    // 4. Hydrodynamic Wave-Face Gravity + Downhill Drop Plunge + Pocket Trim + Rail Carving
    // Down-slope vector points in -gradEta (down the front of the wave)
    const slopeMag = Math.hypot(s.gradX, s.gradZ);
    const downSlopeX = slopeMag > 0.001 ? -s.gradX / slopeMag : 0.0;
    const downSlopeZ = slopeMag > 0.001 ? -s.gradZ / slopeMag : 1.0;

    const onFrontFace = !paddling && s.frontSlope > 0.012 && s.eta > 0.18;

    // 1) Wave gravity acceleration down the face:
    // Strongly boosted so dropping down the face feels thrilling, punchy, and fast!
    const waveGravScale = paddling ? 4.5 : onFrontFace ? 34.0 : 12.0;
    let ax = -s.gradX * waveGravScale;
    let az = -s.gradZ * waveGravScale;

    // 2) Downhill drop plunge acceleration:
    // When aiming down the face of the wave, gravitational potential energy rapidly converts to speed!
    const downhillAlignment = Math.max(0.0, dirX * downSlopeX + dirZ * downSlopeZ);
    if (onFrontFace && downhillAlignment > 0.05) {
      const dropBoost = downhillAlignment * (6.5 + s.frontSlope * 24.0);
      ax += dirX * dropBoost;
      az += dirZ * dropBoost;
    }

    // 3) Pocket trim propulsion down the line
    if (onFrontFace) {
      const pocketDrive = (3.4 + s.bTube * 5.4 + Math.min(1.8, s.eta) * 2.6) * smoothstep(0.02, 0.18, s.frontSlope);
      ax += (dirX * 0.74 + s.kHatX * 0.26) * pocketDrive;
      az += (dirZ * 0.74 + s.kHatZ * 0.26) * pocketDrive;
    }

    // 4) Rail Carving / Pumping Drive:
    // In real surfing, rail carving transfers centripetal water force into forward projection ("pumping for speed").
    // Carving S-turns or bottom turns with A / D generates positive forward thrust!
    const isCarving = onFrontFace && Math.abs(turnInput) > 0.12;
    if (isCarving) {
      const railDrive = Math.abs(turnInput) * (3.8 + Math.min(4.8, curSpeed * 0.45)) * smoothstep(0.02, 0.18, s.frontSlope);
      ax += dirX * railDrive;
      az += dirZ * railDrive;
    }

    // Surfer W/S input:
    // Paddling: W = paddle forward, S = duck dive under waves.
    // Riding: W = pump/drive forward down the line, S = stall into the barrel
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
      // W pump while riding adds extra leg compression drive down the line
      const boost = onFrontFace ? 7.8 : 5.0;
      ax += dirX * boost;
      az += dirZ * boost;
      this.paddlePhase += dt * (onFrontFace ? 3.0 : 7.5);
    } else if (throttle < 0) {
      // Stalling tail brake lets the tube catch up to you!
      ax -= this.vel.x * 2.8 - dirX * 1.5;
      az -= this.vel.z * 2.8 - dirZ * 1.5;
    } else {
      this.paddlePhase += dt * 1.8;
    }

    // Integrate horizontal velocity
    this.vel.x += ax * dt;
    this.vel.z += az * dt;

    // Rail fin grip: project velocity onto surfboard heading so carving A/D genuinely redirects momentum!
    const forwardSpeed = this.vel.x * dirX + this.vel.z * dirZ;
    const lateralX = this.vel.x - dirX * forwardSpeed;
    const lateralZ = this.vel.z - dirZ * forwardSpeed;
    const lateralMag = Math.hypot(lateralX, lateralZ);

    // Dynamic rail bite: convert a portion of lateral slide momentum into forward speed during hard carves!
    const railConvert = onFrontFace && Math.abs(turnInput) > 0.1 ? Math.min(2.8, lateralMag * 0.42) : 0.0;
    const alignedSpeed = Math.max(-1.8, forwardSpeed + railConvert);
    const finGrip = Math.exp(-dt * (curSpeed > 2.5 ? 9.5 : 5.0));

    this.vel.x = dirX * alignedSpeed + lateralX * finGrip;
    this.vel.z = dirZ * alignedSpeed + lateralZ * finGrip;

    // Water drag & speed cap:
    // On the face, drag is gentle (0.26) so carving and bottom turns retain speed.
    // Max riding speed scales up to 15.5 m/s (~56 km/h) when carving and dropping!
    const dragRate = paddling ? 1.5 : onFrontFace ? (isCarving ? 0.20 : 0.26) : 0.65;
    this.vel.x *= Math.exp(-dt * dragRate);
    this.vel.z *= Math.exp(-dt * dragRate);

    const maxSpeed = paddling
      ? (this.isSprinting ? 3.85 : 2.3)
      : (isCarving || downhillAlignment > 0.25 ? 15.5 : 13.5);
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

    // Ride ends once the wave has run out of steam (or the surfer is stuck in the whitewater)
    if (!paddling) {
      this.slowTime = this.speed < 2.4 || nextSample.foam > 0.92 ? this.slowTime + dt : 0;
      if (this.slowTime > 2.0) {
        this.resetToLineup(oceanParams, false);
        this.showToast('Wave over - paddle back out and wait for the next one');
        return;
      }
    }

    if (paddling) {
      if (isDuckDiving) {
        this.statusLabel = '🤿 DUCK DIVE! Punching Under Oncoming Wave Crest';
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
    if (!paddling && this.speed > 3.4 && this.spraySystem && (oceanParams?.particlesWhitewater ?? false)) {
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
    }
    const targetRoll = -turnInput * 0.44 * Math.min(1.0, this.speed / 4.0);
    this.pitch += (wavePitch - this.pitch) * Math.min(1.0, dt * 10.0);
    this.roll += (targetRoll - this.roll) * Math.min(1.0, dt * 10.0);

    // Position surfboard right on the water surface
    this.boardGroup.position.set(this.pos.x, this.pos.y + 0.04, this.pos.z);
    this.boardGroup.rotation.order = 'YXZ';
    this.boardGroup.rotation.y = this.yaw;
    this.boardGroup.rotation.x = this.pitch;
    this.boardGroup.rotation.z = this.roll;

    // 8. Animate 3D Surfer Figure & Poses
    if (paddling) {
      this.surferProneGroup.visible = true;
      this.surferStandingGroup.visible = false;
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
    } else {
      this.surferProneGroup.visible = false;
      this.surferStandingGroup.visible = true;

      // Dynamic athletic crouch for speed and deep barrel tuck
      const barrelCrouch = this.isInBarrel ? 0.25 : 0.0;
      const speedCrouch = Math.min(0.12, (this.speed / 10) * 0.12);
      this.surferStandingGroup.position.y = -(barrelCrouch + speedCrouch);

      // Body lean into carve turns (weight shift)
      this.surferStandingGroup.rotation.z = -turnInput * 0.35;
      this.surferStandingGroup.rotation.x = this.speed > 5.5 ? 0.06 : 0.0;

      if (this.isInBarrel) {
        // Deep tube crouch: lead arm reaching along the barrel wall, trailing arm tucked low
        this.standArmL.rotation.set(-0.85, 0.32, -0.32);
        this.standArmR.rotation.set(0.38, -0.32, 0.65);
      } else {
        // Athletic style: lead arm trims forward, trailing arm balances carves
        this.standArmL.rotation.set(-0.52 - turnInput * 0.32, 0.20, -0.38);
        this.standArmR.rotation.set(0.48 + turnInput * 0.32, -0.20, 0.42);
      }
    }

    // 9. Camera Pose (1st-Person POV vs 3rd-Person Low Bird-View)
    if (this.viewMode === 'first_person') {
      // In 1st-person POV, hide the surfer figure so the camera doesn't clip into its own head/body
      this.surferFigureGroup.visible = false;

      // Surfer eye height: crouched lower (1.18m) when tucked inside the barrel, 1.48m when carving, 0.68m when paddling prone, 0.38m during duck dive
      const targetStanceHeight = isDuckDiving ? 0.38 : paddling ? 0.72 : this.isInBarrel ? 1.18 : 1.46;
      this.currentEyeH = (this.currentEyeH ?? 1.4) + (targetStanceHeight - (this.currentEyeH ?? 1.4)) * Math.min(1.0, dt * 6.0);
      const paddleBob = paddling && !isDuckDiving && throttle > 0 ? Math.sin(this.paddlePhase * 2.0) * 0.045 : 0.0;

      const camX = this.pos.x - dirX * 0.18;
      const camY = this.pos.y + this.currentEyeH + paddleBob;
      const camZ = this.pos.z - dirZ * 0.18;
      this.camera.position.set(camX, camY, camZ);

      // Subtle camera roll banking when carving hard turns
      this.camera.up.set(Math.sin(this.roll * 0.35), Math.cos(this.roll * 0.35), 0).normalize();

      const totalYaw = this.yaw + this.lookYawOffset;
      const totalPitch = this.pitch * 0.45 + this.lookPitchOffset;
      const lookDist = 12.0;
      const lookX = camX + Math.sin(totalYaw) * Math.cos(totalPitch) * lookDist;
      const lookY = camY + Math.sin(totalPitch) * lookDist;
      const lookZ = camZ + Math.cos(totalYaw) * Math.cos(totalPitch) * lookDist;

      this.camera.lookAt(lookX, lookY, lookZ);
      this.controls.target.set(lookX, lookY, lookZ);
    } else {
      // --- THIRD-PERSON LOW BIRD-VIEW (Drone chase perspective) ---
      this.surferFigureGroup.visible = true;

      const camDistBack = paddling ? 5.2 : 5.8;
      const camHeightAbove = paddling ? 2.8 : 3.4;

      const effectiveYaw = this.yaw + this.lookYawOffset;
      const camTargetX = this.pos.x - Math.sin(effectiveYaw) * camDistBack;
      let camTargetY = this.pos.y + camHeightAbove - Math.sin(this.lookPitchOffset) * 2.6;
      const camTargetZ = this.pos.z - Math.cos(effectiveYaw) * camDistBack;

      // Prevent camera from clipping under the displaced ocean surface
      const camWaterSample = this.sampleSurface(camTargetX, camTargetZ, oceanParams);
      const minCamY = (camWaterSample.surfaceY ?? 0) + 0.65;
      if (camTargetY < minCamY) {
        camTargetY = minCamY;
      }

      // Smooth camera trailing with lerp for action-drone feel
      if (!this.camPosSmoothed) {
        this.camPosSmoothed = new THREE.Vector3(camTargetX, camTargetY, camTargetZ);
        this.camLookSmoothed = new THREE.Vector3(this.pos.x, this.pos.y + 0.8, this.pos.z);
      }
      this.camPosSmoothed.lerp(new THREE.Vector3(camTargetX, camTargetY, camTargetZ), Math.min(1.0, dt * 9.0));
      this.camera.position.copy(this.camPosSmoothed);

      // Camera roll: banking smoothly with board carve roll
      this.camera.up.set(Math.sin(-this.roll * 0.22), Math.cos(this.roll * 0.22), 0).normalize();

      // Look target: points down the line ahead of the surfer
      const leadDist = paddling ? 3.0 : 4.5;
      const targetLookX = this.pos.x + Math.sin(effectiveYaw) * leadDist;
      const targetLookY = this.pos.y + 0.8 + Math.sin(this.lookPitchOffset) * 2.2;
      const targetLookZ = this.pos.z + Math.cos(effectiveYaw) * leadDist;

      this.camLookSmoothed.lerp(new THREE.Vector3(targetLookX, targetLookY, targetLookZ), Math.min(1.0, dt * 11.0));
      this.camera.lookAt(this.camLookSmoothed);
      this.controls.target.copy(this.camLookSmoothed);
    }
  }
}
