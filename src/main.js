import * as THREE from 'three';
import { BathymetryManager, WORLD_SIZE } from './bathymetry.js';
import { HydroWaveSolver } from './waveSolver.js';
import { createOceanMaterial } from './waveShader.js';
import { SprayParticleSystem } from './spraySystem.js';
import { BeachCrowdSystem } from './crowdSystem.js';
import { SurferPovController } from './surferPov.js';
import { setupSkyLighting } from './skyLighting.js';
import { CameraController } from './cameraController.js';
import { SculptBrush } from './sculptBrush.js';
import { UIController } from './uiController.js';
import { SurfHudController } from './surfHudController.js';

// --- Scene & Renderer Setup ---
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1d30);
scene.fog = new THREE.FogExp2(0x1b3b58, 0.00075);

const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.4, 2500);
camera.position.set(-160, 95, 230);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
container.appendChild(renderer.domElement);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Core Simulation Managers & Ocean Mesh ---
const btyManager = new BathymetryManager(scene);
const waveSolver = new HydroWaveSolver(btyManager);

const OCEAN_SEGMENTS = 300;
const oceanGeom = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, OCEAN_SEGMENTS, OCEAN_SEGMENTS);
oceanGeom.rotateX(-Math.PI / 2);
const oceanMat = createOceanMaterial(btyManager.texture, waveSolver.simTexture);
const oceanMesh = new THREE.Mesh(oceanGeom, oceanMat);
oceanMesh.renderOrder = 1;
scene.add(oceanMesh);

const spraySystem = new SprayParticleSystem(scene);
const crowdSystem = new BeachCrowdSystem(scene);
const skyLighting = setupSkyLighting(scene, oceanMat);

// --- Simulation State ---
const oceanParams = {
  swellHeight: 2.2,
  swellPeriod: 14.0,
  swellDir: 0.0,
  swellGrouping: 10.0,
  wavesPerSet: 6.0,
  secEnabled: true,
  secHeight: 0.3,
  secPeriod: 11.0,
  secDir: -24.0,
  backwashStrength: 0.45,
  sideWaveStrength: 0.85,
  sideWaveAngle: 35.0,
  windSpeed: 10.0,
  windDir: 10.0,
  tideLevel: 0.2,
  sunElevation: 28.0,
  timeScale: 1.0,
  particlesBarrel: false,
  particlesWhitewater: false,
  particleDensity: 0.0,
  crowdEnabled: true,
  towelsEnabled: true,
  reflectionsEnabled: true,
};

let isPaused = false;
let simTime = 0;

// --- Subsystem Controllers ---
let cameraController;

const surferPov = new SurferPovController(scene, camera, null, waveSolver, btyManager, spraySystem);

const surfHud = new SurfHudController({
  surferPov,
  btyManager,
  crowdSystem,
  getOceanParams: () => oceanParams,
  applyCameraPreset: (mode) => cameraController.applyCameraPreset(mode),
  domElement: renderer.domElement,
});

cameraController = new CameraController({
  camera,
  domElement: renderer.domElement,
  getBtyPreset: () => btyManager.preset,
  isSculpting: () => sculptBrush?.isSculpting() ?? false,
  isSurferActive: () => surferPov.active,
  onSurferKey: (e) => surfHud.handleSurferKey(e),
  onSurfModeRequest: (mode, camInfo) => {
    if (mode === 'exit') surfHud.exitSurfPov(false);
    else surfHud.enterSurfPov(mode, camInfo);
  },
});
surferPov.controls = cameraController.controls;

const sculptBrush = new SculptBrush({
  scene,
  camera,
  domElement: renderer.domElement,
  btyManager,
  getTideLevel: () => oceanParams.tideLevel,
  onTerrainModified: () => {
    crowdSystem.populate(btyManager, oceanParams.tideLevel);
    uiController.syncUIAndTelemetry();
  },
  onTerrainReset: () => {
    waveSolver.warmup(oceanParams, 180);
    spraySystem.warmup(oceanParams, waveSolver, 45);
    crowdSystem.populate(btyManager, oceanParams.tideLevel);
    uiController.syncUIAndTelemetry();
  },
});

const minimapCanvas = document.getElementById('bathymetry-minimap');
const uiController = new UIController({
  oceanParams,
  btyManager,
  waveSolver,
  spraySystem,
  crowdSystem,
  surferPov,
  oceanMat,
  minimapCanvas,
  updateSunLighting: (params) => skyLighting.updateSunLighting(params),
  applyCameraPreset: (mode) => cameraController.applyCameraPreset(mode),
  getIsPaused: () => isPaused,
  setIsPaused: (val) => { isPaused = val; },
});

// Pre-warm the 2D Shallow-Water PDE Solver so waves propagate across the surf zone
waveSolver.warmup(oceanParams, 220);
spraySystem.warmup(oceanParams, waveSolver, 45);
crowdSystem.populate(btyManager, oceanParams.tideLevel);
uiController.syncUIAndTelemetry();

// --- Performance FPS Counter ---
let fpsFrameCount = 0;
let fpsLastTime = performance.now();
const fpsValEl = document.getElementById('fps-val');
const fpsMsEl = document.getElementById('fps-ms');
const fpsDotEl = document.querySelector('.fps-dot');

function updateFPS() {
  fpsFrameCount++;
  const now = performance.now();
  const elapsed = now - fpsLastTime;
  if (elapsed >= 450) {
    const fps = Math.round((fpsFrameCount * 1000) / elapsed);
    const ms = (elapsed / fpsFrameCount).toFixed(1);
    fpsFrameCount = 0;
    fpsLastTime = now;
    if (fpsValEl) fpsValEl.textContent = fps;
    if (fpsMsEl) fpsMsEl.textContent = `${ms}ms`;
    if (fpsDotEl) {
      fpsDotEl.className = 'fps-dot' + (fps >= 48 ? '' : fps >= 28 ? ' warn' : ' bad');
    }
  }
}

// --- Main Animation Loop ---
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  updateFPS();

  const dt = Math.min(0.05, clock.getDelta());

  if (!isPaused) {
    const simDt = dt * (oceanParams.timeScale ?? 1.0);
    simTime += simDt;
    oceanMat.uniforms.uTime.value = simTime;
    waveSolver.update(dt, oceanParams);
    spraySystem.update(simDt, oceanParams, waveSolver);
    crowdSystem.update(simTime);
    uiController.updateSetCountdownUI();
  }

  sculptBrush.update(dt);

  if (surferPov.active) {
    if (!isPaused) {
      surferPov.update(dt * (oceanParams.timeScale ?? 1.0), cameraController.keyState, oceanParams, dt);
    }
    surfHud.updateHud();
  } else {
    cameraController.update(dt);
  }

  // Real-time Bathymetry Depth Map with player location & trail
  const now = clock.getElapsedTime();
  const playerMinimapData = surfHud.getPlayerMinimapData(now);

  btyManager.renderMinimap(
    minimapCanvas,
    oceanParams.tideLevel,
    oceanParams.swellDir,
    playerMinimapData
  );
  surfHud.renderHudMinimap(playerMinimapData);

  oceanMat.uniforms.uCameraPos.value.copy(camera.position);
  renderer.render(scene, camera);
}

window.__debug = {
  camera,
  controls: cameraController.controls,
  surferPov,
  oceanParams,
  waveSolver,
  btyManager,
  scene,
};

animate();
