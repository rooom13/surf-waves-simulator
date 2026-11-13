import * as THREE from 'three';

/**
 * Procedural 3D Surfboard Mesh generator.
 * Creates an extruded surfboard hull with nose rocker, cedar stringer,
 * cyan rail stripe, and EVA traction pad.
 */
export function createSurfboardMesh() {
  const group = new THREE.Group();

  // Shaped surfboard deck (elongated tapered hull along +Z nose to -Z tail)
  const shape = new THREE.Shape();
  shape.moveTo(0, 1.08); // Pointed nose (+Z)
  shape.bezierCurveTo(0.22, 0.72, 0.27, 0.20, 0.25, -0.35);
  shape.bezierCurveTo(0.23, -0.72, 0.16, -0.95, 0.11, -1.02); // Squash tail
  shape.lineTo(-0.11, -1.02);
  shape.bezierCurveTo(-0.16, -0.95, -0.23, -0.72, -0.25, -0.35);
  shape.bezierCurveTo(-0.27, 0.20, -0.22, 0.72, 0, 1.08);

  const extrudeGeom = new THREE.ExtrudeGeometry(shape, {
    depth: 0.048,
    bevelEnabled: true,
    bevelSegments: 3,
    steps: 1,
    bevelSize: 0.022,
    bevelThickness: 0.018,
  });
  extrudeGeom.rotateX(Math.PI / 2);

  // Subtle nose rocker lift
  const posAttr = extrudeGeom.attributes.position;
  for (let i = 0; i < posAttr.count; i++) {
    const z = posAttr.getZ(i);
    const y = posAttr.getY(i);
    const noseRocker = z > 0.2 ? Math.pow(z - 0.2, 2.0) * 0.11 : Math.pow(Math.max(0, -z - 0.35), 2.0) * 0.04;
    posAttr.setY(i, y + noseRocker);
  }
  extrudeGeom.computeVertexNormals();

  const boardMat = new THREE.MeshStandardMaterial({
    color: 0xf8fafc,
    roughness: 0.22,
    metalness: 0.05,
  });
  const boardMesh = new THREE.Mesh(extrudeGeom, boardMat);
  boardMesh.renderOrder = 3;
  group.add(boardMesh);

  // Center cedar stringer stripe
  const stringerGeom = new THREE.BoxGeometry(0.012, 0.056, 2.02);
  const stringerMat = new THREE.MeshBasicMaterial({ color: 0x92400e });
  const stringer = new THREE.Mesh(stringerGeom, stringerMat);
  stringer.position.set(0, 0.012, 0.02);
  group.add(stringer);

  // Cyan/teal racing rail graphic near nose (+Z)
  const stripeGeom = new THREE.BoxGeometry(0.42, 0.054, 0.16);
  const stripeMat = new THREE.MeshBasicMaterial({ color: 0x06b6d4 });
  const stripe = new THREE.Mesh(stripeGeom, stripeMat);
  stripe.position.set(0, 0.02, 0.42);
  group.add(stripe);

  // Rear traction pad at tail (-Z)
  const padGeom = new THREE.BoxGeometry(0.28, 0.055, 0.34);
  const padMat = new THREE.MeshBasicMaterial({ color: 0x1e293b });
  const pad = new THREE.Mesh(padGeom, padMat);
  pad.position.set(0, 0.014, -0.68);
  group.add(pad);

  return group;
}

/**
 * Helper to build an exact anatomical limb segment connecting point A to point B.
 */
function createLimbSegment(pA, pB, radius, material) {
  const dir = new THREE.Vector3().subVectors(pB, pA);
  const len = dir.length();
  dir.normalize();

  const geom = new THREE.CylinderGeometry(radius * 0.88, radius, len, 8);
  const mesh = new THREE.Mesh(geom, material);
  mesh.position.set(0, len * 0.5, 0);

  const pivot = new THREE.Group();
  pivot.position.copy(pA);
  pivot.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  pivot.add(mesh);

  return pivot;
}

/**
 * Creates an anatomical foot mesh with clearly visible toes (+Z local) and heel (-Z local).
 */
