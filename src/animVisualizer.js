import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createSurfboardMesh, createSurferFigure } from './surferModel.js';

const viewport = document.getElementById('viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1523);

const camera = new THREE.PerspectiveCamera(
  45,
  viewport.clientWidth / viewport.clientHeight,
  0.05,
  100
);
camera.position.set(1.9, 1.35, 2.2);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(viewport.clientWidth, viewport.clientHeight);
viewport.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0.28, -0.1);

// Lighting
scene.add(new THREE.HemisphereLight(0x93c5fd, 0x1e293b, 1.1));
const keyLight = new THREE.DirectionalLight(0xfffbeb, 2.0);
keyLight.position.set(3, 5, 4);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.8);
rimLight.position.set(-4, 2, -3);
scene.add(rimLight);

// Reference Water Surface (y = 0) & Grid
const waterPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(8, 8),
  new THREE.MeshStandardMaterial({
    color: 0x0e7490,
    transparent: true,
    opacity: 0.38,
    roughness: 0.25,
    side: THREE.DoubleSide,
  })
);
waterPlane.rotation.x = -Math.PI / 2;
waterPlane.position.y = 0;
scene.add(waterPlane);

const grid = new THREE.GridHelper(8, 16, 0x38bdf8, 0x1e3a5f);
grid.position.y = -0.002;
scene.add(grid);

// Surfboard & Surfer Rig
const rigGroup = new THREE.Group();
scene.add(rigGroup);

const boardMesh = createSurfboardMesh();
rigGroup.add(boardMesh);

const figure = createSurferFigure();
rigGroup.add(figure.group);

// State
let currentAnim = 'sit_idle';
let isPlaying = true;
let speed = 1.0;
let phase = 0; // 0..1 normalized progress

const playPauseBtn = document.getElementById('btn-play-pause');
const replayBtn = document.getElementById('btn-replay');
const speedSlider = document.getElementById('speed-slider');
const speedVal = document.getElementById('val-speed');
const phaseSlider = document.getElementById('phase-slider');
const phaseVal = document.getElementById('val-phase');

document.querySelectorAll('#anim-buttons button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#anim-buttons button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentAnim = btn.dataset.anim;
    phase = 0;
    isPlaying = true;
    playPauseBtn.textContent = 'Pause';
    playPauseBtn.classList.add('active');
  });
});

playPauseBtn.addEventListener('click', () => {
  isPlaying = !isPlaying;
  playPauseBtn.textContent = isPlaying ? 'Pause' : 'Play';
  playPauseBtn.classList.toggle('active', isPlaying);
});

replayBtn.addEventListener('click', () => {
  phase = 0;
  isPlaying = true;
  playPauseBtn.textContent = 'Pause';
  playPauseBtn.classList.add('active');
});

speedSlider.addEventListener('input', (e) => {
  speed = parseFloat(e.target.value);
  speedVal.textContent = `${speed.toFixed(2).replace(/\.00$/, '.0')}x`;
});

phaseSlider.addEventListener('input', (e) => {
  phase = parseFloat(e.target.value);
  isPlaying = false;
  playPauseBtn.textContent = 'Play';
  playPauseBtn.classList.remove('active');
});

const camPresets = {
  iso: [1.9, 1.35, 2.2],
  side: [2.6, 0.55, -0.1],
  front: [0.0, 0.75, 2.7],
  top: [0.0, 3.2, 0.01],
};
document.querySelectorAll('[data-cam]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const pos = camPresets[btn.dataset.cam];
    if (pos) {
      camera.position.set(pos[0], pos[1], pos[2]);
      controls.target.set(0, 0.28, -0.1);
      controls.update();
    }
  });
});

