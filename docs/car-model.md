# Building the car body

`src/scene/carModel.js`, ~250 lines, 99 meshes, 3.2k triangles, no asset files —
it is generated at boot, so every dimension is an editable number.

## The trick that makes it read as a car

Extrude a **side profile** across the width, with the wheel arches cut out of the
outline:

```js
const shape = new THREE.Shape();
shape.moveTo(z0, y0); /* ...outline..., arches are notches in the outline... */
const geo = new THREE.ExtrudeGeometry(shape, {
  depth: width, bevelEnabled: true, bevelSize: 0.05, bevelSegments: 2,
});
geo.rotateY(-Math.PI / 2);      // profile into the ZY plane, extrusion along X
geo.translate(width / 2, 0, 0); // centre it
```

Then a second, narrower extrusion (1.46 m vs 1.86 m) for the glasshouse. Body
colour pillars (A/B/C) are what split one black blob into windscreen, side
windows and rear screen — extend them the full height or they look cut short.

## Proportions (sports car)

| | value |
|---|---|
| length / width | 4.24 / 1.86 m |
| wheelbase / track | 2.62 / 1.60 m |
| wheel radius | 0.33 m |
| floor / belt line / roof | 0.22 / 0.90 / 1.22 m above ground |

Wheels at ±0.8 m, 0.24 m wide → outer face 0.92 m, so the body must be ≥1.84 m or
the tyres poke through the flanks. Arch opening ~0.385 m radius (5.5 cm gap).

## Measure before placing anything

```js
ray.set(new THREE.Vector3(x, y, p.z + 5), new THREE.Vector3(0, 0, -1));
const hit = ray.intersectObjects(root.children, true)[0];
// hit.point.z is the paint surface; put a lens 5 mm proud of it
```

The tail lights were once at z −2.10 with the bodywork at −2.134, so they were
*inside* the paint and only a 4 cm bar showed ("the lights are just a line").

## Wheels

- tyre: one `CylinderGeometry(R, R, 0.24)` rotated 90° about Z. Do **not** add
  torus shoulders at the edges — at `R + tube` they make the wheel fatter at the
  rims than across the tread.
- rim + disc + 5 spokes + **5 lugs, one hi-vis amber**. Five identical spokes are
  unreadable while spinning; one marked bolt makes wheel speed obvious.
- mirror lugs and calipers per side (`x > 0 ? +1 : -1`) or the near-side bolts end
  up inside the car.
- wheels are children of the body and inherit its rotation. Half-shafts (re-aimed
  every frame from the diff to each wheel centre) are what show suspension travel:

```js
shaft.position.set((x0+x1)/2, (axleY+y1)/2, z);
shaft.scale.x = Math.hypot(x1-x0, y1-axleY);
shaft.rotation.z = Math.atan2(y1-axleY, x1-x0);
```

## Materials

Metal at `metalness: 1` renders **black** with nothing to reflect. Bake one env
map before adding the car:

```js
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(scene, 0.04).texture;  // sky + tarmac
scene.environmentIntensity = 0.9;
```

Measured effect on the body: +17 luma. Paint `metalness 0.55 / roughness 0.28`,
alloy `0.55 / 0.38`, glass `0.55 / 0.12`, chrome `1.0 / 0.18`.

## Decals on curves

A flat box on a curved crest floats at its ends. Extrude a band from the *same
outline* as the surface (top edge +4 mm, 20 mm thick, slightly wider) — that is
how the ramp hazard stripe is built.
