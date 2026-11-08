// Synchronized Hydrodynamic Wave Physics, Backwash & Side-Wave Wedge Telemetry Engine

export const GRAVITY = 9.81;

export function evaluateSurfTelemetry(oceanParams, btyManager) {
  const H0 = oceanParams.swellHeight;
  const T = oceanParams.swellPeriod;
  const swellDir = oceanParams.swellDir;
  const windSpeed = oceanParams.windSpeed;
  const windDir = oceanParams.windDir;
  const tide = oceanParams.tideLevel;
  const backwash = oceanParams.backwashStrength ?? 0.2;
  const sideWave = oceanParams.sideWaveStrength ?? 0.25;

  const L0 = (GRAVITY * T * T) / (2 * Math.PI);

  let maxSlope = 0.03;
  let avgReefDepth = 2.6;
  let avgGradX = 0.0;
  let samples = 0;

  for (let z = -25; z <= 20; z += 5) {
    for (let x = -45; x <= 45; x += 10) {
      const s = btyManager.sampleAt(x, z);
      const d = tide - s.elevation;
      if (d > 0.8 && d < 5.5) {
        maxSlope = Math.max(maxSlope, s.slope);
        avgReefDepth += d;
        avgGradX += Math.abs(s.gradX);
        samples++;
      }
    }
  }

  if (samples > 0) {
    avgReefDepth /= samples + 1;
    avgGradX /= samples;
  }

  const windAlignment = Math.cos((windDir * Math.PI) / 180);
  const offshoreFactor = windAlignment * Math.min(1.0, windSpeed / 18.0);

  const wedgeBoost = 1.0 + sideWave * 0.25;
  const periodFactor = 0.88 + 0.28 * ((T - 5) / 15);
  const baseShoaling = Math.min(1.65, Math.max(1.08, Math.pow(10.0 / Math.max(1.5, avgReefDepth), 0.22) * periodFactor));
  const shoalingAmp = baseShoaling * wedgeBoost;
  const breakingFaceHeight = H0 * shoalingAmp * (1.0 + Math.max(0, offshoreFactor) * 0.10);

  const effectiveSlope = Math.max(0.015, maxSlope * 0.65);
  const waveSteepness = Math.max(0.002, breakingFaceHeight / L0);
  const rawIribarren = effectiveSlope / Math.sqrt(waveSteepness);
  const iribarren = Math.max(0.15, rawIribarren * (1.0 + offshoreFactor * 0.28 + sideWave * 0.14));

  // Mead & Black (2001) Vortex Ratio (Tube Length / Width ratio L_v / W_v)
  // Lower vortex ratio (1.3 - 2.2) = rounder/squarer hollow barrel; > 3.0 = spilling roller
  const rawVortexRatio = 0.22 * Math.pow(effectiveSlope, -0.76) * Math.pow(waveSteepness / 0.025, 0.22);
  const vortexRatio = Math.max(1.15, Math.min(4.2, rawVortexRatio * (1.0 - offshoreFactor * 0.18)));

  let breakType = 'Plunging / Hollow Barrel';
  let lipPitchDesc = `Vortex L/W: ${vortexRatio.toFixed(2)} (Round Tube)`;

  if (sideWave >= 1.05 && backwash >= 1.0) {
    breakType = 'Mutant Wedge + Backwash';
    lipPitchDesc = `Vortex L/W: ${vortexRatio.toFixed(2)} (Wedge Peak)`;
  } else if (sideWave >= 1.05) {
    breakType = 'Mutant Side-Wave Wedge';
    lipPitchDesc = `Vortex L/W: ${vortexRatio.toFixed(2)} (Mach Wedge)`;
  } else if (backwash >= 1.15) {
    breakType = 'Heavy Backwash Shorebreak';
    lipPitchDesc = `Vortex L/W: ${vortexRatio.toFixed(2)} (Collision)`;
  } else if (iribarren < 0.45) {
    breakType = 'Spilling / Crumbling';
    lipPitchDesc = `Vortex L/W: ${vortexRatio.toFixed(2)} (Spilling)`;
  } else if (iribarren < 0.72) {
    breakType = 'Semi-Plunging Almond';
    lipPitchDesc = `Vortex L/W: ${vortexRatio.toFixed(2)} (Almond Tube)`;
  } else if (iribarren < 1.55) {
    breakType = 'Plunging / Hollow Barrel';
    lipPitchDesc = `Vortex L/W: ${vortexRatio.toFixed(2)} (Cylindrical)`;
  } else {
    breakType = 'Heavy Slab / Square Tube';
    lipPitchDesc = `Vortex L/W: ${vortexRatio.toFixed(2)} (Square Slab)`;
  }

  const breakDepth = Math.max(1.2, breakingFaceHeight / 0.85);
  const waveSpeed = Math.sqrt(GRAVITY * breakDepth * 1.25);

  const reefAngleEffect = Math.abs(btyManager.params.reefAngle - swellDir) * 0.65;
  const lateralContourAngle = Math.atan2(avgGradX * 2.2, 0.08) * (180 / Math.PI);
  const wedgeAngleBonus = sideWave > 0.2 ? Math.abs(oceanParams.sideWaveAngle ?? 35) * 0.20 * Math.min(1, sideWave) : 0;
  const rawPeelAngle = Math.min(78, Math.max(12, Math.round(lateralContourAngle * 0.6 + reefAngleEffect + wedgeAngleBonus)));

  let peelDesc = 'Fast Makeable Pocket';
  if (rawPeelAngle < 24) {
    peelDesc = 'Fast / Sectiony Closeout';
  } else if (rawPeelAngle < 42) {
    peelDesc = 'Racing Barrel Section';
  } else if (rawPeelAngle < 58) {
    peelDesc = 'Ideal Performance Wall';
  } else {
    peelDesc = 'Cruisy Carving Shoulder';
  }

  let score = 6.0;
  score += ((T - 8) / 12) * 1.4;
  if (breakingFaceHeight >= 1.5 && breakingFaceHeight <= 5.5) score += 1.0;
  else if (breakingFaceHeight < 0.9) score -= 1.2;

  if (windAlignment > 0.3 && windSpeed >= 4 && windSpeed <= 20) {
    score += 1.4;
  } else if (windAlignment < -0.2 && windSpeed > 10) {
    score -= (windSpeed / 20) * 2.4;
  }

  if (sideWave >= 0.25 && sideWave <= 1.4) score += 0.45;
  if (backwash > 1.45) score -= 0.45;
  if (tide < -1.1 || tide > 1.7) score -= 0.7;
  if (rawPeelAngle >= 28 && rawPeelAngle <= 58) score += 0.7;

  score = Math.min(10.0, Math.max(1.5, score));

  let ratingLabel = 'Fair Surf';
  if (score >= 8.8) ratingLabel = 'World-Class Epic';
  else if (score >= 7.5) ratingLabel = 'Firing / Overhead Clean';
  else if (score >= 6.0) ratingLabel = 'Fun & Rippable';
  else if (score >= 4.2) ratingLabel = 'Choppy / Marginal';
  else ratingLabel = 'Blown Out / Poor';

  const swellEnergyKJ = Math.round(H0 * H0 * T * 2.1 * wedgeBoost);

  const wavesPerSet = oceanParams.wavesPerSet ?? 6;
  const grouping = (oceanParams.swellGrouping ?? 45) / 100;
  const setPeriodSec = Math.round(wavesPerSet * T);
  const setWavesCount = Math.max(1, Math.round(wavesPerSet * (1.0 - 0.55 * grouping)));
  const lullWaitSec = Math.round((wavesPerSet - setWavesCount) * T);

  return {
    L0,
    shoalingAmp,
    breakingFaceHeight,
    iribarren,
    breakType,
    lipPitchDesc,
    waveSpeed,
    peelAngle: rawPeelAngle,
    peelDesc,
    score,
    ratingLabel,
    swellEnergyKJ,
    offshoreFactor,
    wavesPerSet,
    setPeriodSec,
    setWavesCount,
    lullWaitSec,
  };
}

