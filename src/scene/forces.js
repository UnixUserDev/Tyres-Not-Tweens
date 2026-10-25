/**
 * Debug overlay: draw the actual force vectors at the actual contact patches,
 * plus the moment arm from the CoM to each patch. This is the honest-looking
 * proof that the car is being pushed where the rubber meets the road.
 */

import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

export class ForceOverlay {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    this.tireArrows = [];
    this.loadArrows = [];
    this.markers = [];

    const markerGeo = new THREE.SphereGeometry(0.06, 8, 6);
    const markerMat = new THREE.MeshBasicMaterial({ color: 0xffe066 });

    for (let i = 0; i < 4; i++) {
      const tire = new THREE.ArrowHelper(UP, new THREE.Vector3(), 1, 0xff4d4d, 0.3, 0.16);
      const load = new THREE.ArrowHelper(UP, new THREE.Vector3(), 1, 0x53e07a, 0.22, 0.12);
      const marker = new THREE.Mesh(markerGeo, markerMat);
      this.group.add(tire, load, marker);
      this.tireArrows.push(tire);
      this.loadArrows.push(load);
      this.markers.push(marker);
    }

    // moment arms: CoM -> contact patch
    const armGeo = new THREE.BufferGeometry();
    armGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 2 * 3), 3));
    this.arms = new THREE.LineSegments(
      armGeo,
      new THREE.LineBasicMaterial({ color: 0x69b7ff, transparent: true, opacity: 0.85 }),
    );
    this.group.add(this.arms);
  }

  setVisible(v) {
    this.group.visible = v;
  }

  toggle() {
    this.group.visible = !this.group.visible;
    return this.group.visible;
  }

  update(car) {
    if (!this.group.visible) return;
    const t = car.body.translation();
    const positions = this.arms.geometry.attributes.position.array;

    car.wheels.forEach((w, i) => {
      const c = w.contact;
      const marker = this.markers[i];
      const tire = this.tireArrows[i];
      const load = this.loadArrows[i];

      if (!c.grounded) {
        marker.visible = tire.visible = load.visible = false;
        positions.set([t.x, t.y, t.z, t.x, t.y, t.z], i * 6);
        return;
      }
      marker.visible = true;
      marker.position.set(c.point.x, c.point.y + 0.02, c.point.z);

      const fwd = c.fwd;
      const right = c.right;
      const fx = c.fx;
      const fy = c.fy;
      const dir = new THREE.Vector3(
        fwd.x * fx + right.x * fy,
        fwd.y * fx + right.y * fy,
        fwd.z * fx + right.z * fy,
      );
      const mag = dir.length();
      tire.visible = mag > 30;
      if (tire.visible) {
        tire.position.set(c.point.x, c.point.y + 0.04, c.point.z);
        tire.setDirection(dir.normalize());
        // body must stay longer than the head, or three.js draws a floating cone
        tire.setLength(Math.max(0.42, mag / 1100), 0.3, 0.16);
      }

      load.visible = c.load > 30;
      if (load.visible) {
        load.position.set(c.point.x, c.point.y, c.point.z);
        load.setDirection(UP);
        load.setLength(Math.max(0.34, c.load / 2600), 0.24, 0.13);
      }

      positions.set([t.x, t.y, t.z, c.point.x, c.point.y, c.point.z], i * 6);
    });

    this.arms.geometry.attributes.position.needsUpdate = true;
  }
}