// Support direct frame/camera inspection via URL query params: ?anim=takeoff&phase=0.74&cam=side
const urlParams = new URLSearchParams(window.location.search);
const paramAnim = urlParams.get('anim');
if (paramAnim) {
  const matchBtn = document.querySelector(`#anim-buttons button[data-anim="${paramAnim}"]`);
  if (matchBtn) {
    document.querySelectorAll('#anim-buttons button').forEach((b) => b.classList.remove('active'));
    matchBtn.classList.add('active');
    currentAnim = paramAnim;
  }
}
const paramPhase = urlParams.get('phase');
if (paramPhase !== null && !Number.isNaN(parseFloat(paramPhase))) {
  phase = Math.max(0, Math.min(1, parseFloat(paramPhase)));
  isPlaying = false;
  playPauseBtn.textContent = 'Play';
  playPauseBtn.classList.remove('active');
  phaseSlider.value = phase.toFixed(3);
  phaseVal.textContent = phase.toFixed(2);
}
const paramCam = urlParams.get('cam');
if (paramCam && camPresets[paramCam]) {
  const pos = camPresets[paramCam];
  camera.position.set(pos[0], pos[1], pos[2]);
  controls.target.set(0, 0.28, -0.1);
  controls.update();
}

function applySitPose(turnDir, strokePhase) {
  figure.proneGroup.visible = false;
  figure.standingGroup.visible = false;
  figure.sittingGroup.visible = true;
  rigGroup.position.y = -0.04;
  rigGroup.rotation.set(0, 0, 0);

  if (turnDir === 0) {
    figure.sitHead.rotation.y = 0;
    figure.sitArmL.rotation.set(0, 0, 0);
    figure.sitArmR.rotation.set(0, 0, 0);
    figure.sitElbowL.rotation.set(0, 0, 0);
    figure.sitElbowR.rotation.set(0, 0, 0);
    return;
  }

  // Exact sitting turn stroke math from surferPov.js:
  // -X = sitArmL (surfer's right arm), +X = sitArmR (surfer's left arm)
  const rad = strokePhase * Math.PI * 2;
  const inWater = Math.sin(rad);
  const waterPull = inWater > 0 ? inWater : 0.0;
  const airLift = inWater < 0 ? -inWater : 0.0;

  const sweepNegX = turnDir * Math.cos(rad);
  const sweepPosX = -sweepNegX;

  const strokeRxNegX = 0.22 - 0.72 * sweepNegX;
  const strokeRxPosX = 0.22 - 0.72 * sweepPosX;
  const abduct = 0.28 + 0.58 * airLift;
  const strokeEx = 0.72 * waterPull - 0.65 * airLift;

  figure.sitHead.rotation.y = turnDir * 0.22;
  figure.sitArmL.rotation.set(strokeRxNegX, 0, -abduct);
  figure.sitElbowL.rotation.set(strokeEx, 0, 0);
  figure.sitArmR.rotation.set(strokeRxPosX, 0, abduct);
  figure.sitElbowR.rotation.set(strokeEx, 0, 0);
}

function applyStandPose(carve, inBarrel) {
  figure.proneGroup.visible = false;
  figure.standingGroup.visible = true;
  figure.sittingGroup.visible = false;
  rigGroup.position.y = 0.02;
  rigGroup.rotation.set(0, 0, -carve * 0.22);

  figure.standingGroup.position.y = 0;
  figure.standingGroup.rotation.set(0, 0, -carve * 0.18);

  const crouch = inBarrel ? 0.10 : Math.abs(carve) * 0.04;
  figure.standingUpperGroup.position.y = -crouch * 0.35;
  figure.standingUpperGroup.rotation.x = crouch * 0.45;

  if (inBarrel) {
    figure.standArmL.rotation.set(-0.25, 0.15, -0.15);
    figure.standArmR.rotation.set(0.18, -0.15, 0.25);
  } else {
    figure.standArmL.rotation.set(-carve * 0.22, carve * 0.12, -carve * 0.18);
    figure.standArmR.rotation.set(carve * 0.22, -carve * 0.12, carve * 0.18);
  }
}

