import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { RemotePose } from "@/lib/multiplayer";
import { HURT_FLASH_MS } from "@/lib/protocol";
import type { ItemType } from "./inventory";

// Other players in the world. They use the same character model as the local
// player (cloned once it has finished loading), with a walk cycle and the same
// punch / combo / kick keyframes the local character uses.

const BONE_NAMES = {
  leftUpperArm: "L_Arm1_",
  rightUpperArm: "R_Arm1_",
  leftLowerArm: "L_Arm2_",
  rightLowerArm: "R_Arm2_",
  leftUpperLeg: "L_Leg1_",
  rightUpperLeg: "R_Leg1_",
  leftLowerLeg: "L_Leg2_",
  rightLowerLeg: "R_Leg2_",
} as const;

type LimbKey = keyof typeof BONE_NAMES;
type Limbs = Partial<Record<LimbKey, THREE.Object3D>>;
type PoseMap = Map<THREE.Object3D, THREE.Quaternion>;

function findBone(root: THREE.Object3D, partial: string) {
  let found: THREE.Object3D | undefined;
  root.traverse((child) => {
    if (!found && child.name.startsWith(partial)) found = child;
  });
  return found;
}

function nameTexture(text: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(10, 14, 20, 0.55)";
  ctx.beginPath();
  ctx.roundRect(8, 26, canvas.width - 16, 76, 22);
  ctx.fill();
  ctx.font = "bold 54px system-ui, sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text.slice(0, 16), canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Aim a limb bone at a world-space direction, storing the result in `store`.
function aimBone(
  root: THREE.Object3D,
  bone: THREE.Object3D | undefined,
  makeTarget: (side: number) => THREE.Vector3,
  store: PoseMap,
) {
  if (!bone || !bone.parent) return;
  const childBone = bone.children.find((child) => (child as THREE.Bone).isBone);
  if (!childBone) return;
  root.updateMatrixWorld(true);
  const origin = bone.getWorldPosition(new THREE.Vector3());
  const direction = childBone.getWorldPosition(new THREE.Vector3()).sub(origin).normalize();
  const side = direction.x >= 0 ? 1 : -1;
  const target = makeTarget(side).normalize();
  const worldDelta = new THREE.Quaternion().setFromUnitVectors(direction, target);
  const parentWorld = bone.parent.getWorldQuaternion(new THREE.Quaternion());
  const currentLocal = bone.quaternion.clone();
  bone.quaternion
    .copy(parentWorld)
    .invert()
    .multiply(worldDelta)
    .multiply(parentWorld)
    .multiply(currentLocal);
  bone.updateMatrixWorld(true);
  store.set(bone, bone.quaternion.clone());
}

type Aim = [THREE.Object3D | undefined, (side: number) => THREE.Vector3];

function capturePose(root: THREE.Object3D, aims: Aim[]) {
  const pose: PoseMap = new Map();
  const saved: PoseMap = new Map();
  aims.forEach(([bone]) => { if (bone) saved.set(bone, bone.quaternion.clone()); });
  aims.forEach(([bone, target]) => aimBone(root, bone, target, pose));
  saved.forEach((quaternion, bone) => bone.quaternion.copy(quaternion));
  root.updateMatrixWorld(true);
  return pose;
}

type AttackPoses = {
  windup: PoseMap;
  strike: PoseMap;
  jabWindup: PoseMap;
  jabStrike: PoseMap;
  kickWindup: PoseMap;
  kickStrike: PoseMap;
};

// Same keyframes the local character uses, rebuilt for this clone's skeleton.
function buildAttackPoses(root: THREE.Object3D, limbs: Limbs): AttackPoses {
  return {
    windup: capturePose(root, [
      [limbs.rightUpperArm, (side) => new THREE.Vector3(side * 0.55, -0.4, -0.6)],
      [limbs.rightLowerArm, (side) => new THREE.Vector3(-side * 0.7, 0.15, 0.2)],
      [limbs.leftUpperArm, (side) => new THREE.Vector3(side * 0.7, -0.35, 0.4)],
      [limbs.leftLowerArm, (side) => new THREE.Vector3(-side * 0.15, 0.05, 0.95)],
    ]),
    strike: capturePose(root, [
      [limbs.rightUpperArm, (side) => new THREE.Vector3(side * 0.26, -0.14, 0.95)],
      [limbs.rightLowerArm, (side) => new THREE.Vector3(side * 0.06, -0.06, 1)],
      [limbs.leftUpperArm, (side) => new THREE.Vector3(side * 0.62, -0.45, -0.4)],
      [limbs.leftLowerArm, (side) => new THREE.Vector3(-side * 0.4, -0.1, -0.3)],
    ]),
    jabWindup: capturePose(root, [
      [limbs.leftUpperArm, (side) => new THREE.Vector3(side * 0.42, -0.5, -0.62)],
      [limbs.leftLowerArm, (side) => new THREE.Vector3(-side * 0.6, 0.12, 0.32)],
      [limbs.rightUpperArm, (side) => new THREE.Vector3(side * 0.45, -0.62, 0.3)],
      [limbs.rightLowerArm, (side) => new THREE.Vector3(-side * 0.5, 0.2, 0.55)],
    ]),
    jabStrike: capturePose(root, [
      [limbs.leftUpperArm, (side) => new THREE.Vector3(side * 0.14, -0.1, 0.98)],
      [limbs.leftLowerArm, (side) => new THREE.Vector3(side * 0.04, -0.04, 1)],
      [limbs.rightUpperArm, (side) => new THREE.Vector3(side * 0.45, -0.62, 0.3)],
      [limbs.rightLowerArm, (side) => new THREE.Vector3(-side * 0.5, 0.2, 0.55)],
    ]),
    kickWindup: capturePose(root, [
      [limbs.rightUpperLeg, () => new THREE.Vector3(0, -0.2, 0.98)],
      [limbs.rightLowerLeg, () => new THREE.Vector3(0, -0.85, -0.5)],
    ]),
    kickStrike: capturePose(root, [
      [limbs.rightUpperLeg, () => new THREE.Vector3(0, 0.12, 0.99)],
      [limbs.rightLowerLeg, () => new THREE.Vector3(0, 0.05, 1)],
    ]),
  };
}

type Avatar = {
  group: THREE.Group;
  sprite: THREE.Sprite;
  body: THREE.Object3D | null;
  limbs: Limbs;
  rest: PoseMap;
  poses: AttackPoses | null;
  target: THREE.Vector3;
  targetYaw: number;
  walk: number;
  moving: boolean;
  attack: RemotePose["attack"];
  attackProgress: number;
  name: string;
  hand: THREE.Object3D | null;
  handScale: number;
  item: ItemType | null;
  itemMesh: THREE.Object3D | null;
  verticalVelocity: number;
  /** Minecraft-style damage tint: materials owned by this avatar + timer. */
  tint: { material: THREE.MeshStandardMaterial; color: THREE.Color; emissive: THREE.Color }[];
  hurtUntil: number;
  tinted: boolean;
};

const HURT_COLOR = new THREE.Color(0xff2a2a);
const HURT_EMISSIVE = new THREE.Color(0x550000);

export function createRemotePlayers(
  scene: THREE.Scene,
  options: { makeItem?: (type: ItemType) => THREE.Object3D | null } = {},
) {
  const avatars = new Map<string, Avatar>();
  let template: THREE.Object3D | null = null;

  const attachBody = (avatar: Avatar) => {
    if (!template) return;
    if (avatar.body) avatar.group.remove(avatar.body);
    const body = cloneSkinned(template);
    // Clone the materials so this avatar can flash red on its own.
    avatar.tint = [];
    avatar.tinted = false;
    body.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const cloned = materials.map((material) => {
          const copy = (material as THREE.MeshStandardMaterial).clone();
          if (copy.color) {
            avatar.tint.push({
              material: copy,
              color: copy.color.clone(),
              emissive: copy.emissive ? copy.emissive.clone() : new THREE.Color(0x000000),
            });
          }
          return copy;
        });
        mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0]!;
      }
    });
    avatar.group.add(body);
    avatar.body = body;
    avatar.limbs = {};
    avatar.rest = new Map();
    for (const [key, prefix] of Object.entries(BONE_NAMES) as [LimbKey, string][]) {
      const bone = findBone(body, prefix);
      if (!bone) continue;
      avatar.limbs[key] = bone;
      avatar.rest.set(bone, bone.quaternion.clone());
    }
    avatar.poses = buildAttackPoses(body, avatar.limbs);
    const handBone = findBone(body, "R_Hand_Attach") ?? findBone(body, "R_Hand_");
    avatar.hand = handBone ?? null;
    avatar.handScale = handBone
      ? handBone.getWorldScale(new THREE.Vector3()).x || 1
      : 1;
    avatar.itemMesh = null;
    const wanted = avatar.item;
    avatar.item = null;
    if (wanted) setItem(avatar, wanted);
  };

  // Shows the block or tool the other player currently has selected.
  const setItem = (avatar: Avatar, type: ItemType | null) => {
    if (avatar.item === type) return;
    avatar.item = type;
    if (avatar.itemMesh) {
      avatar.itemMesh.parent?.remove(avatar.itemMesh);
      avatar.itemMesh = null;
    }
    if (!type || !avatar.hand || !options.makeItem) return;
    const mesh = options.makeItem(type);
    if (!mesh) return;
    mesh.scale.setScalar(1 / avatar.handScale);
    avatar.hand.add(mesh);
    avatar.itemMesh = mesh;
  };

  const build = (id: string, name: string) => {
    const group = new THREE.Group();

    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: nameTexture(name), transparent: true, depthTest: false }),
    );
    sprite.scale.set(1.5, 0.375, 1);
    sprite.position.set(0, 1.92, 0);
    sprite.renderOrder = 10;
    group.add(sprite);

    scene.add(group);
    const avatar: Avatar = {
      group,
      sprite,
      body: null,
      limbs: {},
      rest: new Map(),
      poses: null,
      target: new THREE.Vector3(),
      targetYaw: 0,
      walk: 0,
      moving: false,
      attack: null,
      attackProgress: 0,
      name,
      hand: null,
      handScale: 1,
      item: null,
      itemMesh: null,
      verticalVelocity: 0,
      tint: [],
      hurtUntil: 0,
      tinted: false,
    };
    attachBody(avatar);
    avatars.set(id, avatar);
    return avatar;
  };

  // Called once the local character model has finished loading.
  const setTemplate = (model: THREE.Object3D) => {
    template = model;
    for (const avatar of avatars.values()) attachBody(avatar);
  };

  const remove = (id: string) => {
    const avatar = avatars.get(id);
    if (!avatar) return;
    scene.remove(avatar.group);
    avatar.sprite.material.map?.dispose();
    avatar.sprite.material.dispose();
    for (const entry of avatar.tint) entry.material.dispose();
    avatars.delete(id);
  };

  const setPlayers = (players: RemotePose[]) => {
    const seen = new Set<string>();
    for (const player of players) {
      seen.add(player.id);
      let avatar = avatars.get(player.id);
      if (!avatar) {
        avatar = build(player.id, player.name);
        avatar.group.position.set(player.x, player.y, player.z);
        avatar.group.rotation.y = player.ry;
      }
      if (avatar.name !== player.name) {
        avatar.name = player.name;
        const old = avatar.sprite.material.map;
        avatar.sprite.material.map = nameTexture(player.name);
        avatar.sprite.material.needsUpdate = true;
        old?.dispose();
      }
      const networkY = player.y;
      if (networkY > avatar.target.y + 0.08) avatar.verticalVelocity = 0;
      avatar.target.set(player.x, networkY, player.z);
      avatar.targetYaw = player.ry;
      avatar.moving = player.moving;
      avatar.attack = player.attack ?? null;
      avatar.attackProgress = player.ap ?? 0;
      setItem(avatar, player.item ?? null);
    }
    for (const id of [...avatars.keys()]) if (!seen.has(id)) remove(id);
  };

  // Which player, if any, the given ray (the crosshair) is aimed at. Test a
  // vertical capsule so aiming at the head, torso, or legs all registers.
  const hitCentre = new THREE.Vector3();
  const toCentre = new THREE.Vector3();
  const hitTest = (origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number) => {
    const radius = 0.68;
    let best: { id: string; distance: number } | null = null;
    for (const [id, avatar] of avatars) {
      for (const height of [0.45, 1.05, 1.62]) {
        hitCentre.copy(avatar.group.position);
        hitCentre.y += height;
        toCentre.copy(hitCentre).sub(origin);
        const along = toCentre.dot(direction);
        if (along < 0 || along > maxDistance) continue;
        const perpendicular = Math.sqrt(Math.max(0, toCentre.lengthSq() - along * along));
        if (perpendicular <= radius && (!best || along < best.distance)) best = { id, distance: along };
      }
    }
    return best?.id ?? null;
  };

  const swingAxis = new THREE.Vector3(1, 0, 0);
  const swingQuaternion = new THREE.Quaternion();
  const targetQuaternion = new THREE.Quaternion();

  // Flash a player red (Minecraft-style hurt tint).
  const flash = (id: string) => {
    const avatar = avatars.get(id);
    if (avatar) avatar.hurtUntil = performance.now() + HURT_FLASH_MS;
  };

  const update = (delta: number, groundHeight?: (x: number, z: number, y: number) => number) => {
    const now = performance.now();
    for (const avatar of avatars.values()) {
      const hurt = avatar.hurtUntil > now;
      if (hurt !== avatar.tinted) {
        avatar.tinted = hurt;
        for (const entry of avatar.tint) {
          if (hurt) {
            entry.material.color.copy(HURT_COLOR);
            if (entry.material.emissive) entry.material.emissive.copy(HURT_EMISSIVE);
          } else {
            entry.material.color.copy(entry.color);
            if (entry.material.emissive) entry.material.emissive.copy(entry.emissive);
          }
        }
      }
      if (groundHeight) {
        const groundY = groundHeight(avatar.target.x, avatar.target.z, avatar.target.y + 0.5);
        if (avatar.target.y > groundY + 0.001) {
          avatar.verticalVelocity -= 12.5 * delta;
          avatar.target.y = Math.max(groundY, avatar.target.y + avatar.verticalVelocity * delta);
        } else {
          avatar.target.y = groundY;
          avatar.verticalVelocity = 0;
        }
      }
      // Smooth out the gaps between network updates.
      const blend = 1 - Math.exp(-12 * delta);
      avatar.group.position.lerp(avatar.target, blend);
      let diff = avatar.targetYaw - avatar.group.rotation.y;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      avatar.group.rotation.y += diff * blend;

      // Attack layer: same two-keyframe timing as the local character.
      let attackBlend = 0;
      let segmentT = 0;
      let poseA: PoseMap | undefined;
      let poseB: PoseMap | undefined;
      const poses = avatar.poses;
      if (poses && avatar.attack) {
        const p = THREE.MathUtils.clamp(avatar.attackProgress, 0, 1);
        if (avatar.attack === "kick") {
          poseA = poses.kickWindup; poseB = poses.kickStrike;
          if (p < 0.3) { segmentT = p / 0.3; attackBlend = Math.min(1, segmentT * 1.4); }
          else if (p < 0.48) { segmentT = 1 + (p - 0.3) / 0.18; attackBlend = 1; }
          else if (p < 0.62) { segmentT = 2; attackBlend = 1; }
          else { segmentT = 2; attackBlend = (1 - p) / 0.38; }
        } else if (avatar.attack === "combo") {
          if (p < 0.12) { poseA = poses.jabWindup; poseB = poses.jabStrike; segmentT = p / 0.12; attackBlend = segmentT; }
          else if (p < 0.3) { poseA = poses.jabWindup; poseB = poses.jabStrike; segmentT = 1 + (p - 0.12) / 0.18; attackBlend = 1; }
          else if (p < 0.45) { poseA = poses.jabWindup; poseB = poses.jabStrike; segmentT = 2; attackBlend = 1; }
          else if (p < 0.58) { poseA = poses.windup; poseB = poses.strike; segmentT = (p - 0.45) / 0.13; attackBlend = 1; }
          else if (p < 0.74) { poseA = poses.windup; poseB = poses.strike; segmentT = 1 + (p - 0.58) / 0.16; attackBlend = 1; }
          else { poseA = poses.windup; poseB = poses.strike; segmentT = 2; attackBlend = (1 - p) / 0.26; }
        } else {
          poseA = poses.windup; poseB = poses.strike;
          if (p < 0.26) { segmentT = p / 0.26; attackBlend = segmentT; }
          else if (p < 0.5) { segmentT = 1 + (p - 0.26) / 0.24; attackBlend = 1; }
          else if (p < 0.68) { segmentT = 2; attackBlend = 1; }
          else { segmentT = 2; attackBlend = (1 - p) / 0.32; }
        }
        attackBlend = THREE.MathUtils.clamp(attackBlend, 0, 1);
      }

      // Walk cycle fades out under the attack layer.
      avatar.walk += delta * (avatar.moving ? 8 : 0);
      const swingScale = 1 - attackBlend;
      const swing = (avatar.moving ? Math.sin(avatar.walk) * 0.55 : 0) * swingScale;
      const apply = (bone: THREE.Object3D | undefined, angle: number) => {
        if (!bone) return;
        const rest = avatar.rest.get(bone);
        if (!rest) return;
        swingQuaternion.setFromAxisAngle(swingAxis, angle);
        bone.quaternion.copy(rest).multiply(swingQuaternion);
      };
      apply(avatar.limbs.leftUpperLeg, swing);
      apply(avatar.limbs.rightUpperLeg, -swing);
      apply(avatar.limbs.leftUpperArm, -swing * 0.6);
      apply(avatar.limbs.rightUpperArm, swing * 0.6);
      apply(avatar.limbs.leftLowerArm, 0);
      apply(avatar.limbs.rightLowerArm, 0);
      apply(avatar.limbs.leftLowerLeg, 0);
      apply(avatar.limbs.rightLowerLeg, 0);

      if (attackBlend > 0 && poseA && poseB) {
        poseA.forEach((windup, bone) => {
          const strike = poseB!.get(bone);
          const rest = avatar.rest.get(bone);
          if (!strike || !rest) return;
          if (segmentT <= 1) targetQuaternion.copy(rest).slerp(windup, segmentT);
          else targetQuaternion.copy(windup).slerp(strike, Math.min(segmentT, 2) - 1);
          bone.quaternion.slerp(targetQuaternion, attackBlend);
        });
      }
    }
  };

  const dispose = () => {
    for (const id of [...avatars.keys()]) remove(id);
  };

  return { setPlayers, setTemplate, update, hitTest, flash, dispose, count: () => avatars.size };
}
