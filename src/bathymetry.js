import * as THREE from 'three';

export const WORLD_SIZE = 300; // 300m x 300m coastal surf zone
export const BTY_RES = 160;    // 160x160 bathymetry simulation grid

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

        const normZ = (z + 150) / 300;
        const rockNoise = fbm(x * 0.03, z * 0.03, 3);
        const fineNoise = fbm(x * 0.07, z * 0.07, 2) * 0.25;

        // Default deep ocean to coastal base depth (-15m offshore to -6.5m nearshore before shoals/beach)
        let h = -15.5 * Math.pow(1.0 - normZ, 1.05 * seabedSlope) - 5.2;
        let isAboveWaterStructure = false;

        if (presetName === 'right_point') {
          // RIGHT POINT BREAK (e.g., Rincon / Malibu / Jeffreys Bay):
          // Surfer rides toward +z (shore), peeling to surfer's RIGHT (-x).
          // High rocky headland promontory juts out on the +x side (x > +25, reaching z = -45),
          // curving back into a recessed sandy bay on the -x side (shoreline at z = +105).
          const shoreCurveZ = 102 - 142 * smoothstep(-35, 115, x) + Math.sin(x * 0.035) * 4.0;

          // Above-water headland cliff & curving bay beach
          if (z > shoreCurveZ - 18) {
            const landProgress = smoothstep(shoreCurveZ - 16, shoreCurveZ + 45, z);
            const isHeadland = smoothstep(-10, 75, x);
            const landElev = landProgress * (4.5 + 14.0 * isHeadland) + rockNoise * (0.4 + 1.8 * isHeadland);
            if (z > shoreCurveZ) isAboveWaterStructure = true;
            h = Math.max(h, -4.5 + landElev);
          }

          // Submerged diagonal cobblestone point bar wrapping off the headland from (x=+70, z=-35) to (x=-45, z=+45)
          const barAxisZ = -32 + (70 - rx) * 0.64;
          const distFromBar = rz - barAxisZ;
          const pointBarMask =
            Math.exp(-(distFromBar * distFromBar) / (2 * 26 * 26)) *
            smoothstep(-75, 15, x) *
            smoothstep(130, 40, x);

          const barRise = 5.4 * reefProminence * pointBarMask;
          // Deep bay channel on the inside (-x < -25) so the wave peels into deep water and doesn't close out
          const bayChannel = -3.2 * channelDepth * smoothstep(10, -70, x) * smoothstep(85, -50, z);

          if (!isAboveWaterStructure) {
            h += barRise + bayChannel + fineNoise;
            h = softCapUnderwater(h, -1.75);
          }
        } else if (presetName === 'left_point') {
          // LEFT POINT BREAK (e.g., Raglan / Chicama / Mundaka):
          // Surfer rides toward +z (shore), peeling to surfer's LEFT (+x).
          // Rugged headland cliff juts out on the -x side (x < -25, reaching z = -45),
          // curving back into a recessed sandy bay on the +x side (shoreline at z = +105).
          const shoreCurveZ = 102 - 142 * smoothstep(35, -115, x) + Math.sin(x * 0.035) * 4.0;

          if (z > shoreCurveZ - 18) {
            const landProgress = smoothstep(shoreCurveZ - 16, shoreCurveZ + 45, z);
            const isHeadland = smoothstep(10, -75, x);
            const landElev = landProgress * (4.5 + 14.5 * isHeadland) + rockNoise * (0.4 + 1.8 * isHeadland);
            if (z > shoreCurveZ) isAboveWaterStructure = true;
            h = Math.max(h, -4.5 + landElev);
          }

          // Submerged diagonal cobblestone/reef point shelf wrapping from (x=-70, z=-35) to (x=+45, z=+45)
          const barAxisZ = -32 + (70 + rx) * 0.64;
          const distFromBar = rz - barAxisZ;
          const pointBarMask =
            Math.exp(-(distFromBar * distFromBar) / (2 * 26 * 26)) *
            smoothstep(75, -15, x) *
            smoothstep(-130, -40, x);

          const barRise = 5.4 * reefProminence * pointBarMask;
          const bayChannel = -3.2 * channelDepth * smoothstep(-10, 70, x) * smoothstep(85, -50, z);

          if (!isAboveWaterStructure) {
            h += barRise + bayChannel + fineNoise;
            h = softCapUnderwater(h, -1.75);
          }
        } else if (presetName === 'jetty_wedge') {
          // ROCK JETTY & SANDBAR WEDGE (e.g., Newport Wedge / Sebastian Inlet):
          // Angled boulder rock jetty extending from offshore (x = -74, z = -55) to the beach (x = -18, z = +92)
          // so its +x face directly catches incoming swells and reflects a real sideways wave across the surf zone!
          const jettyCenterX = -52 + (z + 5) * 0.36;
          const distToJetty = Math.abs(x - jettyCenterX);
          const onJettyLength = smoothstep(-62, -48, z) * smoothstep(135, 105, z);

          // Triangular sandbar fillet accumulated on the surf side (+x side) of the jetty
          const distFromJettyRight = x - jettyCenterX;
          const filletEnvelope =
            smoothstep(-2, 16, distFromJettyRight) *
            Math.exp(-(distFromJettyRight * distFromJettyRight) / (2 * 56 * 56)) *
            Math.exp(-((z - 8) * (z - 8)) / (2 * 36 * 36));

          const sandFillet = 5.4 * reefProminence * filletEnvelope;

          // Calm harbor channel on the sheltered lee side (-x side) behind the jetty
          const harborChannel = -5.0 * channelDepth * smoothstep(jettyCenterX + 4, jettyCenterX - 22, x);

          // Steep reflective sandy shorebreak on the surf side (x > jettyCenterX)
          const beachShoreZ = 82 - 12 * Math.exp(-(distFromJettyRight * distFromJettyRight) / (2 * 48 * 48));
          const beachRise =
            10.5 *
            smoothstep(beachShoreZ - 20, beachShoreZ + 42, z) *
            smoothstep(jettyCenterX - 2, jettyCenterX + 8, x);

          h += sandFillet + harborChannel + fineNoise;
          if (z < beachShoreZ - 4) {
            h = softCapUnderwater(h, -1.75);
          }
          h += beachRise;

          // Solid rock boulder jetty wall rising +5.2m above sea level
          if (distToJetty < 11.5 && onJettyLength > 0.05) {
            const jettyProfile = smoothstep(11.0, 4.2, distToJetty) * onJettyLength;
            const boulderRugosity = Math.abs(rockNoise) * 1.4;
            const jettyElev = -4.0 + (9.2 + boulderRugosity) * jettyProfile;
            if (jettyElev > h) {
              h = jettyElev;
              if (h > -0.4) isAboveWaterStructure = true;
            }
          }
        } else if (presetName === 'reef_pass') {
          // BARRIER REEF PASS & DEEP CHANNEL (e.g., Teahupo'o / Cloudbreak / Pipeline):
          // Deep submarine canyon / pass channel on the center-left (x in [-85, -15], depth -14m)
          // next to an abrupt, shallow flat coral reef shelf on the right (x in [-10, +95], depth -1.75m)
          // with a deep turquoise lagoon behind the reef (z in [+28, +85]) and island beach at z > +105.
          const passChannelMask =
            smoothstep(5, -35, x) *
            smoothstep(-115, -75, x) *
            smoothstep(65, -90, z);

          // Angled barrier reef shelf edge facing the deep pass
          const reefFrontZ = -26 + Math.max(0, 45 - rx) * 0.38;
          const onReefShelf =
            smoothstep(reefFrontZ - 16, reefFrontZ + 6, rz) *
            smoothstep(38, 14, rz) *
            smoothstep(-22, 12, rx) *
            smoothstep(115, 75, rx);

          const reefTable = 6.2 * reefProminence * onReefShelf + Math.abs(fineNoise) * 0.6 * onReefShelf;
          const deepPassCut = -5.5 * channelDepth * passChannelMask;
          // Calm deeper lagoon behind the barrier reef before the island shore
          const lagoon = -1.8 * smoothstep(25, 48, z) * smoothstep(95, 65, z);
          const islandShore = 10.5 * smoothstep(88, 148, z);

          h += reefTable + deepPassCut + lagoon;
          if (z < 88) {
            h = softCapUnderwater(h, -1.70);
          }
          h += islandShore;
        } else if (presetName === 'aframe_reef') {
          // A-FRAME REEF PEAK (e.g., Lower Trestles / Uluwatu Peak):
          // Prominent V-shaped submerged reef ridge at x = 0 pointing offshore (z = -30),
          // flanked by deep channels on both sides (|x| > 55).
          const distFromApex = Math.abs(rx);
          const reefZCenter = -24 + distFromApex * 0.56;
          const zDiff = rz - reefZCenter;
          const reefEnvelope =
            Math.exp(-(zDiff * zDiff) / (2 * 22 * 22)) *
            Math.exp(-(distFromApex * distFromApex) / (2 * 56 * 56));

          const reefHeight = 5.8 * reefProminence * reefEnvelope;
          const channelCut = -3.4 * channelDepth * smoothstep(32, 85, Math.abs(x));
          const beachRise = 10.0 * smoothstep(72, 145, z);

          h += reefHeight + channelCut + fineNoise;
          if (z < 72) {
            h = softCapUnderwater(h, -1.75);
          }
          h += beachRise;
        } else if (presetName === 'beach_break') {
          // BEACH BREAK — CRESCENT SANDBARS & RIP CHANNELS (e.g., Hossegor / Supertubos):
          // Two shallow crescent sandbar banks centered at x = -52 and x = +52,
          // separated by a deep central rip-current channel at x = 0 and an inside reform trough at z = +42.
          const leftBarDist = Math.hypot((rx + 52) * 0.85, rz - (-8 + Math.cos((rx + 52) * 0.05) * 8));
          const rightBarDist = Math.hypot((rx - 52) * 0.85, rz - (-8 + Math.cos((rx - 52) * 0.05) * 8));

          const sandbars =
            5.6 *
            reefProminence *
            (Math.exp(-(leftBarDist * leftBarDist) / (2 * 28 * 28)) +
              Math.exp(-(rightBarDist * rightBarDist) / (2 * 28 * 28)));

          // Deep central rip current channel scoured out at x = 0
          const centralRip = -3.5 * channelDepth * Math.exp(-(x * x) / (2 * 20 * 20)) * smoothstep(65, -45, z);
          // Inside reform trough between outer sandbars and steep beach shorebreak
          const reformTrough = -2.2 * Math.exp(-((z - 40) * (z - 40)) / (2 * 16 * 16));
          const beachDunes = 10.5 * smoothstep(68, 145, z) + rockNoise * 0.8 * smoothstep(85, 145, z);

          h += sandbars + centralRip + reformTrough + fineNoise * 0.6;
          if (z < 68) {
            h = softCapUnderwater(h, -1.75);
          }
          h += beachDunes;
        } else if (presetName === 'rivermouth') {
          // RIVER MOUTH ESTUARY & DELTA SANDBAR (e.g., Mundaka / Rivermouth):
          // A river channel cuts through the coastal bluffs around x = -45, scouring a deep outflow channel
          // and depositing a long curved cobblestone/sand delta bar across x in [-20, +85].
          const riverPathX = -48 + Math.sin(z * 0.03) * 10.0;
          const distToRiver = Math.abs(x - riverPathX);
          const riverChannelCut = -6.8 * channelDepth * Math.exp(-(distToRiver * distToRiver) / (2 * 18 * 18));

          // Curved offshore delta sandbar deposited to the right of the river outflow
          const barCurveZ = -22 + (rx - 15) * 0.45 + Math.pow((rx - 15) * 0.02, 2) * 12.0;
          const distToDeltaBar = rz - barCurveZ;
          const deltaBar =
            5.8 *
            reefProminence *
            Math.exp(-(distToDeltaBar * distToDeltaBar) / (2 * 24 * 24)) *
            smoothstep(-25, 10, x) *
            smoothstep(115, 65, x);

          // Coastal bluffs on either side of the river estuary mouth
          const bluffMask = smoothstep(16, 36, distToRiver);
          const shoreRise = (11.5 * bluffMask + 2.2 * (1.0 - bluffMask)) * smoothstep(65, 142, z);

          h += deltaBar + riverChannelCut + fineNoise;
          if (z < 65 || distToRiver < 20) {
            h = softCapUnderwater(h, -1.75);
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

  renderMinimap(canvas, tideLevel, swellDirDeg) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const imgData = ctx.createImageData(w, h);
    const data = imgData.data;

    for (let py = 0; py < h; py++) {
      const v = py / (h - 1);
      const j = Math.min(BTY_RES - 1, Math.floor(v * BTY_RES));

      for (let px = 0; px < w; px++) {
        const u = px / (w - 1);
        const i = Math.min(BTY_RES - 1, Math.floor(u * BTY_RES));
        const elev = this.elevation[j * BTY_RES + i];
        const depth = tideLevel - elev;

        let r = 10, g = 30, b = 55;
        if (depth <= 0) {
          const land = Math.min(1, -depth / 8.0);
          r = 215 - land * 95;
          g = 185 - land * 65;
          b = 115 - land * 45;
        } else if (depth < 3.6) {
          // Highlight the active shallow shoaling reef/sandbar/point contour in bright aqua
          const t = Math.max(0, Math.min(1, (depth - 1.5) / 2.1));
          r = Math.floor(34 * (1 - t) + 18 * t);
          g = Math.floor(215 * (1 - t) + 135 * t);
          b = Math.floor(238 * (1 - t) + 185 * t);
        } else {
          // Deep channels & offshore water in dark navy
          const t = Math.min(1, (depth - 3.6) / 12.0);
          r = Math.floor(18 * (1 - t) + 6 * t);
          g = Math.floor(135 * (1 - t) + 32 * t);
          b = Math.floor(185 * (1 - t) + 68 * t);
        }

        if (depth > 0 && Math.abs((depth % 2.0) - 1.0) < 0.08) {
          r = Math.min(255, r + 24);
          g = Math.min(255, g + 28);
          b = Math.min(255, b + 32);
        }

        const pIdx = (py * w + px) * 4;
        data[pIdx + 0] = r;
        data[pIdx + 1] = g;
        data[pIdx + 2] = b;
        data[pIdx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);

    const rad = (swellDirDeg * Math.PI) / 180;
    const cx = w * 0.5;
    const cy = 18;
    const dx = Math.sin(rad) * 14;
    const dy = Math.cos(rad) * 14;

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - dx * 0.6, cy - dy * 0.6);
    ctx.lineTo(cx + dx * 0.6, cy + dy * 0.6);
    ctx.stroke();

    ctx.fillStyle = '#22d3ee';
    ctx.beginPath();
    ctx.arc(cx + dx * 0.6, cy + dy * 0.6, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}
