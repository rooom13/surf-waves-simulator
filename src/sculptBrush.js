import * as THREE from 'three';

/**
 * Manages the interactive 3D seabed sculpting brush cursor, raycasting,
 * brush UI controls, and terrain height modifications.
 */
export class SculptBrush {
  constructor({ scene, camera, domElement, btyManager, getTideLevel, onTerrainModified, onTerrainReset }) {
    this.scene = scene;
    this.camera = camera;
    this.domElement = domElement;
    this.btyManager = btyManager;
    this.getTideLevel = getTideLevel || (() => 0.2);
    this.onTerrainModified = onTerrainModified || (() => {});
    this.onTerrainReset = onTerrainReset || (() => {});

    this.state = {
      mode: 'none', // 'none' | 'raise' | 'jetty' | 'lower' | 'smooth'
      radius: 24.0,
      strength: 0.5,
      isPointerDown: false,
      hitPoint: new THREE.Vector3(),
      hasHit: false,
    };

    // 3D Ring Cursor Mesh
    const ringGeom = new THREE.RingGeometry(0.92, 1.0, 48);
    ringGeom.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    });
    this.cursorMesh = new THREE.Mesh(ringGeom, ringMat);
    this.cursorMesh.visible = false;
    this.cursorMesh.scale.set(this.state.radius, 1, this.state.radius);
    this.scene.add(this.cursorMesh);

    // Pre-allocated raycaster structures
    this.raycaster = new THREE.Raycaster();
    this.pointerNDC = new THREE.Vector2();

    this._bindUI();
    this._bindPointerEvents();
  }

  isSculpting() {
    return this.state.mode !== 'none';
  }

  _bindUI() {
    const brushButtons = document.querySelectorAll('.brush-btn');
    const brushSettings = document.getElementById('brush-settings');
    const brushStatusBadge = document.getElementById('brush-status-badge');

    brushButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        brushButtons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.state.mode = btn.dataset.brush;

        const isSculpting = this.state.mode !== 'none';
        this.cursorMesh.visible = isSculpting;
        brushSettings?.classList.toggle('visible', isSculpting);

        const labels = {
          none: 'Orbit Mode',
          raise: 'Raise Reef/Bar',
          jetty: 'Build Jetty/Wall',
          lower: 'Dig Channel',
          smooth: 'Smooth Terrain',
        };
        if (brushStatusBadge) {
          brushStatusBadge.textContent = labels[this.state.mode] || 'Orbit Mode';
        }
      });
    });

    // Brush Radius Slider
    const radiusSlider = document.getElementById('brush-radius');
    const valRadius = document.getElementById('val-brush-radius');
    if (radiusSlider) {
      radiusSlider.addEventListener('input', () => {
        const v = parseFloat(radiusSlider.value);
        this.state.radius = v;
        if (valRadius) valRadius.textContent = `${v} m`;
        this.cursorMesh.scale.set(v, 1, v);
      });
    }

    // Brush Strength Slider
    const strengthSlider = document.getElementById('brush-strength');
    const valStrength = document.getElementById('val-brush-strength');
    if (strengthSlider) {
      strengthSlider.addEventListener('input', () => {
        const v = parseFloat(strengthSlider.value);
        this.state.strength = v;
        if (valStrength) valStrength.textContent = v.toFixed(1);
      });
    }

    // Reset Terrain Button
    document.getElementById('reset-terrain-btn')?.addEventListener('click', () => {
      this.btyManager.resetSculpt();
      this.onTerrainReset();
    });
  }

  _updateRaycast(event) {
    if (this.state.mode === 'none') return;
    const rect = this.domElement.getBoundingClientRect();
    this.pointerNDC.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNDC.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointerNDC, this.camera);
    const hits = this.raycaster.intersectObject(this.btyManager.mesh);
    if (hits.length > 0) {
      this.state.hasHit = true;
      this.state.hitPoint.copy(hits[0].point);
      const tide = this.getTideLevel();
      this.cursorMesh.position.set(
        this.state.hitPoint.x,
        Math.max(this.state.hitPoint.y + 0.25, tide + 0.25),
        this.state.hitPoint.z
      );
    } else {
      this.state.hasHit = false;
    }
  }

  _bindPointerEvents() {
    this.domElement.addEventListener('pointerdown', (e) => {
      if (this.state.mode !== 'none' && e.button === 0) {
        this.state.isPointerDown = true;
        this._updateRaycast(e);
      }
    });

    window.addEventListener('pointermove', (e) => {
      if (this.state.mode !== 'none') {
        this._updateRaycast(e);
      }
    });

    window.addEventListener('pointerup', () => {
      this.state.isPointerDown = false;
    });
  }

  update(dt) {
    if (this.state.mode !== 'none' && this.state.isPointerDown && this.state.hasHit) {
      const changed = this.btyManager.applyBrush(
        this.state.hitPoint.x,
        this.state.hitPoint.z,
        this.state.mode,
        this.state.radius,
        this.state.strength,
        dt
      );
      if (changed) {
        this.onTerrainModified();
      }
    }
  }
}
