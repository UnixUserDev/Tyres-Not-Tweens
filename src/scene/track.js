/**
 * Everything you can see that isn't the car. Geometry mirrors physics/sim.js so
 * a ramp you drive up is exactly the hull Rapier resolved.
 */

import * as THREE from 'three';
import { TRACK } from '../physics/sim.js';

function asphaltTexture() {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#6b7075';
  ctx.fillRect(0, 0, size, size);

  // aggregate: speckle + a few larger stones
  for (let i = 0; i < 22000; i++) {
    const v = 55 + Math.random() * 70;
    ctx.fillStyle = `rgba(${v},${v},${v + 4},${0.25 + Math.random() * 0.5})`;
    const r = Math.random() * 1.8;
    ctx.fillRect(Math.random() * size, Math.random() * size, r, r);
  }
  for (let i = 0; i < 900; i++) {
    const v = 30 + Math.random() * 40;
    ctx.fillStyle = `rgba(${v},${v},${v},0.5)`;
    ctx.beginPath();
    ctx.arc(Math.random() * size, Math.random() * size, 1 + Math.random() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // subtle darker patches, like repairs
  for (let i = 0; i < 12; i++) {
    ctx.fillStyle = `rgba(20,22,24,${0.05 + Math.random() * 0.07})`;
    ctx.beginPath();
    ctx.arc(Math.random() * size, Math.random() * size, 30 + Math.random() * 90, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(TRACK.size / 4, TRACK.size / 4);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildSky(scene) {
  const geo = new THREE.SphereGeometry(900, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(0x5b8fd0) },
      bottom: { value: new THREE.Color(0xe9f1f8) },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 top; uniform vec3 bottom; varying vec3 vPos;
      void main() {
        float h = clamp(normalize(vPos).y * 1.6 + 0.15, 0.0, 1.0);
        gl_FragColor = vec4(mix(bottom, top, pow(h, 0.75)), 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(geo, mat));
  scene.fog = new THREE.Fog(0xd3dfe9, 160, 480);
}

function buildGround(scene) {
  const geo = new THREE.PlaneGeometry(TRACK.size, TRACK.size, 1, 1);
  const mat = new THREE.MeshStandardMaterial({
    map: asphaltTexture(),
    color: 0xd8dbde,
    roughness: 0.94,
    metalness: 0.04,
  });
  const ground = new THREE.Mesh(geo, mat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
}

function paintMaterial(opacity = 0.72) {
  return new THREE.MeshStandardMaterial({
    color: 0xe9ecea,
    roughness: 0.65,
    transparent: true,
    opacity,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
}

function flatRect(scene, mat, w, d, x, z, rotY = 0, y = 0.012) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.z = rotY;
  mesh.position.set(x, y, z);
  scene.add(mesh);
  return mesh;
}

function buildMarkings(scene) {
  const mat = paintMaterial();

  // runway edges
  flatRect(scene, mat, 0.18, 150, -7.4, 65);
  flatRect(scene, mat, 0.18, 150, 7.4, 65);
  // centre dashes
  for (let z = 0; z < 140; z += 11) flatRect(scene, mat, 0.14, 4.5, 0, z);

  // start / finish
  for (let i = 0; i < 2; i++) flatRect(scene, mat, 1.0, 0.5, -6.5 + i * 1.2, 2);
  for (let i = 0; i < 2; i++) flatRect(scene, paintMaterial(0.9), 1.0, 0.5, 5.3 + i * 1.2, 2);

  // braking boards across the runway at the 50 m mark
  for (let i = 0; i < 6; i++) {
    flatRect(scene, paintMaterial(0.5), 0.9, 0.5, -6 + i * 2.4, 50);
  }

  // skidpad rings
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(TRACK.skidpad.radius - 0.16, TRACK.skidpad.radius + 0.16, 128),
    paintMaterial(0.6),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(TRACK.skidpad.x, 0.012, TRACK.skidpad.z);
  scene.add(ring);

  const inner = new THREE.Mesh(
    new THREE.RingGeometry(7.8, 8.1, 96),
    paintMaterial(0.5),
  );
  inner.rotation.x = -Math.PI / 2;
  inner.position.set(TRACK.skidpad.x, 0.012, TRACK.skidpad.z);
  scene.add(inner);
}

function buildRamps(scene, sim) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x6d6f73,
    roughness: 0.85,
    metalness: 0.1,
    flatShading: true,
    side: THREE.DoubleSide,
  });

  for (const ramp of sim.ramps) {
    // Extrude the same outline the collider is built from, so the surface you
    // see is the surface the wheels raycast against.
    const shape = new THREE.Shape();
    const o = ramp.outline;
    shape.moveTo(o[0][0], o[0][1]);
    for (let i = 1; i < o.length; i++) shape.lineTo(o[i][0], o[i][1]);
    shape.closePath();

    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: ramp.width,
      bevelEnabled: false,
      curveSegments: 1,
    });
    geo.rotateY(-Math.PI / 2); // profile into the ZY plane, extrude across X
    geo.translate(ramp.width / 2, 0, 0);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(ramp.x, 0, ramp.z);
    mesh.rotation.y = ramp.yaw;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);

    // Hazard stripe ON the crest. A flat box on a curved crest floats at its
    // ends, so this is a band that follows the outline, 20 mm thick, sitting
    // 4 mm proud of the surface and slightly wider than the ramp.
    const t0 = ramp.kind === 'kicker' ? 0.92 : 0.6;
    const t1 = ramp.kind === 'kicker' ? 1.0 : 0.74;
    const bandPts = o.filter(([z]) => z >= t0 * ramp.length - 1e-6 && z <= t1 * ramp.length + 1e-6);
    if (bandPts.length >= 2) {
      const band = new THREE.Shape();
      band.moveTo(bandPts[0][0], bandPts[0][1] + 0.004);
      for (let i = 1; i < bandPts.length; i++) band.lineTo(bandPts[i][0], bandPts[i][1] + 0.004);
      for (let i = bandPts.length - 1; i >= 0; i--) band.lineTo(bandPts[i][0], bandPts[i][1] - 0.02);
      band.closePath();

      const bandGeo = new THREE.ExtrudeGeometry(band, {
        depth: ramp.width + 0.02,
        bevelEnabled: false,
        curveSegments: 1,
      });
      bandGeo.rotateY(-Math.PI / 2);
      bandGeo.translate((ramp.width + 0.02) / 2, 0, 0);

      const stripe = new THREE.Mesh(
        bandGeo,
        new THREE.MeshStandardMaterial({ color: 0xd9b23a, roughness: 0.6 }),
      );
      stripe.position.set(ramp.x, 0, ramp.z);
      stripe.rotation.y = ramp.yaw;
      stripe.receiveShadow = true;
      scene.add(stripe);
    }
  }
}

function buildWalls(scene, sim) {
  const mat = new THREE.MeshStandardMaterial({ color: 0x8a8d91, roughness: 0.9 });
  for (const w of sim.staticBoxes) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w.sx, w.sy, w.sz), mat);
    mesh.position.set(w.x, w.y, w.z);
    mesh.rotation.y = w.yaw;
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    scene.add(mesh);
  }
}

