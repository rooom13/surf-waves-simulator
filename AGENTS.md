# Surf Waves Simulator

3D surf and wave simulator built with Vite, vanilla ES modules, and Three.js (`three`).

## Commands

- `npm run dev` — start the local Vite dev server
- `npm run build` — build production bundle into `dist/`

## Verification

- There is no automated test suite. After any code change, run `npm run build` to verify there are no syntax or bundling errors.

## Conventions & Guardrails

- Source code lives in `src/` and `index.html`. Do not hand-edit `dist/`.
- Keep `update()` / render-loop paths allocation-free where possible to preserve 60fps performance.
- Keep shader uniforms and attributes in `src/waveShader.js` in sync with JS callers.
- Keep edits minimal and preserve existing physics/bathymetry tuning unless asked to change them.
