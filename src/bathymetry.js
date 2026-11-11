import * as THREE from 'three';

export const WORLD_SIZE = 600; // 600m x 600m domain (4x area expansion)
export const BTY_RES = 180;    // 180x180 bathymetry simulation grid

// Spline samples extracted from reference bathymetry drawing across u in [0, 1]
export const COAST_SAMPLES = [
  0.824, 0.824, 0.824, 0.824, 0.824, 0.824, 0.823, 0.821, 0.821, 0.81, 0.792,
  0.772, 0.748, 0.725, 0.697, 0.671, 0.641, 0.612, 0.584, 0.544, 0.505, 0.45,
  0.391, 0.344, 0.324, 0.319, 0.328, 0.352, 0.453, 0.641, 0.695, 0.709, 0.718
];
export const REEF_SAMPLES = [
  0.701, 0.701, 0.696, 0.691, 0.69, 0.688, 0.682, 0.675, 0.661, 0.647, 0.626,
  0.599, 0.571, 0.535, 0.493, 0.444, 0.396, 0.356, 0.321, 0.289, 0.272, 0.261,
  0.254, 0.25, 0.25, 0.26, 0.278, 0.3, 0.339, 0.554, 0.651, 0.675, 0.687
];
export const SHELF_SAMPLES = [
  0.587, 0.587, 0.58, 0.57, 0.56, 0.54, 0.51, 0.47, 0.42, 0.37, 0.32,
  0.27, 0.23, 0.20, 0.18, 0.17, 0.16, 0.155, 0.15, 0.145, 0.14, 0.135,
  0.132, 0.13, 0.13, 0.135, 0.14, 0.15, 0.18, 0.25, 0.38, 0.48, 0.52
];

export function evalCurve(samples, u) {
  const n = samples.length - 1;
  const clampedU = Math.max(0, Math.min(1, u));
  const t = clampedU * n;
  const i0 = Math.floor(t);
  const frac = t - i0;
  if (i0 >= n) return samples[n];

  const p0 = samples[Math.max(0, i0 - 1)];
  const p1 = samples[i0];
  const p2 = samples[Math.min(n, i0 + 1)];
  const p3 = samples[Math.min(n, i0 + 2)];

  const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
  const b = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3;
  const c = -0.5 * p0 + 0.5 * p2;
  const d = p1;

  return ((a * frac + b) * frac + c) * frac + d;
}

function hash2(x, y) {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return h - Math.floor(h);
}

