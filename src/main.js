import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BathymetryManager, WORLD_SIZE } from './bathymetry.js';
import { HydroWaveSolver } from './waveSolver.js';
import { createOceanMaterial } from './waveShader.js';
import { evaluateSurfTelemetry } from './wavePhysics.js';
import {
  SprayParticleSystem,
  PARTICLE_TYPE_BARREL,
  PARTICLE_TYPE_WHITEWATER,
  PARTICLE_TYPE_BOARD_SPRAY,
} from './spraySystem.js';
import { BeachCrowdSystem } from './crowdSystem.js';
import { SurferPovController } from './surferPov.js';

// --- Scene, Camera & Renderer Setup ---
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

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.target.set(30, 0, -40);
controls.minPolarAngle = 0.02;
controls.maxPolarAngle = Math.PI * 0.96; // Allow tilting & orbiting underwater to inspect seabed structure
controls.minDistance = 3;
controls.maxDistance = 850;
controls.screenSpacePanning = true;
controls.panSpeed = 1.35;
controls.mouseButtons = {
  LEFT: null, // Left-drag is handled below as Minecraft-style free-look from the camera's own position
  MIDDLE: THREE.MOUSE.PAN, // Mousewheel click & drag moves the camera in screen space
  RIGHT: THREE.MOUSE.PAN,
};

// Prevent browser middle-click autoscroll icon when dragging with the mousewheel button
renderer.domElement.addEventListener('mousedown', (e) => {
  if (e.button === 1) {
    e.preventDefault();
  }
});
renderer.domElement.addEventListener('auxclick', (e) => {
  if (e.button === 1) {
    e.preventDefault();
  }
});

// --- Sky Dome & Sun Lighting ---
const ambientLight = new THREE.HemisphereLight(0x93c5fd, 0x1e293b, 0.9);
scene.add(ambientLight);

const sunLight = new THREE.DirectionalLight(0xfffbeb, 2.2);
sunLight.position.set(80, 95, -140);
scene.add(sunLight);

