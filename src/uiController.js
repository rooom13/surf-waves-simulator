import { evaluateSurfTelemetry } from './wavePhysics.js';
import {
  PARTICLE_TYPE_BARREL,
  PARTICLE_TYPE_WHITEWATER,
  PARTICLE_TYPE_BOARD_SPRAY,
} from './spraySystem.js';

/**
 * Manages all DOM UI bindings, sliders, parameter synchronization,
 * telemetry updates, and preset configurations.
 */
export class UIController {
  constructor({
    oceanParams,
    btyManager,
    waveSolver,
    spraySystem,
    crowdSystem,
    surferPov,
    oceanMat,
    minimapCanvas,
    updateSunLighting,
    applyCameraPreset,
    getIsPaused,
    setIsPaused,
  }) {
    this.oceanParams = oceanParams;
    this.btyManager = btyManager;
    this.waveSolver = waveSolver;
    this.spraySystem = spraySystem;
    this.crowdSystem = crowdSystem;
    this.surferPov = surferPov;
    this.oceanMat = oceanMat;
    this.minimapCanvas = minimapCanvas;
    this.updateSunLighting = updateSunLighting;
    this.applyCameraPreset = applyCameraPreset;
    this.getIsPaused = getIsPaused || (() => false);
    this.setIsPaused = setIsPaused || (() => {});

    this.lastCountdownKey = '';

    this._bindSliders();
    this._bindDetailsAndProps();
    this._bindPresetAndModeSelectors();
    this._bindPanelCollapses();
  }

