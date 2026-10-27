/**
 * Visual car. Purely cosmetic - it reads the physics body, it never writes to it.
 *
 * The shell is a side profile extruded across the car, with the wheel arches cut
 * out of the outline, so the wheels sit in real openings instead of poking
 * through a slab. Proportions are a mid-engine-ish sports car: 4.24 m long,
 * 1.80 m wide, roof 1.22 m off the ground, on 0.66 m wheels.
 *
 * Body frame is the physics frame: origin at the centre of mass, +Z forward,
 * +Y up, ground 0.58 m below the origin at ride height.
 */

import * as THREE from 'three';

const PAINT = 0x1d3557;

const BOTTOM = -0.36; // under-body line, 0.22 m off the ground
const ARCH_Y = -0.25; // wheel centre (0.33 m radius, 0.58 m ride height)
const ARCH_R = 0.385; // radius of the opening: 5.5 cm of tyre-to-arch gap
const BELT = 0.32; // belt line: top of the doors / base of the glass

function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Extrude a 2D profile (z forward, y up) across the car's width. */
function extrudeProfile(points, width, material, bevel = 0.04) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 10,
  });
  // profile is built in the XY plane and extruded along Z; stand it up so the
  // profile lies in the car's ZY plane and the extrusion runs along X
  geo.rotateY(-Math.PI / 2);
  geo.translate(0, 0, 0);
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // extrude ran from 0..width along -X after the rotation; centre it
  mesh.position.x = (width - bevel * 2) / 2;
  return mesh;
}

/** Sample a wheel-arch arc in the body profile, from the bottom line up and over. */
function archPoints(zc, steps = 12) {
  const dy = ARCH_Y - BOTTOM; // 0.11
  const dz = Math.sqrt(ARCH_R * ARCH_R - dy * dy);
  const a0 = Math.atan2(-dy, dz);
  const a1 = Math.PI - a0;
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    out.push([zc + Math.cos(a) * ARCH_R, ARCH_Y + Math.sin(a) * ARCH_R]);
  }
  return out;
}

function bodyProfile() {
  const dz = Math.sqrt(ARCH_R * ARCH_R - (ARCH_Y - BOTTOM) ** 2);
  const front = 1.31;
  const rear = -1.31;
  return [
    [2.02, -0.26], // front valance
    [front + dz, BOTTOM], // up to the front arch
    ...archPoints(front),
    [rear + dz, BOTTOM], // sill
    ...archPoints(rear),
    [-2.0, -0.32], // under the tail
    [-2.12, -0.02], // tail panel
    [-2.06, 0.2], // tail top
    [-1.5, 0.3], // boot lid
    [-1.16, BELT], // base of the rear screen
    [0.6, BELT], // belt line along the doors
    [1.3, 0.29], // bonnet
    [1.82, 0.2], // top of the nose
    [2.1, 0.02], // nose face
    [2.06, -0.16],
  ];
}

/** A painted flare around a wheel opening, sitting proud of the flank. */
function archFlare(zc, material) {
  const outer = ARCH_R + 0.055;
  const inner = ARCH_R;
  const dy = ARCH_Y - BOTTOM;
  const a0 = Math.atan2(-dy, Math.sqrt(inner * inner - dy * dy));
  const a1 = Math.PI - a0;

  const shape = new THREE.Shape();
  shape.moveTo(zc + Math.cos(a0) * outer, ARCH_Y + Math.sin(a0) * outer);
  for (let i = 1; i <= 16; i++) {
    const a = a0 + ((a1 - a0) * i) / 16;
    shape.lineTo(zc + Math.cos(a) * outer, ARCH_Y + Math.sin(a) * outer);
  }
  for (let i = 16; i >= 0; i--) {
    const a = a0 + ((a1 - a0) * i) / 16;
    shape.lineTo(zc + Math.cos(a) * inner, ARCH_Y + Math.sin(a) * inner);
  }
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.03,
    bevelEnabled: true,
    bevelThickness: 0.01,
    bevelSize: 0.01,
    bevelSegments: 1,
    curveSegments: 8,
  });
  geo.rotateY(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  return mesh;
}

function cabinProfile() {
  return [
    [0.6, 0.3], // windscreen base, tucked under the belt line to avoid z-fighting
    [0.08, 0.6], // top of the windscreen
    [-0.62, 0.6], // roof, rear edge
    [-1.16, 0.3], // base of the rear screen
  ];
}