const skyGeom = new THREE.SphereGeometry(1400, 32, 20);
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: {
    uSunDir: { value: new THREE.Vector3(0.4, 0.48, -0.75).normalize() },
  },
  vertexShader: /* glsl */ `
    varying vec3 vWorldDirection;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldDirection = normalize(wp.xyz);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uSunDir;
    varying vec3 vWorldDirection;
    void main() {
      vec3 d = normalize(vWorldDirection);
      float y = clamp(d.y, 0.0, 1.0);
      float sunElev = clamp(uSunDir.y, 0.05, 1.0);

      vec3 zenith = mix(vec3(0.10, 0.20, 0.38), vec3(0.15, 0.42, 0.72), sunElev);
      vec3 horizon = mix(vec3(0.88, 0.52, 0.32), vec3(0.68, 0.85, 0.95), sunElev);
      vec3 col = mix(horizon, zenith, pow(y, 0.55));

      float sunDot = max(0.0, dot(d, normalize(uSunDir)));
      col += vec3(1.0, 0.85, 0.62) * pow(sunDot, 28.0) * 0.55;
      col += vec3(1.0, 0.98, 0.90) * smoothstep(0.9985, 0.9998, sunDot) * 2.5;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
const skyDome = new THREE.Mesh(skyGeom, skyMat);
scene.add(skyDome);

// --- Bathymetry, Real-Time 2D Hydrodynamic Wave PDE Solver & 3D Ocean Mesh ---
const btyManager = new BathymetryManager(scene);
const waveSolver = new HydroWaveSolver(btyManager);

const OCEAN_SEGMENTS = 300;
const oceanGeom = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, OCEAN_SEGMENTS, OCEAN_SEGMENTS);
oceanGeom.rotateX(-Math.PI / 2);
const oceanMat = createOceanMaterial(btyManager.texture, waveSolver.simTexture);
const oceanMesh = new THREE.Mesh(oceanGeom, oceanMat);
oceanMesh.renderOrder = 1;
scene.add(oceanMesh);

// --- Offshore Spray Particle System & Inland Beach Crowd Scale Reference ---
const spraySystem = new SprayParticleSystem(scene);
const crowdSystem = new BeachCrowdSystem(scene);

// --- 3D Sculpting Brush Cursor Ring ---
const ringGeom = new THREE.RingGeometry(0.92, 1.0, 48);
ringGeom.rotateX(-Math.PI / 2);
const ringMat = new THREE.MeshBasicMaterial({
  color: 0x22d3ee,
  side: THREE.DoubleSide,
  transparent: true,
  opacity: 0.85,
  depthTest: false,
});
const brushCursor = new THREE.Mesh(ringGeom, ringMat);
brushCursor.visible = false;
scene.add(brushCursor);

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
};

const brushState = {
  mode: 'none', // 'none' | 'raise' | 'jetty' | 'lower' | 'smooth'
  radius: 24.0,
  strength: 0.5,
  isPointerDown: false,
  hitPoint: new THREE.Vector3(),
  hasHit: false,
};

let isPaused = false;
let simTime = 0;

// --- UI Binding & Synchronization ---
const minimapCanvas = document.getElementById('bathymetry-minimap');

function updateSunLighting() {
  const elevRad = (oceanParams.sunElevation * Math.PI) / 180;
  const azimRad = (-145 * Math.PI) / 180;
  const sunDir = new THREE.Vector3(
    Math.cos(elevRad) * Math.sin(azimRad),
    Math.sin(elevRad),
    Math.cos(elevRad) * Math.cos(azimRad)
  ).normalize();

  sunLight.position.copy(sunDir).multiplyScalar(180);
  oceanMat.uniforms.uSunDir.value.copy(sunDir);
  skyMat.uniforms.uSunDir.value.copy(sunDir);
}

function syncUIAndTelemetry() {
  oceanMat.uniforms.uWindSpeed.value = oceanParams.windSpeed;
  oceanMat.uniforms.uWindDir.value = oceanParams.windDir;
  oceanMat.uniforms.uTideLevel.value = oceanParams.tideLevel;

  updateSunLighting();

  const interBadge = document.getElementById('interference-badge');
  if (interBadge) {
    if (oceanParams.backwashStrength > 0.8 && oceanParams.sideWaveStrength > 0.8) {
      interBadge.textContent = 'High Reflection PDE';
    } else {
      interBadge.textContent = '2D PDE Active';
    }
  }

  const t = evaluateSurfTelemetry(oceanParams, btyManager);

  document.getElementById('swell-energy-badge').textContent = `${t.swellEnergyKJ} kJ`;

  const windBadge = document.getElementById('wind-regime-badge');
  const absWindAngle = Math.abs(oceanParams.windDir);
  if (oceanParams.windSpeed < 3) {
    windBadge.textContent = 'Glassy Calm';
  } else if (absWindAngle < 45) {
    windBadge.textContent = 'Clean Offshore';
  } else if (absWindAngle < 115) {
    windBadge.textContent = 'Cross-Shore';
  } else {
    windBadge.textContent = 'Onshore Chop';
  }

  const tideBadge = document.getElementById('tide-stage-badge');
  if (oceanParams.tideLevel < -0.5) tideBadge.textContent = 'Low Tide Drain';
  else if (oceanParams.tideLevel > 0.8) tideBadge.textContent = 'High Tide Push';
  else tideBadge.textContent = 'Mid Tide';

  document.getElementById('metric-break-type').textContent = t.breakType;
  document.getElementById('metric-surf-rating').textContent = `★ ${t.score.toFixed(1)}/10 — ${t.ratingLabel}`;

  const faceFt = (t.breakingFaceHeight * 3.28084).toFixed(1);
  document.getElementById('metric-face-height').innerHTML = `${t.breakingFaceHeight.toFixed(1)} m <small>(${faceFt} ft)</small>`;
  document.getElementById('metric-shoaling-factor').textContent = `Shoaling Amp: ${t.shoalingAmp.toFixed(2)}x`;

  document.getElementById('metric-iribarren').textContent = t.iribarren.toFixed(2);
  document.getElementById('metric-lip-pitch').textContent = t.lipPitchDesc;

  document.getElementById('metric-wavelength').innerHTML = `L<sub>0</sub>: ${Math.round(t.L0)} m`;
  const kts = (t.waveSpeed * 1.94384).toFixed(1);
  document.getElementById('metric-wave-speed').textContent = `Break Speed: ${t.waveSpeed.toFixed(1)} m/s (${kts} kts)`;

  document.getElementById('metric-peel-angle').textContent = `${t.peelAngle}° Peel`;
  document.getElementById('metric-peel-desc').textContent = t.peelDesc;

  const valWavesPerSet = document.getElementById('val-waves-per-set');
  if (valWavesPerSet) {
    valWavesPerSet.textContent = `${t.wavesPerSet} waves (${t.setPeriodSec} s Set)`;
  }
  updateSetCountdownUI(t);

  btyManager.renderMinimap(minimapCanvas, oceanParams.tideLevel, oceanParams.swellDir);
  updateParticlesUI();
}

let lastCountdownKey = '';
function updateSetCountdownUI(cachedTelemetry) {
  const metricSetPeriod = document.getElementById('metric-set-period');
  const metricSetLull = document.getElementById('metric-set-lull');
  if (!metricSetPeriod || !metricSetLull) return;

  const status = waveSolver.getSetCountdown(oceanParams);
  const key = `${status.isContinuous}-${status.isSetActive}-${status.secondsRemaining}-${status.setCycleSec}`;
  if (key === lastCountdownKey && !cachedTelemetry) return;
  lastCountdownKey = key;

  const setWavesCount = Math.max(2, Math.round((oceanParams.wavesPerSet ?? 6) * 0.48));
  if (status.isContinuous) {
    metricSetPeriod.textContent = 'Continuous Train';
    metricSetPeriod.style.color = '#f8fafc';
    metricSetLull.textContent = `0 s Lull • ${status.setCycleSec} s Cycle`;
  } else if (status.isSetActive) {
    metricSetPeriod.textContent = `Set Active (${status.secondsRemaining} s)`;
    metricSetPeriod.style.color = '#38bdf8';
    metricSetLull.textContent = `Pumping Now • ~${setWavesCount} Waves/Set (${status.setCycleSec} s)`;
  } else {
    metricSetPeriod.textContent = `Next Set in ${status.secondsRemaining} s`;
    metricSetPeriod.style.color = '#fbbf24';
    metricSetLull.textContent = `In Lull • ${status.setCycleSec} s Cycle (~${setWavesCount} Waves/Set)`;
  }
}

function bindSlider(id, valId, paramObj, key, formatter, onChange) {
  const el = document.getElementById(id);
  const valEl = document.getElementById(valId);
  if (!el) return;

  el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    paramObj[key] = v;
    if (valEl && formatter) valEl.textContent = formatter(v);
    if (onChange) onChange(v);
  });
}

bindSlider(
  'swell-height',
  'val-swell-height',
  oceanParams,
  'swellHeight',
  (v) => `${v.toFixed(1)} m (${(v * 3.28084).toFixed(1)} ft)`,
  syncUIAndTelemetry
);

bindSlider(
  'swell-period',
  'val-swell-period',
  oceanParams,
  'swellPeriod',
  (v) => `${v} s (${v >= 13 ? 'Groundswell' : v >= 9 ? 'Mid-Period' : 'Windswell'})`,
  syncUIAndTelemetry
);

bindSlider(
  'swell-dir',
  'val-swell-dir',
  oceanParams,
  'swellDir',
  (v) => `${v > 0 ? '+' : ''}${v}° (${v === 0 ? 'Direct' : v < 0 ? 'West Peak' : 'East Peak'})`,
  syncUIAndTelemetry
);

bindSlider(
  'swell-grouping',
  'val-swell-grouping',
  oceanParams,
  'swellGrouping',
  (v) => `${v}%`,
  () => {
    waveSolver.warmup(oceanParams, 300);
    spraySystem.warmup(oceanParams, waveSolver, 45);
    syncUIAndTelemetry();
  }
);

bindSlider(
  'waves-per-set',
  'val-waves-per-set',
  oceanParams,
  'wavesPerSet',
  (v) => `${v} waves (${Math.round(v * oceanParams.swellPeriod)} s Set)`,
  syncUIAndTelemetry
);

document.getElementById('sec-swell-enabled').addEventListener('change', (e) => {
  oceanParams.secEnabled = e.target.checked;
  document.getElementById('sec-swell-controls').style.opacity = e.target.checked ? '1' : '0.4';
  syncUIAndTelemetry();
});

bindSlider('sec-height', 'val-sec-height', oceanParams, 'secHeight', (v) => `${v.toFixed(1)} m`, syncUIAndTelemetry);
bindSlider('sec-period', 'val-sec-period', oceanParams, 'secPeriod', (v) => `${v} s`, syncUIAndTelemetry);
bindSlider('sec-dir', 'val-sec-dir', oceanParams, 'secDir', (v) => `${v}°`, syncUIAndTelemetry);

bindSlider(
  'backwash-strength',
  'val-backwash',
  oceanParams,
  'backwashStrength',
  (v) => `${v.toFixed(2)}x`,
  syncUIAndTelemetry
);
bindSlider(
  'sidewave-strength',
  'val-sidewave-strength',
  oceanParams,
  'sideWaveStrength',
  (v) => `${v.toFixed(2)}x`,
  syncUIAndTelemetry
);

bindSlider('wind-speed', 'val-wind-speed', oceanParams, 'windSpeed', (v) => `${v} kts`, syncUIAndTelemetry);
bindSlider(
  'wind-dir',
  'val-wind-dir',
  oceanParams,
  'windDir',
  (v) => {
    const a = Math.abs(v);
    const label = a < 45 ? 'Offshore' : a < 120 ? 'Cross' : 'Onshore';
    return `${v}° (${label})`;
  },
  syncUIAndTelemetry
);

bindSlider(
  'tide-level',
  'val-tide',
  oceanParams,
  'tideLevel',
  (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} m (${v < -0.5 ? 'Low' : v > 0.8 ? 'High' : 'Mid'})`,
  () => {
    crowdSystem.populate(btyManager, oceanParams.tideLevel);
    syncUIAndTelemetry();
  }
);