function buildProps(scene, sim) {
  const coneBody = new THREE.MeshStandardMaterial({ color: 0xe8631f, roughness: 0.55 });
  const coneBand = new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.5 });
  const coneGeo = new THREE.ConeGeometry(0.2, 0.64, 14);
  // The band has to be a frustum that follows the cone's taper. As a plain
  // cylinder of radius ~0.15 sitting where the cone is already down to ~0.08,
  // it bulged out as a fat ring around a thin cone.
  //   radius at height y (cone is centred, base y=-0.32, tip y=+0.32):
  //   r(y) = 0.2 * (0.32 - y) / 0.64
  const bandLo = 0.02;
  const bandHi = 0.13;
  const rAt = (y) => 0.2 * (0.32 - y) / 0.64;
  const bandGeo = new THREE.CylinderGeometry(
    rAt(bandHi) + 0.003,
    rAt(bandLo) + 0.003,
    bandHi - bandLo,
    14,
  );
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x9a7245, roughness: 0.85 });

  const meshes = [];
  for (const prop of sim.props) {
    let mesh;
    if (prop.kind === 'cone') {
      mesh = new THREE.Group();
      const cone = new THREE.Mesh(coneGeo, coneBody);
      cone.castShadow = true;
      const band = new THREE.Mesh(bandGeo, coneBand);
      band.position.y = (0.02 + 0.13) / 2;
      mesh.add(cone, band);
    } else {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(prop.size, prop.size, prop.size), crateMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    scene.add(mesh);
    meshes.push({ mesh, body: prop.body });
  }
  return meshes;
}

