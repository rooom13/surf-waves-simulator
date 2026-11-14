import * as THREE from 'three';
import { WORLD_SIZE } from './bathymetry.js';
import { evaluateSurfTelemetry } from './wavePhysics.js';

/**
 * Manages Surfer POV view transitions, the Surfer HUD display,
 * surfer mouse/touch inputs, and the GPS trail on the minimap.
 */
export class SurfHudController {
  constructor({
    surferPov,
    btyManager,
    crowdSystem,
    getOceanParams,
    applyCameraPreset,
    domElement,
  }) {
    this.surferPov = surferPov;
    this.btyManager = btyManager;
    this.crowdSystem = crowdSystem;
    this.getOceanParams = getOceanParams;
    this.applyCameraPreset = applyCameraPreset;
    this.domElement = domElement;

    // HUD DOM Elements
    this.surfHud = document.getElementById('surf-hud');
    this.surfHudSpeed = document.getElementById('surf-hud-speed');
    this.surfHudWaveSpeed = document.getElementById('surf-hud-wave-speed');
    this.surfHudStatus = document.getElementById('surf-hud-status');
    this.surfViewToggleBtn = document.getElementById('surf-view-toggle-btn');
    this.cameraSelectEl = document.getElementById('camera-select');
    this.hudMinimapCanvas = document.getElementById('surf-hud-minimap');
    this.surfHudMapCard = document.getElementById('surf-hud-map-card');
    this.surfHudDepthTag = document.getElementById('surf-hud-depth-tag');

    this._lastWaveSpeedCalc = 0;

    // Minimap Player Trail
    this.playerTrail = [];
    this.lastTrailTime = 0;

    // Cursor Drop-Point Placement Mode
    this.pendingDropMode = null;
    this._dropDownX = 0;
    this._dropDownY = 0;
    this._raycaster = new THREE.Raycaster();
    this._pointerNDC = new THREE.Vector2();
    this._rayPoint = new THREE.Vector3();
    this._buildDropCursor();
    this._buildDropBanner();

    this._bindEvents();
  }