bindSlider(
  'sun-elevation',
  'val-sun-elevation',
  oceanParams,
  'sunElevation',
  (v) => `${v}° (${v < 15 ? 'Golden Hour' : v < 38 ? 'Afternoon' : 'Midday'})`,
  syncUIAndTelemetry
);

// --- Foam & Spray Particle Controls ---
function updateParticlesUI() {
  const barrelToggle = document.getElementById('particles-barrel-toggle');
  const whitewaterToggle = document.getElementById('particles-whitewater-toggle');
  const selectEl = document.getElementById('particles-select');
  const badgeEl = document.getElementById('particles-badge');

  if (barrelToggle && barrelToggle.checked !== !!oceanParams.particlesBarrel) {
    barrelToggle.checked = !!oceanParams.particlesBarrel;
  }
  if (whitewaterToggle && whitewaterToggle.checked !== !!oceanParams.particlesWhitewater) {
    whitewaterToggle.checked = !!oceanParams.particlesWhitewater;
  }

  if (selectEl) {
    let targetVal = 'all';
    if (!oceanParams.particlesBarrel && !oceanParams.particlesWhitewater) {
      targetVal = 'none';
    } else if (!oceanParams.particlesBarrel) {
      targetVal = 'no_barrel';
    } else if (!oceanParams.particlesWhitewater) {
      targetVal = 'no_whitewater';
    }
    if (selectEl.value !== targetVal) selectEl.value = targetVal;
  }

  if (badgeEl) {
    if (!oceanParams.particlesBarrel && !oceanParams.particlesWhitewater) {
      badgeEl.textContent = 'Disabled';
      badgeEl.className = 'badge subtle';
    } else if (!oceanParams.particlesBarrel) {
      badgeEl.textContent = 'Whitewater Only';
      badgeEl.className = 'badge subtle';
    } else if (!oceanParams.particlesWhitewater) {
      badgeEl.textContent = 'Barrel Only';
      badgeEl.className = 'badge subtle';
    } else if ((oceanParams.particleDensity ?? 1.0) < 0.99) {
      badgeEl.textContent = `${Math.round((oceanParams.particleDensity ?? 1.0) * 100)}% Density`;
      badgeEl.className = 'badge';
    } else {
      badgeEl.textContent = 'All Active';
      badgeEl.className = 'badge';
    }
  }
}

