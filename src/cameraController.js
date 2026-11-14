import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * Manages the perspective camera, OrbitControls, Minecraft-style free-look drag,
 * WASD/QE fly-through movement, and camera presets.
 */
export class CameraController {
  constructor({ camera, domElement, getBtyPreset, isSculpting, isSurferActive, onSurferKey, onSurfModeRequest }) {
    this.camera = camera;
    this.domElement = domElement;
    this.getBtyPreset = getBtyPreset;
    this.isSculpting = isSculpting || (() => false);
    this.isSurferActive = isSurferActive || (() => false);
    this.onSurferKey = onSurferKey || (() => {});
    this.onSurfModeRequest = onSurfModeRequest || (() => {});

    // OrbitControls
    this.controls = new OrbitControls(this.camera, this.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.target.set(30, 0, -40);
    this.controls.minPolarAngle = 0.02;
    this.controls.maxPolarAngle = Math.PI * 0.96; // Allow inspecting underwater seabed
    this.controls.minDistance = 3;
    this.controls.maxDistance = 850;
    this.controls.screenSpacePanning = true;
    this.controls.panSpeed = 1.35;
    this.controls.mouseButtons = {
      LEFT: null, // Left-drag handled as free-look
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN,
    };

    // Pre-allocated vectors for WASD & free-look (zero allocations in hot loop)
    this.camMoveVelocity = new THREE.Vector3();
    this.camForward = new THREE.Vector3();
    this.camRight = new THREE.Vector3();
    this.worldUp = new THREE.Vector3(0, 1, 0);
    this.desiredVel = new THREE.Vector3();
    this.deltaMove = new THREE.Vector3();
    this.freeLookDir = new THREE.Vector3();

    // Free-look state
    this.freeLook = { dragging: false, lastX: 0, lastY: 0 };

    // Keyboard state
    this.keyState = {
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

    this._bindEvents();
  }

  _bindEvents() {
    // Prevent middle-click browser autoscroll
    const preventMiddle = (e) => {
      if (e.button === 1) e.preventDefault();
    };
    this.domElement.addEventListener('mousedown', preventMiddle);
    this.domElement.addEventListener('auxclick', preventMiddle);

    // Free-look: left-drag turns view around camera's own position
    this.domElement.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.isSurferActive() || this.isSculpting()) return;
      this.freeLook.dragging = true;
      this.freeLook.lastX = e.clientX;
      this.freeLook.lastY = e.clientY;
      this.domElement.style.cursor = 'grabbing';
    });

    window.addEventListener('pointermove', (e) => {
      if (!this.freeLook.dragging) return;
      const dx = e.clientX - this.freeLook.lastX;
      const dy = e.clientY - this.freeLook.lastY;
      this.freeLook.lastX = e.clientX;
      this.freeLook.lastY = e.clientY;

      this.freeLookDir.subVectors(this.controls.target, this.camera.position);
      const dist = Math.max(3, this.freeLookDir.length());
      this.freeLookDir.normalize();

      let yaw = Math.atan2(this.freeLookDir.x, this.freeLookDir.z);
      let pitch = Math.asin(Math.max(-1, Math.min(1, this.freeLookDir.y)));
      yaw -= dx * 0.0042;
      pitch = Math.max(-1.5, Math.min(1.5, pitch - dy * 0.0042));

      this.freeLookDir.set(
        Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        Math.cos(yaw) * Math.cos(pitch)
      );
      this.controls.target.copy(this.camera.position).addScaledVector(this.freeLookDir, dist);
    });

    window.addEventListener('pointerup', () => {
      if (this.freeLook.dragging) {
        this.freeLook.dragging = false;
        this.domElement.style.cursor = '';
      }
    });