export function buildCarModel() {
  const root = new THREE.Group();

  const paint = new THREE.MeshStandardMaterial({
    color: PAINT,
    metalness: 0.55,
    roughness: 0.28,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x121417, metalness: 0.3, roughness: 0.65 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x2b3a49,
    metalness: 0.55,
    roughness: 0.12,
  });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xd6dee8, metalness: 1, roughness: 0.18 });
  const alloy = new THREE.MeshStandardMaterial({ color: 0xb9c3cd, metalness: 0.55, roughness: 0.38 });
  const red = new THREE.MeshStandardMaterial({
    color: 0xff2a1a,
    emissive: 0xff1a0a,
    emissiveIntensity: 1.7,
  });
  const white = new THREE.MeshStandardMaterial({
    color: 0xe9f1fb,
    emissive: 0xdfe9ff,
    emissiveIntensity: 0.85,
    metalness: 0.4,
    roughness: 0.15,
  });

  // ---- shell
  const BODY_W = 1.86;
  root.add(extrudeProfile(bodyProfile(), BODY_W, paint, 0.05));

  // ---- glasshouse, inset from the body sides
  root.add(extrudeProfile(cabinProfile(), 1.46, glass, 0.02));

  // ---- roof panel, sitting on top of the glass so the roof is body colour
  root.add(box(1.45, 0.05, 0.8, paint, 0, 0.612, -0.27));

  // ---- pillars. Painted, not black: on a real car the pillars are body
  // colour, and they are what divides one big black blob into a windscreen,
  // two side windows and a rear screen.
  for (const x of [-0.735, 0.735]) {
    // A-pillar, leaning back with the windscreen
    const a = box(0.05, 0.6, 0.05, paint, x, 0.45, 0.34);
    a.rotation.x = -1.047;
    root.add(a);
    // B-pillar, vertical
    root.add(box(0.05, 0.32, 0.09, paint, x, 0.45, -0.16));
    // C-pillar, leaning forward with the rear screen
    const c = box(0.05, 0.62, 0.05, paint, x, 0.45, -0.89);
    c.rotation.x = -2.077;
    root.add(c);
    // chrome window surround along the belt line
    root.add(box(0.03, 0.025, 1.76, chrome, x, 0.315, -0.28));
  }

  // ---- front end
  root.add(box(1.78, 0.1, 0.5, dark, 0, -0.33, 1.94)); // splitter

  // headlights: dark recess with a bright lens sitting proud of the nose, and
  // a slim DRL under each. The nose face slopes forward as it rises, so the
  // lenses lean with it instead of floating.
  for (const sx of [-1, 1]) {
    const recess = box(0.46, 0.14, 0.05, dark, sx * 0.53, -0.02, 2.09);
    recess.rotation.x = 0.28;
    root.add(recess);

    const lens = box(0.38, 0.085, 0.05, white, sx * 0.53, -0.01, 2.12);
    lens.rotation.x = 0.28;
    root.add(lens);

    const drl = box(0.36, 0.02, 0.04, white, sx * 0.53, -0.075, 2.125);
    drl.rotation.x = 0.28;
    root.add(drl);
  }

  // ---- rear end
  root.add(box(1.72, 0.14, 0.42, dark, 0, -0.3, -1.94)); // diffuser

  // Tail lights. The tail surface sits at z ~ -2.134 at this height, so lamps
  // at -2.1 were buried and only the thin bar showed - which read as a stripe.
  // Recess first, then a lens proud of it, tilted with the tail panel.
  // Tail plane through (y=0.10, z=-2.14), leaning 0.245 rad. The lamps are
  // 20 mm deep and centred so their back face is inside the panel and their
  // face is ~5 mm proud: flush, not floating.
  for (const sx of [-1, 1]) {
    const lamp = box(0.42, 0.09, 0.02, red, sx * 0.52, 0.1, -2.135);
    lamp.rotation.x = 0.27;
    root.add(lamp);
  }
  // full-width bar, raised so its top edge lines up with the top of the lamps
  // (lamps: y 0.10 +/- 0.045, so their top is 0.145 and the bar's centre 0.13).
  // z follows the tail plane at that height so it stays flush.
  const tailBar = box(0.62, 0.03, 0.02, red, 0, 0.13, -2.128);
  tailBar.rotation.x = 0.27;
  root.add(tailBar);
  for (const x of [-0.34, 0.34]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.12, 12), chrome);
    pipe.rotation.x = Math.PI / 2;
    // out of the diffuser's rear face rather than buried in it
    pipe.position.set(x, -0.3, -2.12);
    root.add(pipe);
  }

  // ---- rear wing on uprights, mounted to the boot rather than floating, and
  // tilted so it actually looks like it is doing something
  const wing = box(1.66, 0.045, 0.34, dark, 0, 0.44, -1.84);
  wing.rotation.x = 0.17; // trailing edge up = downforce
  root.add(wing);
  for (const x of [-0.84, 0.84]) {
    root.add(box(0.02, 0.18, 0.34, dark, x, 0.44, -1.84)); // end plates
  }
  for (const x of [-0.5, 0.5]) {
    root.add(box(0.05, 0.16, 0.14, dark, x, 0.35, -1.84));
  }

  // ---- sills, mirrors, door shut line
  for (const x of [-0.9, 0.9]) root.add(box(0.07, 0.1, 1.9, dark, x, -0.34, 0));
  for (const x of [-0.82, 0.82]) {
    root.add(box(0.06, 0.05, 0.1, dark, x * 1.0, 0.32, 0.5)); // stalk
    root.add(box(0.16, 0.08, 0.1, paint, x * 1.09, 0.34, 0.5)); // mirror
  }
  for (const x of [-0.902, 0.902]) root.add(box(0.012, 0.02, 1.5, dark, x, 0.14, -0.1));

  // ---- wheels
  const tireGeo = new THREE.CylinderGeometry(0.33, 0.33, 0.24, 30);
  tireGeo.rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.207, 0.207, 0.252, 24);
  rimGeo.rotateZ(Math.PI / 2);
  const discGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.26, 20);
  discGeo.rotateZ(Math.PI / 2);

  const lugGeo = new THREE.CylinderGeometry(0.024, 0.024, 0.035, 8);
  lugGeo.rotateZ(Math.PI / 2);
  const marker = new THREE.MeshStandardMaterial({
    color: 0xffc21a,
    emissive: 0x8a5c00,
    emissiveIntensity: 0.5,
    roughness: 0.4,
  });

  const rubber = new THREE.MeshStandardMaterial({ color: 0x0e0f12, roughness: 0.92 });

  // ---- axles: a diff housing bolted to the chassis plus two half-shafts that
  // run to the actual wheel centres, so they articulate with suspension travel
  // and visibly roll with the body.
  const shaftGeo = new THREE.CylinderGeometry(0.032, 0.032, 1, 8);
  shaftGeo.rotateZ(Math.PI / 2); // axis along X, unit length, scaled per frame
  const shaftMat = new THREE.MeshStandardMaterial({ color: 0x8d949c, metalness: 0.9, roughness: 0.35 });
  const axles = [];
  const AXLE_Y = -0.36; // level with the floor so it does not look like it is scraping
  for (const z of [1.31, -1.31]) {
    const diff = box(0.34, 0.17, 0.26, dark, 0, AXLE_Y, z);
    root.add(diff);
    const shafts = [-1, 1].map(() => {
      const shaft = new THREE.Mesh(shaftGeo, shaftMat);
      shaft.castShadow = true;
      root.add(shaft);
      return shaft;
    });
    axles.push({ z, diff, shafts });
  }

  const wheels = [];
  const offsets = [
    [0.8, 1.31],
    [-0.8, 1.31],
    [0.8, -1.31],
    [-0.8, -1.31],
  ];

  offsets.forEach(([x, z]) => {
    const group = new THREE.Group();
    const spin = new THREE.Group();

    // One cylinder, constant radius. The old version added torus "shoulders"
    // at each edge (0.345 outer) which made the tyre fatter at the rims than
    // across the tread.
    const tire = new THREE.Mesh(tireGeo, rubber);
    tire.castShadow = true;
    spin.add(tire);

    const rim = new THREE.Mesh(rimGeo, alloy);
    const disc = new THREE.Mesh(discGeo, dark);
    spin.add(rim, disc);

    for (let i = 0; i < 5; i++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.36, 0.05), alloy);
      spoke.rotation.x = (i / 5) * Math.PI * 2;
      spoke.position.x = 0.02;
      spin.add(spoke);
    }

    // Lugs, with one in hi-vis. Five identical spokes are unreadable once the
    // wheel is turning; a single marked bolt makes wheel speed obvious.
    // They go on the OUTBOARD face: +X on the left wheels, -X on the right,
    // otherwise the near-side bolts sit inside the car.
    const outboard = x > 0 ? 1 : -1;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const lug = new THREE.Mesh(lugGeo, i === 0 ? marker : alloy);
      lug.position.set(outboard * 0.132, Math.cos(a) * 0.135, Math.sin(a) * 0.135);
      spin.add(lug);
    }

    // brake caliper, does not spin with the wheel
    const caliper = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.13, 0.19), red);
    caliper.position.set(x > 0 ? 0.03 : -0.03, -0.02, -0.14);
    group.add(caliper);

    group.add(spin);
    group.position.set(x, ARCH_Y, z);
    root.add(group);
    wheels.push({ group, spin, x, z });
  });

  return { root, wheels, axles, axleY: AXLE_Y, axleEndX: 0.68, axleStartX: 0.15 };
}