const MAX_SKID_QUADS = 2000;

class Skidmarks {
  constructor(scene) {
    this.positions = new Float32Array(MAX_SKID_QUADS * 4 * 3);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    const indices = new Uint32Array(MAX_SKID_QUADS * 6);
    for (let q = 0; q < MAX_SKID_QUADS; q++) {
      const v = q * 4;
      indices.set([v, v + 1, v + 2, v, v + 2, v + 3], q * 6);
    }
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geometry.setDrawRange(0, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x0a0a0a,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this.head = 0;
    this.count = 0;
    this.last = new Map();
  }

  update(car) {
    car.wheels.forEach((wheel, i) => {
      const c = wheel.contact;
      const laid = this.last.get(i);
      if (!c.grounded || c.utilisation < 0.9 || Math.abs(c.fx) + Math.abs(c.fy) < 300) {
        this.last.delete(i);
        return;
      }
      const p = { x: c.point.x, y: 0.014, z: c.point.z };
      if (!laid) {
        this.last.set(i, p);
        return;
      }
      const dx = p.x - laid.x;
      const dz = p.z - laid.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.03) return;
      if (len > 2.5) {
        this.last.set(i, p);
        return;
      }
      const nx = (-dz / len) * 0.11;
      const nz = (dx / len) * 0.11;
      const o = this.head * 12;
      const P = this.positions;
      P[o + 0] = laid.x - nx;
      P[o + 1] = laid.y;
      P[o + 2] = laid.z - nz;
      P[o + 3] = laid.x + nx;
      P[o + 4] = laid.y;
      P[o + 5] = laid.z + nz;
      P[o + 6] = p.x + nx;
      P[o + 7] = p.y;
      P[o + 8] = p.z + nz;
      P[o + 9] = p.x - nx;
      P[o + 10] = p.y;
      P[o + 11] = p.z - nz;

      this.head = (this.head + 1) % MAX_SKID_QUADS;
      this.count = Math.min(this.count + 1, MAX_SKID_QUADS);
      this.geometry.setDrawRange(0, this.count * 6);
      this.geometry.attributes.position.needsUpdate = true;
      this.last.set(i, p);
    });
  }

  clear() {
    this.head = 0;
    this.count = 0;
    this.geometry.setDrawRange(0, 0);
    this.last.clear();
  }
}

export function buildWorld(scene, sim) {
  buildSky(scene);
  buildGround(scene);
  buildMarkings(scene);

  const hemi = new THREE.HemisphereLight(0xdfeaff, 0x3a3f45, 0.55);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff6e8, 3.4);
  sun.position.set(60, 90, 40);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 260;
  sun.shadow.camera.left = -60;
  sun.shadow.camera.right = 60;
  sun.shadow.camera.top = 60;
  sun.shadow.camera.bottom = -60;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);
  scene.add(sun.target);

  buildWalls(scene, sim);

  // ramps and props belong to the scenario, so they live in their own groups
  // and get rebuilt when the scenario changes
  const rampGroup = new THREE.Group();
  const propGroup = new THREE.Group();
  scene.add(rampGroup, propGroup);
  const skidmarks = new Skidmarks(scene);
  let props = [];

  const clear = (group) => {
    for (const child of [...group.children]) {
      child.traverse?.((o) => {
        o.geometry?.dispose?.();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
        else o.material?.dispose?.();
      });
      group.remove(child);
    }
  };

  const rebuild = () => {
    clear(rampGroup);
    clear(propGroup);
    buildRamps(rampGroup, sim);
    props = buildProps(propGroup, sim);
    skidmarks.clear();
  };
  rebuild();

  return {
    sun,
    skidmarks,
    rebuild,
    update(car) {
      for (const { mesh, body } of props) {
        const t = body.translation();
        const r = body.rotation();
        mesh.position.set(t.x, t.y, t.z);
        mesh.quaternion.set(r.x, r.y, r.z, r.w);
      }
      skidmarks.update(car);

      // keep the shadow frustum on the car
      const p = car.body.translation();
      sun.position.set(p.x + 60, 90, p.z + 40);
      sun.target.position.set(p.x, 0, p.z);
      sun.target.updateMatrixWorld();
    },
  };
}