    // Keyboard handlers
    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement ? document.activeElement.tagName : '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      if (this.isSurferActive()) {
        const handled = this.onSurferKey(e);
        if (handled) return;
      }

      if (e.code in this.keyState) {
        this.keyState[e.code] = true;
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code in this.keyState) {
        this.keyState[e.code] = false;
      }
    });

    window.addEventListener('blur', () => {
      Object.keys(this.keyState).forEach((k) => {
        this.keyState[k] = false;
      });
    });
  }

  update(dt) {
    let moveZ = 0;
    let moveX = 0;
    let moveY = 0;

    const ks = this.keyState;
    if (ks.KeyW || ks.ArrowUp) moveZ += 1;
    if (ks.KeyS || ks.ArrowDown) moveZ -= 1;
    if (ks.KeyD || ks.ArrowRight) moveX += 1;
    if (ks.KeyA || ks.ArrowLeft) moveX -= 1;
    if (ks.KeyE) moveY += 1;
    if (ks.KeyQ) moveY -= 1;

    const baseSpeed = ks.ShiftLeft || ks.ShiftRight ? 95.0 : 42.0;

    this.camera.getWorldDirection(this.camForward);
    this.camForward.normalize();

    const horizForward = this.camRight.set(this.camForward.x, 0, this.camForward.z);
    if (horizForward.lengthSq() < 0.0001) {
      horizForward.set(0, 0, -1);
    } else {
      horizForward.normalize();
    }
    this.camRight.crossVectors(horizForward, this.worldUp).normalize();

    this.desiredVel.set(0, 0, 0);
    this.desiredVel.addScaledVector(this.camForward, moveZ);
    this.desiredVel.addScaledVector(this.camRight, moveX);
    this.desiredVel.y += moveY;

    if (this.desiredVel.lengthSq() > 0) {
      this.desiredVel.normalize().multiplyScalar(baseSpeed);
    }

    this.camMoveVelocity.lerp(this.desiredVel, Math.min(1.0, dt * 10.0));

    if (this.camMoveVelocity.lengthSq() > 0.01) {
      this.deltaMove.copy(this.camMoveVelocity).multiplyScalar(dt);
      // Allow diving underwater down to -24m to inspect the 3D ground structure
      if (this.camera.position.y + this.deltaMove.y < -24.0) {
        this.deltaMove.y = Math.max(0, -24.0 - this.camera.position.y);
      }
      this.camera.position.add(this.deltaMove);
      this.controls.target.add(this.deltaMove);
    }

    if (this.controls.enabled) {
      this.controls.update();
    }
  }

  applyCameraPreset(cameraMode) {
    if (cameraMode === 'surf_third') {
      this.onSurfModeRequest('third_person');
      return;
    }
    if (cameraMode === 'surf_pov') {
      this.onSurfModeRequest('first_person');
      return;
    }

    if (this.isSurferActive()) {
      this.onSurfModeRequest('exit');
    }

    const preset = this.getBtyPreset();
    // Shoulder camera on the open surf side (+x for left_point/jetty_wedge/rivermouth, -x for right_point/reef_pass)
    const sideSign = preset === 'left_point' || preset === 'jetty_wedge' || preset === 'rivermouth' ? 1 : -1;

    if (preset === 'nazare') {
      if (cameraMode === 'cliff') {
        // High perched view right from Farol da Nazaré lighthouse fortress overlooking Praia do Norte
        this.camera.position.set(-36, 42, -14);
        this.controls.target.set(35, 6, -20);
        return;
      } else if (cameraMode === 'lineup') {
        this.camera.position.set(65, 20, -115);
        this.controls.target.set(30, 4, -20);
        return;
      } else if (cameraMode === 'barrel') {
        this.camera.position.set(55, 10, -50);
        this.controls.target.set(15, 4, -20);
        return;
      } else if (cameraMode === 'overview') {
        this.camera.position.set(90, 140, 220);
        this.controls.target.set(0, 0, -25);
        return;
      }
    }

    if (cameraMode === 'overview') {
      this.camera.position.set(160 * sideSign, 95, 230);
      this.controls.target.set(-30 * sideSign, 0, -40);
    } else if (cameraMode === 'underwater') {
      this.camera.position.set(110 * -sideSign, -8, -120);
      this.controls.target.set(30 * -sideSign, -3, -60);
    } else if (cameraMode === 'lineup') {
      this.camera.position.set(175 * -sideSign, 12, -145);
      this.controls.target.set(155 * -sideSign, 2, -220);
    } else if (cameraMode === 'barrel') {
      this.camera.position.set(120 * -sideSign, 5, -110);
      this.controls.target.set(40 * -sideSign, 2, -70);
    } else if (cameraMode === 'cliff') {
      this.camera.position.set(195 * -sideSign, 42, -50);
      this.controls.target.set(60 * -sideSign, 2, -120);
    } else if (cameraMode === 'topdown') {
      this.camera.position.set(0, 480, 20);
      this.controls.target.set(0, 0, 0);
    }
  }
}