const particlesSelect = document.getElementById('particles-select');
if (particlesSelect) {
  particlesSelect.addEventListener('change', (e) => {
    const val = e.target.value;
    if (val === 'all') {
      oceanParams.particlesBarrel = true;
      oceanParams.particlesWhitewater = true;
    } else if (val === 'no_barrel') {
      oceanParams.particlesBarrel = false;
      oceanParams.particlesWhitewater = true;
      spraySystem.clearType(PARTICLE_TYPE_BARREL);
    } else if (val === 'no_whitewater') {
      oceanParams.particlesBarrel = true;
      oceanParams.particlesWhitewater = false;
      spraySystem.clearType(PARTICLE_TYPE_WHITEWATER);
      spraySystem.clearType(PARTICLE_TYPE_BOARD_SPRAY);
    } else if (val === 'none') {
      oceanParams.particlesBarrel = false;
      oceanParams.particlesWhitewater = false;
      spraySystem.clear();
    }
    updateParticlesUI();
  });
}

const particlesBarrelToggle = document.getElementById('particles-barrel-toggle');
if (particlesBarrelToggle) {
  particlesBarrelToggle.addEventListener('change', (e) => {
    oceanParams.particlesBarrel = e.target.checked;
    if (!oceanParams.particlesBarrel) {
      spraySystem.clearType(PARTICLE_TYPE_BARREL);
    }
    updateParticlesUI();
  });
}

const particlesWhitewaterToggle = document.getElementById('particles-whitewater-toggle');
if (particlesWhitewaterToggle) {
  particlesWhitewaterToggle.addEventListener('change', (e) => {
    oceanParams.particlesWhitewater = e.target.checked;
    if (!oceanParams.particlesWhitewater) {
      spraySystem.clearType(PARTICLE_TYPE_WHITEWATER);
      spraySystem.clearType(PARTICLE_TYPE_BOARD_SPRAY);
    }
    updateParticlesUI();
  });
}

const particleDensitySlider = document.getElementById('particle-density');
const particleDensityVal = document.getElementById('val-particle-density');
if (particleDensitySlider) {
  particleDensitySlider.addEventListener('input', () => {
    const v = parseFloat(particleDensitySlider.value);
    oceanParams.particleDensity = v / 100.0;
    if (particleDensityVal) particleDensityVal.textContent = `${Math.round(v)}%`;
    if (oceanParams.particleDensity <= 0.005) {
      spraySystem.clear();
    }
    updateParticlesUI();
  });
}

// Parametric Bathymetry Sliders
bindSlider(
  'seabed-slope',
  'val-seabed-slope',
  btyManager.params,
  'seabedSlope',
  (v) => `${v.toFixed(2)}x`,
  () => {
    btyManager.generatePreset(btyManager.preset);
    crowdSystem.populate(btyManager, oceanParams.tideLevel);
    syncUIAndTelemetry();
  }
);