  _buildDropCursor() {
    this.dropCursorGroup = new THREE.Group();
    const outerGeom = new THREE.RingGeometry(2.6, 3.2, 48);
    outerGeom.rotateX(-Math.PI / 2);
    const outerMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
    });
    const innerGeom = new THREE.RingGeometry(0.45, 0.9, 32);
    innerGeom.rotateX(-Math.PI / 2);
    const innerMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    });
    this.dropCursorGroup.add(new THREE.Mesh(outerGeom, outerMat));
    this.dropCursorGroup.add(new THREE.Mesh(innerGeom, innerMat));
    this.dropCursorGroup.renderOrder = 10;
    this.dropCursorGroup.visible = false;
    this.surferPov.scene.add(this.dropCursorGroup);
  }

  _buildDropBanner() {
    const banner = document.createElement('div');
    banner.id = 'drop-placement-banner';
    banner.style.cssText = [
      'position: fixed',
      'top: 74px',
      'left: 50%',
      'transform: translateX(-50%)',
      'z-index: 60',
      'background: rgba(10, 25, 47, 0.9)',
      'border: 1px solid rgba(34, 211, 238, 0.65)',
      'color: #e0f2fe',
      'padding: 8px 16px',
      'border-radius: 999px',
      'font-size: 13px',
      'font-weight: 600',
      'letter-spacing: 0.2px',
      'box-shadow: 0 8px 24px rgba(0,0,0,0.45)',
      'pointer-events: none',
      'display: none',
    ].join(';');
    banner.textContent = '🎯 Click on the ocean where you want to drop the surfer (Esc to cancel)';
    document.body.appendChild(banner);
    this.dropBannerEl = banner;
  }

  /**
   * Raymarches from the camera through (clientX, clientY) against the live displaced 3D ocean surface.
   */
  _raycastOceanSurface(clientX, clientY) {
    const rect = this.domElement.getBoundingClientRect();
    this._pointerNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this._pointerNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;

    const cam = this.surferPov.camera;
    this._raycaster.setFromCamera(this._pointerNDC, cam);
    const origin = this._raycaster.ray.origin;
    const dir = this._raycaster.ray.direction;
    const params = this.getOceanParams();

    // Determine ray parameter range intersecting the vertical slab [-6m, +22m]
    let tMin = 2.0;
    let tMax = 900.0;
    if (Math.abs(dir.y) > 1e-4) {
      const tA = (22.0 - origin.y) / dir.y;
      const tB = (-6.0 - origin.y) / dir.y;
      tMin = Math.max(2.0, Math.min(tA, tB));
      tMax = Math.min(900.0, Math.max(tA, tB));
    }

    if (tMax > tMin) {
      const steps = 48;
      const dt = (tMax - tMin) / steps;
      let prevT = tMin;
      for (let i = 0; i <= steps; i++) {
        const t = tMin + i * dt;
        this._rayPoint.copy(origin).addScaledVector(dir, t);
        if (Math.abs(this._rayPoint.x) > WORLD_SIZE * 0.48 || Math.abs(this._rayPoint.z) > WORLD_SIZE * 0.48) {
          prevT = t;
          continue;
        }
        const surf = this.surferPov.sampleSurface(this._rayPoint.x, this._rayPoint.z, params);
        if (this._rayPoint.y <= surf.surfaceY) {
          // Binary search refinement between prevT and t
          let lo = prevT;
          let hi = t;
          for (let k = 0; k < 6; k++) {
            const mid = 0.5 * (lo + hi);
            this._rayPoint.copy(origin).addScaledVector(dir, mid);
            const midSurf = this.surferPov.sampleSurface(this._rayPoint.x, this._rayPoint.z, params);
            if (this._rayPoint.y <= midSurf.surfaceY) hi = mid;
            else lo = mid;
          }
          this._rayPoint.copy(origin).addScaledVector(dir, hi);
          const finalSurf = this.surferPov.sampleSurface(this._rayPoint.x, this._rayPoint.z, params);
          return { x: this._rayPoint.x, y: finalSurf.surfaceY, z: this._rayPoint.z };
        }
        prevT = t;
      }
    }

    // Fallback: intersect horizontal tide plane
    if (Math.abs(dir.y) > 1e-4) {
      const tPlane = ((params.tideLevel ?? 0.2) - origin.y) / dir.y;
      if (tPlane > 1.0 && tPlane < 1200.0) {
        this._rayPoint.copy(origin).addScaledVector(dir, tPlane);
        const bound = WORLD_SIZE * 0.44;
        const x = Math.max(-bound, Math.min(bound, this._rayPoint.x));
        const z = Math.max(-bound, Math.min(bound, this._rayPoint.z));
        const surf = this.surferPov.sampleSurface(x, z, params);
        return { x, y: surf.surfaceY, z };
      }
    }
    return null;
  }

  startDropPlacement(viewMode = 'third_person') {
    if (this.surferPov.active) {
      this.enterSurfPov(viewMode);
      return;
    }
    this.pendingDropMode = viewMode;
    this.domElement.style.cursor = 'crosshair';
    if (this.dropBannerEl) {
      this.dropBannerEl.style.display = 'block';
    }
    document.getElementById('surf-third-btn')?.classList.toggle('active', viewMode === 'third_person');
    document.getElementById('surf-pov-btn')?.classList.toggle('active', viewMode === 'first_person');
  }

  cancelDropPlacement() {
    if (!this.pendingDropMode) return;
    this.pendingDropMode = null;
    this.dropCursorGroup.visible = false;
    this.domElement.style.cursor = '';
    if (this.dropBannerEl) {
      this.dropBannerEl.style.display = 'none';
    }
    document.getElementById('surf-third-btn')?.classList.remove('active');
    document.getElementById('surf-pov-btn')?.classList.remove('active');
    if (this.cameraSelectEl && (this.cameraSelectEl.value === 'surf_third' || this.cameraSelectEl.value === 'surf_pov')) {
      this.cameraSelectEl.value = 'overview';
    }
  }

  _bindEvents() {
    document.getElementById('surf-third-btn')?.addEventListener('click', () => this.startDropPlacement('third_person'));
    document.getElementById('surf-pov-btn')?.addEventListener('click', () => this.startDropPlacement('first_person'));
    document.getElementById('surf-view-toggle-btn')?.addEventListener('click', () => this.toggleSurfView());
    document.getElementById('surf-exit-btn')?.addEventListener('click', () => this.exitSurfPov(true));
    document.getElementById('surf-dropin-btn')?.addEventListener('click', () => {
      this.playerTrail.length = 0;
      this.surferPov.resetToLineup(this.getOceanParams(), true);
    });

    this.domElement.addEventListener('pointerdown', (e) => {
      if (this.pendingDropMode && e.button === 0) {
        this._dropDownX = e.clientX;
        this._dropDownY = e.clientY;
        return;
      }
      this.surferPov.onPointerDown(e);
    });
    window.addEventListener('pointermove', (e) => {
      if (this.pendingDropMode) {
        const hit = this._raycastOceanSurface(e.clientX, e.clientY);
        if (hit) {
          this.dropCursorGroup.position.set(hit.x, hit.y + 0.18, hit.z);
          this.dropCursorGroup.visible = true;
        } else {
          this.dropCursorGroup.visible = false;
        }
        return;
      }
      this.surferPov.onPointerMove(e);
    });
    window.addEventListener('pointerup', (e) => {
      if (this.pendingDropMode && e.button === 0) {
        const moved = Math.hypot(e.clientX - this._dropDownX, e.clientY - this._dropDownY);
        if (moved < 6) {
          const hit = this._raycastOceanSurface(e.clientX, e.clientY);
          if (hit) {
            const mode = this.pendingDropMode;
            this.cancelDropPlacement();
            this.enterSurfPov(mode, { x: hit.x, z: hit.z });
            return;
          }
        }
        // Restore crosshair cursor after an orbit drag in placement mode
        this.domElement.style.cursor = 'crosshair';
        return;
      }
      this.surferPov.onPointerUp();
    });
    this.domElement.addEventListener('wheel', (e) => this.surferPov.onWheel(e), { passive: true });
  }

  handleSurferKey(e) {
    if (this.pendingDropMode && e.code === 'Escape') {
      e.preventDefault();
      this.cancelDropPlacement();
      return true;
    }
    if (!this.surferPov.active) return false;

    if (e.code === 'Space') {
      e.preventDefault();
      this.surferPov.takeOff(this.getOceanParams());
      return true;
    }
    if (e.code === 'KeyC' || e.code === 'KeyV') {
      e.preventDefault();
      this.toggleSurfView();
      return true;
    }
    if (e.code === 'KeyM') {
      e.preventDefault();
      this.surfHudMapCard?.classList.toggle('hidden');
      return true;
    }
    if (e.code === 'Escape') {
      e.preventDefault();
      this.exitSurfPov(true);
      return true;
    }
    return false;
  }

  updateSurfViewButton() {
    if (!this.surfViewToggleBtn) return;
    const is3rd = this.surferPov.viewMode === 'third_person';
    this.surfViewToggleBtn.innerHTML = is3rd
      ? '📷 Switch to 1st Person <kbd style="font-size:10px;margin-left:4px">C</kbd>'
      : '🦅 Switch to Bird-View <kbd style="font-size:10px;margin-left:4px">C</kbd>';
    this.surfViewToggleBtn.title = is3rd
      ? 'Switch to First-Person Surf POV (Key: C or V)'
      : 'Switch to Third-Person Low Bird-View (Key: C or V)';
  }

  enterSurfPov(viewMode = 'third_person', dropPoint = null) {
    if (this.surferPov.active) {
      if (viewMode && this.surferPov.viewMode !== viewMode) {
        this.surferPov.setViewMode(viewMode);
        if (this.cameraSelectEl) this.cameraSelectEl.value = viewMode === 'third_person' ? 'surf_third' : 'surf_pov';
        this.updateSurfViewButton();
      }
      return;
    }
    this.surfHud?.classList.remove('hidden');
    document.activeElement?.blur?.();
    const params = this.getOceanParams();
    this.surferPov.enable(params, viewMode, dropPoint);
    if (this.cameraSelectEl) this.cameraSelectEl.value = viewMode === 'third_person' ? 'surf_third' : 'surf_pov';
    this.crowdSystem?.setVisible?.(true);
    this.updateSurfViewButton();
    this.updateWaveSpeed(true);
  }

  updateWaveSpeed(force = false) {
    if (!this.surfHudWaveSpeed) return;
    const now = performance.now();
    if (force || now - this._lastWaveSpeedCalc > 350) {
      this._lastWaveSpeedCalc = now;
      const t = evaluateSurfTelemetry(this.getOceanParams(), this.btyManager);
      const kts = (t.waveSpeed * 1.94384).toFixed(1);
      this.surfHudWaveSpeed.textContent = `${t.waveSpeed.toFixed(1)} m/s (${kts} kts)`;
    }
  }

  toggleSurfView() {
    if (!this.surferPov.active) return;
    const nextMode = this.surferPov.toggleViewMode();
    if (this.cameraSelectEl) this.cameraSelectEl.value = nextMode === 'third_person' ? 'surf_third' : 'surf_pov';
    this.updateSurfViewButton();
  }

  exitSurfPov(returnToOrbit = true) {
    this.surferPov.disable();
    this.surfHud?.classList.add('hidden');
    if (returnToOrbit) {
      if (this.cameraSelectEl) this.cameraSelectEl.value = 'overview';
      this.applyCameraPreset('overview');
    }
  }

  updateHud() {
    if (!this.surferPov.active) return;

    if (this.surfHudSpeed) {
      this.surfHudSpeed.textContent = `${this.surferPov.speed.toFixed(1)} m/s (${(this.surferPov.speed * 1.94384).toFixed(1)} kts)`;
    }
    this.updateWaveSpeed();
    if (this.surfHudStatus) {
      if (this.surfHudStatus.textContent !== this.surferPov.statusLabel) {
        this.surfHudStatus.textContent = this.surferPov.statusLabel;
      }
      this.surfHudStatus.classList.toggle('in-barrel', this.surferPov.isInBarrel);
    }

    if (this.surfHudDepthTag) {
      const samp = this.btyManager.sampleAt(this.surferPov.pos.x, this.surferPov.pos.z);
      const tide = this.getOceanParams().tideLevel ?? 0.2;
      const d = Math.max(0, tide - samp.elevation);
      this.surfHudDepthTag.textContent = d > 0.05 ? `Depth: ${d.toFixed(1)}m` : 'On Shore';
    }
  }

  getPlayerMinimapData(now) {
    if (this.surferPov.active) {
      if (now - this.lastTrailTime > 0.06) {
        this.lastTrailTime = now;
        this.playerTrail.push({ x: this.surferPov.pos.x, z: this.surferPov.pos.z });
        if (this.playerTrail.length > 32) this.playerTrail.shift();
      }
    } else if (this.playerTrail.length > 0) {
      this.playerTrail.length = 0;
    }

    return {
      x: this.surferPov.pos.x,
      z: this.surferPov.pos.z,
      yaw: this.surferPov.yaw,
      active: this.surferPov.active,
      trail: this.playerTrail,
    };
  }

  renderHudMinimap(playerMinimapData) {
    if (this.surferPov.active && this.hudMinimapCanvas && !this.surfHudMapCard?.classList.contains('hidden')) {
      const p = this.getOceanParams();
      this.btyManager.renderMinimap(
        this.hudMinimapCanvas,
        p.tideLevel,
        p.swellDir,
        playerMinimapData
      );
    }
  }
}
