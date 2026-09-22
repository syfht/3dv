import * as THREE from "three";
import { isPlaceable, type ItemType, type ToolKind, type ToolMaterial } from "./inventory";

// Simple low-poly held models for sticks and tools, built from boxes so they
// match the blocky look of the world. The handle runs along +Y with the grip
// at the origin, so the group can be parented straight onto the hand bone.

const WOOD = 0x9a6b3c;
const HEADS: Record<ToolMaterial, number> = { wooden: 0xc08a4a, stone: 0x8d8d8d };

const box = (w: number, h: number, d: number, color: number) => {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ color }),
  );
  mesh.castShadow = true;
  return mesh;
};

function handle(length: number) {
  const stick = box(0.035, length, 0.035, WOOD);
  stick.position.y = length / 2;
  return stick;
}

function addHead(group: THREE.Group, kind: ToolKind, color: number, top: number) {
  const parts: THREE.Mesh[] = [];
  if (kind === "sword") {
    const blade = box(0.055, 0.34, 0.025, color);
    blade.position.y = top + 0.15;
    const guard = box(0.17, 0.04, 0.04, color);
    guard.position.y = top - 0.01;
    parts.push(blade, guard);
  } else if (kind === "pickaxe") {
    const bar = box(0.3, 0.05, 0.05, color);
    bar.position.y = top;
    const leftTip = box(0.06, 0.05, 0.05, color);
    leftTip.position.set(-0.16, top - 0.045, 0);
    const rightTip = box(0.06, 0.05, 0.05, color);
    rightTip.position.set(0.16, top - 0.045, 0);
    parts.push(bar, leftTip, rightTip);
  } else if (kind === "axe") {
    const blade = box(0.14, 0.17, 0.05, color);
    blade.position.set(-0.08, top - 0.03, 0);
    const edge = box(0.05, 0.21, 0.05, color);
    edge.position.set(-0.16, top - 0.03, 0);
    parts.push(blade, edge);
  } else if (kind === "shovel") {
    const scoop = box(0.14, 0.14, 0.05, color);
    scoop.position.y = top + 0.04;
    parts.push(scoop);
  } else {
    // hoe
    const bar = box(0.18, 0.05, 0.05, color);
    bar.position.set(0.06, top, 0);
    const blade = box(0.05, 0.1, 0.05, color);
    blade.position.set(0.14, top - 0.06, 0);
    parts.push(bar, blade);
  }
  for (const part of parts) group.add(part);
}

export function makeHandItem(type: ItemType): THREE.Group | null {
  if (isPlaceable(type)) return null;
  const group = new THREE.Group();

  if (type === "stick") {
    group.add(handle(0.34));
  } else if (type === "coal") {
    const lump = box(0.18, 0.14, 0.12, 0x292b2f);
    lump.position.y = 0.08;
    lump.rotation.set(0.18, 0.25, -0.12);
    group.add(lump);
  } else {
    const [material, kind] = type.split("_") as [ToolMaterial, ToolKind];
    const length = kind === "sword" ? 0.2 : 0.46;
    group.add(handle(length));
    addHead(group, kind, HEADS[material], length);
  }

  // Tilt so the item reads as gripped rather than standing straight up.
  group.rotation.set(0, 0, -0.35);
  group.position.y = -0.06;
  return group;
}
