import * as THREE from 'three';
import { WORLD_SIZE, BTY_RES } from './bathymetry.js';

export const oceanVertexShader = /* glsl */ `
  uniform float uTime;
  uniform sampler2D uBathymetryTex;
  uniform sampler2D uWaveSimTex;
  uniform float uWorldSize;
  uniform float uBtyRes;

  uniform float uWindSpeed;
  uniform float uWindDir;
  uniform float uTideLevel;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vDepth;
  varying float vFoam;
  varying float vWaveHeight;
  varying float vSubsurface;

  // 4-tap bilinear sampling on RGBA Float texture
  vec4 sampleTexBilinear(sampler2D tex, vec2 worldXZ) {
    vec2 uv = clamp(worldXZ / uWorldSize + 0.5, 0.001, 0.999);
    vec2 texelPos = uv * (uBtyRes - 1.0);
    vec2 i0 = floor(texelPos);
    vec2 f = fract(texelPos);
    vec2 i1 = min(vec2(uBtyRes - 1.0), i0 + 1.0);

    vec4 c00 = texture2D(tex, (i0 + 0.5) / uBtyRes);
    vec4 c10 = texture2D(tex, (vec2(i1.x, i0.y) + 0.5) / uBtyRes);
    vec4 c01 = texture2D(tex, (vec2(i0.x, i1.y) + 0.5) / uBtyRes);
    vec4 c11 = texture2D(tex, (i1 + 0.5) / uBtyRes);

    return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
  }

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  // Evaluate 3D displaced ocean surface from the live 2D Hydrodynamic Wave PDE state
  vec3 evaluateSurface(
    vec2 baseXZ,
    out float outFoam,
    out float outSubsurface,
    out float outDepth
  ) {
    vec4 bty = sampleTexBilinear(uBathymetryTex, baseXZ);
    float seabedElev = bty.r;
    float depth = uTideLevel - seabedElev;
    outDepth = depth;

    if (depth <= 0.02) {
      outFoam = 0.0;
      outSubsurface = 0.0;
      return vec3(baseXZ.x, seabedElev - 0.05, baseXZ.y);
    }

    // Read live PDE simulation state:
    // R = shapedEta, G = 3D horiz dispX, B = 3D horiz dispZ, A = advected whitewater foam
    vec4 sim = sampleTexBilinear(uWaveSimTex, baseXZ);
    float eta = sim.r;
    vec2 horizDisp = sim.gb;
    float pdeFoam = sim.a;

    // Fine-scale local wind chop ripples
    float windRad = radians(uWindDir);
    float windAlignment = cos(windRad);
    float swashTaper = smoothstep(0.04, 0.85, depth);
    float windChopAmp = (uWindSpeed / 30.0) * (0.08 + 0.16 * max(0.0, -windAlignment)) * swashTaper;
    vec2 windVec = vec2(sin(windRad), -cos(windRad));
    float chop1 = noise(baseXZ * 0.42 + windVec * uTime * 2.4) * 2.0 - 1.0;
    float chop2 = noise(baseXZ * 0.98 - windVec.yx * uTime * 3.1) * 2.0 - 1.0;
    float windRipple = (chop1 * 0.65 + chop2 * 0.35) * windChopAmp;

    // Enhance foam slightly on steep pitching crests
    float crestFoamBoost = smoothstep(0.55, 1.85, eta) * smoothstep(4.5, 1.2, depth) * 0.35;
    outFoam = clamp(pdeFoam + crestFoamBoost, 0.0, 1.0);
    outSubsurface = clamp(smoothstep(0.15, 1.6, eta) * (0.5 + 0.5 * length(horizDisp) * 0.4), 0.0, 1.0);

    float totalY = max(seabedElev + 0.12, uTideLevel + eta + windRipple);
    return vec3(baseXZ.x + horizDisp.x, totalY, baseXZ.y + horizDisp.y);
  }

  void main() {
    vec2 baseXZ = position.xz;

    float foam, sss, depth;
    vec3 displacedPos = evaluateSurface(baseXZ, foam, sss, depth);

    // Compute accurate 3D surface normal via central finite differences
    float eps = 1.25;
    float fTmp, sTmp, dTmp;
    vec3 posXPlus = evaluateSurface(baseXZ + vec2(eps, 0.0), fTmp, sTmp, dTmp);
    vec3 posXMinus = evaluateSurface(baseXZ - vec2(eps, 0.0), fTmp, sTmp, dTmp);
    vec3 posZPlus = evaluateSurface(baseXZ + vec2(0.0, eps), fTmp, sTmp, dTmp);
    vec3 posZMinus = evaluateSurface(baseXZ - vec2(0.0, eps), fTmp, sTmp, dTmp);

    vec3 tangentX = posXPlus - posXMinus;
    vec3 tangentZ = posZPlus - posZMinus;
    vec3 computedNormal = normalize(cross(tangentZ, tangentX));

    vWorldPos = displacedPos;
    vNormal = computedNormal;
    vDepth = depth;
    vFoam = foam;
    vWaveHeight = displacedPos.y - uTideLevel;
    vSubsurface = sss;

    gl_Position = projectionMatrix * viewMatrix * vec4(displacedPos, 1.0);
  }
`;

