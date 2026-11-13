import { WORLD_SIZE, BTY_RES } from './bathymetry.js';

/**
 * Renders the top-down 2D Bathymetry Depth Minimap on an HTML5 canvas.
 * Includes color-depth zones, isobath contours, swell direction indicator,
 * and real-time player location with carving trail.
 */
export function renderMinimap(canvas, btyManager, tideLevel, swellDirDeg, playerInfo = null) {
  if (!canvas || !btyManager) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  const btyVersion = btyManager.minimapVersion || 0;
  // Check if background depth map needs to be recomputed for this canvas
  if (
    !canvas._minimapOffscreen ||
    canvas._minimapOffscreen.width !== w ||
    canvas._minimapOffscreen.height !== h ||
    canvas._lastBtyVersion !== btyVersion ||
    canvas._lastTideLevel !== tideLevel ||
    canvas._lastSwellDir !== swellDirDeg
  ) {
    if (!canvas._minimapOffscreen) {
      canvas._minimapOffscreen = document.createElement('canvas');
    }
    canvas._minimapOffscreen.width = w;
    canvas._minimapOffscreen.height = h;
    const offCtx = canvas._minimapOffscreen.getContext('2d');
    const imgData = offCtx.createImageData(w, h);
    const data = imgData.data;

    for (let py = 0; py < h; py++) {
      const v = py / (h - 1);
      const fvFull = v * (BTY_RES - 1);
      const j0 = Math.floor(fvFull);
      const j1 = Math.min(BTY_RES - 1, j0 + 1);
      const fv = fvFull - j0;

      for (let px = 0; px < w; px++) {
        const u = px / (w - 1);
        const fuFull = u * (BTY_RES - 1);
        const i0 = Math.floor(fuFull);
        const i1 = Math.min(BTY_RES - 1, i0 + 1);
        const fu = fuFull - i0;

        const e00 = btyManager.elevation[j0 * BTY_RES + i0];
        const e10 = btyManager.elevation[j0 * BTY_RES + i1];
        const e01 = btyManager.elevation[j1 * BTY_RES + i0];
        const e11 = btyManager.elevation[j1 * BTY_RES + i1];
        const elev = (e00 * (1 - fu) + e10 * fu) * (1 - fv) + (e01 * (1 - fu) + e11 * fu) * fv;
        const depth = tideLevel - elev;

        let r = 14, g = 2, b = 78;

        if (depth <= 0.0) {
          // Dry land / beach
          const landDist = -depth;
          if (landDist < 0.65 || py >= h - 6) {
            // Warm golden shoreline sand
            r = 185;
            g = 170;
            b = 95;
          } else {
            // Olive green headland hill terrain (matches reference drawing)
            r = 108;
            g = 135;
            b = 67;
          }
        } else if (depth < 3.3) {
          // Shallow breaking shelf / reef: luminous electric cyan (matches reference drawing)
          r = 0;
          g = 219;
          b = 248;
        } else if (depth < 8.2) {
          // Mid-depth oceanic band (matches reference drawing)
          r = 0;
          g = 64;
          b = 133;
        } else {
          // Deep offshore ocean: dark indigo navy (matches reference drawing)
          r = 14;
          g = 2;
          b = 78;

          // Subtle isobath contour rings (depth interval 2.5m)
          const contourStep = 2.5;
          const frac = (depth % contourStep) / contourStep;
          const dist = Math.min(frac, 1.0 - frac) * contourStep;
          if (dist < 0.16) {
            const lineAlpha = Math.max(0, 1.0 - dist / 0.16) * 0.40;
            r = Math.min(255, Math.floor(r * (1 - lineAlpha) + 26 * lineAlpha));
            g = Math.min(255, Math.floor(g * (1 - lineAlpha) + 85 * lineAlpha));
            b = Math.min(255, Math.floor(b * (1 - lineAlpha) + 155 * lineAlpha));
          }
        }

        const pIdx = (py * w + px) * 4;
        data[pIdx + 0] = r;
        data[pIdx + 1] = g;
        data[pIdx + 2] = b;
        data[pIdx + 3] = 255;
      }
    }

    offCtx.putImageData(imgData, 0, 0);

    // Swell direction arrow (pure white stem + bright cyan circle head)
    const rad = (swellDirDeg * Math.PI) / 180;
    const cx = w * 0.5;
    const cy = 20;
    const arrowLen = 13;
    const dx = Math.sin(rad) * arrowLen;
    const dy = Math.cos(rad) * arrowLen;

    offCtx.strokeStyle = '#ffffff';
    offCtx.lineWidth = 2.0;
    offCtx.lineCap = 'round';
    offCtx.beginPath();
    offCtx.moveTo(cx - dx * 0.4, cy - dy * 0.4);
    offCtx.lineTo(cx + dx * 0.5, cy + dy * 0.5);
    offCtx.stroke();

    offCtx.fillStyle = '#00d9f3';
    offCtx.beginPath();
    offCtx.arc(cx + dx * 0.5, cy + dy * 0.5, 3.5, 0, Math.PI * 2);
    offCtx.fill();

    canvas._lastBtyVersion = btyVersion;
    canvas._lastTideLevel = tideLevel;
    canvas._lastSwellDir = swellDirDeg;
  }

  // Draw cached bathymetry background
  ctx.drawImage(canvas._minimapOffscreen, 0, 0);

  // Render real-time Player Location (Tiny at-scale white surfboard)
  if (playerInfo) {
    const u = playerInfo.x / WORLD_SIZE + 0.5;
    const v = playerInfo.z / WORLD_SIZE + 0.5;
    const px = Math.max(3, Math.min(w - 3, u * (w - 1)));
    const py = Math.max(3, Math.min(h - 3, v * (h - 1)));

    // 1. Subtle Surfing Wake / Carve Trail
    if (playerInfo.active && playerInfo.trail && playerInfo.trail.length > 1) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let t = 1; t < playerInfo.trail.length; t++) {
        const p0 = playerInfo.trail[t - 1];
        const p1 = playerInfo.trail[t];
        const u0 = p0.x / WORLD_SIZE + 0.5;
        const v0 = p0.z / WORLD_SIZE + 0.5;
        const u1 = p1.x / WORLD_SIZE + 0.5;
        const v1 = p1.z / WORLD_SIZE + 0.5;
        const normProg = t / playerInfo.trail.length;
        ctx.lineWidth = 0.7 + normProg * 0.9;
        ctx.strokeStyle = `rgba(255, 255, 255, ${normProg * 0.40})`;
        ctx.beginPath();
        ctx.moveTo(u0 * (w - 1), v0 * (h - 1));
        ctx.lineTo(u1 * (w - 1), v1 * (h - 1));
        ctx.stroke();
      }
      ctx.restore();
    }

    // 2. Tiny at-scale directional white surfboard (oriented along player yaw heading)
    // On canvas, X is right and Y is down (+Z).
    const headingAngle = Math.atan2(Math.cos(playerInfo.yaw ?? 0), Math.sin(playerInfo.yaw ?? 0));
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(headingAngle);

    // Subtle drop shadow so white board pops against light beach foam and reef
    ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
    ctx.shadowBlur = 2.5;

    // Scaled surfboard geometry: length ~5.8px, width ~2.4px
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.75)';
    ctx.lineWidth = 0.6;

    ctx.beginPath();
    ctx.moveTo(3.0, 0); // nose pointing in heading direction
    ctx.bezierCurveTo(1.6, 1.25, -1.6, 1.25, -2.8, 0.75); // right rail
    ctx.lineTo(-2.8, -0.75); // tail block
    ctx.bezierCurveTo(-1.6, -1.25, 1.6, -1.25, 3.0, 0); // left rail
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Stringer line
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = '#b45309';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(-2.3, 0);
    ctx.lineTo(2.5, 0);
    ctx.stroke();

    ctx.restore();
  }
}