function applyAnimation(anim, p) {
  figure.proneGroup.position.set(0, 0, 0);
  figure.proneGroup.rotation.set(0, 0, 0);
  figure.proneHead.rotation.set(0.12, 0, 0);
  figure.proneUpper.rotation.set(0, 0, 0);
  figure.proneHipL.rotation.set(0, 0, 0);
  figure.proneKneeL.rotation.set(0, 0, 0);
  figure.proneFootL.rotation.set(-0.55, 0, 0);
  figure.proneHipR.rotation.set(0, 0, 0);
  figure.proneKneeR.rotation.set(0, 0, 0);
  figure.proneFootR.rotation.set(-0.55, 0, 0);
  figure.standingGroup.position.set(0, 0, 0);
  figure.standingGroup.rotation.set(0, 0, 0);
  figure.standingUpperGroup.position.set(0, 0, 0);
  figure.standingUpperGroup.rotation.set(0, 0, 0);

  if (anim === 'paddle' || anim === 'paddle_sprint') {
    figure.proneGroup.visible = true;
    figure.standingGroup.visible = false;
    figure.sittingGroup.visible = false;
    rigGroup.position.y = 0.02;
    rigGroup.rotation.set(0, 0, 0);

    const rad = p * Math.PI * 2;
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    const recL = s < 0 ? -s : 0;
    const recR = s > 0 ? s : 0;

    figure.proneArmL.rotation.set(-c * 0.85, 0, -(0.45 + recL * 0.60));
    figure.proneElbowL.rotation.set(-0.35 - recL * 1.00, 0, 0.20 + recL * 0.15);
    figure.proneArmR.rotation.set(c * 0.85, 0, 0.45 + recR * 0.60);
    figure.proneElbowR.rotation.set(-0.35 - recR * 1.00, 0, -(0.20 + recR * 0.15));
    figure.proneGroup.rotation.z = s * 0.055;
    figure.proneHead.rotation.x = 0.22;
  } else if (anim === 'paddle_idle') {
    figure.proneGroup.visible = true;
    figure.standingGroup.visible = false;
    figure.sittingGroup.visible = false;
    rigGroup.position.y = 0.02;
    rigGroup.rotation.set(0, 0, 0);

    figure.proneArmL.rotation.set(0.08, 0, -0.38);
    figure.proneArmR.rotation.set(0.08, 0, 0.38);
    figure.proneElbowL.rotation.set(-0.55, 0, 0.22);
    figure.proneElbowR.rotation.set(-0.55, 0, -0.22);
    figure.proneHead.rotation.x = 0.12;
  } else if (anim === 'duck_dive') {
    figure.proneGroup.visible = true;
    figure.standingGroup.visible = false;
    figure.sittingGroup.visible = false;
    rigGroup.position.y = -0.18 * Math.sin(p * Math.PI);
    rigGroup.rotation.set(0.28 * Math.sin(p * Math.PI), 0, 0);

    figure.proneArmL.rotation.set(-0.55, 0, -0.35);
    figure.proneArmR.rotation.set(-0.55, 0, 0.35);
    figure.proneElbowL.rotation.set(-0.65, 0, 0.30);
    figure.proneElbowR.rotation.set(-0.65, 0, -0.30);
    figure.proneHead.rotation.x = -0.32;
  } else if (anim === 'sit_idle') {
    applySitPose(0, p);
  } else if (anim === 'sit_turn_left') {
    applySitPose(1, p);
  } else if (anim === 'sit_turn_right') {
    applySitPose(-1, p);
  } else if (anim === 'takeoff') {
    rigGroup.position.y = 0.02;
    rigGroup.rotation.set(0.04 * Math.sin(p * Math.PI), 0, 0);

    if (p < 0.74) {
      figure.proneGroup.visible = true;
      figure.standingGroup.visible = false;
      figure.sittingGroup.visible = false;

      if (p < 0.28) {
        const p1 = p / 0.28;
        const s1 = p1 * p1 * (3 - 2 * p1);
        figure.proneUpper.rotation.set(-1.05 * s1, 0, 0);
        figure.proneArmL.rotation.set(1.95 - 0.60 * s1, 0, -(0.24 - 0.08 * s1));
        figure.proneArmR.rotation.set(1.95 - 0.60 * s1, 0, 0.24 - 0.08 * s1);
        figure.proneElbowL.rotation.set(-2.10 + 1.05 * s1, 0, 0.12 * (1 - s1));
        figure.proneElbowR.rotation.set(-2.10 + 1.05 * s1, 0, -0.12 * (1 - s1));
        figure.proneHead.rotation.x = 0.12 + 0.55 * s1;
      } else if (p < 0.54) {
        const p2 = (p - 0.28) / 0.26;
        const s2 = p2 * p2 * (3 - 2 * p2);
        const hipLx = -2.45 * s2;
        const kneeLx = 1.60 * s2;
        const hipRx = -0.75 * s2;
        const kneeRx = 0.10 * s2;
        const ankleYL = 0.075 + 0.27 * (Math.sin(hipLx) + Math.sin(hipLx + kneeLx));
        const ankleYR = 0.075 + 0.27 * (Math.sin(hipRx) + Math.sin(hipRx + kneeRx));
        const kneeYL = 0.075 + 0.27 * Math.sin(hipLx);
        const kneeYR = 0.075 + 0.27 * Math.sin(hipRx);
        const minLegY = Math.min(ankleYL, ankleYR, kneeYL, kneeYR);
        const groundedPy = Math.max(0.28 * s2, 0.055 - minLegY);

        figure.proneGroup.position.set(0, groundedPy, 0.02 * s2);
        figure.proneGroup.rotation.set(0, 0, 0);
        figure.proneUpper.rotation.set(-1.05 + 0.10 * s2, 0, 0);
        figure.proneArmL.rotation.set(1.35 - 0.35 * s2, 0, -0.16);
        figure.proneArmR.rotation.set(1.35 - 0.35 * s2, 0, 0.16);
        figure.proneElbowL.rotation.set(-1.05 + 0.20 * s2, 0, 0);
        figure.proneElbowR.rotation.set(-1.05 + 0.20 * s2, 0, 0);
        figure.proneHead.rotation.set(0.67 - 0.10 * s2, 0, 0);

        figure.proneHipL.rotation.set(hipLx, 0, -0.08 * s2);
        figure.proneKneeL.rotation.set(kneeLx, 0, 0);
        figure.proneFootL.rotation.set(THREE.MathUtils.lerp(-0.55, -(hipLx + kneeLx), s2), 0.78 * s2, 0);
        figure.proneHipR.rotation.set(hipRx, 0, 0.08 * s2);
        figure.proneKneeR.rotation.set(kneeRx, 0, 0);
        figure.proneFootR.rotation.set(THREE.MathUtils.lerp(-0.55, -(hipRx + kneeRx), s2), (Math.PI / 2) * s2, 0);
      } else {
        const p2b = (p - 0.54) / 0.20;
        const s2b = p2b * p2b * (3 - 2 * p2b);
        const hipLx = THREE.MathUtils.lerp(-2.45, -2.35, s2b);
        const kneeLx = THREE.MathUtils.lerp(1.60, 0.70, s2b);
        const hipRx = THREE.MathUtils.lerp(-0.75, -1.08, s2b);
        const kneeRx = THREE.MathUtils.lerp(0.10, 0.10, s2b);
        const ankleYL = 0.075 + 0.27 * (Math.sin(hipLx) + Math.sin(hipLx + kneeLx));
        const ankleYR = 0.075 + 0.27 * (Math.sin(hipRx) + Math.sin(hipRx + kneeRx));
        const minLegY = Math.min(ankleYL, ankleYR);
        const groundedPy = 0.055 - minLegY;

        figure.proneGroup.position.set(0.08 * s2b, groundedPy, THREE.MathUtils.lerp(0.02, 0.0, s2b));
        figure.proneGroup.rotation.set(0, 0, 0);
        figure.proneUpper.rotation.set(THREE.MathUtils.lerp(-0.95, -1.52, s2b), 0, 1.15 * s2b);
        figure.proneArmL.rotation.set(THREE.MathUtils.lerp(1.00, 0.55, s2b), 0, THREE.MathUtils.lerp(-0.16, -0.95, s2b));
        figure.proneArmR.rotation.set(THREE.MathUtils.lerp(1.00, 0.45, s2b), 0, THREE.MathUtils.lerp(0.16, 1.05, s2b));
        figure.proneElbowL.rotation.set(THREE.MathUtils.lerp(-0.85, -0.35, s2b), 0, 0);
        figure.proneElbowR.rotation.set(THREE.MathUtils.lerp(-0.85, -0.25, s2b), 0, 0);
        figure.proneHead.rotation.set(THREE.MathUtils.lerp(0.57, 1.45, s2b), 0, -1.15 * s2b);

        figure.proneHipL.rotation.set(hipLx, 0, THREE.MathUtils.lerp(-0.08, 0.0, s2b));
        figure.proneKneeL.rotation.set(kneeLx, 0, 0);
        figure.proneFootL.rotation.set(-(hipLx + kneeLx), 0.78, 0);
        figure.proneHipR.rotation.set(hipRx, 0, THREE.MathUtils.lerp(0.08, 0.0, s2b));
        figure.proneKneeR.rotation.set(kneeRx, 0, 0);
        figure.proneFootR.rotation.set(-(hipRx + kneeRx), Math.PI / 2, 0);
      }
    } else {
      figure.proneGroup.visible = false;
      figure.standingGroup.visible = true;
      figure.sittingGroup.visible = false;

      const p3 = (p - 0.74) / 0.26;
      const s3 = p3 * p3 * (3 - 2 * p3);
      figure.standingGroup.position.set(0, 0, 0);
      figure.standingGroup.rotation.y = 0.0;
      figure.standingUpperGroup.position.y = THREE.MathUtils.lerp(-0.08, 0.0, s3);
      figure.standingUpperGroup.rotation.x = THREE.MathUtils.lerp(0.10, 0.0, s3);
      figure.standArmL.rotation.set(
        THREE.MathUtils.lerp(0.25, 0.0, s3),
        THREE.MathUtils.lerp(0.10, 0.0, s3),
        THREE.MathUtils.lerp(-0.12, 0.0, s3)
      );
      figure.standArmR.rotation.set(
        THREE.MathUtils.lerp(0.20, 0.0, s3),
        THREE.MathUtils.lerp(-0.10, 0.0, s3),
        THREE.MathUtils.lerp(0.12, 0.0, s3)
      );
    }
  } else if (anim === 'stand_ride') {
    applyStandPose(0, false);
  } else if (anim === 'stand_carve_l') {
    applyStandPose(-0.85, false);
  } else if (anim === 'stand_carve_r') {
    applyStandPose(0.85, false);
  } else if (anim === 'stand_barrel') {
    applyStandPose(0, true);
  }
}

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());

  if (isPlaying) {
    const cycleRate =
      currentAnim === 'paddle_sprint'
        ? 1.9
        : currentAnim === 'takeoff'
        ? 1.0 / 0.48
        : currentAnim === 'sit_turn_left' || currentAnim === 'sit_turn_right'
        ? 3.5
        : currentAnim === 'duck_dive'
        ? 0.6
        : 1.0;

    if (currentAnim === 'takeoff') {
      // Loop take-off with a brief pause at the end so you can inspect the standing pose
      phase += dt * cycleRate * speed * 0.55;
      if (phase > 1.35) phase = 0;
    } else {
      phase = (phase + dt * cycleRate * speed) % 1.0;
    }

    const clampedPhase = Math.min(1.0, phase);
    phaseSlider.value = clampedPhase.toFixed(3);
    phaseVal.textContent = clampedPhase.toFixed(2);
  } else {
    phaseVal.textContent = phase.toFixed(2);
  }

  applyAnimation(currentAnim, Math.min(1.0, phase));
  controls.update();
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = viewport.clientWidth / viewport.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
});

animate();