function smoothstep(e0, e1, v) {
  const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// CPU evaluation of wave height, breaker stage, wedge peak & backwash collision
export function sampleWaveOnCPU(x, z, time, oceanParams, btyManager) {
  const bty = btyManager.sampleAt(x, z);
  const depth = oceanParams.tideLevel - bty.elevation;
  if (depth <= 0.05) {
    return {
      y: bty.elevation,
      plunge: 0,
      foam: 0,
      crestPhase: 0,
      cosPhase: 0,
      sinPhase: 0,
      collisionBlowup: 0,
      wedgeConstructive: 0,
      depth: 0,
      gradX: bty.gradX,
    };
  }

  const H0 = oceanParams.swellHeight;
  const T = oceanParams.swellPeriod;
  const dirRad = (oceanParams.swellDir * Math.PI) / 180;
  const dirX = Math.sin(dirRad);
  const dirZ = Math.cos(dirRad);

  const simWavelength = 38.0 + (T - 5.0) * 3.0;
  const k = (2.0 * Math.PI) / simWavelength;
  const omega = (2.0 * Math.PI) / (T * 0.44);

  const s = x * dirX + z * dirZ + bty.phaseDelay * 0.80;
  const phase = k * s - omega * time;

  const groupEnv = 1.0 - (oceanParams.swellGrouping / 100) * 0.32 * (0.5 - 0.5 * Math.cos(phase * 0.25));

  const windOffshore = Math.cos((oceanParams.windDir * Math.PI) / 180) * Math.min(1, oceanParams.windSpeed / 18);
  const stageShift = (H0 - 2.0) * 0.08 - oceanParams.tideLevel * 0.12 - windOffshore * 0.06;
  const stage = Math.max(0, bty.breakerStage + stageShift * smoothstep(9.0, 2.5, depth));

  const shoalingPeak = Math.exp(-Math.pow((stage - 0.44) / 0.34, 2.0));
  const postBreakRoller = smoothstep(0.52, 1.15, stage);
  const swashTaper = smoothstep(0.02, 0.85, depth);
  const periodBoost = 0.92 + 0.18 * ((T - 5.0) / 15.0);

  const heightEnvelope = (0.86 * (1.0 - postBreakRoller * 0.52) + 0.48 * shoalingPeak) * periodBoost * swashTaper;
  const H1 = H0 * groupEnv * heightEnvelope;

  const c = Math.cos(phase);
  const sn = Math.sin(phase);

  let vertSide = 0;
  let wedgeConstructive = 0;
  const sideStrength = oceanParams.sideWaveStrength ?? 0.25;
  const sideAngle = oceanParams.sideWaveAngle ?? 35;
  if (sideStrength > 0.01) {
    const sideRad = (sideAngle * Math.PI) / 180;
    const sSide = x * Math.sin(sideRad) + z * Math.cos(sideRad) + bty.phaseDelay * 0.50;
    const phaseSide = k * 1.04 * sSide - omega * time + 0.5;
    const cSide = Math.cos(phaseSide);
    const sideOriginSign = sideAngle >= 0 ? 1 : -1;
    const lateralDecay = Math.exp(-Math.max(0, x * sideOriginSign + 80) / 150);
    const HSide = H0 * 0.32 * sideStrength * lateralDecay * swashTaper * (1.0 - postBreakRoller * 0.4);
    vertSide = HSide * 0.5 * cSide;
    if (c > 0.0 && cSide > 0.0) {
      wedgeConstructive = c * cSide * sideStrength * lateralDecay * 0.55;
      vertSide += wedgeConstructive * H1 * 0.28;
    }
  }

  let vertBW = 0;
  let collisionBlowup = 0;
  const bwStrength = oceanParams.backwashStrength ?? 0.2;
  if (bwStrength > 0.01 && depth > 0.08 && depth < 4.8 && z > 5) {
    const bwZone = smoothstep(0.08, 0.65, depth) * smoothstep(4.8, 1.2, depth) * smoothstep(5.0, 40.0, z);
    const cuspCurve = Math.sin(x * 0.045) * 3.5;
    const phaseBW = k * 1.25 * (z + cuspCurve) + omega * 1.08 * time;
    const cBW = Math.cos(phaseBW);
    const cuspEnv = 0.70 + 0.30 * Math.cos(x * 0.06);
    const HBW = H0 * 0.24 * bwStrength * bwZone * cuspEnv;
    vertBW = HBW * 0.5 * cBW;
    if (c > 0.25 && cBW > 0.25) {
      collisionBlowup = c * cBW * bwStrength * bwZone * cuspEnv * 0.65;
      vertBW += collisionBlowup * H1 * 0.42;
    }
  }

  const activePitchZone = shoalingPeak * (1.0 - postBreakRoller * 0.65) * swashTaper;
  const plunge = Math.min(1.25, activePitchZone * (0.85 + bty.slope * 2.5));
  const crestSharpness = Math.min(0.44, 0.20 + 0.22 * shoalingPeak);
  const waveY =
    H1 * 0.5 * (c + crestSharpness * (c * c - sn * sn)) +
    H1 * 0.14 * shoalingPeak * smoothstep(-0.3, 0.9, c) +
    vertSide +
    vertBW;

  return {
    y: oceanParams.tideLevel + waveY,
    plunge,
    foam: activePitchZone * Math.max(0, c) + postBreakRoller * 0.8 + collisionBlowup,
    crestPhase: phase,
    cosPhase: c,
    sinPhase: sn,
    collisionBlowup,
    wedgeConstructive,
    depth,
    gradX: bty.gradX,
  };
}
