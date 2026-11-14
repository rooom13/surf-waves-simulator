import * as THREE from 'three';
import {
  generateBathymetryPreset,
  evalCurve,
  COAST_SAMPLES,
  REEF_SAMPLES,
  SHELF_SAMPLES,
} from './bathymetryPresets.js';
import { renderMinimap } from './minimapRenderer.js';

export const WORLD_SIZE = 600; // 600m x 600m domain
export const BTY_RES = 180;    // 180x180 bathymetry simulation grid

// Re-export curve samples & evaluator for backwards compatibility with telemetry and crowd modules
export { evalCurve, COAST_SAMPLES, REEF_SAMPLES, SHELF_SAMPLES };

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

    // Minimap cache flags
    this.minimapDirty = true;
    this.minimapVersion = 1;

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
    generateBathymetryPreset(presetName, this.params, this.baseElevation);
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
    this.minimapVersion = (this.minimapVersion || 0) + 1;
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
          const shallowDrive = Math.pow((3.65 - depth) / 2.1, 1.35);
          prevStage += shallowDrive * cellStep * 0.028;
        } else if (depth > 4.0) {
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
      const i = k % BTY_RES;
      const j = Math.floor(k / BTY_RES);
      const x = (i / (BTY_RES - 1) - 0.5) * WORLD_SIZE;
      const z = (j / (BTY_RES - 1) - 0.5) * WORLD_SIZE;
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
        // Deep channel / offshore floor
        const t = Math.max(0, Math.min(1, (h + 16.0) / 10.0));
        r = 0.05 + t * 0.08;
        g = 0.16 + t * 0.16;
        b = 0.28 + t * 0.18;
      } else if (h < -0.3) {
        // Shallow shoaling sandbar / reef shelf
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
          r = 0.22 + t * 0.52;
          g = 0.32 + t * 0.38;
          b = 0.30 + t * 0.16;
        }
      } else if (h < 1.8) {
        // Wet & dry sandy beach (or rock jetty base)
        if (this.preset === 'jetty_wedge' && sl > 0.22) {
          r = 0.32;
          g = 0.33;
          b = 0.35;
        } else if (this.preset === 'nazare' && x < -30) {
          // Dark rocky shoreline at the base of Farol cliff
          r = 0.28;
          g = 0.29;
          b = 0.31;
        } else {
          const t = (h + 0.3) / 2.1;
          r = 0.64 + t * 0.20;
          g = 0.56 + t * 0.18;
          b = 0.40 + t * 0.14;
        }
      } else if (h < 6.0) {
        // Rocky cliffs / jetty boulders / coastal bluffs
        if (this.preset === 'nazare' || (this.preset === 'jetty_wedge' && sl > 0.18)) {
          r = 0.36;
          g = 0.36;
          b = 0.38;
        } else {
          const t = (h - 1.8) / 4.2;
          r = 0.50 - t * 0.14;
          g = 0.46 - t * 0.09;
          b = 0.36 - t * 0.10;
        }
      } else {
        // High headland coastal vegetation & scrub
        if (this.preset === 'nazare') {
          // Weathered Atlantic limestone/granite cliff with plateau top
          const t = Math.min(1, (h - 6.0) / 24.0);
          r = 0.38 - t * 0.10;
          g = 0.38 - t * 0.04;
          b = 0.36 - t * 0.10;
        } else {
          const t = Math.min(1, (h - 6.0) / 9.0);
          r = 0.24 - t * 0.05;
          g = 0.39 + t * 0.06;
          b = 0.22 - t * 0.04;
        }
      }

      // Topographic contour lines every 1.5m
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
    renderMinimap(canvas, this, tideLevel, swellDirDeg, playerInfo);
  }
}
