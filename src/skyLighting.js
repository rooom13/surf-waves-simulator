import * as THREE from 'three';

/**
 * Creates and manages the sky dome and directional sun lighting.
 */
export function setupSkyLighting(scene, oceanMat) {
  const ambientLight = new THREE.HemisphereLight(0x93c5fd, 0x1e293b, 0.9);
  scene.add(ambientLight);

  const sunLight = new THREE.DirectionalLight(0xfffbeb, 2.2);
  sunLight.position.set(80, 95, -140);
  scene.add(sunLight);

  const skyGeom = new THREE.SphereGeometry(1400, 32, 20);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0.4, 0.48, -0.75).normalize() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldDirection;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldDirection = normalize(wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      varying vec3 vWorldDirection;
      void main() {
        vec3 d = normalize(vWorldDirection);
        float y = clamp(d.y, 0.0, 1.0);
        float sunElev = clamp(uSunDir.y, 0.05, 1.0);

        vec3 zenith = mix(vec3(0.10, 0.20, 0.38), vec3(0.15, 0.42, 0.72), sunElev);
        vec3 horizon = mix(vec3(0.88, 0.52, 0.32), vec3(0.68, 0.85, 0.95), sunElev);
        vec3 col = mix(horizon, zenith, pow(y, 0.55));

        float sunDot = max(0.0, dot(d, normalize(uSunDir)));
        col += vec3(1.0, 0.85, 0.62) * pow(sunDot, 28.0) * 0.55;
        col += vec3(1.0, 0.98, 0.90) * smoothstep(0.9985, 0.9998, sunDot) * 2.5;

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const skyDome = new THREE.Mesh(skyGeom, skyMat);
  scene.add(skyDome);

  // Pre-allocated vector for zero-allocation updates in animation/UI calls
  const sunDir = new THREE.Vector3();

  function updateSunLighting(oceanParams) {
    const elevRad = (oceanParams.sunElevation * Math.PI) / 180;
    const azimRad = (-145 * Math.PI) / 180;
    sunDir
      .set(
        Math.cos(elevRad) * Math.sin(azimRad),
        Math.sin(elevRad),
        Math.cos(elevRad) * Math.cos(azimRad)
      )
      .normalize();

    sunLight.position.copy(sunDir).multiplyScalar(180);
    oceanMat.uniforms.uSunDir.value.copy(sunDir);
    skyMat.uniforms.uSunDir.value.copy(sunDir);
  }

  return {
    ambientLight,
    sunLight,
    skyMat,
    skyDome,
    updateSunLighting,
  };
}
