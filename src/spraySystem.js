import * as THREE from 'three';

function createMistSpriteTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0.0, 'rgba(255, 255, 255, 0.90)');
  grad.addColorStop(0.45, 'rgba(240, 249, 255, 0.45)');
  grad.addColorStop(1.0, 'rgba(240, 249, 255, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

export class SprayParticleSystem {
  constructor(scene) {
    this.scene = scene;
    this.count = 950;

    this.positions = new Float32Array(this.count * 3);
    this.velocities = new Float32Array(this.count * 3);
    this.life = new Float32Array(this.count);
    this.maxLife = new Float32Array(this.count);

    for (let i = 0; i < this.count; i++) {
      this.life[i] = 0;
      this.maxLife[i] = 1.0 + Math.random() * 1.2;
      this.positions[i * 3 + 1] = -100;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));

    const mat = new THREE.PointsMaterial({
      color: 0xf8fafc,
      map: createMistSpriteTexture(),
      size: 1.5,
      transparent: true,
      opacity: 0.48,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(geom, mat);
    this.scene.add(this.points);
    this.spawnCursor = 0;
  }

  spawnParticle(x, y, z, vx, vy, vz, maxL) {
    const idx = this.spawnCursor;
    this.spawnCursor = (this.spawnCursor + 1) % this.count;
    this.positions[idx * 3 + 0] = x;
    this.positions[idx * 3 + 1] = y;
    this.positions[idx * 3 + 2] = z;
    this.velocities[idx * 3 + 0] = vx;
    this.velocities[idx * 3 + 1] = vy;
    this.velocities[idx * 3 + 2] = vz;
    this.life[idx] = 0.01;
    this.maxLife[idx] = maxL;
  }

  update(dt, oceanParams, waveSolver) {
    const windRad = (oceanParams.windDir * Math.PI) / 180;
    const windSpeed = oceanParams.windSpeed;
    const windVx = Math.sin(windRad) * windSpeed * 0.42;
    const windVz = -Math.cos(windRad) * windSpeed * 0.42;

    const spawnAttempts = 32;
    for (let s = 0; s < spawnAttempts; s++) {
      const rx = (Math.random() - 0.5) * 185;
      const rz = -55 + Math.random() * 125;
      const sample = waveSolver.sampleAt(rx, rz);

      // Spawn spray on breaking wave crests or high-elevation wedge/backwash peaks
      if (sample.eta > oceanParams.swellHeight * 0.36 && (sample.plunge > 0.12 || sample.foam > 0.35 || windSpeed > 10)) {
        const yPos = oceanParams.tideLevel + sample.eta + 0.12;
        const burstUp = 1.8 + Math.random() * 2.6 + sample.plunge * 2.0 + Math.max(0, sample.eta - 1.2) * 1.5;

        this.spawnParticle(
          rx + sample.dispX,
          yPos,
          rz + sample.dispZ,
          windVx + (Math.random() - 0.5) * 3.2,
          burstUp,
          windVz + (Math.random() - 0.5) * 2.6,
          0.6 + Math.random() * 0.8
        );
      }
    }

    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;

      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) {
        this.life[i] = 0;
        this.positions[i * 3 + 1] = -100;
        continue;
      }

      this.velocities[i * 3 + 1] -= 6.5 * dt;
      this.positions[i * 3 + 0] += this.velocities[i * 3 + 0] * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;
    }

    this.points.geometry.attributes.position.needsUpdate = true;
  }
}