bindSlider(
  'reef-prominence',
  'val-reef-prominence',
  btyManager.params,
  'reefProminence',
  (v) => `${v.toFixed(2)}x`,
  () => {
    btyManager.generatePreset(btyManager.preset);
    crowdSystem.populate(btyManager, oceanParams.tideLevel);
    syncUIAndTelemetry();
  }
);

bindSlider(
  'reef-angle',
  'val-reef-angle',
  btyManager.params,
  'reefAngle',
  (v) => `${v}°`,
  () => {
    btyManager.generatePreset(btyManager.preset);
    crowdSystem.populate(btyManager, oceanParams.tideLevel);
    syncUIAndTelemetry();
  }
);

bindSlider(
  'channel-depth',
  'val-channel-depth',
  btyManager.params,
  'channelDepth',
  (v) => `${v.toFixed(1)}x`,
  () => {
    btyManager.generatePreset(btyManager.preset);
    crowdSystem.populate(btyManager, oceanParams.tideLevel);
    syncUIAndTelemetry();
  }
);

function applyCameraPreset(cameraMode) {
  if (cameraMode === 'surf_third') {
    enterSurfPov('third_person');
    return;
  }
  if (cameraMode === 'surf_pov') {
    enterSurfPov('first_person');
    return;
  }
  if (surferPov.active) exitSurfPov(false);

  const preset = btyManager.preset;
  // Place shoulder camera on the open surf side (+x for left_point/jetty_wedge/rivermouth, -x for right_point/reef_pass)
  const sideSign = preset === 'left_point' || preset === 'jetty_wedge' || preset === 'rivermouth' ? 1 : -1;

  if (cameraMode === 'overview') {
    camera.position.set(160 * sideSign, 95, 230);
    controls.target.set(-30 * sideSign, 0, -40);
  } else if (cameraMode === 'underwater') {
    camera.position.set(110 * -sideSign, -8, -120);
    controls.target.set(30 * -sideSign, -3, -60);
  } else if (cameraMode === 'lineup') {
    camera.position.set(175 * -sideSign, 12, -145);
    controls.target.set(155 * -sideSign, 2, -220);
  } else if (cameraMode === 'barrel') {
    camera.position.set(120 * -sideSign, 5, -110);
    controls.target.set(40 * -sideSign, 2, -70);
  } else if (cameraMode === 'cliff') {
    camera.position.set(195 * -sideSign, 42, -50);
    controls.target.set(60 * -sideSign, 2, -120);
  } else if (cameraMode === 'topdown') {
    camera.position.set(0, 480, 20);
    controls.target.set(0, 0, 0);
  }
}

// Preset Selector
document.getElementById('preset-select').addEventListener('change', (e) => {
  const preset = e.target.value;
  btyManager.sculptOffset.fill(0);
  btyManager.generatePreset(preset);
  applyCameraPreset(document.getElementById('camera-select').value);

  const presetInterference = {
    right_point: { bw: 0.35, sw: 0.75 },
    left_point: { bw: 0.35, sw: 0.75 },
    jetty_wedge: { bw: 0.75, sw: 1.35 },
    reef_pass: { bw: 0.20, sw: 0.65 },
    aframe_reef: { bw: 0.30, sw: 0.65 },
    beach_break: { bw: 0.65, sw: 0.55 },
    rivermouth: { bw: 0.30, sw: 0.65 },
  }[preset];

  if (presetInterference) {
    oceanParams.backwashStrength = presetInterference.bw;
    oceanParams.sideWaveStrength = presetInterference.sw;

    const bwEl = document.getElementById('backwash-strength');
    const swEl = document.getElementById('sidewave-strength');
    if (bwEl) bwEl.value = presetInterference.bw;
    if (swEl) swEl.value = presetInterference.sw;

    document.getElementById('val-backwash').textContent = `${presetInterference.bw.toFixed(2)}x`;
    document.getElementById('val-sidewave-strength').textContent = `${presetInterference.sw.toFixed(2)}x`;
  }

  waveSolver.warmup(oceanParams, 300);
  spraySystem.warmup(oceanParams, waveSolver, 45);
  crowdSystem.populate(btyManager, oceanParams.tideLevel);
  syncUIAndTelemetry();
});

// Visualization Mode Selector
document.getElementById('viz-select').addEventListener('change', (e) => {
  const mode = e.target.value;
  oceanMat.wireframe = mode === 'wireframe';
  if (mode === 'realistic') oceanMat.uniforms.uVizMode.value = 0;
  else if (mode === 'xray') oceanMat.uniforms.uVizMode.value = 1;
  else if (mode === 'heatmap') oceanMat.uniforms.uVizMode.value = 2;
  else if (mode === 'wireframe') oceanMat.uniforms.uVizMode.value = 3;
});

// Camera Preset Selector
document.getElementById('camera-select').addEventListener('change', (e) => {
  applyCameraPreset(e.target.value);
});

