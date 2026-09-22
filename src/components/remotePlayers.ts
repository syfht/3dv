import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { RemotePose } from "@/lib/multiplayer";
import { HURT_FLASH_MS } from "@/lib/protocol";
import type { AttackKind, LocomotionKind } from "@/lib/protocol";
import type { ItemType } from "./inventory";
import {
  CLIPS,
  createCharacterAnimator,
  randomDamageClip,
  type CharacterAnimator,
  type LocomotionClip,
} from "./characterAnimator";

// Other players in the world. They use the same character model as the local
// player (cloned once it has finished loading) and the same animation clips
// baked into the GLB.

const ATTACK_CLIP: Record<AttackKind, string> = {
  skill: CLIPS.skill,
  combo1: CLIPS.combo1,
  combo2: CLIPS.combo2,
  combo3: CLIPS.combo3,
  combo31: CLIPS.combo31,
  guardCounter: CLIPS.guardCounter,
  guard: CLIPS.guard,
  roll: CLIPS.roll,
};

const LOCOMOTION_CLIP: Record<LocomotionKind, LocomotionClip> = {
  idle: CLIPS.idle,
  walk: CLIPS.walk,
  backWalk: CLIPS.backWalk,
  run: CLIPS.run,
};

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

type Avatar = {
  group: THREE.Group;
  sprite: THREE.Sprite;
  body: THREE.Object3D | null;
  animator: CharacterAnimator | null;
  target: THREE.Vector3;
  targetYaw: number;
  moving: boolean;
  locomotion: LocomotionKind;
  attack: AttackKind | null;
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
  /** While set, this avatar is playing Dead_A and ignores other animations. */
  deadUntil: number;
};

const HURT_COLOR = new THREE.Color(0xff2a2a);
const HURT_EMISSIVE = new THREE.Color(0x550000);

export function createRemotePlayers(
  scene: THREE.Scene,
  options: { makeItem?: (type: ItemType) => THREE.Object3D | null } = {},
) {
  const avatars = new Map<string, Avatar>();
  let template: THREE.Object3D | null = null;
  let templateClips: THREE.AnimationClip[] = [];

  const attachBody = (avatar: Avatar) => {
    if (!template) return;
    if (avatar.body) avatar.group.remove(avatar.body);
    avatar.animator?.dispose();
    avatar.animator = null;
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
    avatar.animator = createCharacterAnimator(body, templateClips);
    avatar.animator.setLocomotion(CLIPS.idle, 0);
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
      animator: null,
      target: new THREE.Vector3(),
      targetYaw: 0,
      moving: false,
      locomotion: "idle",
      attack: null,
      name,
      hand: null,
      handScale: 1,
      item: null,
      itemMesh: null,
      verticalVelocity: 0,
      tint: [],
      hurtUntil: 0,
      tinted: false,
      deadUntil: 0,
    };
    attachBody(avatar);
    avatars.set(id, avatar);
    return avatar;
  };

  // Called once the local character model has finished loading.
  const setTemplate = (model: THREE.Object3D, clips: THREE.AnimationClip[] = []) => {
    template = model;
    templateClips = clips;
    for (const avatar of avatars.values()) attachBody(avatar);
  };

  const remove = (id: string) => {
    const avatar = avatars.get(id);
    if (!avatar) return;
    avatar.animator?.dispose();
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
      avatar.locomotion = player.locomotion ?? (player.moving ? "walk" : "idle");
      // A newly reported attack starts the matching clip on this avatar.
      const attack = player.attack ?? null;
      if (attack && attack !== avatar.attack && avatar.deadUntil <= performance.now()) {
        const clip = ATTACK_CLIP[attack];
        if (clip) avatar.animator?.play(clip, { priority: 1 });
      }
      avatar.attack = attack;
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

  // Flash a player red and play one of the model's damage reactions.
  const flash = (id: string) => {
    const avatar = avatars.get(id);
    if (!avatar) return;
    avatar.hurtUntil = performance.now() + HURT_FLASH_MS;
    if (avatar.deadUntil > performance.now()) return; // already collapsing
    avatar.animator?.play(randomDamageClip(), { priority: 2 });
  };

  // Another player ran out of health: play Dead_A and hold the last frame
  // until the clip has run, then blend back for their respawn.
  const die = (id: string) => {
    const avatar = avatars.get(id);
    if (!avatar?.animator) return;
    const length = avatar.animator.play(CLIPS.dead, { priority: 3, hold: true });
    avatar.attack = null;
    avatar.deadUntil = performance.now() + (length || 1.2) * 1000;
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

      if (avatar.deadUntil && avatar.deadUntil <= now) {
        // Death clip finished: stand back up for the respawn.
        avatar.deadUntil = 0;
        avatar.animator?.release();
      }
      if (!avatar.deadUntil) {
        avatar.animator?.setLocomotion(LOCOMOTION_CLIP[avatar.locomotion] ?? CLIPS.idle);
      }
      avatar.animator?.update(delta);
    }
  };

  const dispose = () => {
    for (const id of [...avatars.keys()]) remove(id);
  };

  return { setPlayers, setTemplate, update, hitTest, flash, die, dispose, count: () => avatars.size };
}
