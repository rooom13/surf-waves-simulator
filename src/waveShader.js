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
  varying float vPocket;
  varying float vLip;

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

  // Evaluate 3D displaced ocean surface with parametric overturning barrel lip & concave pocket
  vec3 evaluateSurface(
    vec2 baseXZ,
    out float outFoam,
    out float outSubsurface,
    out float outDepth,
    out float outPocket,
    out float outLip
  ) {
    vec4 bty = sampleTexBilinear(uBathymetryTex, baseXZ);
    float seabedElev = bty.r;
    float depth = uTideLevel - seabedElev;
    outDepth = depth;

    if (depth <= 0.02) {
      outFoam = 0.0;
      outSubsurface = 0.0;
      outPocket = 0.0;
      outLip = 0.0;
      return vec3(baseXZ.x, seabedElev - 0.05, baseXZ.y);
    }

    // Read live PDE simulation state:
    // R = shapedEta, G = barrelVec.x, B = barrelVec.z, A = advected whitewater foam
    vec4 sim = sampleTexBilinear(uWaveSimTex, baseXZ);
    float eta = sim.r;
    vec2 barrelVec = sim.gb;
    float pdeFoam = sim.a;

    float B_tube = length(barrelVec);
    vec2 kHat = B_tube > 0.001 ? barrelVec / B_tube : vec2(0.0, 1.0);

    // Spatial gradient of wave elevation & wide-smoothed foam for post-break crest drop
    float stepD = 2.85;
    vec4 simPX = sampleTexBilinear(uWaveSimTex, baseXZ + vec2(stepD, 0.0));
    vec4 simMX = sampleTexBilinear(uWaveSimTex, baseXZ - vec2(stepD, 0.0));
    vec4 simPZ = sampleTexBilinear(uWaveSimTex, baseXZ + vec2(0.0, stepD));
    vec4 simMZ = sampleTexBilinear(uWaveSimTex, baseXZ - vec2(0.0, stepD));
    vec2 gradEta = vec2(simPX.r - simMX.r, simPZ.r - simMZ.r) / (2.0 * stepD);
    float smoothFoam = (pdeFoam * 0.36) + (simPX.a + simMX.a + simPZ.a + simMZ.a) * 0.16;

    // Positive on the shoreward-facing front wall, negative on the offshore back slope
    float frontSlope = -dot(gradEta, kHat);
    float frontFace = smoothstep(0.01, 0.15, frontSlope);
    float upperCrest = smoothstep(-0.08, 0.12, frontSlope) * smoothstep(0.35, 2.05, eta);
    float shoalWall = smoothstep(7.5, 1.6, depth) * smoothstep(0.10, 0.70, depth);
    float breakProgress = smoothstep(0.18, 0.82, smoothFoam);

    // Sample crest elevation just behind the front face (-kHat) to normalize vertical position on the wave wall
    float crestBehindEta = sampleTexBilinear(uWaveSimTex, baseXZ - kHat * 2.85).r;
    float localPeakEta = max(eta, crestBehindEta);
    float normFaceH = clamp(eta / max(0.45, localPeakEta), 0.0, 1.0);
    float isTallBarrel = smoothstep(1.18, 1.72, localPeakEta) * smoothstep(0.24, 0.80, B_tube);

    // 1. Bounded Trochoidal horizontal convergence (+gradEta points toward the wave crest):
    // Steepens the wave face smoothly without ever self-intersecting at the crest!
    vec2 steepenGrad = tanh(gradEta * 1.35);
    vec2 horizDisp = steepenGrad * (1.55 + 1.10 * shoalWall);

    // 2. Full-Height Concave Hollow Cavity ("The Green Room" Bowl) carved into the steep front wall
    // Spans 10% to 78% of the local wave peak height underneath the overhanging lip roof!
    float steepPocketFace = smoothstep(0.05, 0.20, frontSlope) * isTallBarrel;
    float pocketBand = steepPocketFace * smoothstep(0.08, 0.28, normFaceH) * (1.0 - smoothstep(0.70, 0.90, normFaceH));
    float pocketStrength = pocketBand * min(1.40, B_tube);
    horizDisp -= kHat * pocketStrength * 1.95;
    float pocketCarveY = -pocketStrength * 0.42;

    // 3. Overturning Pitching Crest Roof (overhangs the top of the cavity; falls down once broken!)
    float crestRoof = smoothstep(-0.04, 0.12, frontSlope) * smoothstep(0.65, 0.92, normFaceH) * isTallBarrel;
    float crestThrow = crestRoof * min(1.35, B_tube) * (1.0 - breakProgress * 0.50);
    horizDisp += kHat * crestThrow * 2.65;
    float crestLiftY = upperCrest * (1.0 - breakProgress * 0.95) * (0.46 * shoalWall + 0.30 * min(1.20, B_tube));

    // 4. Dissolving Lip Edge at the top-front tip of the pitching crest (spawns the falling white foam particle curtain!)
    float lipEdge = frontFace * smoothstep(0.72, 0.96, normFaceH) * isTallBarrel;
    horizDisp += kHat * lipEdge * 0.85;
    float lipDropY = -lipEdge * 0.48;

    // Progressive post-break crest collapse so the already-broken crest falls down into a whitewater bore
    float collapseDropY = -breakProgress * max(0.0, eta - 0.15) * 0.85;

    // Fine-scale local wind chop ripples (suppressed inside the glassy hollow barrel pocket)
    float windRad = radians(uWindDir);
    float windAlignment = cos(windRad);
    float swashTaper = smoothstep(0.04, 0.85, depth);
    float glassyPocketDamp = 1.0 - clamp(pocketStrength * 0.75, 0.0, 0.85);
    float windChopAmp = (uWindSpeed / 30.0) * (0.07 + 0.15 * max(0.0, -windAlignment)) * swashTaper * glassyPocketDamp;
    vec2 windVec = vec2(sin(windRad), -cos(windRad));
    float chop1 = noise(baseXZ * 0.42 + windVec * uTime * 2.4) * 2.0 - 1.0;
    float chop2 = noise(baseXZ * 0.98 - windVec.yx * uTime * 3.1) * 2.0 - 1.0;
    float windRipple = (chop1 * 0.65 + chop2 * 0.35) * windChopAmp;

    outPocket = clamp(pocketStrength, 0.0, 1.0);
    outLip = clamp(lipEdge, 0.0, 1.0);

    // At the active peeling pocket, keep the entire full-height concave barrel cavity wall clean, dark & glassy
    // so the hollow cavity is clearly visible right behind the falling white foam particle curtain!
    float isPeelingPocket = 1.0 - smoothstep(0.62, 0.92, pdeFoam);
    float cleanPocket = smoothstep(0.08, 0.42, outPocket) * (1.0 - smoothstep(0.45, 0.90, outLip)) * isPeelingPocket;
    float wallFoam = pdeFoam * (1.0 - cleanPocket * 0.96);
    float lipTipFoam = smoothstep(0.30, 0.82, outLip) * 0.88;

    outFoam = clamp(max(wallFoam, lipTipFoam), 0.0, 1.0);
    outSubsurface = clamp(
      smoothstep(0.08, 1.4, eta) * (0.45 + 0.55 * min(1.2, B_tube)) + outPocket * 0.55 + outLip * 0.45,
      0.0,
      1.0
    );

    vec2 finalXZ = baseXZ + horizDisp;
    float displacedSeabed = sampleTexBilinear(uBathymetryTex, finalXZ).r;
    float maxSeabed = max(seabedElev, displacedSeabed);
    float minFloorY = maxSeabed + mix(0.10, 0.46, smoothstep(0.12, 0.65, depth));
    float totalY = max(minFloorY, uTideLevel + eta + crestLiftY + pocketCarveY + lipDropY + collapseDropY + windRipple);
    return vec3(finalXZ.x, totalY, finalXZ.y);
  }

  void main() {
    vec2 baseXZ = position.xz;

    float foam, sss, depth, pocket, lip;
    vec3 displacedPos = evaluateSurface(baseXZ, foam, sss, depth, pocket, lip);

    // Compute accurate 3D surface normal via central finite differences
    float eps = 0.85;
    float fTmp, sTmp, dTmp, pTmp, lTmp;
    vec3 posXPlus = evaluateSurface(baseXZ + vec2(eps, 0.0), fTmp, sTmp, dTmp, pTmp, lTmp);
    vec3 posXMinus = evaluateSurface(baseXZ - vec2(eps, 0.0), fTmp, sTmp, dTmp, pTmp, lTmp);
    vec3 posZPlus = evaluateSurface(baseXZ + vec2(0.0, eps), fTmp, sTmp, dTmp, pTmp, lTmp);
    vec3 posZMinus = evaluateSurface(baseXZ - vec2(0.0, eps), fTmp, sTmp, dTmp, pTmp, lTmp);

    vec3 tangentX = posXPlus - posXMinus;
    vec3 tangentZ = posZPlus - posZMinus;
    vec3 computedNormal = normalize(cross(tangentZ, tangentX));

    vWorldPos = displacedPos;
    vNormal = computedNormal;
    vDepth = depth;
    vFoam = foam;
    vWaveHeight = displacedPos.y - uTideLevel;
    vSubsurface = sss;
    vPocket = pocket;
    vLip = lip;

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
  varying float vPocket;
  varying float vLip;

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

    // Subsurface Scattering (SSS) through thin pitching wave crests & hollow barrel wall ("Green Room")
    float backLight = pow(clamp(dot(V, -L) * 0.5 + 0.5, 0.0, 1.0), 2.2);
    float crestThinness = vSubsurface * (1.0 - abs(N.y) * 0.52);
    vec3 greenRoomCol = mix(vec3(0.06, 0.68, 0.62), vec3(0.03, 0.82, 0.72), clamp(vPocket + vLip * 0.5, 0.0, 1.0));
    vec3 sssColor = greenRoomCol * crestThinness * (0.38 + 0.62 * backLight);

    // Deep 3D Cylindrical Cavity Shading inside the hollow barrel pocket under the overhanging lip
    float cavityDepth = clamp(vPocket * (1.0 - vLip * 0.35), 0.0, 1.0);
    float tubeShadow = 1.0 - clamp(cavityDepth * 0.84, 0.0, 0.86);
    vec3 cavityInteriorCol = vec3(0.01, 0.08, 0.13);
    waterBase = mix(waterBase * tubeShadow, cavityInteriorCol, cavityDepth * 0.78);
    sssColor *= 1.0 - cavityDepth * 0.65;

    // Fresnel Sky Reflection (reduced inside the sheltered barrel pocket so emerald water shines through)
    float cosTheta = max(0.0, dot(N, V));
    float pocketShelter = 1.0 - clamp(vPocket * 0.68, 0.0, 0.75);
    float fresnel = (0.02 + 0.90 * pow(1.0 - cosTheta, 4.4)) * pocketShelter;

    vec3 skyZenith = vec3(0.22, 0.48, 0.74);
    vec3 skyHorizon = vec3(0.66, 0.82, 0.92);
    vec3 R = reflect(-V, N);
    vec3 skyReflect = mix(skyHorizon, skyZenith, clamp(R.y, 0.0, 1.0));

    // Multi-Scale Lacy Whitewater Foam
    float foamPattern = fbmFoam(vWorldPos.xz * 0.42 + vec2(0.0, -uTime * 1.5));
    float fineBubbles = noise(vWorldPos.xz * 2.2 + vec2(uTime * 0.7, -uTime * 1.9));

    // Sun Specular Highlight (modulated by micro-wavelet facets so it sparkles naturally instead of a flat white disk)
    vec3 H = normalize(L + V);
    float specPower = pow(max(0.0, dot(N, H)), 220.0);
    float facetSparkle = 0.30 + 0.70 * smoothstep(0.38, 0.78, fineBubbles);
    vec3 sunGlitter = vec3(1.0, 0.96, 0.86) * specPower * facetSparkle * 0.75;

    vec3 color = mix(waterBase + sssColor, skyReflect, fresnel * 0.62) + sunGlitter;

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