// Simulation Speed Selector (0.25x Slow-Mo to 4.0x Fast-Forward, default 1.0x Real-Time)
const speedSelect = document.getElementById('speed-select');
if (speedSelect) {
  speedSelect.addEventListener('change', (e) => {
    oceanParams.timeScale = parseFloat(e.target.value) || 1.0;
    updateSetCountdownUI(true);
  });
}

// Pause Button
const pauseBtn = document.getElementById('pause-btn');
pauseBtn.addEventListener('click', () => {
  isPaused = !isPaused;
  pauseBtn.classList.toggle('active', isPaused);
  pauseBtn.textContent = isPaused ? '▶ Resume' : '⏸ Pause';
});

// Panel Collapse Buttons
document.querySelectorAll('.collapse-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const body = document.getElementById(btn.dataset.target);
    const panel = btn.closest('.panel');
    const isCollapsed = body.classList.toggle('collapsed');
    panel.classList.toggle('collapsed-panel', isCollapsed);
    btn.textContent = isCollapsed ? '+' : '−';
  });
});

// --- 3D Seabed Sculpting Brush Controls ---
const brushButtons = document.querySelectorAll('.brush-btn');
const brushSettings = document.getElementById('brush-settings');
const brushStatusBadge = document.getElementById('brush-status-badge');

brushButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    brushButtons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    brushState.mode = btn.dataset.brush;

    const isSculpting = brushState.mode !== 'none';
    controls.mouseButtons.LEFT = null;
    brushCursor.visible = isSculpting;
    brushSettings.classList.toggle('visible', isSculpting);

    const labels = {
      none: 'Orbit Mode',
      raise: 'Raise Reef/Bar',
      jetty: 'Build Jetty/Wall',
      lower: 'Dig Channel',
      smooth: 'Smooth Terrain',
    };
    brushStatusBadge.textContent = labels[brushState.mode];
  });
});

bindSlider('brush-radius', 'val-brush-radius', brushState, 'radius', (v) => `${v} m`, (v) => {
  brushCursor.scale.set(v, 1, v);
});
brushCursor.scale.set(brushState.radius, 1, brushState.radius);

bindSlider('brush-strength', 'val-brush-strength', brushState, 'strength', (v) => v.toFixed(1));

document.getElementById('reset-terrain-btn').addEventListener('click', () => {
  btyManager.resetSculpt();
  waveSolver.warmup(oceanParams, 180);
  spraySystem.warmup(oceanParams, waveSolver, 45);
  crowdSystem.populate(btyManager, oceanParams.tideLevel);
  syncUIAndTelemetry();
});

const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();

function updateBrushRaycast(event) {
  if (brushState.mode === 'none') return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNDC.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNDC.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointerNDC, camera);
  const hits = raycaster.intersectObject(btyManager.mesh);
  if (hits.length > 0) {
    brushState.hasHit = true;
    brushState.hitPoint.copy(hits[0].point);
    brushCursor.position.set(
      brushState.hitPoint.x,
      Math.max(brushState.hitPoint.y + 0.25, oceanParams.tideLevel + 0.25),
      brushState.hitPoint.z
    );
  } else {
    brushState.hasHit = false;
  }
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (brushState.mode !== 'none' && e.button === 0) {
    brushState.isPointerDown = true;
    updateBrushRaycast(e);
  }
});

window.addEventListener('pointermove', (e) => {
  if (brushState.mode !== 'none') {
    updateBrushRaycast(e);
  }
});

window.addEventListener('pointerup', () => {
  brushState.isPointerDown = false;
});

// --- Minecraft-style free-look: left-drag turns the view around the camera's own position ---
const freeLook = { dragging: false, lastX: 0, lastY: 0 };
const freeLookDir = new THREE.Vector3();

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || surferPov.active || brushState.mode !== 'none') return;
  freeLook.dragging = true;
  freeLook.lastX = e.clientX;
  freeLook.lastY = e.clientY;
  renderer.domElement.style.cursor = 'grabbing';
});

window.addEventListener('pointermove', (e) => {
  if (!freeLook.dragging) return;
  const dx = e.clientX - freeLook.lastX;
  const dy = e.clientY - freeLook.lastY;
  freeLook.lastX = e.clientX;
  freeLook.lastY = e.clientY;

  freeLookDir.subVectors(controls.target, camera.position);
  const dist = Math.max(3, freeLookDir.length());
  freeLookDir.normalize();

  let yaw = Math.atan2(freeLookDir.x, freeLookDir.z);
  let pitch = Math.asin(Math.max(-1, Math.min(1, freeLookDir.y)));
  yaw -= dx * 0.0042; // drag right -> look right
  pitch = Math.max(-1.5, Math.min(1.5, pitch - dy * 0.0042)); // drag down -> look down

  freeLookDir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  controls.target.copy(camera.position).addScaledVector(freeLookDir, dist);
});

window.addEventListener('pointerup', () => {
  if (freeLook.dragging) {
    freeLook.dragging = false;
    renderer.domElement.style.cursor = '';
  }
});

