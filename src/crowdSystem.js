import * as THREE from 'three';
import { WORLD_SIZE } from './bathymetry.js';

// Deterministic pseudo-random helper for repeatable crowd placement per preset
function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const SKIN_TONES = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];
const SHIRT_COLORS = [
  0xff4757, // coral red
  0x1e90ff, // ocean blue
  0x2ed573, // lime green
  0xffa502, // mango orange
  0xffffff, // crisp white
  0xfef08a, // sun yellow
  0xa855f7, // violet
  0x06b6d4, // cyan
  0x1e293b, // wetsuit charcoal/navy
];
const SHORT_COLORS = [0x0f172a, 0x1e3a8a, 0x334155, 0xdc2626, 0x0284c7, 0xf59e0b];
const BOARD_COLORS = [0xffffff, 0xfef08a, 0x38bdf8, 0xfb7185, 0x4ade80, 0xf97316];
const UMBRELLA_COLORS = [0xef4444, 0x3b82f6, 0xf59e0b, 0x10b981, 0xec4899, 0x8b5cf6];

export class BeachCrowdSystem {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'BeachCrowdReference';
    this.scene.add(this.group);

    this.crowdGroup = new THREE.Group();
    this.crowdGroup.name = 'BeachCrowdPeople';
    this.group.add(this.crowdGroup);

    this.propsGroup = new THREE.Group();
    this.propsGroup.name = 'BeachCrowdProps';
    this.group.add(this.propsGroup);