function noise2D(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3.0 - 2.0 * fx);
  const uy = fy * fy * (3.0 - 2.0 * fy);

  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);

  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(x, y, octaves = 4) {
  let val = 0;
  let amp = 0.5;
  let freq = 1.0;
  for (let i = 0; i < octaves; i++) {
    val += amp * (noise2D(x * freq, y * freq) * 2.0 - 1.0);
    freq *= 2.03;
    amp *= 0.5;
  }
  return val;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Smoothly caps underwater shoaling features so they stay submerged below wave troughs
function softCapUnderwater(h, maxElev) {
  if (h <= maxElev - 0.8) return h;
  const excess = h - (maxElev - 0.8);
  return (maxElev - 0.8) + Math.tanh(excess) * 0.8;
}

export class BathymetryManager {
  constructor(scene) {
    this.scene = scene;
    this.preset = 'right_point';
    this.params = {
      seabedSlope: 1.0,
      reefProminence: 1.15,
      reefAngle: 0,
      channelDepth: 1.0,
    };

    this.baseElevation = new Float32Array(BTY_RES * BTY_RES);
    this.sculptOffset = new Float32Array(BTY_RES * BTY_RES);
    this.elevation = new Float32Array(BTY_RES * BTY_RES);
    this.breakerStage = new Float32Array(BTY_RES * BTY_RES);
    this.phaseDelay = new Float32Array(BTY_RES * BTY_RES);
    this.slope = new Float32Array(BTY_RES * BTY_RES);
    this.gradX = new Float32Array(BTY_RES * BTY_RES);

    this.texData = new Float32Array(BTY_RES * BTY_RES * 4);
    this.texture = new THREE.DataTexture(
      this.texData,
      BTY_RES,
      BTY_RES,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;

    // Minimap offscreen cache for smooth real-time player tracking
    this.minimapOffscreen = null;
    this.minimapDirty = true;
    this.minimapVersion = 1;
    this.lastTideLevel = null;
    this.lastSwellDir = null;

    this.createTerrainMesh();
    this.generatePreset(this.preset);
  }

  createTerrainMesh() {
    const geom = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, BTY_RES - 1, BTY_RES - 1);
    geom.rotateX(-Math.PI / 2);

    const count = geom.attributes.position.count;
    const colors = new Float32Array(count * 3);
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.78,
      metalness: 0.05,
      flatShading: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geom, mat);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.scene.add(this.mesh);
  }

  resetSculpt() {
    this.sculptOffset.fill(0);
    this.generatePreset(this.preset);
  }

  generatePreset(presetName) {
    this.preset = presetName;
    const { seabedSlope, reefProminence, reefAngle, channelDepth } = this.params;
    const angleRad = (reefAngle * Math.PI) / 180;
    const cosA = Math.cos(angleRad);
    const sinA = Math.sin(angleRad);

    for (let j = 0; j < BTY_RES; j++) {
      const v = j / (BTY_RES - 1);
      const z = (v - 0.5) * WORLD_SIZE; // -150 (offshore) to +150 (shore)

      for (let i = 0; i < BTY_RES; i++) {
        const u = i / (BTY_RES - 1);
        const x = (u - 0.5) * WORLD_SIZE;
        const idx = j * BTY_RES + i;

        const rx = x * cosA - z * sinA;
        const rz = x * sinA + z * cosA;

        const normZ = (z + WORLD_SIZE * 0.5) / WORLD_SIZE;
        const rockNoise = fbm(x * 0.02, z * 0.02, 3);
        const fineNoise = fbm(x * 0.05, z * 0.05, 2) * 0.25;

        // Base coastal shelf profile
        let h = -12.5 * Math.pow(1.0 - normZ, 1.15 * seabedSlope) - 1.6;
        let isAboveWaterStructure = false;

        if (presetName === 'right_point') {
          // RIGHT POINT BREAK MATCHING REFERENCE BATHYMETRY DRAWING:
          // Expanded 600m x 600m domain with 4 color-depth zones:
          // 1. Deep Ocean (v < sv)
          // 2. Mid-Depth Shelf (sv <= v < rv)
          // 3. Shallow Peeling Reef (rv <= v < cv)
          // 4. Headland Hill & Shore (v >= cv)
          const cv = evalCurve(COAST_SAMPLES, u);
          const rv = evalCurve(REEF_SAMPLES, u);
          const sv = evalCurve(SHELF_SAMPLES, u);

          if (v >= cv) {
            // Above-water headland hill & sandy shoreline
            const distLand = (v - cv) * WORLD_SIZE;
            const isHeadland = smoothstep(0.40, 0.76, u) * smoothstep(0.96, 0.78, u);
            const landElev = smoothstep(0.0, 42.0, distLand) * (6.5 + 20.0 * isHeadland) + Math.abs(rockNoise) * (0.4 + 2.2 * isHeadland);
            if (distLand > 1.2) isAboveWaterStructure = true;
            h = -0.4 + landElev;
          } else if (v >= rv) {
            // Shallow breaking reef shelf (cyan band)
            const tReef = (v - rv) / Math.max(0.001, cv - rv);
            const apexProximity = Math.exp(-((u - 0.76) * (u - 0.76)) / (2 * 0.09 * 0.09));
            h = -3.0 + 2.45 * Math.pow(tReef, 0.85) * reefProminence + apexProximity * 0.45 * reefProminence + fineNoise * 0.25;
            h = softCapUnderwater(h, -0.65);
          } else if (v >= sv) {
            // Mid-depth ocean shelf (blue band)
            const tMid = (v - sv) / Math.max(0.001, rv - sv);
            h = -8.2 + 5.2 * smoothstep(0.0, 1.0, tMid) * seabedSlope + fineNoise * 0.15;
          } else {
            // Deep offshore ocean (navy band)
            const tDeep = Math.max(0.0, Math.min(1.0, v / Math.max(0.001, sv)));
            h = -16.0 + 7.8 * tDeep * seabedSlope;
          }
        } else if (presetName === 'left_point') {
          // LEFT POINT BREAK (e.g., Raglan / Chicama / Mundaka):
          // Surfer rides toward +z (shore), peeling to surfer's LEFT (+x).
          const shoreCurveZ = 66 - 118 * smoothstep(30, -105, x) + Math.sin(x * 0.035) * 3.5;

          const shoreRamp = 3.4 * smoothstep(shoreCurveZ - 52, shoreCurveZ - 6, z);
          h += shoreRamp;

          if (z > shoreCurveZ - 16) {
            const landProgress = smoothstep(shoreCurveZ - 14, shoreCurveZ + 42, z);
            const isHeadland = smoothstep(5, -68, x);
            const landElev = landProgress * (5.2 + 14.5 * isHeadland) + rockNoise * (0.4 + 1.8 * isHeadland);
            if (z > shoreCurveZ - 2) isAboveWaterStructure = true;
            h = Math.max(h, -1.4 + landElev);
          }

          // Submerged diagonal cobblestone/reef point shelf wrapping from (x=-60, z=-48) to (x=+45, z=+48)
          const barAxisZ = -45 + (60 + rx) * 0.85;
          const distFromBar = rz - barAxisZ;
          const barWidth = distFromBar < 0 ? 18.0 : 32.0;
          const pointBarMask =
            Math.exp(-(distFromBar * distFromBar) / (2 * barWidth * barWidth)) *
            smoothstep(70, 0, x) *
            smoothstep(-125, -40, x);

          const barRise = 4.8 * reefProminence * pointBarMask;
          const bayChannel = -2.8 * channelDepth * smoothstep(-25, 45, x) * smoothstep(52, -45, z);

          if (!isAboveWaterStructure) {
            h += barRise + bayChannel + fineNoise * 0.5;
            h = softCapUnderwater(h, -1.15);
          }
        } else if (presetName === 'jetty_wedge') {
          // ROCK JETTY & SANDBAR WEDGE (e.g., Newport Wedge / Sebastian Inlet):
          // Angled boulder rock jetty extending from offshore (x = -74, z = -55) to the beach (x = -18, z = +68)
          const jettyCenterX = -52 + (z + 5) * 0.36;
          const distToJetty = Math.abs(x - jettyCenterX);
          const onJettyLength = smoothstep(-62, -48, z) * smoothstep(135, 105, z);

          // Diagonal sandbar wedge accumulated on the surf side (+x side) of the jetty from z=-42 to z=+55
          const distFromJettyRight = x - jettyCenterX;
          const wedgeBarZ = -38 + distFromJettyRight * 0.72;
          const zFromWedge = z - wedgeBarZ;
          const barWidth = zFromWedge < 0 ? 20.0 : 34.0;
          const filletEnvelope =
            smoothstep(-2, 10, distFromJettyRight) *
            Math.exp(-(distFromJettyRight * distFromJettyRight) / (2 * 56 * 56)) *
            Math.exp(-(zFromWedge * zFromWedge) / (2 * barWidth * barWidth));

          const sandFillet = 7.4 * reefProminence * filletEnvelope;

          // Calm harbor channel on the sheltered lee side (-x side) behind the jetty
          const harborChannel = -4.2 * channelDepth * smoothstep(jettyCenterX + 4, jettyCenterX - 22, x);

          // Steep reflective sandy shorebreak on the surf side (x > jettyCenterX)
          const beachShoreZ = 64 - 10 * Math.exp(-(distFromJettyRight * distFromJettyRight) / (2 * 48 * 48));
          const shoreRamp = 3.2 * smoothstep(beachShoreZ - 48, beachShoreZ - 8, z) * smoothstep(jettyCenterX - 4, jettyCenterX + 6, x);
          const beachRise =
            9.5 *
            smoothstep(beachShoreZ - 14, beachShoreZ + 38, z) *
            smoothstep(jettyCenterX - 2, jettyCenterX + 8, x);

          h += sandFillet + harborChannel + shoreRamp + fineNoise * 0.5;
          if (z < beachShoreZ - 8) {
            h = softCapUnderwater(h, -1.15);
          }
          h += beachRise;

          // Solid rock boulder jetty wall rising +5.2m above sea level
          if (distToJetty < 11.5 && onJettyLength > 0.05) {
            const jettyProfile = smoothstep(11.0, 4.2, distToJetty) * onJettyLength;
            const boulderRugosity = Math.abs(rockNoise) * 1.4;
            const jettyElev = -3.0 + (8.2 + boulderRugosity) * jettyProfile;
            if (jettyElev > h) {
              h = jettyElev;
              if (h > -0.4) isAboveWaterStructure = true;
            }
          }
        } else if (presetName === 'reef_pass') {
          // BARRIER REEF PASS & DEEP CHANNEL (e.g., Teahupo'o / Cloudbreak / Pipeline):
          // Deep submarine canyon / pass channel on the left (x in [-95, -15], depth -11m)
          // next to an abrupt, shallow diagonal coral reef shelf on the right (x in [-5, +95], depth -1.25m)
          const passChannelMask =
            smoothstep(12, -25, x) *
            smoothstep(-115, -75, x) *
            smoothstep(58, -90, z);

          // Diagonal barrier reef shelf edge starting at (x=+70, z=-48) and peeling left toward the pass (x=-5, z=+22)
          const reefFrontZ = -46 + Math.max(0, 70 - rx) * 0.68;
          const onReefShelf =
            smoothstep(reefFrontZ - 14, reefFrontZ + 6, rz) *
            smoothstep(48, 18, rz) *
            smoothstep(-12, 12, rx) *
            smoothstep(120, 80, rx);

          const reefTable = 7.6 * reefProminence * onReefShelf + Math.abs(fineNoise) * 0.45 * onReefShelf;
          const deepPassCut = -4.2 * channelDepth * passChannelMask;
          const islandRamp = 3.2 * smoothstep(22, 64, z);
          const islandShore = 9.5 * smoothstep(64, 135, z);

          h += reefTable + deepPassCut + islandRamp;
          if (z < 64) {
            h = softCapUnderwater(h, -1.15);
          }
          h += islandShore;
        } else if (presetName === 'aframe_reef') {
          // A-FRAME REEF PEAK (e.g., Lower Trestles / Uluwatu Peak):
          // Prominent V-shaped submerged reef ridge at x = 0 pointing offshore (z = -46),
          // peeling both LEFT (+x) and RIGHT (-x) into deeper channels on both sides (|x| > 55).
          const distFromApex = Math.abs(rx);
          const reefZCenter = -44 + distFromApex * 0.85;
          const zDiff = rz - reefZCenter;
          const barWidth = zDiff < 0 ? 18.0 : 32.0;
          const reefEnvelope =
            Math.exp(-(zDiff * zDiff) / (2 * barWidth * barWidth)) *
            Math.exp(-(distFromApex * distFromApex) / (2 * 52 * 52));

          const reefHeight = 7.5 * reefProminence * reefEnvelope;
          const channelCut = -3.0 * channelDepth * smoothstep(30, 82, Math.abs(x));
          const shoreRamp = 3.2 * smoothstep(18, 62, z);
          const beachRise = 9.5 * smoothstep(62, 135, z);

          h += reefHeight + channelCut + shoreRamp + fineNoise * 0.5;
          if (z < 62) {
            h = softCapUnderwater(h, -1.15);
          }
          h += beachRise;
        } else if (presetName === 'beach_break') {
          // BEACH BREAK — CRESCENT SANDBARS & RIP CHANNELS (e.g., Hossegor / Supertubos):
          // Two shallow V-shaped sandbar banks centered at x = -48 and x = +48 starting at z = -36,
          // separated by a deep central rip-current channel at x = 0.
          const leftApexDist = Math.abs(rx + 48);
          const leftBarZ = -34 + leftApexDist * 0.80;
          const leftZDiff = rz - leftBarZ;

          const rightApexDist = Math.abs(rx - 48);
          const rightBarZ = -34 + rightApexDist * 0.80;
          const rightZDiff = rz - rightBarZ;

          const sandbars =
            7.2 *
            reefProminence *
            (Math.exp(-(leftZDiff * leftZDiff) / (2 * 24 * 24)) * Math.exp(-(leftApexDist * leftApexDist) / (2 * 36 * 36)) +
              Math.exp(-(rightZDiff * rightZDiff) / (2 * 24 * 24)) * Math.exp(-(rightApexDist * rightApexDist) / (2 * 36 * 36)));

          // Deep central rip current channel scoured out at x = 0
          const centralRip = -3.2 * channelDepth * Math.exp(-(x * x) / (2 * 18 * 18)) * smoothstep(55, -45, z);
          const shoreRamp = 3.2 * smoothstep(12, 60, z);
          const beachDunes = 9.8 * smoothstep(60, 135, z) + rockNoise * 0.8 * smoothstep(75, 135, z);

          h += sandbars + centralRip + shoreRamp + fineNoise * 0.5;
          if (z < 60) {
            h = softCapUnderwater(h, -1.15);
          }
          h += beachDunes;
        } else if (presetName === 'rivermouth') {
          // RIVER MOUTH ESTUARY & DELTA SANDBAR (e.g., Mundaka / Rivermouth):
          // A river channel cuts through the coastal bluffs around x = -48, scouring a deep outflow channel
          // and depositing a long diagonal cobblestone/sand delta bar from (x=-10, z=-44) to (x=+70, z=+48).
          const riverPathX = -48 + Math.sin(z * 0.03) * 10.0;
          const distToRiver = Math.abs(x - riverPathX);
          const riverChannelCut = -5.2 * channelDepth * Math.exp(-(distToRiver * distToRiver) / (2 * 18 * 18));

          // Diagonal offshore delta sandbar deposited to the right of the river outflow
          const barCurveZ = -42 + Math.max(0, rx + 10) * 0.85;
          const distToDeltaBar = rz - barCurveZ;
          const barWidth = distToDeltaBar < 0 ? 18.0 : 32.0;
          const deltaBar =
            7.4 *
            reefProminence *
            Math.exp(-(distToDeltaBar * distToDeltaBar) / (2 * barWidth * barWidth)) *
            smoothstep(-22, 5, x) *
            smoothstep(110, 60, x);

          // Coastal bluffs on either side of the river estuary mouth
          const bluffMask = smoothstep(16, 36, distToRiver);
          const shoreRamp = 3.0 * smoothstep(12, 58, z) * bluffMask;
          const shoreRise = (10.5 * bluffMask + 1.8 * (1.0 - bluffMask)) * smoothstep(58, 135, z);

          h += deltaBar + riverChannelCut + shoreRamp + fineNoise * 0.5;
          if (z < 58 || distToRiver < 20) {
            h = softCapUnderwater(h, -1.15);
          }
          if (distToRiver >= 20) {
            h += shoreRise;
          }
        }

        this.baseElevation[idx] = h;
      }
    }

    this.recomputeDerivedFields();
  }

  applyBrush(worldX, worldZ, mode, radius, strength, dt) {
    if (mode === 'none') return false;
    let modified = false;
    const prevSculpt = mode === 'smooth' ? new Float32Array(this.sculptOffset) : null;

    for (let j = 0; j < BTY_RES; j++) {
      const z = (j / (BTY_RES - 1) - 0.5) * WORLD_SIZE;
      if (Math.abs(z - worldZ) > radius) continue;

      for (let i = 0; i < BTY_RES; i++) {
        const x = (i / (BTY_RES - 1) - 0.5) * WORLD_SIZE;
        const dist = Math.hypot(x - worldX, z - worldZ);
        if (dist > radius) continue;

        const idx = j * BTY_RES + i;
        const falloff = Math.pow(1.0 - dist / radius, 2.0);

        if (mode === 'raise') {
          const targetMax = Math.max(0, -1.35 - this.baseElevation[idx]);
          this.sculptOffset[idx] = Math.min(targetMax, this.sculptOffset[idx] + strength * 5.5 * falloff * dt);
          modified = true;
        } else if (mode === 'jetty') {
          const targetMax = 5.2 - this.baseElevation[idx];
          this.sculptOffset[idx] = Math.min(targetMax, this.sculptOffset[idx] + strength * 10.0 * falloff * dt);
          modified = true;
        } else if (mode === 'lower') {
          this.sculptOffset[idx] = Math.max(-10.0, this.sculptOffset[idx] - strength * 5.5 * falloff * dt);
          modified = true;
        } else if (mode === 'smooth' && i > 0 && i < BTY_RES - 1 && j > 0 && j < BTY_RES - 1) {
          const avg =
            (prevSculpt[idx - 1] +
              prevSculpt[idx + 1] +
              prevSculpt[idx - BTY_RES] +
              prevSculpt[idx + BTY_RES]) *
            0.25;
          this.sculptOffset[idx] += (avg - prevSculpt[idx]) * Math.min(1.0, strength * 5.0 * falloff * dt);
          modified = true;
        }
      }
    }

    if (modified) {
      this.recomputeDerivedFields();
    }
    return modified;
  }

  recomputeDerivedFields() {
    this.minimapDirty = true;
    this.minimapVersion = 1;
    const cellStep = WORLD_SIZE / (BTY_RES - 1);

    // 1. Combine base elevation + sculpt offset
    for (let k = 0; k < BTY_RES * BTY_RES; k++) {
      this.elevation[k] = this.baseElevation[k] + this.sculptOffset[k];
    }

    // 2. Gentle hydrodynamic smoothing pass
    const tempElev = new Float32Array(this.elevation);
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 1; j < BTY_RES - 1; j++) {
        for (let i = 1; i < BTY_RES - 1; i++) {
          const idx = j * BTY_RES + i;
          this.elevation[idx] =
            tempElev[idx] * 0.64 +
            (tempElev[idx - 1] + tempElev[idx + 1] + tempElev[idx - BTY_RES] + tempElev[idx + BTY_RES]) * 0.09;
        }
      }
      tempElev.set(this.elevation);
    }

    // 3. Compute gradients & seabed slope
    for (let j = 0; j < BTY_RES; j++) {
      const jm = Math.max(0, j - 1);
      const jp = Math.min(BTY_RES - 1, j + 1);
      const dz = (jp - jm) * cellStep;

      for (let i = 0; i < BTY_RES; i++) {
        const im = Math.max(0, i - 1);
        const ip = Math.min(BTY_RES - 1, i + 1);
        const dx = (ip - im) * cellStep;

        const idx = j * BTY_RES + i;
        const dhdx = (this.elevation[j * BTY_RES + ip] - this.elevation[j * BTY_RES + im]) / dx;
        const dhdz = (this.elevation[jp * BTY_RES + i] - this.elevation[jm * BTY_RES + i]) / dz;

        this.gradX[idx] = dhdx;
        const forwardSlope = Math.max(0.01, dhdz);
        const totalMag = Math.hypot(dhdx, dhdz);
        this.slope[idx] = Math.min(0.45, Math.max(0.015, forwardSlope * 0.7 + totalMag * 0.3));
      }
    }

    // 4. Compute Cumulative Wave Refraction Delay & Contour-Specific Breaker Stage
    // Waves ONLY accumulate breaking progress when passing over shallow shoals (depth < 3.6m),
    // and reform quickly in deep channels (depth > 4.0m) so point breaks, reef passes, and rip channels look distinct!
    const delayBuffer = new Float32Array(BTY_RES * BTY_RES);
    const stageBuffer = new Float32Array(BTY_RES * BTY_RES);
    const refDepth = 12.0;

    for (let j = 1; j < BTY_RES; j++) {
      for (let i = 0; i < BTY_RES; i++) {
        const idx = j * BTY_RES + i;
        const prevIdx = (j - 1) * BTY_RES + i;
        const h = this.elevation[idx];
        const depth = Math.max(0.8, -h);

        // Wave refraction delay over shallow contours (bends crests toward point/reef)
        const slowness = Math.min(0.36, Math.max(0.0, Math.sqrt(refDepth / Math.min(refDepth, depth)) - 1.0) * 0.20);
        delayBuffer[idx] = delayBuffer[prevIdx] + slowness * cellStep;

        let prevStage = stageBuffer[prevIdx];
        if (depth < 3.65) {
          // Shallow reef/point/sandbar triggers shoaling & breaking
          const shallowDrive = Math.pow((3.65 - depth) / 2.1, 1.35);
          prevStage += shallowDrive * cellStep * 0.028;
        } else if (depth > 4.0) {
          // Deep channel or inside reform trough: wave stays unbroken / reforms rapidly
          prevStage = Math.max(0, prevStage - cellStep * 0.025);
        }
        stageBuffer[idx] = Math.min(1.5, prevStage);
      }

      // Lateral Huygens smoothing pass per row
      for (let pass = 0; pass < 3; pass++) {
        for (let i = 1; i < BTY_RES - 1; i++) {
          const idx = j * BTY_RES + i;
          delayBuffer[idx] = delayBuffer[idx] * 0.54 + (delayBuffer[idx - 1] + delayBuffer[idx + 1]) * 0.23;
          stageBuffer[idx] = stageBuffer[idx] * 0.54 + (stageBuffer[idx - 1] + stageBuffer[idx + 1]) * 0.23;
        }
      }
    }

    this.phaseDelay.set(delayBuffer);
    this.breakerStage.set(stageBuffer);

    // 5. Upload RGBA Float Texture & Update 3D Terrain Mesh Colors
    const posAttr = this.mesh.geometry.attributes.position;
    const colAttr = this.mesh.geometry.attributes.color;

    for (let k = 0; k < BTY_RES * BTY_RES; k++) {
      const h = this.elevation[k];
      const sl = this.slope[k];

      const k4 = k * 4;
      this.texData[k4 + 0] = h;
      this.texData[k4 + 1] = this.breakerStage[k];
      this.texData[k4 + 2] = this.phaseDelay[k];
      this.texData[k4 + 3] = sl;

      posAttr.setY(k, h);

      let r, g, b;
      if (h < -6.0) {
        // Deep channel / offshore floor: rich marine blue-teal
        const t = Math.max(0, Math.min(1, (h + 16.0) / 10.0));
        r = 0.05 + t * 0.08;
        g = 0.16 + t * 0.16;
        b = 0.28 + t * 0.18;
      } else if (h < -0.3) {
        // Shallow shoaling sandbar / reef shelf (-6.0m to -0.3m) — bright high-contrast sand/coral tones
        const t = Math.pow((h + 6.0) / 5.7, 1.15);
        const isReefy =
          this.preset === 'reef_pass' ||
          this.preset === 'aframe_reef' ||
          sl > 0.18;
        if (isReefy) {
          r = 0.16 + t * 0.36;
          g = 0.30 + t * 0.34;
          b = 0.34 + t * 0.22;
        } else {
          // Warm submerged golden sandbar
          r = 0.22 + t * 0.52;
          g = 0.32 + t * 0.38;
          b = 0.30 + t * 0.16;
        }
      } else if (h < 1.8) {
        // Wet & dry sandy beach (or rock jetty base)
        if (this.preset === 'jetty_wedge' && sl > 0.22) {
          // Dark granite jetty boulders
          r = 0.32;
          g = 0.33;
          b = 0.35;
        } else {
          const t = (h + 0.3) / 2.1;
          r = 0.64 + t * 0.20;
          g = 0.56 + t * 0.18;
          b = 0.40 + t * 0.14;
        }
      } else if (h < 6.0) {
        // Rocky cliffs / jetty boulders / coastal bluffs
        if (this.preset === 'jetty_wedge' && sl > 0.18) {
          r = 0.38;
          g = 0.39;
          b = 0.41;
        } else {
          const t = (h - 1.8) / 4.2;
          r = 0.50 - t * 0.14;
          g = 0.46 - t * 0.09;
          b = 0.36 - t * 0.10;
        }
      } else {
        // High headland coastal vegetation & scrub
        const t = Math.min(1, (h - 6.0) / 9.0);
        r = 0.24 - t * 0.05;
        g = 0.39 + t * 0.06;
        b = 0.22 - t * 0.04;
      }

      // Add subtle underwater topographic contour lines every 1.5m so ground structure is clearly readable
      if (h < -0.4 && Math.abs((Math.abs(h) % 1.5) - 0.75) < 0.08) {
        r = Math.min(1.0, r + 0.09);
        g = Math.min(1.0, g + 0.12);
        b = Math.min(1.0, b + 0.14);
      }

      colAttr.setXYZ(k, r, g, b);
    }

    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.texture.needsUpdate = true;
  }

  sampleAt(worldX, worldZ) {
    const u = Math.max(0, Math.min(0.999, worldX / WORLD_SIZE + 0.5));
    const v = Math.max(0, Math.min(0.999, worldZ / WORLD_SIZE + 0.5));

    const gx = u * (BTY_RES - 1);
    const gz = v * (BTY_RES - 1);
    const i0 = Math.floor(gx);
    const j0 = Math.floor(gz);
    const i1 = Math.min(BTY_RES - 1, i0 + 1);
    const j1 = Math.min(BTY_RES - 1, j0 + 1);
    const fx = gx - i0;
    const fz = gz - j0;

    const idx00 = j0 * BTY_RES + i0;
    const idx10 = j0 * BTY_RES + i1;
    const idx01 = j1 * BTY_RES + i0;
    const idx11 = j1 * BTY_RES + i1;

    const bilerp = (arr) => {
      const a = arr[idx00] * (1 - fx) + arr[idx10] * fx;
      const b = arr[idx01] * (1 - fx) + arr[idx11] * fx;
      return a * (1 - fz) + b * fz;
    };

    return {
      elevation: bilerp(this.elevation),
      breakerStage: bilerp(this.breakerStage),
      phaseDelay: bilerp(this.phaseDelay),
      slope: bilerp(this.slope),
      gradX: bilerp(this.gradX),
    };
  }

  renderMinimap(canvas, tideLevel, swellDirDeg, playerInfo = null) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    const btyVersion = this.minimapVersion || 0;
    // Check if background depth map needs to be recomputed for this canvas
    if (
      !canvas._minimapOffscreen ||
      canvas._minimapOffscreen.width !== w ||
      canvas._minimapOffscreen.height !== h ||
      canvas._lastBtyVersion !== btyVersion ||
      canvas._lastTideLevel !== tideLevel ||
      canvas._lastSwellDir !== swellDirDeg
    ) {
      if (!canvas._minimapOffscreen) {
        canvas._minimapOffscreen = document.createElement('canvas');
      }
      canvas._minimapOffscreen.width = w;
      canvas._minimapOffscreen.height = h;
      const offCtx = canvas._minimapOffscreen.getContext('2d');
      const imgData = offCtx.createImageData(w, h);
      const data = imgData.data;

      for (let py = 0; py < h; py++) {
        const v = py / (h - 1);
        const fvFull = v * (BTY_RES - 1);
        const j0 = Math.floor(fvFull);
        const j1 = Math.min(BTY_RES - 1, j0 + 1);
        const fv = fvFull - j0;

        for (let px = 0; px < w; px++) {
          const u = px / (w - 1);
          const fuFull = u * (BTY_RES - 1);
          const i0 = Math.floor(fuFull);
          const i1 = Math.min(BTY_RES - 1, i0 + 1);
          const fu = fuFull - i0;

          const e00 = this.elevation[j0 * BTY_RES + i0];
          const e10 = this.elevation[j0 * BTY_RES + i1];
          const e01 = this.elevation[j1 * BTY_RES + i0];
          const e11 = this.elevation[j1 * BTY_RES + i1];
          const elev = (e00 * (1 - fu) + e10 * fu) * (1 - fv) + (e01 * (1 - fu) + e11 * fu) * fv;
          const depth = tideLevel - elev;

          let r = 14, g = 2, b = 78;

          if (depth <= 0.0) {
            // Dry land / beach
            const landDist = -depth;
            if (landDist < 0.65 || py >= h - 6) {
              // Warm golden shoreline sand
              r = 185;
              g = 170;
              b = 95;
            } else {
              // Olive green headland hill terrain (matches reference drawing)
              r = 108;
              g = 135;
              b = 67;
            }
          } else if (depth < 3.3) {
            // Shallow breaking shelf / reef: luminous electric cyan (matches reference drawing)
            r = 0;
            g = 219;
            b = 248;
          } else if (depth < 8.2) {
            // Mid-depth oceanic band (matches reference drawing)
            r = 0;
            g = 64;
            b = 133;
          } else {
            // Deep offshore ocean: dark indigo navy (matches reference drawing)
            r = 14;
            g = 2;
            b = 78;

            // Subtle isobath contour rings (depth interval 2.5m)
            const contourStep = 2.5;
            const frac = (depth % contourStep) / contourStep;
            const dist = Math.min(frac, 1.0 - frac) * contourStep;
            if (dist < 0.16) {
              const lineAlpha = Math.max(0, 1.0 - dist / 0.16) * 0.40;
              r = Math.min(255, Math.floor(r * (1 - lineAlpha) + 26 * lineAlpha));
              g = Math.min(255, Math.floor(g * (1 - lineAlpha) + 85 * lineAlpha));
              b = Math.min(255, Math.floor(b * (1 - lineAlpha) + 155 * lineAlpha));
            }
          }

          const pIdx = (py * w + px) * 4;
          data[pIdx + 0] = r;
          data[pIdx + 1] = g;
          data[pIdx + 2] = b;
          data[pIdx + 3] = 255;
        }
      }

      offCtx.putImageData(imgData, 0, 0);

      // Swell direction arrow (pure white stem + bright cyan circle head)
      const rad = (swellDirDeg * Math.PI) / 180;
      const cx = w * 0.5;
      const cy = 20;
      const arrowLen = 13;
      const dx = Math.sin(rad) * arrowLen;
      const dy = Math.cos(rad) * arrowLen;

      offCtx.strokeStyle = '#ffffff';
      offCtx.lineWidth = 2.0;
      offCtx.lineCap = 'round';
      offCtx.beginPath();
      offCtx.moveTo(cx - dx * 0.4, cy - dy * 0.4);
      offCtx.lineTo(cx + dx * 0.5, cy + dy * 0.5);
      offCtx.stroke();

      offCtx.fillStyle = '#00d9f3';
      offCtx.beginPath();
      offCtx.arc(cx + dx * 0.5, cy + dy * 0.5, 3.5, 0, Math.PI * 2);
      offCtx.fill();

      canvas._lastBtyVersion = btyVersion;
      canvas._lastTideLevel = tideLevel;
      canvas._lastSwellDir = swellDirDeg;
    }

    // Draw cached bathymetry background
    ctx.drawImage(canvas._minimapOffscreen, 0, 0);

    // Render real-time Player Location (Tiny at-scale white surfboard)
    if (playerInfo) {
      const u = playerInfo.x / WORLD_SIZE + 0.5;
      const v = playerInfo.z / WORLD_SIZE + 0.5;
      const px = Math.max(3, Math.min(w - 3, u * (w - 1)));
      const py = Math.max(3, Math.min(h - 3, v * (h - 1)));

      // 1. Subtle Surfing Wake / Carve Trail
      if (playerInfo.active && playerInfo.trail && playerInfo.trail.length > 1) {
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (let t = 1; t < playerInfo.trail.length; t++) {
          const p0 = playerInfo.trail[t - 1];
          const p1 = playerInfo.trail[t];
          const u0 = p0.x / WORLD_SIZE + 0.5;
          const v0 = p0.z / WORLD_SIZE + 0.5;
          const u1 = p1.x / WORLD_SIZE + 0.5;
          const v1 = p1.z / WORLD_SIZE + 0.5;
          const normProg = t / playerInfo.trail.length;
          ctx.lineWidth = 0.7 + normProg * 0.9;
          ctx.strokeStyle = `rgba(255, 255, 255, ${normProg * 0.40})`;
          ctx.beginPath();
          ctx.moveTo(u0 * (w - 1), v0 * (h - 1));
          ctx.lineTo(u1 * (w - 1), v1 * (h - 1));
          ctx.stroke();
        }
        ctx.restore();
      }

      // 2. Tiny at-scale directional white surfboard (oriented along player yaw heading)
      // On canvas, X is right and Y is down (+Z).
      const headingAngle = Math.atan2(Math.cos(playerInfo.yaw ?? 0), Math.sin(playerInfo.yaw ?? 0));
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(headingAngle);

      // Subtle drop shadow so white board pops against light beach foam and reef
      ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
      ctx.shadowBlur = 2.5;

      // Scaled surfboard geometry: length ~5.8px, width ~2.4px
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.75)';
      ctx.lineWidth = 0.6;

      ctx.beginPath();
      ctx.moveTo(3.0, 0); // nose pointing in heading direction
      ctx.bezierCurveTo(1.6, 1.25, -1.6, 1.25, -2.8, 0.75); // right rail
      ctx.lineTo(-2.8, -0.75); // tail block
      ctx.bezierCurveTo(-1.6, -1.25, 1.6, -1.25, 3.0, 0); // left rail
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Stringer line
      ctx.shadowColor = 'transparent';
      ctx.strokeStyle = '#b45309';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(-2.3, 0);
      ctx.lineTo(2.5, 0);
      ctx.stroke();

      ctx.restore();
    }
  }
}
