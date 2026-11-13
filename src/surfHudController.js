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

    this._bindEvents();
  }

  _bindEvents() {
    document.getElementById('surf-third-btn')?.addEventListener('click', () => this.enterSurfPov('third_person'));
    document.getElementById('surf-pov-btn')?.addEventListener('click', () => this.enterSurfPov('first_person'));
    document.getElementById('surf-view-toggle-btn')?.addEventListener('click', () => this.toggleSurfView());
    document.getElementById('surf-exit-btn')?.addEventListener('click', () => this.exitSurfPov(true));
    document.getElementById('surf-dropin-btn')?.addEventListener('click', () => {
      this.playerTrail.length = 0;
      this.surferPov.resetToLineup(this.getOceanParams(), true);
    });

    this.domElement.addEventListener('pointerdown', (e) => this.surferPov.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.surferPov.onPointerMove(e));
    window.addEventListener('pointerup', () => this.surferPov.onPointerUp());
    this.domElement.addEventListener('wheel', (e) => this.surferPov.onWheel(e), { passive: true });
  }

  handleSurferKey(e) {
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

  enterSurfPov(viewMode = 'third_person') {
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
    this.surferPov.enable(params, viewMode);
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