export const oceanFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uCameraPos;
  uniform int uVizMode; // 0 = realistic, 1 = xray, 2 = heatmap, 3 = wireframe

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vDepth;
  varying float vFoam;
  varying float vWaveHeight;
  varying float vSubsurface;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  float fbmFoam(vec2 p) {
    float v = 0.0;
    v += 0.50 * noise(p);
    v += 0.28 * noise(p * 2.3 + vec2(1.7, 3.2));
    v += 0.22 * noise(p * 5.1 - vec2(2.4, 1.1));
    return v;
  }

  void main() {
    if (vDepth <= 0.03) {
      discard;
    }

    vec3 N = gl_FrontFacing ? normalize(vNormal) : -normalize(vNormal);
    vec3 V = normalize(uCameraPos - vWorldPos);
    vec3 L = normalize(uSunDir);

    if (uVizMode == 2) {
      float energy = clamp((vWaveHeight + 1.0) / 2.6, 0.0, 1.0);
      vec3 cold = vec3(0.05, 0.22, 0.52);
      vec3 mid = vec3(0.08, 0.78, 0.85);
      vec3 hot = vec3(0.98, 0.68, 0.12);
      vec3 tube = vec3(0.98, 0.18, 0.58);

      vec3 col = mix(cold, mid, smoothstep(0.0, 0.45, energy));
      col = mix(col, hot, smoothstep(0.40, 0.80, energy));
      col = mix(col, tube, smoothstep(0.72, 1.0, energy));
      col = mix(col, vec3(1.0), smoothstep(0.55, 0.98, vFoam) * 0.65);

      gl_FragColor = vec4(col, 0.88);
      return;
    }

    // Natural Ocean Color Absorption (Deep Sapphire -> Coastal Teal -> Shallow Emerald)
    vec3 deepWaterCol = vec3(0.02, 0.12, 0.24);
    vec3 midWaterCol = vec3(0.03, 0.28, 0.40);
    vec3 shallowWaterCol = vec3(0.07, 0.48, 0.52);

    float depthFactor = clamp(vDepth / 10.5, 0.0, 1.0);
    vec3 waterBase = mix(shallowWaterCol, midWaterCol, smoothstep(0.0, 0.45, depthFactor));
    waterBase = mix(waterBase, deepWaterCol, smoothstep(0.40, 1.0, depthFactor));

    float ndotl = max(0.0, dot(N, L));
    waterBase *= (0.72 + 0.38 * ndotl);

    // Subsurface Scattering (SSS) through thin pitching wave crests
    float backLight = pow(clamp(dot(V, -L) * 0.5 + 0.5, 0.0, 1.0), 2.4);
    float crestThinness = vSubsurface * (1.0 - abs(N.y) * 0.55);
    vec3 sssColor = vec3(0.08, 0.68, 0.62) * crestThinness * (0.32 + 0.55 * backLight);

    // Fresnel Sky Reflection
    float cosTheta = max(0.0, dot(N, V));
    float fresnel = 0.02 + 0.92 * pow(1.0 - cosTheta, 4.4);

    vec3 skyZenith = vec3(0.22, 0.48, 0.74);
    vec3 skyHorizon = vec3(0.66, 0.82, 0.92);
    vec3 R = reflect(-V, N);
    vec3 skyReflect = mix(skyHorizon, skyZenith, clamp(R.y, 0.0, 1.0));

    // Sun Specular Highlight
    vec3 H = normalize(L + V);
    float specPower = pow(max(0.0, dot(N, H)), 160.0);
    vec3 sunGlitter = vec3(1.0, 0.95, 0.84) * specPower * 1.35;

    vec3 color = mix(waterBase + sssColor, skyReflect, fresnel * 0.62) + sunGlitter;

    // Multi-Scale Lacy Whitewater Foam
    float foamPattern = fbmFoam(vWorldPos.xz * 0.42 + vec2(0.0, -uTime * 1.5));
    float fineBubbles = noise(vWorldPos.xz * 2.2 + vec2(uTime * 0.7, -uTime * 1.9));

    float lacyMask = smoothstep(0.24, 0.72, vFoam + (foamPattern - 0.42) * 0.42);
    float denseLipFoam = smoothstep(0.55, 0.92, vFoam);
    float totalFoam = clamp(mix(lacyMask * (0.65 + 0.35 * fineBubbles), 1.0, denseLipFoam), 0.0, 1.0);

    float foamLight = 0.74 + 0.26 * ndotl;
    vec3 foamColor = vec3(0.94, 0.97, 0.99) * foamLight;

    color = mix(color, foamColor, totalFoam);

    float alpha = 0.88;
    if (!gl_FrontFacing || uCameraPos.y < vWorldPos.y) {
      // Underwater view looking at the underside of the waves & seabed
      alpha = mix(0.45, 0.82, totalFoam);
    } else if (uVizMode == 1) {
      alpha = mix(0.36, 0.85, totalFoam);
    } else {
      // Translucent over shallow reefs/sandbars so ground structure is visible from above too
      alpha = mix(0.58, 0.91, clamp(vDepth / 6.5, 0.0, 1.0));
      alpha = max(alpha, totalFoam * 0.96);
    }

    gl_FragColor = vec4(color, alpha);
  }
`;

export function createOceanMaterial(bathymetryTexture, waveSimTexture) {
  return new THREE.ShaderMaterial({
    vertexShader: oceanVertexShader,
    fragmentShader: oceanFragmentShader,
    transparent: true,
    depthWrite: true,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uBathymetryTex: { value: bathymetryTexture },
      uWaveSimTex: { value: waveSimTexture },
      uWorldSize: { value: WORLD_SIZE },
      uBtyRes: { value: BTY_RES },

      uWindSpeed: { value: 10.0 },
      uWindDir: { value: 10.0 },
      uTideLevel: { value: 0.2 },

      uSunDir: { value: new THREE.Vector3(0.4, 0.5, -0.7).normalize() },
      uCameraPos: { value: new THREE.Vector3(0, 25, 90) },
      uVizMode: { value: 0 },
    },
  });
}
