import { WORLD_SIZE, BTY_RES } from './bathymetry.js';

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

/**
 * Computes base seabed elevation for the requested surf spot preset.
 * Writes output directly into the Float32Array baseElevation buffer.
 */
export function generateBathymetryPreset(presetName, params, baseElevation) {
  const { seabedSlope, reefProminence, reefAngle, channelDepth } = params;
  const angleRad = (reefAngle * Math.PI) / 180;
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);

  for (let j = 0; j < BTY_RES; j++) {
    const v = j / (BTY_RES - 1);
    const z = (v - 0.5) * WORLD_SIZE; // -300 (offshore) to +300 (shore)

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

      baseElevation[idx] = h;
    }
  }
}
