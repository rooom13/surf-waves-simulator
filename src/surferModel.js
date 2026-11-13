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

  // Cyan/teal racing rail graphic near nose
  const stripeGeom = new THREE.BoxGeometry(0.42, 0.054, 0.16);
  const stripeMat = new THREE.MeshBasicMaterial({ color: 0x06b6d4 });
  const stripe = new THREE.Mesh(stripeGeom, stripeMat);
  stripe.position.set(0, 0.02, 0.42);
  group.add(stripe);

  // Rear traction pad (EVA grip pad)
  const padGeom = new THREE.BoxGeometry(0.28, 0.055, 0.34);
  const padMat = new THREE.MeshBasicMaterial({ color: 0x1e293b });
  const pad = new THREE.Mesh(padGeom, padMat);
  pad.position.set(0, 0.014, -0.68);
  group.add(pad);

  return group;
}

/**
 * Procedural 3D Surfer Character Figure generator.
 * Builds both Prone (paddling) and Standing (riding) poses with joint pivots
 * for dynamic animation.
 */
export function createSurferFigure() {
  const group = new THREE.Group();
  group.name = 'SurferFigure';

  // Stylized high-performance surf materials
  const wetsuitMat = new THREE.MeshStandardMaterial({
    color: 0x111827, // dark charcoal neoprene
    roughness: 0.40,
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

  // 1. PRONE GROUP (Lying down paddling or duck diving)
  const prone = new THREE.Group();
  prone.name = 'SurferProne';

  // Prone Torso (arched upward chest)
  const proneTorsoGeom = new THREE.CapsuleGeometry(0.13, 0.42, 4, 8);
  const proneTorso = new THREE.Mesh(proneTorsoGeom, wetsuitMat);
  proneTorso.position.set(0, 0.14, 0.02);
  proneTorso.rotation.x = 0.18; // chest lifted
  prone.add(proneTorso);

  // Wetsuit back accent panel
  const proneAccentGeom = new THREE.BoxGeometry(0.20, 0.04, 0.22);
  const proneAccent = new THREE.Mesh(proneAccentGeom, wetsuitAccentMat);
  proneAccent.position.set(0, 0.21, 0.05);
  proneAccent.rotation.x = 0.18;
  prone.add(proneAccent);

  // Prone Head
  const proneHeadGeom = new THREE.SphereGeometry(0.11, 10, 8);
  const proneHead = new THREE.Mesh(proneHeadGeom, skinMat);
  proneHead.position.set(0, 0.26, 0.32);
  prone.add(proneHead);

  const proneHairGeom = new THREE.SphereGeometry(0.115, 8, 6);
  proneHairGeom.scale(1.0, 0.55, 1.05);
  const proneHair = new THREE.Mesh(proneHairGeom, hairMat);
  proneHair.position.set(0, 0.05, -0.02);
  proneHead.add(proneHair);

  // Prone Legs (extended back toward tail)
  const proneLegGeom = new THREE.CapsuleGeometry(0.065, 0.55, 4, 8);
  proneLegGeom.rotateX(Math.PI / 2);
  const proneLegL = new THREE.Mesh(proneLegGeom, wetsuitMat);
  proneLegL.position.set(-0.09, 0.08, -0.44);
  const proneLegR = new THREE.Mesh(proneLegGeom, wetsuitMat);
  proneLegR.position.set(0.09, 0.08, -0.44);
  prone.add(proneLegL, proneLegR);

  // Prone Arms (paddling shoulder pivots)
  const armGeom = new THREE.CapsuleGeometry(0.052, 0.42, 4, 8);
  armGeom.translate(0, -0.19, 0);

  const proneArmL = new THREE.Group();
  proneArmL.position.set(-0.19, 0.17, 0.18);
  const armLMesh = new THREE.Mesh(armGeom, skinMat);
  proneArmL.add(armLMesh);

  const proneArmR = new THREE.Group();
  proneArmR.position.set(0.19, 0.17, 0.18);
  const armRMesh = new THREE.Mesh(armGeom, skinMat);
  proneArmR.add(armRMesh);

  prone.add(proneArmL, proneArmR);
  group.add(prone);

  // 2. STANDING GROUP (Athletic wave riding stance)
  const standing = new THREE.Group();
  standing.name = 'SurferStanding';

  // Pelvis / Hips
  const hipGeom = new THREE.BoxGeometry(0.28, 0.16, 0.22);
  const hips = new THREE.Mesh(hipGeom, wetsuitMat);
  hips.position.set(-0.02, 0.65, -0.16);
  standing.add(hips);

  // Torso (angled slightly forward & turned towards wave face)
  const standTorsoGeom = new THREE.CapsuleGeometry(0.155, 0.44, 4, 10);
  const standTorso = new THREE.Mesh(standTorsoGeom, wetsuitMat);
  standTorso.position.set(-0.03, 0.98, -0.14);
  standTorso.rotation.x = -0.08;
  standTorso.rotation.y = 0.32;
  standing.add(standTorso);

  // Wetsuit chest/shoulder cyan accent
  const standAccentGeom = new THREE.BoxGeometry(0.24, 0.18, 0.18);
  const standAccent = new THREE.Mesh(standAccentGeom, wetsuitAccentMat);
  standAccent.position.set(-0.03, 1.08, -0.14);
  standAccent.rotation.y = 0.32;
  standing.add(standAccent);

  // Standing Head & Hair
  const standHeadGeom = new THREE.SphereGeometry(0.12, 10, 8);
  const standHead = new THREE.Mesh(standHeadGeom, skinMat);
  standHead.position.set(-0.02, 1.34, -0.11);
  standHead.rotation.y = 0.48; // looking down the line
  standing.add(standHead);

  const standHairGeom = new THREE.SphereGeometry(0.125, 8, 6);
  standHairGeom.scale(1.0, 0.58, 1.05);
  const standHair = new THREE.Mesh(standHairGeom, hairMat);
  standHair.position.set(0, 0.05, -0.01);
  standHead.add(standHair);

  // Front Left Leg (flexed athletic knee, foot angled forward on deck)
  const legThighGeom = new THREE.CapsuleGeometry(0.072, 0.38, 4, 8);
  legThighGeom.translate(0, -0.16, 0);

  const legCalfGeom = new THREE.CapsuleGeometry(0.065, 0.36, 4, 8);
  legCalfGeom.translate(0, -0.15, 0);

  // Left Thigh
  const leftThigh = new THREE.Mesh(legThighGeom, wetsuitMat);
  leftThigh.position.set(-0.11, 0.62, -0.08);
  leftThigh.rotation.x = -0.52;
  leftThigh.rotation.z = -0.18;
  standing.add(leftThigh);

  // Left Shin / Calf
  const leftCalf = new THREE.Mesh(legCalfGeom, wetsuitMat);
  leftCalf.position.set(-0.08, 0.34, 0.08);
  leftCalf.rotation.x = 0.38;
  leftCalf.rotation.z = -0.06;
  standing.add(leftCalf);

  // Left Foot (angled forward ~35°)
  const footGeom = new THREE.BoxGeometry(0.10, 0.05, 0.22);
  const leftFoot = new THREE.Mesh(footGeom, skinMat);
  leftFoot.position.set(-0.06, 0.035, 0.22);
  leftFoot.rotation.y = 0.58;
  standing.add(leftFoot);

  // Back Right Leg (driving power over rear traction pad)
  const rightThigh = new THREE.Mesh(legThighGeom, wetsuitMat);
  rightThigh.position.set(0.08, 0.62, -0.24);
  rightThigh.rotation.x = 0.42;
  rightThigh.rotation.z = 0.16;
  standing.add(rightThigh);

  const rightCalf = new THREE.Mesh(legCalfGeom, wetsuitMat);
  rightCalf.position.set(0.06, 0.35, -0.46);
  rightCalf.rotation.x = -0.32;
  rightCalf.rotation.z = 0.08;
  standing.add(rightCalf);

  const rightFoot = new THREE.Mesh(footGeom, skinMat);
  rightFoot.position.set(0.02, 0.035, -0.62);
  rightFoot.rotation.y = 1.35; // nearly perpendicular across traction pad
  standing.add(rightFoot);

  // Arms: Shoulders with pivots for dynamic balance & carving counter-rotation
  const standArmGeom = new THREE.CapsuleGeometry(0.056, 0.44, 4, 8);
  standArmGeom.translate(0, -0.20, 0);

  // Leading Left Arm (pointing down the line into the barrel)
  const standArmL = new THREE.Group();
  standArmL.position.set(-0.21, 1.15, -0.05);
  const standArmLMesh = new THREE.Mesh(standArmGeom, wetsuitMat);
  standArmL.add(standArmLMesh);
  const handLGeom = new THREE.SphereGeometry(0.045, 6, 6);
  const handL = new THREE.Mesh(handLGeom, skinMat);
  handL.position.set(0, -0.42, 0);
  standArmL.add(handL);
  standing.add(standArmL);

  // Trailing Right Arm (held out and back for balance)
  const standArmR = new THREE.Group();
  standArmR.position.set(0.18, 1.15, -0.22);
  const standArmRMesh = new THREE.Mesh(standArmGeom, wetsuitMat);
  standArmR.add(standArmRMesh);
  const handR = new THREE.Mesh(handLGeom, skinMat);
  handR.position.set(0, -0.42, 0);
  standArmR.add(handR);
  standing.add(standArmR);

  group.add(standing);

  // Initially show prone
  prone.visible = true;
  standing.visible = false;

  return {
    group,
    proneGroup: prone,
    standingGroup: standing,
    proneHead,
    proneArmL,
    proneArmR,
    standArmL,
    standArmR,
  };
}