function createFootMesh(material) {
  const shape = new THREE.Shape();
  // Toes at +Z, heel at -Z, sole at y = 0, instep at y = +0.042
  shape.moveTo(-0.032, 0.07); // heel left
  shape.lineTo(0.032, 0.07);  // heel right
  shape.bezierCurveTo(0.040, 0.01, 0.044, -0.05, 0.042, -0.08); // outer ball
  shape.bezierCurveTo(0.025, -0.095, -0.025, -0.095, -0.040, -0.08); // toes
  shape.bezierCurveTo(-0.042, -0.05, -0.036, 0.01, -0.032, 0.07); // inner arch

  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: 0.042,
    bevelEnabled: true,
    bevelSegments: 2,
    steps: 1,
    bevelSize: 0.005,
    bevelThickness: 0.005,
  });
  geom.rotateX(-Math.PI / 2);
  return new THREE.Mesh(geom, material);
}

/**
 * Procedural 3D Surfer Character Figure generator.
 * Stance: TRUE REGULAR
 * - Left foot in front (at +Z near nose).
 * - Right foot in back (at -Z on traction pad).
 * - Both knees bent forward in the direction of travel (+Z).
 * - Chest open toward wave face (+X).
 * - Head and lead arm pointing down the line (+Z).
 */
export function createSurferFigure() {
  const group = new THREE.Group();
  group.name = 'SurferFigure';

  // Stylized high-performance surf materials
  const wetsuitMat = new THREE.MeshStandardMaterial({
    color: 0x111827, // dark charcoal neoprene
    roughness: 0.38,
    metalness: 0.08,
  });
  const wetsuitAccentMat = new THREE.MeshStandardMaterial({
    color: 0x06b6d4, // bright cyan stripes/panels
    roughness: 0.32,
    metalness: 0.12,
  });
  const skinMat = new THREE.MeshStandardMaterial({
    color: 0xd49568, // tanned skin tone
    roughness: 0.65,
    metalness: 0.04,
  });
  const hairMat = new THREE.MeshStandardMaterial({
    color: 0x221712, // dark brown surf hair
    roughness: 0.85,
    metalness: 0.02,
  });

  // =========================================================================
  // 1. PRONE GROUP (Paddling flat on deck with arched cobra chest)
  // =========================================================================
  const prone = new THREE.Group();
  prone.name = 'SurferProne';

  // Prone Torso: horizontal along Z, chest lifted in classic surf paddle arch
  const proneTorsoGeom = new THREE.CapsuleGeometry(0.12, 0.38, 4, 10);
  proneTorsoGeom.rotateX(Math.PI / 2);
  const proneTorso = new THREE.Mesh(proneTorsoGeom, wetsuitMat);
  proneTorso.position.set(0, 0.11, 0.04);
  proneTorso.rotation.x = -0.26; // Arch chest upward ~15°
  prone.add(proneTorso);

  // Wetsuit back accent panel
  const proneAccentGeom = new THREE.BoxGeometry(0.19, 0.04, 0.22);
  const proneAccent = new THREE.Mesh(proneAccentGeom, wetsuitAccentMat);
  proneAccent.position.set(0, 0.17, 0.08);
  proneAccent.rotation.x = -0.26;
  prone.add(proneAccent);

  // Prone Head: looking forward along +Z toward the nose
  const proneHeadGeom = new THREE.SphereGeometry(0.105, 10, 8);
  const proneHead = new THREE.Mesh(proneHeadGeom, skinMat);
  proneHead.position.set(0, 0.22, 0.28);
  proneHead.rotation.x = 0.12;
  prone.add(proneHead);

  const proneHairGeom = new THREE.SphereGeometry(0.11, 8, 6);
  proneHairGeom.scale(1.0, 0.55, 1.05);
  const proneHair = new THREE.Mesh(proneHairGeom, hairMat);
  proneHair.position.set(0, 0.04, -0.02);
  proneHead.add(proneHair);

  // Prone Legs: extending back toward tail (-Z)
  const proneLegGeom = new THREE.CapsuleGeometry(0.06, 0.52, 4, 8);
  proneLegGeom.rotateX(Math.PI / 2);
  const proneLegL = new THREE.Mesh(proneLegGeom, wetsuitMat);
  proneLegL.position.set(-0.075, 0.065, -0.42);
  const proneLegR = new THREE.Mesh(proneLegGeom, wetsuitMat);
  proneLegR.position.set(0.075, 0.065, -0.42);
  prone.add(proneLegL, proneLegR);

  // Prone Feet: resting on deck near tail
  const proneFootL = createFootMesh(skinMat);
  proneFootL.position.set(-0.075, 0.04, -0.72);
  proneFootL.rotation.x = -0.55;
  const proneFootR = createFootMesh(skinMat);
  proneFootR.position.set(0.075, 0.04, -0.72);
  proneFootR.rotation.x = -0.55;
  prone.add(proneFootL, proneFootR);

  // Prone Arms: shoulder pivots for paddling animation
  const armGeom = new THREE.CapsuleGeometry(0.048, 0.38, 4, 8);
  armGeom.translate(0, -0.18, 0);

  const proneArmL = new THREE.Group();
  proneArmL.position.set(-0.17, 0.16, 0.18);
  const armLMesh = new THREE.Mesh(armGeom, skinMat);
  proneArmL.add(armLMesh);

  const proneArmR = new THREE.Group();
  proneArmR.position.set(0.17, 0.16, 0.18);
  const armRMesh = new THREE.Mesh(armGeom, skinMat);
  proneArmR.add(armRMesh);

  prone.add(proneArmL, proneArmR);
  group.add(prone);

  // =========================================================================
  // 2. STANDING GROUP: TEXTBOOK REGULAR STANCE (Left Foot Front, Right Foot Back)
  // =========================================================================
  const standing = new THREE.Group();
  standing.name = 'SurferStanding';

  // --- Feet on Deck (Surface y = 0.035) ---
  // Back Foot: RIGHT FOOT at tail (-Z = -0.62m ON TRACTION PAD)
  // Pointing across the stringer toward right rail (+X)
  const standFootR = createFootMesh(skinMat);
  standFootR.position.set(-0.02, 0.035, -0.62);
  standFootR.rotation.y = Math.PI / 2; // 90°: toes point toward +X (right rail), heel at -X (left rail)
  standing.add(standFootR);

  // Front Foot: LEFT FOOT forward (+Z = +0.18m on center deck)
  // Angled ~45° open toward front-right rail (+X, +Z)
  const standFootL = createFootMesh(skinMat);
  standFootL.position.set(0.02, 0.035, 0.18);
  standFootL.rotation.y = 0.78; // 45°: toes point toward +X/+Z
  standing.add(standFootL);

  // --- Upper Body Group ---
  const upperBody = new THREE.Group();
  upperBody.name = 'SurferStandingUpper';
  standing.add(upperBody);

  // Regular Stance Joint Alignments:
  // Back Leg (Right Leg): Right Ankle is back at -Z.
  // Back Knee drops forward (+Z) and inward (+X) into the athletic surf crouch!
  const rightAnkle = new THREE.Vector3(-0.02, 0.04, -0.62);
  const rightKnee = new THREE.Vector3(0.02, 0.28, -0.48);
  const rightHip = new THREE.Vector3(0.02, 0.50, -0.26);

  // Front Leg (Left Leg): Left Ankle is forward at +Z.
  // Front Knee flexes forward (+Z) over front foot!
  const leftAnkle = new THREE.Vector3(0.02, 0.04, 0.18);
  const leftKnee = new THREE.Vector3(0.03, 0.28, 0.16);
  const leftHip = new THREE.Vector3(-0.02, 0.50, -0.04);

  // Calf Segments (connect ankles to knees)
  const rightCalfSeg = createLimbSegment(rightAnkle, rightKnee, 0.056, wetsuitMat);
  const leftCalfSeg = createLimbSegment(leftAnkle, leftKnee, 0.056, wetsuitMat);
  standing.add(rightCalfSeg, leftCalfSeg);

  // Knee Joint Caps
  const kneeGeom = new THREE.SphereGeometry(0.064, 8, 8);
  const kneeR = new THREE.Mesh(kneeGeom, wetsuitMat);
  kneeR.position.copy(rightKnee);
  const kneeL = new THREE.Mesh(kneeGeom, wetsuitMat);
  kneeL.position.copy(leftKnee);
  standing.add(kneeR, kneeL);

  // Thigh Segments (connect knees to hips)
  const rightThighSeg = createLimbSegment(rightKnee, rightHip, 0.066, wetsuitMat);
  const leftThighSeg = createLimbSegment(leftKnee, leftHip, 0.066, wetsuitMat);
  upperBody.add(rightThighSeg, leftThighSeg);

  // Hip Joint Caps
  const hipCapGeom = new THREE.SphereGeometry(0.068, 8, 8);
  const hipCapR = new THREE.Mesh(hipCapGeom, wetsuitMat);
  hipCapR.position.copy(rightHip);
  const hipCapL = new THREE.Mesh(hipCapGeom, wetsuitMat);
  hipCapL.position.copy(leftHip);
  upperBody.add(hipCapR, hipCapL);

  // --- Pelvis & Hips ---
  // Angled ~75° open toward right rail (+X)
  const hipGeom = new THREE.BoxGeometry(0.18, 0.14, 0.26);
  const hips = new THREE.Mesh(hipGeom, wetsuitMat);
  hips.position.set(0.0, 0.50, -0.15);
  hips.rotation.y = 1.35;
  upperBody.add(hips);

  // --- Torso & Chest ---
  // Torso extends upward, chest open ~72° toward right rail (+X)
  const standTorsoGeom = new THREE.CapsuleGeometry(0.13, 0.30, 4, 10);
  const standTorso = new THREE.Mesh(standTorsoGeom, wetsuitMat);
  standTorso.position.set(0.0, 0.70, -0.15);
  standTorso.rotation.y = 1.25;
  upperBody.add(standTorso);

  // Wetsuit chest cyan accent panel (clearly identifies the front/chest on +X)
  const standAccentGeom = new THREE.BoxGeometry(0.06, 0.18, 0.22);
  const standAccent = new THREE.Mesh(standAccentGeom, wetsuitAccentMat);
  standAccent.position.set(0.10, 0.72, -0.14);
  upperBody.add(standAccent);

  // --- Head & Neck ---
  // Head is turned forward (+Z) looking directly down the peeling wave wall
  const standHeadGeom = new THREE.SphereGeometry(0.11, 10, 8);
  const standHead = new THREE.Mesh(standHeadGeom, skinMat);
  standHead.position.set(0.0, 0.94, -0.12);
  standHead.rotation.y = 0.12; // Looking along +Z (nose of board)
  standHead.rotation.x = -0.05;
  upperBody.add(standHead);

  // Nose pointing forward (+Z)
  const noseGeom = new THREE.ConeGeometry(0.025, 0.05, 6);
  noseGeom.rotateX(Math.PI / 2);
  const nose = new THREE.Mesh(noseGeom, skinMat);
  nose.position.set(0.0, -0.01, 0.11);
  standHead.add(nose);

  // Hair on back of skull (-Z)
  const standHairGeom = new THREE.SphereGeometry(0.115, 8, 6);
  standHairGeom.scale(1.0, 0.58, 1.05);
  const standHair = new THREE.Mesh(standHairGeom, hairMat);
  standHair.position.set(0.0, 0.04, -0.03);
  standHead.add(standHair);

  // --- Dynamic Surfing Arms ---
  // LEAD ARM (LEFT ARM): front shoulder at +Z (z = -0.04), reaching FORWARD along +Z down the line
  const standArmL = new THREE.Group();
  standArmL.position.set(-0.02, 0.80, -0.04);
  const localElbowL = new THREE.Vector3(0.08, -0.10, 0.18);
  const localHandL = new THREE.Vector3(0.12, -0.16, 0.38);

  const armLUpper = createLimbSegment(new THREE.Vector3(0, 0, 0), localElbowL, 0.046, wetsuitMat);
  const elbowCapL = new THREE.Mesh(new THREE.SphereGeometry(0.048, 8, 8), wetsuitMat);
  elbowCapL.position.copy(localElbowL);
  const armLFore = createLimbSegment(localElbowL, localHandL, 0.040, skinMat);
  const handL = new THREE.Mesh(new THREE.SphereGeometry(0.042, 6, 6), skinMat);
  handL.position.copy(localHandL);
  standArmL.add(armLUpper, elbowCapL, armLFore, handL);
  upperBody.add(standArmL);

  // TRAILING ARM (RIGHT ARM): back shoulder at -Z (z = -0.26), held back and up for balance
  const standArmR = new THREE.Group();
  standArmR.position.set(0.04, 0.80, -0.26);
  const localElbowR = new THREE.Vector3(0.04, -0.06, -0.16);
  const localHandR = new THREE.Vector3(0.08, -0.10, -0.32);

  const armRUpper = createLimbSegment(new THREE.Vector3(0, 0, 0), localElbowR, 0.046, wetsuitMat);
  const elbowCapR = new THREE.Mesh(new THREE.SphereGeometry(0.048, 8, 8), wetsuitMat);
  elbowCapR.position.copy(localElbowR);
  const armRFore = createLimbSegment(localElbowR, localHandR, 0.040, skinMat);
  const handR = new THREE.Mesh(new THREE.SphereGeometry(0.042, 6, 6), skinMat);
  handR.position.copy(localHandR);
  standArmR.add(armRUpper, elbowCapR, armRFore, handR);
  upperBody.add(standArmR);

  group.add(standing);

  // =========================================================================
  // 3. SITTING GROUP: RELAXED STRADDLE ON DECK (Legs in water, upright torso)
  // =========================================================================
  const sitting = new THREE.Group();
  sitting.name = 'SurferSitting';

  // --- Pelvis & Hips ---
  // Centered over stringer at z = -0.20, resting on the deck
  const sitHipGeom = new THREE.BoxGeometry(0.20, 0.08, 0.20);
  const sitHips = new THREE.Mesh(sitHipGeom, wetsuitMat);
  sitHips.position.set(0.0, 0.06, -0.20);
  sitting.add(sitHips);

  // --- Torso & Chest ---
  // Torso extends upward with slight relaxed forward lean (~4°)
  const sitTorsoGeom = new THREE.CapsuleGeometry(0.12, 0.26, 4, 10);
  const sitTorso = new THREE.Mesh(sitTorsoGeom, wetsuitMat);
  sitTorso.position.set(0.0, 0.24, -0.20);
  sitTorso.rotation.x = 0.06;
  sitting.add(sitTorso);

  // Wetsuit cyan accent panel on chest (+Z side)
  const sitAccentGeom = new THREE.BoxGeometry(0.18, 0.12, 0.06);
  const sitAccent = new THREE.Mesh(sitAccentGeom, wetsuitAccentMat);
  sitAccent.position.set(0.0, 0.26, -0.10);
  sitAccent.rotation.x = 0.06;
  sitting.add(sitAccent);

  // --- Head & Neck ---
  const sitNeckGeom = new THREE.CylinderGeometry(0.045, 0.05, 0.06, 8);
  const sitNeck = new THREE.Mesh(sitNeckGeom, skinMat);
  sitNeck.position.set(0.0, 0.40, -0.18);
  sitting.add(sitNeck);

  const sitHead = new THREE.Group();
  sitHead.position.set(0.0, 0.48, -0.17);
  sitHead.rotation.x = -0.04;

  const sitHeadMesh = new THREE.Mesh(standHeadGeom, skinMat);
  sitHead.add(sitHeadMesh);

  const sitNose = new THREE.Mesh(noseGeom, skinMat);
  sitNose.position.set(0.0, -0.01, 0.11);
  sitHead.add(sitNose);

  const sitHair = new THREE.Mesh(standHairGeom, hairMat);
  sitHair.position.set(0.0, 0.04, -0.03);
  sitHead.add(sitHair);
  sitting.add(sitHead);

  // --- Legs straddling the surfboard rails & dangling into the water ---
  // Left Leg:
  const sitLeftHip = new THREE.Vector3(-0.09, 0.08, -0.19);
  const sitLeftKnee = new THREE.Vector3(-0.28, 0.01, -0.06);
  const sitLeftAnkle = new THREE.Vector3(-0.28, -0.32, -0.06);

  const sitLeftThigh = createLimbSegment(sitLeftHip, sitLeftKnee, 0.058, wetsuitMat);
  const sitLeftKneeMesh = new THREE.Mesh(new THREE.SphereGeometry(0.060, 8, 8), wetsuitMat);
  sitLeftKneeMesh.position.copy(sitLeftKnee);
  const sitLeftCalf = createLimbSegment(sitLeftKnee, sitLeftAnkle, 0.052, wetsuitMat);
  const sitLeftFoot = createFootMesh(skinMat);
  sitLeftFoot.position.copy(sitLeftAnkle);
  sitLeftFoot.rotation.x = 0.45;
  sitLeftFoot.rotation.y = -0.12;
  sitting.add(sitLeftThigh, sitLeftKneeMesh, sitLeftCalf, sitLeftFoot);

  // Right Leg:
  const sitRightHip = new THREE.Vector3(0.09, 0.08, -0.19);
  const sitRightKnee = new THREE.Vector3(0.28, 0.01, -0.06);
  const sitRightAnkle = new THREE.Vector3(0.28, -0.32, -0.06);

  const sitRightThigh = createLimbSegment(sitRightHip, sitRightKnee, 0.058, wetsuitMat);
  const sitRightKneeMesh = new THREE.Mesh(new THREE.SphereGeometry(0.060, 8, 8), wetsuitMat);
  sitRightKneeMesh.position.copy(sitRightKnee);
  const sitRightCalf = createLimbSegment(sitRightKnee, sitRightAnkle, 0.052, wetsuitMat);
  const sitRightFoot = createFootMesh(skinMat);
  sitRightFoot.position.copy(sitRightAnkle);
  sitRightFoot.rotation.x = 0.45;
  sitRightFoot.rotation.y = 0.12;
  sitting.add(sitRightThigh, sitRightKneeMesh, sitRightCalf, sitRightFoot);

  // --- Arms resting comfortably along the rails/deck (Seamlessly connected) ---
  // Left Arm (pivot at shoulder)
  const sitArmL = new THREE.Group();
  sitArmL.position.set(-0.16, 0.35, -0.18);
  const sitLocalElbowL = new THREE.Vector3(-0.06, -0.16, 0.06);
  const sitLocalHandL = new THREE.Vector3(-0.06, -0.29, 0.20);

  const sitUpL = createLimbSegment(new THREE.Vector3(0, 0, 0), sitLocalElbowL, 0.044, wetsuitMat);
  const sitElbowCapL = new THREE.Mesh(new THREE.SphereGeometry(0.046, 8, 8), wetsuitMat);
  sitElbowCapL.position.copy(sitLocalElbowL);
  const sitForeL = createLimbSegment(sitLocalElbowL, sitLocalHandL, 0.040, skinMat);
  const sitHandL = new THREE.Mesh(new THREE.SphereGeometry(0.042, 6, 6), skinMat);
  sitHandL.position.copy(sitLocalHandL);
  sitArmL.add(sitUpL, sitElbowCapL, sitForeL, sitHandL);
  sitting.add(sitArmL);

  // Right Arm (pivot at shoulder)
  const sitArmR = new THREE.Group();
  sitArmR.position.set(0.16, 0.35, -0.18);
  const sitLocalElbowR = new THREE.Vector3(0.06, -0.16, 0.06);
  const sitLocalHandR = new THREE.Vector3(0.06, -0.29, 0.20);

  const sitUpR = createLimbSegment(new THREE.Vector3(0, 0, 0), sitLocalElbowR, 0.044, wetsuitMat);
  const sitElbowCapR = new THREE.Mesh(new THREE.SphereGeometry(0.046, 8, 8), wetsuitMat);
  sitElbowCapR.position.copy(sitLocalElbowR);
  const sitForeR = createLimbSegment(sitLocalElbowR, sitLocalHandR, 0.040, skinMat);
  const sitHandR = new THREE.Mesh(new THREE.SphereGeometry(0.042, 6, 6), skinMat);
  sitHandR.position.copy(sitLocalHandR);
  sitArmR.add(sitUpR, sitElbowCapR, sitForeR, sitHandR);
  sitting.add(sitArmR);

  group.add(sitting);

  // Initially show sitting when waiting in lineup
  prone.visible = false;
  standing.visible = false;
  sitting.visible = true;

  return {
    group,
    proneGroup: prone,
    standingGroup: standing,
    standingUpperGroup: upperBody,
    sittingGroup: sitting,
    proneHead,
    proneArmL,
    proneArmR,
    standArmL,
    standArmR,
    sitHead,
    sitArmL,
    sitArmR,
  };
}
