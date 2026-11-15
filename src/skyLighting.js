import * as THREE from 'three';

/**
 * Creates and manages the sky dome, procedural clouds, and directional sun lighting.
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
      uSkyZenith: { value: new THREE.Vector3(0.15, 0.42, 0.72) },
      uSkyHorizon: { value: new THREE.Vector3(0.68, 0.85, 0.95) },
      uSunColor: { value: new THREE.Vector3(1.0, 0.96, 0.88) },
      uGlowColor: { value: new THREE.Vector3(1.0, 0.85, 0.62) },
      uCloudLit: { value: new THREE.Vector3(1.0, 0.98, 0.96) },
      uCloudShadow: { value: new THREE.Vector3(0.56, 0.67, 0.82) },
      uCloudCover: { value: 0.35 },
      uTime: { value: 0.0 },
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
      uniform vec3 uSkyZenith;
      uniform vec3 uSkyHorizon;
      uniform vec3 uSunColor;
      uniform vec3 uGlowColor;
      uniform vec3 uCloudLit;
      uniform vec3 uCloudShadow;
      uniform float uCloudCover;
      uniform float uTime;
      varying vec3 vWorldDirection;

      float hash21(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
          mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
          u.y
        );
      }

      float fbmCloud(vec2 p) {
        float v = 0.0;
        float amp = 0.52;
        const mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
        for (int i = 0; i < 4; i++) {
          v += amp * vnoise(p);
          p = rot * p * 2.07 + vec2(13.1, 7.7);
          amp *= 0.50;
        }
        return v;
      }

      void main() {
        vec3 d = normalize(vWorldDirection);
        float y = clamp(d.y, 0.0, 1.0);
        vec3 sDir = normalize(uSunDir);

        // Sky gradient + directional horizon warmth toward the sun
        float sunDot = max(0.0, dot(d, sDir));
        vec3 horizonCol = mix(uSkyHorizon, uGlowColor, pow(sunDot, 3.0) * (1.0 - y) * 0.55);
        vec3 col = mix(horizonCol, uSkyZenith, pow(y, 0.55));

        // Sun halo & solar disc
        col += uGlowColor * pow(sunDot, 22.0) * 0.58;
        col += uSunColor * smoothstep(0.9985, 0.9998, sunDot) * 2.6;

        // Procedural clouds on a curved sky layer above the horizon
        if (uCloudCover > 0.01 && d.y > 0.015) {
          vec2 cloudUV = d.xz / (d.y + 0.16);
          vec2 drift = vec2(uTime * 0.0045, uTime * 0.0022);
          float baseNoise = fbmCloud(cloudUV * 0.42 + drift);

          float threshold = mix(0.76, 0.24, clamp(uCloudCover, 0.0, 1.0));
          float density = smoothstep(threshold - 0.14, threshold + 0.24, baseNoise);

          // Sample slightly toward sun for sunlit rims vs. shaded cloud bellies
          vec2 sunStep = normalize(sDir.xz + vec2(0.0001)) * 0.14;
          float shadowNoise = fbmCloud((cloudUV + sunStep) * 0.42 + drift);
          float litFactor = clamp(0.55 + (baseNoise - shadowNoise) * 2.4, 0.0, 1.0);

          // Forward-scattering silver/gold lining when looking near the sun
          float silverLining = pow(sunDot, 6.0) * (1.0 - density * 0.55) * 0.65;
          vec3 cloudCol = mix(uCloudShadow, uCloudLit, litFactor);
          cloudCol += uGlowColor * silverLining;

          // Fade clouds smoothly into horizon atmospheric haze
          float horizonFade = smoothstep(0.015, 0.19, d.y);
          float cloudAlpha = density * horizonFade * (0.72 + 0.20 * uCloudCover);
          col = mix(col, cloudCol, clamp(cloudAlpha, 0.0, 0.94));
        }

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const skyDome = new THREE.Mesh(skyGeom, skyMat);
  scene.add(skyDome);

  // Pre-allocated vectors/colors for zero-allocation updates
  const sunDir = new THREE.Vector3();
  const cZenith = new THREE.Color();
  const cHorizon = new THREE.Color();
  const cSun = new THREE.Color();
  const cGlow = new THREE.Color();
  const cCloudLit = new THREE.Color();
  const cCloudShadow = new THREE.Color();
  const cAmbientSky = new THREE.Color();
  const cAmbientGround = new THREE.Color();

  // Palettes: Sunrise (rose/peach/lavender), Sunset (fiery amber/magenta/indigo), Daylight (coastal blue)
  const dayZenith = new THREE.Color(0.15, 0.42, 0.72);
  const dayHorizon = new THREE.Color(0.68, 0.85, 0.95);
  const dayLowZenith = new THREE.Color(0.10, 0.22, 0.42);
  const dayLowHorizon = new THREE.Color(0.88, 0.60, 0.40);

  const sunriseZenith = new THREE.Color(0.12, 0.21, 0.46);
  const sunriseHorizon = new THREE.Color(0.95, 0.58, 0.56);
  const sunriseSun = new THREE.Color(1.0, 0.86, 0.76);
  const sunriseGlow = new THREE.Color(1.0, 0.68, 0.60);
  const sunriseCloudLit = new THREE.Color(1.0, 0.80, 0.76);
  const sunriseCloudShadow = new THREE.Color(0.48, 0.44, 0.64);

  const sunsetZenith = new THREE.Color(0.09, 0.12, 0.32);
  const sunsetHorizon = new THREE.Color(0.95, 0.38, 0.20);
  const sunsetSun = new THREE.Color(1.0, 0.70, 0.34);
  const sunsetGlow = new THREE.Color(1.0, 0.46, 0.22);
  const sunsetCloudLit = new THREE.Color(1.0, 0.60, 0.34);
  const sunsetCloudShadow = new THREE.Color(0.38, 0.24, 0.42);

  const daySun = new THREE.Color(1.0, 0.97, 0.90);
  const dayGlow = new THREE.Color(1.0, 0.88, 0.66);
  const dayCloudLit = new THREE.Color(0.98, 0.99, 1.0);
  const dayCloudShadow = new THREE.Color(0.56, 0.67, 0.82);

  const cLowZenith = new THREE.Color();
  const cLowHorizon = new THREE.Color();
  const cLowSun = new THREE.Color();
  const cLowGlow = new THREE.Color();
  const cLowCloudLit = new THREE.Color();
  const cLowCloudShadow = new THREE.Color();
  const cLowAmbient = new THREE.Color();

  const sunriseAmbient = new THREE.Color(0.62, 0.68, 0.88);
  const sunsetAmbient = new THREE.Color(0.76, 0.50, 0.58);
  const dayAmbient = new THREE.Color(0x93c5fd);

  function updateSunLighting(oceanParams) {
    // sunElevation represents the 3°..177° arc from Sunrise -> Midday -> Sunset
    const arcDeg = THREE.MathUtils.clamp(oceanParams.sunElevation ?? 125, 3, 177);
    const t = (arcDeg - 3) / 174; // 0 = Sunrise, 0.5 = Midday, 1 = Sunset

    // Sun skims 2° above the ocean at Sunrise/Sunset and arcs up to 72° at Midday
    const elevDeg = 2.0 + 70.0 * Math.sin(t * Math.PI);
    const elevRad = (elevDeg * Math.PI) / 180;
    // Sweep across the seaward horizon (+130° east -> 180° seaward -> 230°/-130° west)
    const azimDeg = 130.0 + t * 100.0;
    const azimRad = (azimDeg * Math.PI) / 180;

    sunDir
      .set(
        Math.cos(elevRad) * Math.sin(azimRad),
        Math.sin(elevRad),
        Math.cos(elevRad) * Math.cos(azimRad)
      )
      .normalize();

    // Blend between Sunrise palette (t=0) and Sunset palette (t=1) for low-sun colors
    const sunsetMix = THREE.MathUtils.smoothstep(t, 0.35, 0.65);
    cLowZenith.copy(sunriseZenith).lerp(sunsetZenith, sunsetMix);
    cLowHorizon.copy(sunriseHorizon).lerp(sunsetHorizon, sunsetMix);
    cLowSun.copy(sunriseSun).lerp(sunsetSun, sunsetMix);
    cLowGlow.copy(sunriseGlow).lerp(sunsetGlow, sunsetMix);
    cLowCloudLit.copy(sunriseCloudLit).lerp(sunsetCloudLit, sunsetMix);
    cLowCloudShadow.copy(sunriseCloudShadow).lerp(sunsetCloudShadow, sunsetMix);
    cLowAmbient.copy(sunriseAmbient).lerp(sunsetAmbient, sunsetMix);

    // Blend smoothly from low-sun (Sunrise/Sunset) into Daylight as the sun climbs
    const dayWeight = THREE.MathUtils.smoothstep(elevDeg, 3.0, 32.0);

    cZenith.copy(cLowZenith).lerp(dayZenith, dayWeight);
    cHorizon.copy(cLowHorizon).lerp(dayHorizon, dayWeight);
    cSun.copy(cLowSun).lerp(daySun, dayWeight);
    cGlow.copy(cLowGlow).lerp(dayGlow, dayWeight);
    cCloudLit.copy(cLowCloudLit).lerp(dayCloudLit, dayWeight);
    cCloudShadow.copy(cLowCloudShadow).lerp(dayCloudShadow, dayWeight);
    cAmbientSky.copy(cLowAmbient).lerp(dayAmbient, dayWeight);
    cAmbientGround.setRGB(
      0.15 - 0.03 * dayWeight,
      0.13 + 0.03 * dayWeight,
      0.20 + 0.03 * dayWeight
    );

    sunLight.intensity = 1.55 + dayWeight * 0.75;
    sunLight.position.copy(sunDir).multiplyScalar(180);
    sunLight.color.copy(cSun);
    ambientLight.color.copy(cAmbientSky);
    ambientLight.groundColor.copy(cAmbientGround);

    skyMat.uniforms.uSunDir.value.copy(sunDir);
    skyMat.uniforms.uSkyZenith.value.set(cZenith.r, cZenith.g, cZenith.b);
    skyMat.uniforms.uSkyHorizon.value.set(cHorizon.r, cHorizon.g, cHorizon.b);
    skyMat.uniforms.uSunColor.value.set(cSun.r, cSun.g, cSun.b);
    skyMat.uniforms.uGlowColor.value.set(cGlow.r, cGlow.g, cGlow.b);
    skyMat.uniforms.uCloudLit.value.set(cCloudLit.r, cCloudLit.g, cCloudLit.b);
    skyMat.uniforms.uCloudShadow.value.set(cCloudShadow.r, cCloudShadow.g, cCloudShadow.b);
    skyMat.uniforms.uCloudCover.value = oceanParams.cloudCover ?? 0.35;

    oceanMat.uniforms.uSunDir.value.copy(sunDir);
    oceanMat.uniforms.uSkyZenith.value.set(cZenith.r, cZenith.g, cZenith.b);
    oceanMat.uniforms.uSkyHorizon.value.set(cHorizon.r, cHorizon.g, cHorizon.b);
    oceanMat.uniforms.uSunColor.value.set(cSun.r, cSun.g, cSun.b);
  }

  return {
    ambientLight,
    sunLight,
    skyMat,
    skyDome,
    updateSunLighting,
  };
}