    this.actors = [];
    this.sharedGeometries = this.createSharedGeometries();
    this.sharedMaterials = this.createSharedMaterials();
  }

  createSharedGeometries() {
    // Human proportions scaled to ~1.78m total height (true 1:1 world meters)
    // Slightly bold limb thickness so figures remain clearly visible at 40m-110m camera distance
    const legGeom = new THREE.CapsuleGeometry(0.085, 0.65, 4, 8);
    legGeom.translate(0, 0.40, 0);

    const torsoGeom = new THREE.CapsuleGeometry(0.18, 0.46, 4, 10);
    torsoGeom.translate(0, 1.12, 0);

    const headGeom = new THREE.SphereGeometry(0.145, 10, 10);
    headGeom.translate(0, 1.64, 0);

    const armGeom = new THREE.CapsuleGeometry(0.065, 0.48, 4, 8);
    armGeom.translate(0, -0.22, 0); // Pivot at shoulder

    // Surfboard geometry (~2.05m long, 0.52m wide, 0.07m thick)
    const boardGeom = new THREE.CapsuleGeometry(0.24, 1.55, 4, 12);
    boardGeom.scale(1.0, 1.0, 0.16);

    // Beach umbrella pole & canopy (2.3m tall, 2.2m wide)
    const poleGeom = new THREE.CylinderGeometry(0.04, 0.04, 2.35, 8);
    poleGeom.translate(0, 1.15, 0);
    const canopyGeom = new THREE.ConeGeometry(1.25, 0.48, 12, 1, true);
    canopyGeom.translate(0, 2.22, 0);

    // Beach towel (1.8m x 0.9m)
    const towelGeom = new THREE.BoxGeometry(0.95, 0.04, 1.85);
    towelGeom.translate(0, 0.03, 0);

    return {
      legGeom,
      torsoGeom,
      headGeom,
      armGeom,
      boardGeom,
      poleGeom,
      canopyGeom,
      towelGeom,
    };
  }

  createSharedMaterials() {
    const skinMats = SKIN_TONES.map(
      (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.65, metalness: 0.05 })
    );
    const shirtMats = SHIRT_COLORS.map(
      (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7, metalness: 0.05 })
    );
    const shortMats = SHORT_COLORS.map(
      (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.75, metalness: 0.05 })
    );
    const wetsuitMat = new THREE.MeshStandardMaterial({
      color: 0x111827,
      roughness: 0.38,
      metalness: 0.12,
    });
    const boardMats = BOARD_COLORS.map(
      (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.2, metalness: 0.1 })
    );
    const umbrellaMats = UMBRELLA_COLORS.map(
      (c) =>
        new THREE.MeshStandardMaterial({
          color: c,
          roughness: 0.6,
          metalness: 0.05,
          side: THREE.DoubleSide,
        })
    );
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.4, metalness: 0.5 });
    const woodMat = new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.8, metalness: 0.05 });
    const towerCabinMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.55, metalness: 0.05 });
    const towerRoofMat = new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.5, metalness: 0.1 });

    return {
      skinMats,
      shirtMats,
      shortMats,
      wetsuitMat,
      boardMats,
      umbrellaMats,
      poleMat,
      woodMat,
      towerCabinMat,
      towerRoofMat,
    };
  }

  clear() {
    while (this.crowdGroup.children.length > 0) {
      const child = this.crowdGroup.children.pop();
      this.crowdGroup.remove(child);
    }
    while (this.propsGroup.children.length > 0) {
      const child = this.propsGroup.children.pop();
      this.propsGroup.remove(child);
    }
    this.actors = [];
  }

  setCrowdVisible(visible) {
    this.crowdGroup.visible = !!visible;
  }

  setPropsVisible(visible) {
    this.propsGroup.visible = !!visible;
  }

  setVisible(visible) {
    this.group.visible = !!visible;
  }

  createHumanMesh(rng, role = 'spectator') {
    const person = new THREE.Group();
    const { legGeom, torsoGeom, headGeom, armGeom, boardGeom } = this.sharedGeometries;
    const { skinMats, shirtMats, shortMats, wetsuitMat, boardMats } = this.sharedMaterials;

    const isSurfer = role === 'surfer';
    const isWetsuit = isSurfer && rng() < 0.68;

    const skinMat = skinMats[Math.floor(rng() * skinMats.length)];
    const topMat = isWetsuit ? wetsuitMat : shirtMats[Math.floor(rng() * shirtMats.length)];
    const bottomMat = isWetsuit ? wetsuitMat : shortMats[Math.floor(rng() * shortMats.length)];

    // Left & right legs
    const leftLeg = new THREE.Mesh(legGeom, bottomMat);
    leftLeg.position.x = -0.1;
    const rightLeg = new THREE.Mesh(legGeom, bottomMat);
    rightLeg.position.x = 0.1;

    // Torso
    const torso = new THREE.Mesh(torsoGeom, topMat);

    // Head
    const head = new THREE.Mesh(headGeom, skinMat);

    // Left & right arms
    const armMat = isWetsuit ? wetsuitMat : skinMat;
    const leftArm = new THREE.Mesh(armGeom, armMat);
    leftArm.position.set(-0.24, 1.32, 0);
    leftArm.rotation.z = 0.12;

    const rightArm = new THREE.Mesh(armGeom, armMat);
    rightArm.position.set(0.24, 1.32, 0);
    rightArm.rotation.z = -0.12;

    person.add(leftLeg, rightLeg, torso, head, leftArm, rightArm);

    // Optional surfboard under arm or upright in sand
    if (isSurfer) {
      const boardMat = boardMats[Math.floor(rng() * boardMats.length)];
      const board = new THREE.Mesh(boardGeom, boardMat);
      if (rng() < 0.72) {
        // Carrying surfboard under right arm
        board.position.set(0.32, 1.05, 0.08);
        board.rotation.x = Math.PI * 0.46;
        board.rotation.z = -0.18;
        rightArm.rotation.z = -0.42;
        rightArm.rotation.x = -0.25;
      } else {
        // Standing beside surfboard planted vertically in the sand
        board.position.set(0.42, 1.0, 0.1);
        board.rotation.y = 0.35;
        board.rotation.z = 0.08;
      }
      person.add(board);
    } else if (rng() < 0.25) {
      // Spectator pointing or shading eyes looking out at the surf
      rightArm.rotation.x = -Math.PI * 0.65;
      rightArm.rotation.z = -0.15;
    }

    // Slight height variation (1.68m to 1.88m)
    const heightScale = 0.94 + rng() * 0.12;
    person.scale.setScalar(heightScale);

    return { person, leftArm, rightArm, head };
  }

  createUmbrellaSetup(rng) {
    const setup = new THREE.Group();
    const { poleGeom, canopyGeom, towelGeom } = this.sharedGeometries;
    const { umbrellaMats, poleMat, shirtMats } = this.sharedMaterials;

    const umbMat = umbrellaMats[Math.floor(rng() * umbrellaMats.length)];
    const pole = new THREE.Mesh(poleGeom, poleMat);
    const canopy = new THREE.Mesh(canopyGeom, umbMat);

    const umbrella = new THREE.Group();
    umbrella.add(pole, canopy);
    // Slight tilt toward the sun
    umbrella.rotation.z = (rng() - 0.5) * 0.22;
    umbrella.rotation.x = -0.12;
    setup.add(umbrella);

    // 1 or 2 beach towels beside the umbrella
    const towelCount = 1 + Math.floor(rng() * 2);
    for (let t = 0; t < towelCount; t++) {
      const towelMat = shirtMats[Math.floor(rng() * shirtMats.length)];
      const towel = new THREE.Mesh(towelGeom, towelMat);
      towel.position.set((t === 0 ? -1 : 1) * (0.85 + rng() * 0.35), 0.04, 0.2 + (rng() - 0.5) * 0.5);
      towel.rotation.y = (rng() - 0.5) * 0.35;
      setup.add(towel);
    }

    return setup;
  }

  createLifeguardTower() {
    // Classic 4.2m tall wooden coastal lifeguard tower for unmistakable vertical scale vs wave height
    const tower = new THREE.Group();
    const { woodMat, towerCabinMat, towerRoofMat } = this.sharedMaterials;

    // 4 angled support legs (2.1m high platform)
    const postGeom = new THREE.BoxGeometry(0.14, 2.2, 0.14);
    const positions = [
      [-0.85, 1.05, -0.85],
      [0.85, 1.05, -0.85],
      [-0.85, 1.05, 0.85],
      [0.85, 1.05, 0.85],
    ];
    positions.forEach(([px, py, pz]) => {
      const post = new THREE.Mesh(postGeom, woodMat);
      post.position.set(px, py, pz);
      tower.add(post);
    });

    // Deck platform at 2.1m elevation
    const deckGeom = new THREE.BoxGeometry(2.4, 0.14, 2.6);
    const deck = new THREE.Mesh(deckGeom, woodMat);
    deck.position.set(0, 2.12, 0);
    tower.add(deck);

    // Cabin (1.65m tall on top of deck -> 3.8m)
    const cabinGeom = new THREE.BoxGeometry(1.75, 1.65, 1.75);
    const cabin = new THREE.Mesh(cabinGeom, towerCabinMat);
    cabin.position.set(0, 2.98, 0.15);
    tower.add(cabin);

    // Red rescue roof (reaches ~4.25m total height)
    const roofGeom = new THREE.ConeGeometry(1.55, 0.55, 4);
    roofGeom.rotateY(Math.PI * 0.25);
    const roof = new THREE.Mesh(roofGeom, towerRoofMat);
    roof.position.set(0, 4.05, 0.15);
    tower.add(roof);

    // Ramp/stairs at the back
    const rampGeom = new THREE.BoxGeometry(0.75, 0.1, 2.65);
    const ramp = new THREE.Mesh(rampGeom, woodMat);
    ramp.position.set(0, 1.06, -1.65);
    ramp.rotation.x = 0.82;
    tower.add(ramp);

    return tower;
  }

  populate(btyManager, tideLevel = 0.2) {
    this.clear();

    const preset = btyManager.preset;
    let seed = 1337;
    for (let i = 0; i < preset.length; i++) {
      seed = (seed * 31 + preset.charCodeAt(i)) % 100000;
    }
    const rng = seededRandom(seed);

    // Scan the terrain for candidate spots in 3 zones:
    // 1. Shoreline / Water's Edge (surfers & waders looking at the lineup)
    // 2. Dry Sandy Beach (clusters of beachgoers, umbrellas, towels, lifeguard tower)
    // 3. Headland / Cliff / Jetty Overlook (spectators watching from high ground or jetty spine)
    const shorelineSpots = [];
    const beachSpots = [];
    const overlookSpots = [];

    const step = 4.0;
    const bound = WORLD_SIZE * 0.45; // Stay within [-135m, +135m]

    for (let z = -bound; z <= bound; z += step) {
      for (let x = -bound; x <= bound; x += step) {
        const s = btyManager.sampleAt(x, z);
        const h = s.elevation;
        const sl = s.slope;

        // Skip underwater or sheer vertical walls
        if (h < tideLevel - 0.15 || sl > 0.54) continue;

        if (h >= tideLevel - 0.15 && h <= tideLevel + 1.15 && sl < 0.34) {
          shorelineSpots.push({ x, z, h, sl });
        } else if (h > tideLevel + 1.15 && h <= 3.8 && sl < 0.28 && z > 10) {
          beachSpots.push({ x, z, h, sl });
        } else if (
          (preset === 'jetty_wedge' && x < -10 && z < 55 && h > 1.1 && sl < 0.45) ||
          (h > 1.6 && h <= 11.5 && z < 75 && sl < 0.52)
        ) {
          overlookSpots.push({ x, z, h, sl });
        }
      }
    }

    // Helper to pick spaced-out spots so people don't overlap
    const placedPositions = [];
    const canPlace = (x, z, minDist) => {
      for (let i = 0; i < placedPositions.length; i++) {
        const p = placedPositions[i];
        if (Math.hypot(x - p.x, z - p.z) < minDist) return false;
      }
      return true;
    };

    // 1. Place 1 or 2 Lifeguard Towers on the main sandy beach for a 4.2m scale landmark
    if (beachSpots.length > 0) {
      for (let t = 0; t < 2; t++) {
        const candidate = beachSpots[Math.floor(rng() * beachSpots.length)];
        if (candidate && candidate.h > tideLevel + 1.4 && canPlace(candidate.x, candidate.z, 32.0)) {
          const tower = this.createLifeguardTower();
          const exactH = btyManager.sampleAt(candidate.x, candidate.z).elevation;
          tower.position.set(candidate.x, exactH, candidate.z);
          // Face toward the ocean (-Z)
          tower.rotation.y = Math.PI + (rng() - 0.5) * 0.35;
          this.propsGroup.add(tower);
          placedPositions.push({ x: candidate.x, z: candidate.z });

          // Put a lifeguard standing on the deck (y + 2.18m)
          const { person, leftArm, rightArm, head } = this.createHumanMesh(rng, 'spectator');
          const guardGroup = new THREE.Group();
          guardGroup.position.set(candidate.x, exactH, candidate.z);
          guardGroup.rotation.y = tower.rotation.y;
          person.position.set(0.5, 2.18, -0.75);
          guardGroup.add(person);
          this.crowdGroup.add(guardGroup);
          this.actors.push({
            mesh: person,
            leftArm,
            rightArm,
            head,
            baseYaw: 0,
            phase: rng() * Math.PI * 2,
          });
        }
      }
    }

    // 2. Place 40-52 Surfers along the water's edge & point shoreline facing the breaking peak
    const targetSurfers = Math.min(52, Math.max(22, Math.floor(shorelineSpots.length * 0.32)));
    for (let n = 0; n < targetSurfers * 5 && this.actors.length < targetSurfers; n++) {
      if (shorelineSpots.length === 0) break;
      const spot = shorelineSpots[Math.floor(rng() * shorelineSpots.length)];
      const jx = spot.x + (rng() - 0.5) * 2.5;
      const jz = spot.z + (rng() - 0.5) * 2.5;
      const exactH = btyManager.sampleAt(jx, jz).elevation;
      if (exactH < tideLevel - 0.15 || !canPlace(jx, jz, 2.0)) continue;

      const { person, leftArm, rightArm, head } = this.createHumanMesh(rng, 'surfer');
      person.position.set(jx, exactH, jz);

      // Face toward the offshore surf peak (roughly toward x=0, z=-25)
      const angleToPeak = Math.atan2(-jx, -25 - jz) + (rng() - 0.5) * 0.45;
      person.rotation.y = angleToPeak;

      this.crowdGroup.add(person);
      placedPositions.push({ x: jx, z: jz });
      this.actors.push({
        mesh: person,
        leftArm,
        rightArm,
        head,
        baseYaw: angleToPeak,
        phase: rng() * Math.PI * 2,
      });
    }

    // 3. Place 18-24 Beach Umbrella Camps + small social groups of 2-4 people around each
    const targetUmbrellas = Math.min(24, Math.max(10, Math.floor(beachSpots.length * 0.12)));
    let umbrellasPlaced = 0;
    for (let n = 0; n < targetUmbrellas * 5 && umbrellasPlaced < targetUmbrellas; n++) {
      if (beachSpots.length === 0) break;
      const spot = beachSpots[Math.floor(rng() * beachSpots.length)];
      const ux = spot.x + (rng() - 0.5) * 3.0;
      const uz = spot.z + (rng() - 0.5) * 3.0;
      const exactH = btyManager.sampleAt(ux, uz).elevation;
      if (exactH < tideLevel + 0.9 || !canPlace(ux, uz, 7.5)) continue;

      const umbrella = this.createUmbrellaSetup(rng);
      umbrella.position.set(ux, exactH, uz);
      umbrella.rotation.y = rng() * Math.PI * 2;
      this.propsGroup.add(umbrella);
      placedPositions.push({ x: ux, z: uz });
      umbrellasPlaced++;

      // Add 2 to 4 people standing/chatting around this umbrella camp
      const groupSize = 2 + Math.floor(rng() * 3);
      for (let m = 0; m < groupSize; m++) {
        const angle = (m / groupSize) * Math.PI * 2 + rng() * 0.8;
        const dist = 1.4 + rng() * 1.8;
        const px = ux + Math.cos(angle) * dist;
        const pz = uz + Math.sin(angle) * dist;
        const ph = btyManager.sampleAt(px, pz).elevation;
        if (ph < tideLevel + 0.4) continue;

        const role = rng() < 0.3 ? 'surfer' : 'spectator';
        const { person, leftArm, rightArm, head } = this.createHumanMesh(rng, role);
        person.position.set(px, ph, pz);

        // Either face the ocean or face each other in conversation
        const yaw =
          rng() < 0.65
            ? Math.atan2(-px, -20 - pz) + (rng() - 0.5) * 0.5
            : Math.atan2(ux - px, uz - pz);
        person.rotation.y = yaw;

        this.crowdGroup.add(person);
        placedPositions.push({ x: px, z: pz });
        this.actors.push({
          mesh: person,
          leftArm,
          rightArm,
          head,
          baseYaw: yaw,
          phase: rng() * Math.PI * 2,
        });
      }
    }

    // 4. Place 32-48 Headland / Jetty / Cliff Spectators overlooking the lineup
    const targetOverlook = Math.min(48, Math.max(18, Math.floor(overlookSpots.length * 0.35)));
    let overlookPlaced = 0;
    for (let n = 0; n < targetOverlook * 5 && overlookPlaced < targetOverlook; n++) {
      if (overlookSpots.length === 0) break;
      const spot = overlookSpots[Math.floor(rng() * overlookSpots.length)];
      const ox = spot.x + (rng() - 0.5) * 2.0;
      const oz = spot.z + (rng() - 0.5) * 2.0;
      const exactH = btyManager.sampleAt(ox, oz).elevation;
      if (exactH < tideLevel + 0.9 || !canPlace(ox, oz, 2.2)) continue;

      const role = rng() < 0.25 ? 'surfer' : 'spectator';
      const { person, leftArm, rightArm, head } = this.createHumanMesh(rng, role);
      person.position.set(ox, exactH, oz);

      const angleToLineup = Math.atan2(-ox, -15 - oz) + (rng() - 0.5) * 0.4;
      person.rotation.y = angleToLineup;

      this.crowdGroup.add(person);
      placedPositions.push({ x: ox, z: oz });
      overlookPlaced++;
      this.actors.push({
        mesh: person,
        leftArm,
        rightArm,
        head,
        baseYaw: angleToLineup,
        phase: rng() * Math.PI * 2,
      });
    }
  }

  update(simTime) {
    if (!this.group.visible || !this.crowdGroup.visible) return;
    // Subtle lifelike idle animation (head panning along the peeling wave, gentle weight sway)
    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i];
      const t = simTime * 1.6 + a.phase;
      a.mesh.rotation.y = a.baseYaw + Math.sin(t * 0.45) * 0.14;
      if (a.head) {
        a.head.rotation.y = Math.sin(t * 0.7) * 0.22;
      }
      if (a.leftArm) {
        a.leftArm.rotation.x = Math.sin(t) * 0.08;
      }
    }
  }
}