  _bindSlider(id, valId, paramObj, key, formatter, onChange) {
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

  _bindSliders() {
    const p = this.oceanParams;
    const sync = () => this.syncUIAndTelemetry();

    // Primary Swell
    this._bindSlider('swell-height', 'val-swell-height', p, 'swellHeight', (v) => `${v.toFixed(1)} m (${(v * 3.28084).toFixed(1)} ft)`, sync);
    this._bindSlider('swell-period', 'val-swell-period', p, 'swellPeriod', (v) => `${v} s (${v >= 18 ? 'Monster Groundswell' : v >= 13 ? 'Long-Period' : v >= 9 ? 'Mid-Period' : 'Windswell'})`, sync);
    this._bindSlider('swell-dir', 'val-swell-dir', p, 'swellDir', (v) => `${v > 0 ? '+' : ''}${v}° (${v === 0 ? 'Direct' : v < 0 ? 'West Peak' : 'East Peak'})`, sync);
    this._bindSlider('swell-grouping', 'val-swell-grouping', p, 'swellGrouping', (v) => `${v}%`, () => {
      this.waveSolver.warmup(p, 300);
      this.spraySystem.warmup(p, this.waveSolver, 45);
      this.syncUIAndTelemetry();
    });
    this._bindSlider('waves-per-set', 'val-waves-per-set', p, 'wavesPerSet', (v) => `${v} waves (${Math.round(v * p.swellPeriod)} s Set)`, sync);

    // Secondary Swell
    const secCheck = document.getElementById('sec-swell-enabled');
    if (secCheck) {
      secCheck.addEventListener('change', (e) => {
        p.secEnabled = e.target.checked;
        const secControls = document.getElementById('sec-swell-controls');
        if (secControls) secControls.style.opacity = e.target.checked ? '1' : '0.4';
        this.syncUIAndTelemetry();
      });
    }
    this._bindSlider('sec-height', 'val-sec-height', p, 'secHeight', (v) => `${v.toFixed(1)} m`, sync);
    this._bindSlider('sec-period', 'val-sec-period', p, 'secPeriod', (v) => `${v} s`, sync);
    this._bindSlider('sec-dir', 'val-sec-dir', p, 'secDir', (v) => `${v}°`, sync);

    // Interference
    this._bindSlider('backwash-strength', 'val-backwash', p, 'backwashStrength', (v) => `${v.toFixed(2)}x`, sync);
    this._bindSlider('sidewave-strength', 'val-sidewave-strength', p, 'sideWaveStrength', (v) => `${v.toFixed(2)}x`, sync);

    // Wind & Environment
    this._bindSlider('wind-speed', 'val-wind-speed', p, 'windSpeed', (v) => `${v} kts`, sync);
    this._bindSlider('wind-dir', 'val-wind-dir', p, 'windDir', (v) => {
      const a = Math.abs(v);
      const label = a < 45 ? 'Offshore' : a < 120 ? 'Cross' : 'Onshore';
      return `${v}° (${label})`;
    }, sync);

    this._bindSlider('tide-level', 'val-tide', p, 'tideLevel', (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} m (${v < -0.5 ? 'Low' : v > 0.8 ? 'High' : 'Mid'})`, () => {
      this.crowdSystem.populate(this.btyManager, p.tideLevel);
      this.syncUIAndTelemetry();
    });

    this._bindSlider('sun-elevation', 'val-sun-elevation', p, 'sunElevation', (v) => `${v}° (${v < 15 ? 'Golden Hour' : v < 38 ? 'Afternoon' : 'Midday'})`, sync);

    // Parametric Bathymetry Sliders
    const bp = this.btyManager.params;
    const reGenBty = () => {
      this.btyManager.generatePreset(this.btyManager.preset);
      this.crowdSystem.populate(this.btyManager, p.tideLevel);
      this.syncUIAndTelemetry();
    };
    this._bindSlider('seabed-slope', 'val-seabed-slope', bp, 'seabedSlope', (v) => `${v.toFixed(2)}x`, reGenBty);
    this._bindSlider('reef-prominence', 'val-reef-prominence', bp, 'reefProminence', (v) => `${v.toFixed(2)}x`, reGenBty);
    this._bindSlider('reef-angle', 'val-reef-angle', bp, 'reefAngle', (v) => `${v}°`, reGenBty);
    this._bindSlider('channel-depth', 'val-channel-depth', bp, 'channelDepth', (v) => `${v.toFixed(1)}x`, reGenBty);

    // Surfer Mobility & Board Physics Sliders
    if (this.surferPov && this.surferPov.mobility) {
      const m = this.surferPov.mobility;
      const mobilityBindings = [
        ['surf-paddle-accel', 'val-surf-paddle-accel', 'paddleAccel', (v) => `${v.toFixed(1)} m/s²`],
        ['surf-paddle-speed', 'val-surf-paddle-speed', 'paddleMaxSpeed', (v) => `${v.toFixed(1)} m/s`],
        ['surf-paddle-turn', 'val-surf-paddle-turn', 'paddleTurnRate', (v) => `${v.toFixed(2)} rad/s`],
        ['surf-takeoff-speed', 'val-surf-takeoff-speed', 'takeOffSpeed', (v) => `${v.toFixed(1)} m/s`],
        ['surf-gravity-gain', 'val-surf-gravity-gain', 'faceGravityGain', (v) => `${v.toFixed(2)}x`],
        ['surf-curl-push', 'val-surf-curl-push', 'curlPushGain', (v) => `${v.toFixed(2)}x`],
        ['surf-ride-accel', 'val-surf-ride-accel', 'rideAccel', (v) => `${v.toFixed(1)} m/s²`],
        ['surf-carve-speed', 'val-surf-carve-speed', 'carveTurnSpeed', (v) => `${v.toFixed(2)}x`],
        ['surf-carve-radius', 'val-surf-carve-radius', 'carveMinRadius', (v) => `${v.toFixed(1)} m`],
        ['surf-pump-gain', 'val-surf-pump-gain', 'railPumpGain', (v) => `${v.toFixed(2)}x`],
        ['surf-slip-loss', 'val-surf-slip-loss', 'carveSlipLoss', (v) => `${v.toFixed(2)}`],
        ['surf-ride-drag', 'val-surf-ride-drag', 'rideDrag', (v) => `${v.toFixed(2)}`],
        ['surf-stall-brake', 'val-surf-stall-brake', 'stallBrake', (v) => `${v.toFixed(1)}x`],
      ];

      for (const [id, valId, key, fmt] of mobilityBindings) {
        this._bindSlider(id, valId, m, key, fmt);
      }

      const resetMobilityBtn = document.getElementById('reset-mobility-btn');
      if (resetMobilityBtn) {
        resetMobilityBtn.addEventListener('click', () => {
          this.surferPov.resetMobility();
          for (const [id, valId, key, fmt] of mobilityBindings) {
            const el = document.getElementById(id);
            const valEl = document.getElementById(valId);
            if (el) el.value = m[key];
            if (valEl) valEl.textContent = fmt(m[key]);
          }
        });
      }
    }
  }

  _bindDetailsAndProps() {
    const p = this.oceanParams;

    const selectEl = document.getElementById('particles-select');
    if (selectEl) {
      selectEl.addEventListener('change', (e) => {
        const val = e.target.value;
        if (val === 'all') {
          p.particlesBarrel = true;
          p.particlesWhitewater = true;
          if (p.particleDensity <= 0.01) p.particleDensity = 0.6;
        } else if (val === 'no_barrel') {
          p.particlesBarrel = false;
          p.particlesWhitewater = true;
          this.spraySystem.clearType(PARTICLE_TYPE_BARREL);
          if (p.particleDensity <= 0.01) p.particleDensity = 0.6;
        } else if (val === 'no_whitewater') {
          p.particlesBarrel = true;
          p.particlesWhitewater = false;
          this.spraySystem.clearType(PARTICLE_TYPE_WHITEWATER);
          this.spraySystem.clearType(PARTICLE_TYPE_BOARD_SPRAY);
        } else if (val === 'none') {
          p.particlesBarrel = false;
          p.particlesWhitewater = false;
          this.spraySystem.clear();
        }
        this.updateDetailsUI();
      });
    }

    const barrelToggle = document.getElementById('particles-barrel-toggle');
    if (barrelToggle) {
      barrelToggle.addEventListener('change', (e) => {
        p.particlesBarrel = e.target.checked;
        if (!p.particlesBarrel) {
          this.spraySystem.clearType(PARTICLE_TYPE_BARREL);
        }
        this.updateDetailsUI();
      });
    }

    const whitewaterToggle = document.getElementById('particles-whitewater-toggle');
    if (whitewaterToggle) {
      whitewaterToggle.addEventListener('change', (e) => {
        p.particlesWhitewater = e.target.checked;
        if (!p.particlesWhitewater) {
          this.spraySystem.clearType(PARTICLE_TYPE_WHITEWATER);
          this.spraySystem.clearType(PARTICLE_TYPE_BOARD_SPRAY);
        }
        this.updateDetailsUI();
      });
    }

    const densitySlider = document.getElementById('particle-density');
    const densityVal = document.getElementById('val-particle-density');
    if (densitySlider) {
      densitySlider.addEventListener('input', () => {
        const v = parseFloat(densitySlider.value);
        p.particleDensity = v / 100.0;
        if (densityVal) densityVal.textContent = `${Math.round(v)}%`;
        if (p.particleDensity <= 0.005) {
          this.spraySystem.clear();
        }
        this.updateDetailsUI();
      });
    }

    const crowdToggle = document.getElementById('crowd-toggle');
    if (crowdToggle) {
      crowdToggle.addEventListener('change', (e) => {
        p.crowdEnabled = e.target.checked;
        this.crowdSystem.setCrowdVisible(p.crowdEnabled);
        this.updateDetailsUI();
      });
    }

    const towelsToggle = document.getElementById('towels-toggle');
    if (towelsToggle) {
      towelsToggle.addEventListener('change', (e) => {
        p.towelsEnabled = e.target.checked;
        this.crowdSystem.setPropsVisible(p.towelsEnabled);
        this.updateDetailsUI();
      });
    }

    const reflectionToggle = document.getElementById('reflection-toggle');
    if (reflectionToggle) {
      reflectionToggle.addEventListener('change', (e) => {
        p.reflectionsEnabled = e.target.checked;
        if (this.oceanMat?.uniforms?.uReflectionStrength) {
          this.oceanMat.uniforms.uReflectionStrength.value = p.reflectionsEnabled ? 1.0 : 0.0;
        }
        this.updateDetailsUI();
      });
    }
  }

  _bindPresetAndModeSelectors() {
    const p = this.oceanParams;

    // Bathymetry Preset Selector
    const presetSelect = document.getElementById('preset-select');
    if (presetSelect) {
      presetSelect.addEventListener('change', (e) => {
        const preset = e.target.value;
        this.btyManager.sculptOffset.fill(0);
        this.btyManager.generatePreset(preset);
        this.applyCameraPreset(document.getElementById('camera-select')?.value || 'overview');

        const presetInterference = {
          right_point: { bw: 0.35, sw: 0.75, sh: 2.2, sp: 14.0, sAngle: 35.0 },
          left_point: { bw: 0.35, sw: 0.75, sh: 2.2, sp: 14.0, sAngle: 35.0 },
          jetty_wedge: { bw: 0.75, sw: 1.35, sh: 1.8, sp: 12.0, sAngle: 40.0 },
          reef_pass: { bw: 0.20, sw: 0.65, sh: 2.5, sp: 15.0, sAngle: 30.0 },
          aframe_reef: { bw: 0.30, sw: 0.65, sh: 2.2, sp: 13.0, sAngle: 35.0 },
          beach_break: { bw: 0.65, sw: 0.55, sh: 1.8, sp: 11.0, sAngle: 25.0 },
          rivermouth: { bw: 0.30, sw: 0.65, sh: 2.0, sp: 14.0, sAngle: 35.0 },
          nazare: { bw: 1.15, sw: 2.10, sh: 8.5, sp: 18.0, sAngle: 46.0 },
        }[preset];

        if (presetInterference) {
          p.backwashStrength = presetInterference.bw;
          p.sideWaveStrength = presetInterference.sw;
          if (presetInterference.sh) p.swellHeight = presetInterference.sh;
          if (presetInterference.sp) p.swellPeriod = presetInterference.sp;
          if (presetInterference.sAngle) p.sideWaveAngle = presetInterference.sAngle;

          const bwEl = document.getElementById('backwash-strength');
          const swEl = document.getElementById('sidewave-strength');
          const shEl = document.getElementById('swell-height');
          const spEl = document.getElementById('swell-period');
          const saEl = document.getElementById('sidewave-angle');

          if (bwEl) bwEl.value = presetInterference.bw;
          if (swEl) swEl.value = presetInterference.sw;
          if (shEl && presetInterference.sh) shEl.value = presetInterference.sh;
          if (spEl && presetInterference.sp) spEl.value = presetInterference.sp;
          if (saEl && presetInterference.sAngle) saEl.value = presetInterference.sAngle;

          const valBw = document.getElementById('val-backwash');
          const valSw = document.getElementById('val-sidewave-strength');
          const valSh = document.getElementById('val-swell-height');
          const valSp = document.getElementById('val-swell-period');
          const valSa = document.getElementById('val-sidewave-angle');

          if (valBw) valBw.textContent = `${presetInterference.bw.toFixed(2)}x`;
          if (valSw) valSw.textContent = `${presetInterference.sw.toFixed(2)}x`;
          if (valSh && presetInterference.sh) {
            const ft = (presetInterference.sh * 3.28084).toFixed(1);
            valSh.textContent = `${presetInterference.sh.toFixed(1)} m (${ft} ft)`;
          }
          if (valSp && presetInterference.sp) {
            valSp.textContent = `${presetInterference.sp.toFixed(0)} s (${presetInterference.sp >= 14 ? 'Groundswell' : 'Mid-Period'})`;
          }
          if (valSa && presetInterference.sAngle) valSa.textContent = `${presetInterference.sAngle}°`;
        }

        this.waveSolver.warmup(p, 300);
        this.spraySystem.warmup(p, this.waveSolver, 45);
        this.crowdSystem.populate(this.btyManager, p.tideLevel);
        this.syncUIAndTelemetry();
      });
    }

    // Visualization Mode Selector
    const vizSelect = document.getElementById('viz-select');
    if (vizSelect) {
      vizSelect.addEventListener('change', (e) => {
        const mode = e.target.value;
        this.oceanMat.wireframe = mode === 'wireframe';
        if (mode === 'realistic') this.oceanMat.uniforms.uVizMode.value = 0;
        else if (mode === 'xray') this.oceanMat.uniforms.uVizMode.value = 1;
        else if (mode === 'heatmap') this.oceanMat.uniforms.uVizMode.value = 2;
        else if (mode === 'wireframe') this.oceanMat.uniforms.uVizMode.value = 3;
      });
    }

    // Camera Preset Selector
    const cameraSelect = document.getElementById('camera-select');
    if (cameraSelect) {
      cameraSelect.addEventListener('change', (e) => {
        this.applyCameraPreset(e.target.value);
      });
    }

    // Simulation Speed Selector (plus [ and ] keyboard shortcuts to step speed down/up while surfing)
    const speedSelect = document.getElementById('speed-select');
    if (speedSelect) {
      speedSelect.addEventListener('change', (e) => {
        p.timeScale = parseFloat(e.target.value) || 1.0;
        this.updateSetCountdownUI(true);
        speedSelect.blur();
      });

      window.addEventListener('keydown', (e) => {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
        if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
          const opts = Array.from(speedSelect.options);
          const curIdx = Math.max(0, speedSelect.selectedIndex);
          const nextIdx = e.code === 'BracketRight'
            ? Math.min(opts.length - 1, curIdx + 1)
            : Math.max(0, curIdx - 1);
          if (nextIdx !== curIdx) {
            speedSelect.selectedIndex = nextIdx;
            p.timeScale = parseFloat(opts[nextIdx].value) || 1.0;
            this.updateSetCountdownUI(true);
          }
        }
      });
    }

    // Pause Button
    const pauseBtn = document.getElementById('pause-btn');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => {
        const isPaused = !this.getIsPaused();
        this.setIsPaused(isPaused);
        pauseBtn.classList.toggle('active', isPaused);
        pauseBtn.textContent = isPaused ? '▶ Resume' : '⏸ Pause';
      });
    }
  }

  _bindPanelCollapses() {
    document.querySelectorAll('.collapse-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const body = document.getElementById(btn.dataset.target);
        const panel = btn.closest('.panel');
        if (body && panel) {
          const isCollapsed = body.classList.toggle('collapsed');
          panel.classList.toggle('collapsed-panel', isCollapsed);
          btn.textContent = isCollapsed ? '+' : '−';
        }
      });
    });
  }

  updateDetailsUI() {
    const p = this.oceanParams;
    const barrelToggle = document.getElementById('particles-barrel-toggle');
    const whitewaterToggle = document.getElementById('particles-whitewater-toggle');
    const crowdToggle = document.getElementById('crowd-toggle');
    const towelsToggle = document.getElementById('towels-toggle');
    const reflectionToggle = document.getElementById('reflection-toggle');
    const selectEl = document.getElementById('particles-select');
    const badgeEl = document.getElementById('details-badge');

    if (barrelToggle && barrelToggle.checked !== !!p.particlesBarrel) {
      barrelToggle.checked = !!p.particlesBarrel;
    }
    if (whitewaterToggle && whitewaterToggle.checked !== !!p.particlesWhitewater) {
      whitewaterToggle.checked = !!p.particlesWhitewater;
    }
    if (crowdToggle && crowdToggle.checked !== !!p.crowdEnabled) {
      crowdToggle.checked = !!p.crowdEnabled;
    }
    if (towelsToggle && towelsToggle.checked !== !!p.towelsEnabled) {
      towelsToggle.checked = !!p.towelsEnabled;
    }
    if (reflectionToggle && reflectionToggle.checked !== (p.reflectionsEnabled !== false)) {
      reflectionToggle.checked = p.reflectionsEnabled !== false;
    }

    if (selectEl) {
      let targetVal = 'all';
      if (!p.particlesBarrel && !p.particlesWhitewater) {
        targetVal = 'none';
      } else if (!p.particlesBarrel) {
        targetVal = 'no_barrel';
      } else if (!p.particlesWhitewater) {
        targetVal = 'no_whitewater';
      }
      if (selectEl.value !== targetVal) selectEl.value = targetVal;
    }

    if (badgeEl) {
      const hasParticles = p.particlesBarrel || p.particlesWhitewater;
      const hasCrowd = !!p.crowdEnabled;
      const hasProps = !!p.towelsEnabled;

      if (hasParticles && hasCrowd && hasProps) {
        badgeEl.textContent = 'Full Detail';
        badgeEl.className = 'badge';
      } else if (hasCrowd && hasProps && !hasParticles) {
        badgeEl.textContent = 'Props Only';
        badgeEl.className = 'badge subtle';
      } else if (!hasCrowd && !hasProps && !hasParticles) {
        badgeEl.textContent = 'Minimal';
        badgeEl.className = 'badge subtle';
      } else {
        badgeEl.textContent = 'Custom';
        badgeEl.className = 'badge subtle';
      }
    }
  }

  updateSetCountdownUI(cachedTelemetry) {
    const metricSetPeriod = document.getElementById('metric-set-period');
    const metricSetLull = document.getElementById('metric-set-lull');
    if (!metricSetPeriod || !metricSetLull) return;

    const status = this.waveSolver.getSetCountdown(this.oceanParams);
    const key = `${status.isContinuous}-${status.isSetActive}-${status.secondsRemaining}-${status.setCycleSec}`;
    if (key === this.lastCountdownKey && !cachedTelemetry) return;
    this.lastCountdownKey = key;

    const setWavesCount = Math.max(2, Math.round((this.oceanParams.wavesPerSet ?? 6) * 0.48));
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

  syncUIAndTelemetry() {
    const p = this.oceanParams;
    this.oceanMat.uniforms.uWindSpeed.value = p.windSpeed;
    this.oceanMat.uniforms.uWindDir.value = p.windDir;
    this.oceanMat.uniforms.uTideLevel.value = p.tideLevel;
    if (this.oceanMat.uniforms.uReflectionStrength) {
      this.oceanMat.uniforms.uReflectionStrength.value = (p.reflectionsEnabled !== false) ? 1.0 : 0.0;
    }

    this.updateSunLighting(p);

    const interBadge = document.getElementById('interference-badge');
    if (interBadge) {
      if (p.backwashStrength > 0.8 && p.sideWaveStrength > 0.8) {
        interBadge.textContent = 'High Reflection PDE';
      } else {
        interBadge.textContent = '2D PDE Active';
      }
    }

    const t = evaluateSurfTelemetry(p, this.btyManager);

    const swellEnergyEl = document.getElementById('swell-energy-badge');
    if (swellEnergyEl) swellEnergyEl.textContent = `${t.swellEnergyKJ} kJ`;

    const windBadge = document.getElementById('wind-regime-badge');
    if (windBadge) {
      const absWindAngle = Math.abs(p.windDir);
      if (p.windSpeed < 3) {
        windBadge.textContent = 'Glassy Calm';
      } else if (absWindAngle < 45) {
        windBadge.textContent = 'Clean Offshore';
      } else if (absWindAngle < 115) {
        windBadge.textContent = 'Cross-Shore';
      } else {
        windBadge.textContent = 'Onshore Chop';
      }
    }

    const tideBadge = document.getElementById('tide-stage-badge');
    if (tideBadge) {
      if (p.tideLevel < -0.5) tideBadge.textContent = 'Low Tide Drain';
      else if (p.tideLevel > 0.8) tideBadge.textContent = 'High Tide Push';
      else tideBadge.textContent = 'Mid Tide';
    }

    const setElText = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    const setElHtml = (id, html) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = html;
    };

    setElText('metric-break-type', t.breakType);
    setElText('metric-surf-rating', `★ ${t.score.toFixed(1)}/10 — ${t.ratingLabel}`);

    const faceFt = (t.breakingFaceHeight * 3.28084).toFixed(1);
    setElHtml('metric-face-height', `${t.breakingFaceHeight.toFixed(1)} m <small>(${faceFt} ft)</small>`);
    setElText('metric-shoaling-factor', `Shoaling Amp: ${t.shoalingAmp.toFixed(2)}x`);

    setElText('metric-iribarren', t.iribarren.toFixed(2));
    setElText('metric-lip-pitch', t.lipPitchDesc);

    setElHtml('metric-wavelength', `L<sub>0</sub>: ${Math.round(t.L0)} m`);
    const kts = (t.waveSpeed * 1.94384).toFixed(1);
    setElText('metric-wave-speed', `Break Speed: ${t.waveSpeed.toFixed(1)} m/s (${kts} kts)`);

    setElText('metric-peel-angle', `${t.peelAngle}° Peel`);
    setElText('metric-peel-desc', t.peelDesc);

    const valWavesPerSet = document.getElementById('val-waves-per-set');
    if (valWavesPerSet) {
      valWavesPerSet.textContent = `${t.wavesPerSet} waves (${t.setPeriodSec} s Set)`;
    }

    this.updateSetCountdownUI(t);

    if (this.minimapCanvas) {
      this.btyManager.renderMinimap(this.minimapCanvas, p.tideLevel, p.swellDir);
    }
    this.updateDetailsUI();
  }
}