// --- WASD + Mouse-Click Drag Camera Navigation ---
const keyState = {
  KeyW: false,
  KeyA: false,
  KeyS: false,
  KeyD: false,
  KeyQ: false,
  KeyE: false,
  ArrowUp: false,
  ArrowDown: false,
  ArrowLeft: false,
  ArrowRight: false,
  ShiftLeft: false,
  ShiftRight: false,
};

const camMoveVelocity = new THREE.Vector3();
const camForward = new THREE.Vector3();
const camRight = new THREE.Vector3();
const worldUp = new THREE.Vector3(0, 1, 0);

window.addEventListener('keydown', (e) => {
  const tag = document.activeElement ? document.activeElement.tagName : '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (surferPov.active) {
    if (e.code === 'Space') {
      e.preventDefault();
      surferPov.takeOff(oceanParams);
    } else if (e.code === 'KeyC' || e.code === 'KeyV') {
      e.preventDefault();
      toggleSurfView();
    } else if (e.code === 'KeyM') {
      e.preventDefault();
      document.getElementById('surf-hud-map-card')?.classList.toggle('hidden');
    } else if (e.code === 'Escape') {
      exitSurfPov(true);
    }
  }
  if (e.code in keyState) {
    keyState[e.code] = true;
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code in keyState) {
    keyState[e.code] = false;
  }
});

window.addEventListener('blur', () => {
  Object.keys(keyState).forEach((k) => {
    keyState[k] = false;
  });
});

function updateWASDCamera(dt) {
  let moveZ = 0;
  let moveX = 0;
  let moveY = 0;

  if (keyState.KeyW || keyState.ArrowUp) moveZ += 1;
  if (keyState.KeyS || keyState.ArrowDown) moveZ -= 1;
  if (keyState.KeyD || keyState.ArrowRight) moveX += 1;
  if (keyState.KeyA || keyState.ArrowLeft) moveX -= 1;
  if (keyState.KeyE) moveY += 1;
  if (keyState.KeyQ) moveY -= 1;

  const baseSpeed = keyState.ShiftLeft || keyState.ShiftRight ? 95.0 : 42.0;

  camera.getWorldDirection(camForward);
  camForward.normalize();

  const horizForward = new THREE.Vector3(camForward.x, 0, camForward.z);
  if (horizForward.lengthSq() < 0.0001) {
    horizForward.set(0, 0, -1);
  } else {
    horizForward.normalize();
  }
  camRight.crossVectors(horizForward, worldUp).normalize();

  const desiredVel = new THREE.Vector3();
  desiredVel.addScaledVector(camForward, moveZ);
  desiredVel.addScaledVector(camRight, moveX);
  desiredVel.y += moveY;

  if (desiredVel.lengthSq() > 0) {
    desiredVel.normalize().multiplyScalar(baseSpeed);
  }

  camMoveVelocity.lerp(desiredVel, Math.min(1.0, dt * 10.0));

  if (camMoveVelocity.lengthSq() > 0.01) {
    const delta = camMoveVelocity.clone().multiplyScalar(dt);
    // Allow diving underwater down to -24m to inspect the 3D ground structure from any angle
    if (camera.position.y + delta.y < -24.0) {
      delta.y = Math.max(0, -24.0 - camera.position.y);
    }
    camera.position.add(delta);
    controls.target.add(delta);
  }
}

// --- Surfing Mode (1st-Person POV & 3rd-Person Low Bird-View) ---
const surferPov = new SurferPovController(scene, camera, controls, waveSolver, btyManager, spraySystem);
const surfHud = document.getElementById('surf-hud');
const surfHudSpeed = document.getElementById('surf-hud-speed');
const surfHudStatus = document.getElementById('surf-hud-status');
const surfViewToggleBtn = document.getElementById('surf-view-toggle-btn');
const cameraSelectEl = document.getElementById('camera-select');

function updateSurfViewButton() {
  if (!surfViewToggleBtn) return;
  const is3rd = surferPov.viewMode === 'third_person';
  surfViewToggleBtn.innerHTML = is3rd
    ? '📷 Switch to 1st Person <kbd style="font-size:10px;margin-left:4px">C</kbd>'
    : '🦅 Switch to Bird-View <kbd style="font-size:10px;margin-left:4px">C</kbd>';
  surfViewToggleBtn.title = is3rd
    ? 'Switch to First-Person Surf POV (Key: C or V)'
    : 'Switch to Third-Person Low Bird-View (Key: C or V)';
}

function enterSurfPov(viewMode = 'third_person') {
  if (surferPov.active) {
    if (viewMode && surferPov.viewMode !== viewMode) {
      surferPov.setViewMode(viewMode);
      cameraSelectEl.value = viewMode === 'third_person' ? 'surf_third' : 'surf_pov';
      updateSurfViewButton();
    }
    return;
  }
  surfHud.classList.remove('hidden');
  document.activeElement?.blur?.();
  surferPov.enable(oceanParams, viewMode);
  cameraSelectEl.value = viewMode === 'third_person' ? 'surf_third' : 'surf_pov';
  crowdSystem.setVisible?.(true);
  updateSurfViewButton();
}

function toggleSurfView() {
  if (!surferPov.active) return;
  const nextMode = surferPov.toggleViewMode();
  cameraSelectEl.value = nextMode === 'third_person' ? 'surf_third' : 'surf_pov';
  updateSurfViewButton();
}

function exitSurfPov(returnToOrbit) {
  surferPov.disable();
  surfHud.classList.add('hidden');
  if (returnToOrbit) {
    cameraSelectEl.value = 'overview';
    applyCameraPreset('overview');
  }
}

const hudMinimapCanvas = document.getElementById('surf-hud-minimap');
const surfHudMapCard = document.getElementById('surf-hud-map-card');
const surfHudDepthTag = document.getElementById('surf-hud-depth-tag');
const playerTrail = [];
let lastTrailTime = 0;

function updateSurfHud() {
  surfHudSpeed.textContent = `${surferPov.speed.toFixed(1)} m/s (${(surferPov.speed * 1.94384).toFixed(1)} kts)`;
  if (surfHudStatus.textContent !== surferPov.statusLabel) surfHudStatus.textContent = surferPov.statusLabel;
  surfHudStatus.classList.toggle('in-barrel', surferPov.isInBarrel);

  if (surfHudDepthTag) {
    const samp = btyManager.sampleAt(surferPov.pos.x, surferPov.pos.z);
    const d = Math.max(0, (oceanParams.tideLevel ?? 0.2) - samp.elevation);
    surfHudDepthTag.textContent = d > 0.05 ? `Depth: ${d.toFixed(1)}m` : 'On Shore';
  }
}

document.getElementById('surf-third-btn')?.addEventListener('click', () => enterSurfPov('third_person'));
document.getElementById('surf-pov-btn').addEventListener('click', () => enterSurfPov('first_person'));
document.getElementById('surf-view-toggle-btn')?.addEventListener('click', toggleSurfView);
document.getElementById('surf-exit-btn').addEventListener('click', () => exitSurfPov(true));
document.getElementById('surf-dropin-btn').addEventListener('click', () => {
  playerTrail.length = 0;
  surferPov.resetToLineup(oceanParams, true);
});
renderer.domElement.addEventListener('pointerdown', (e) => surferPov.onPointerDown(e));
window.addEventListener('pointermove', (e) => surferPov.onPointerMove(e));
window.addEventListener('pointerup', () => surferPov.onPointerUp());

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Pre-warm the 2D Shallow-Water PDE Solver so waves are already propagating across the surf zone
waveSolver.warmup(oceanParams, 220);
spraySystem.warmup(oceanParams, waveSolver, 45);
crowdSystem.populate(btyManager, oceanParams.tideLevel);
syncUIAndTelemetry();

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
    updateSetCountdownUI();
  }

  if (brushState.mode !== 'none' && brushState.isPointerDown && brushState.hasHit) {
    const changed = btyManager.applyBrush(
      brushState.hitPoint.x,
      brushState.hitPoint.z,
      brushState.mode,
      brushState.radius,
      brushState.strength,
      dt
    );
    if (changed) {
      crowdSystem.populate(btyManager, oceanParams.tideLevel);
      syncUIAndTelemetry();
    }
  }

  if (surferPov.active) {
    if (!isPaused) {
      surferPov.update(dt * (oceanParams.timeScale ?? 1.0), keyState, oceanParams);
    }
    updateSurfHud();
  } else {
    updateWASDCamera(dt);
  }

  // Track player position trail for minimap
  const now = clock.getElapsedTime();
  if (surferPov.active) {
    if (now - lastTrailTime > 0.06) {
      lastTrailTime = now;
      playerTrail.push({ x: surferPov.pos.x, z: surferPov.pos.z });
      if (playerTrail.length > 32) playerTrail.shift();
    }
  } else if (playerTrail.length > 0) {
    playerTrail.length = 0;
  }

  // Real-time Bathymetry Depth Map with player location
  const playerMinimapData = {
    x: surferPov.pos.x,
    z: surferPov.pos.z,
    yaw: surferPov.yaw,
    active: surferPov.active,
    trail: playerTrail,
  };

  btyManager.renderMinimap(
    minimapCanvas,
    oceanParams.tideLevel,
    oceanParams.swellDir,
    playerMinimapData
  );

  if (surferPov.active && hudMinimapCanvas && !surfHudMapCard?.classList.contains('hidden')) {
    btyManager.renderMinimap(
      hudMinimapCanvas,
      oceanParams.tideLevel,
      oceanParams.swellDir,
      playerMinimapData
    );
  }

  if (controls.enabled) {
    controls.update();
  }

  oceanMat.uniforms.uCameraPos.value.copy(camera.position);
  renderer.render(scene, camera);
}

window.__debug = { camera, controls, surferPov, oceanParams, waveSolver, btyManager, scene };

animate();
