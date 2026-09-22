import { useEffect, useRef, useState } from "react";
import { Eye, PersonStanding } from "lucide-react";
import * as THREE from "three";
import { MODEL_URL, createModelLoader } from "@/assets/model";
import { createVoxelWorld, type BlockType } from "./voxelWorld";
import InventoryPanel from "./InventoryPanel";
import FurnacePanel, { type FurnaceState } from "./FurnacePanel";
import MobileControls from "./MobileControls";
import { makeHandItem } from "./handItems";
import { createRemotePlayers } from "./remotePlayers";
import { startBackgroundTicker } from "@/lib/backgroundTicker";
import { CLIENT_ID, connectWorld, type RemotePose, type WorldSession } from "@/lib/multiplayer";
import { HIT_RANGE, HURT_FLASH_MS } from "@/lib/protocol";
import {
  BLOCK_LABEL,
  BREAK_TIMES,
  HOTBAR_SIZE,
  INVENTORY_SIZE,
  craftResult,
  isPlaceable,
  maxStack,
  miningSpeed,
  type ItemType,
  type Slot,
} from "./inventory";

const MAX_HEALTH = 20; // 10 hearts


type KeyState = Record<string, boolean>;

type SpringBone = {
  bone: THREE.Object3D;
  rest: THREE.Quaternion;
  kind: "hair" | "chest" | "butt" | "cloth" | "accessory";
  valueX: number;
  valueZ: number;
  velocityX: number;
  velocityZ: number;
  weight: number;
};

const BONE_NAMES = {
  hips: "C_Hips_",
  spine: "C_Spine1_",
  chest: "C_Chest_",
  head: "C_Head_",
  leftUpperArm: "L_Arm1_",
  rightUpperArm: "R_Arm1_",
  leftLowerArm: "L_Arm2_",
  rightLowerArm: "R_Arm2_",
  leftUpperLeg: "L_Leg1_",
  rightUpperLeg: "R_Leg1_",
  leftLowerLeg: "L_Leg2_",
  rightLowerLeg: "R_Leg2_",
  leftFoot: "L_Foot_",
  rightFoot: "R_Foot_",
} as const;

function findBone(root: THREE.Object3D, partial: string) {
  let found: THREE.Object3D | undefined;
  root.traverse((child) => {
    if (!found && child.name.startsWith(partial)) found = child;
  });
  return found;
}


// Day / night: 5 minutes of daylight, 5 minutes of night.
const CYCLE_SECONDS = 600;

export default function TerrainGame({
  username = "Player",
  disabled = false,
  session,
  onProgress,
  onReady,
}: {
  username?: string;
  disabled?: boolean;
  session?: WorldSession;
  onProgress?: (percent: number) => void;
  onReady?: () => void;
}) {
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const onProgressRef = useRef(onProgress);
  const onReadyRef = useRef(onReady);
  onProgressRef.current = onProgress;
  onReadyRef.current = onReady;
  const hostRef = useRef<HTMLDivElement>(null);
  const usernameRef = useRef(username);
  const disabledRef = useRef(false);
  const setNameTagRef = useRef<(name: string) => void>(() => {});
  const [, setLoaded] = useState(false);
  const [, setMoving] = useState(false);
  const [playerCount, setPlayerCount] = useState(1);
  const [health, setHealth] = useState(MAX_HEALTH);
  const healthRef = useRef(MAX_HEALTH);
  const setHealthValue = (value: number) => {
    const next = THREE.MathUtils.clamp(value, 0, MAX_HEALTH);
    if (next === healthRef.current) return;
    healthRef.current = next;
    setHealth(next);
  };
  // Taking damage flashes the screen red, the way Minecraft tints a hit player.
  const [hurt, setHurt] = useState(false);
  const hurtTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashHurt = () => {
    setHurt(true);
    if (hurtTimer.current) clearTimeout(hurtTimer.current);
    hurtTimer.current = setTimeout(() => setHurt(false), HURT_FLASH_MS);
  };
  useEffect(() => () => {
    if (hurtTimer.current) clearTimeout(hurtTimer.current);
  }, []);
  // Online, the server owns health: local damage (falls) is reported to it and
  // the new value comes back in the next snapshot. Offline it applies directly.
  const linkRef = useRef<ReturnType<typeof connectWorld> | null>(null);
  const damagePlayer = (amount: number) => {
    if (amount <= 0) return;
    flashHurt();
    if (linkRef.current) {
      linkRef.current.sendDamage(amount);
      return;
    }
    setHealthValue(healthRef.current - amount);
  };
  const [, setAttackLabel] = useState<string | null>(null);
  const [inventory, setInventory] = useState<Slot[]>(() =>
    Array.from({ length: INVENTORY_SIZE }, () => null),
  );
  const [selectedSlot, setSelectedSlot] = useState(0);
  const [invOpen, setInvOpen] = useState(false);
  const [craftOpen, setCraftOpen] = useState(false);
  const [craftGrid, setCraftGrid] = useState<Slot[]>(() => [null, null, null, null]);
  const [tableGrid, setTableGrid] = useState<Slot[]>(() => Array.from({ length: 9 }, () => null));
  const [cursor, setCursor] = useState<Slot>(null);
  const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 });
  const invRef = useRef<Slot[]>(inventory);
  const craftRef = useRef<Slot[]>(craftGrid);
  const tableRef = useRef<Slot[]>(tableGrid);
  const cursorRef = useRef<Slot>(null);
  const selectedRef = useRef(0);
  const invOpenRef = useRef(false);
  const craftOpenRef = useRef(false);

  // --- chests: 3x9 storage kept per chest block, keyed by its coordinates ----
  const CHEST_SIZE = 27;
  const [chestOpen, setChestOpen] = useState(false);
  const [chestSlots, setChestSlots] = useState<Slot[]>([]);
  const chestOpenRef = useRef(false);
  const chestRef = useRef<Slot[]>([]);
  const chestKeyRef = useRef<string | null>(null);
  const chestStoreRef = useRef(new Map<string, Slot[]>());

  // Furnace contents stay with each placed furnace for this game session.
  const [furnaceOpen, setFurnaceOpen] = useState(false);
  const [furnaceState, setFurnaceState] = useState<FurnaceState | null>(null);
  const furnaceOpenRef = useRef(false);
  const furnaceKeyRef = useRef<string | null>(null);
  const furnaceStoreRef = useRef(new Map<string, FurnaceState>());

  const syncInventory = () => setInventory([...invRef.current]);
  const syncCraft = () => setCraftGrid([...craftRef.current]);
  const syncTable = () => setTableGrid([...tableRef.current]);
  const syncChest = () => setChestSlots([...chestRef.current]);
  const anyMenuOpen = () => invOpenRef.current || craftOpenRef.current || chestOpenRef.current || furnaceOpenRef.current;

  // Merge a stack into the inventory, filling partial stacks first.
  const addStack = (type: ItemType, count: number) => {
    const list = invRef.current;
    const limit = maxStack(type);
    let left = count;
    for (let index = 0; index < list.length && left > 0; index += 1) {
      const slot = list[index];
      if (slot && slot.type === type && slot.count < limit) {
        const move = Math.min(left, limit - slot.count);
        list[index] = { type, count: slot.count + move };
        left -= move;
      }
    }
    for (let index = 0; index < list.length && left > 0; index += 1) {
      if (list[index] === null) {
        const move = Math.min(left, limit);
        list[index] = { type, count: move };
        left -= move;
      }
    }
    syncInventory();
  };

  const handleSlotClick = (
    area: "inv" | "craft" | "craft3" | "chest",
    index: number,
    right: boolean,
  ) => {
    const list =
      area === "inv"
        ? invRef.current
        : area === "craft"
          ? craftRef.current
          : area === "chest"
            ? chestRef.current
            : tableRef.current;
    const slot = list[index] ?? null;
    let held = cursorRef.current;
    if (!held) {
      if (!slot) return;
      if (right) {
        const take = Math.ceil(slot.count / 2);
        held = { type: slot.type, count: take };
        const rest = slot.count - take;
        list[index] = rest > 0 ? { type: slot.type, count: rest } : null;
      } else {
        held = slot;
        list[index] = null;
      }
    } else if (!slot) {
      if (right) {
        list[index] = { type: held.type, count: 1 };
        held = held.count > 1 ? { type: held.type, count: held.count - 1 } : null;
      } else {
        list[index] = held;
        held = null;
      }
    } else if (slot.type === held.type) {
      const limit = maxStack(slot.type);
      if (right) {
        if (slot.count < limit) {
          list[index] = { type: slot.type, count: slot.count + 1 };
          held = held.count > 1 ? { type: held.type, count: held.count - 1 } : null;
        }
      } else {
        const move = Math.min(held.count, limit - slot.count);
        list[index] = { type: slot.type, count: slot.count + move };
        held = held.count - move > 0 ? { type: held.type, count: held.count - move } : null;
      }
    } else if (!right) {
      list[index] = held;
      held = slot;
    }
    cursorRef.current = held;
    setCursor(held);
    if (area === "inv") syncInventory();
    else if (area === "craft") syncCraft();
    else if (area === "chest") syncChest();
    else syncTable();
  };

  const handleTakeResult = (right: boolean, table = false) => {
    const gridRef = table ? tableRef : craftRef;
    const syncGrid = table ? syncTable : syncCraft;
    const result = craftResult(gridRef.current);
    if (!result) return;
    const held = cursorRef.current;
    if (held && (held.type !== result.type || held.count + result.count > maxStack(result.type)))
      return;
    // Consume one item from every filled crafting cell.
    gridRef.current = gridRef.current.map((slot) =>
      slot ? (slot.count > 1 ? { type: slot.type, count: slot.count - 1 } : null) : null,
    );
    syncGrid();
    if (right) {
      addStack(result.type, result.count);
      return;
    }
    const next: Slot = held
      ? { type: held.type, count: held.count + result.count }
      : { type: result.type, count: result.count };
    cursorRef.current = next;
    setCursor(next);
  };

  // Closing returns the cursor stack and crafting grid to the inventory.
  const closeGridPanel = (
    gridRef: typeof craftRef,
    syncGrid: () => void,
    setOpen: (open: boolean) => void,
    openRef: typeof invOpenRef,
  ) => {
    const held = cursorRef.current;
    if (held) addStack(held.type, held.count);
    cursorRef.current = null;
    setCursor(null);
    gridRef.current.forEach((slot, index) => {
      if (slot) addStack(slot.type, slot.count);
      gridRef.current[index] = null;
    });
    syncGrid();
    openRef.current = false;
    setOpen(false);
  };

  const closeInventory = () => closeGridPanel(craftRef, syncCraft, setInvOpen, invOpenRef);
  const closeCrafting = () => closeGridPanel(tableRef, syncTable, setCraftOpen, craftOpenRef);

  const openCrafting = () => {
    if (anyMenuOpen()) return;
    craftOpenRef.current = true;
    setCraftOpen(true);
    if (document.pointerLockElement) document.exitPointerLock();
  };

  const openInventory = () => {
    if (anyMenuOpen()) return;
    invOpenRef.current = true;
    setInvOpen(true);
    if (document.pointerLockElement) document.exitPointerLock();
  };

  // Chest contents stay in the world; only the cursor stack comes back.
  const closeChest = () => {
    const held = cursorRef.current;
    if (held) addStack(held.type, held.count);
    cursorRef.current = null;
    setCursor(null);
    chestOpenRef.current = false;
    chestKeyRef.current = null;
    setChestOpen(false);
  };

  const openChestAt = (blockKey: string) => {
    if (anyMenuOpen()) return;
    let slots = chestStoreRef.current.get(blockKey);
    if (!slots) {
      slots = Array.from({ length: CHEST_SIZE }, () => null);
      chestStoreRef.current.set(blockKey, slots);
    }
    chestRef.current = slots;
    chestKeyRef.current = blockKey;
    setChestSlots([...slots]);
    chestOpenRef.current = true;
    setChestOpen(true);
    if (document.pointerLockElement) document.exitPointerLock();
  };

  const closeFurnace = () => {
    const held = cursorRef.current;
    if (held) addStack(held.type, held.count);
    cursorRef.current = null;
    setCursor(null);
    furnaceOpenRef.current = false;
    furnaceKeyRef.current = null;
    setFurnaceOpen(false);
    setFurnaceState(null);
  };

  const openFurnaceAt = (blockKey: string) => {
    if (anyMenuOpen()) return;
    let state = furnaceStoreRef.current.get(blockKey);
    if (!state) {
      state = { input: null, fuel: null, output: null, burnLeft: 0, burnTotal: 0, progress: 0, updatedAt: performance.now() };
      furnaceStoreRef.current.set(blockKey, state);
    }
    furnaceKeyRef.current = blockKey;
    furnaceOpenRef.current = true;
    setFurnaceState({ ...state });
    setFurnaceOpen(true);
    if (document.pointerLockElement) document.exitPointerLock();
  };

  const handleFurnaceSlotClick = (area: "inv" | "furnace", index: number, right: boolean) => {
    if (area === "inv") {
      handleSlotClick("inv", index, right);
      return;
    }
    const key = furnaceKeyRef.current;
    if (!key) return;
    const state = furnaceStoreRef.current.get(key);
    if (!state) return;
    const names = ["input", "fuel", "output"] as const;
    const name = names[index];
    if (!name) return;
    let slot = state[name];
    let held = cursorRef.current;
    if (name === "output") {
      if (!slot || held) return;
      const take = right ? 1 : slot.count;
      held = { type: slot.type, count: take };
      state.output = slot.count > take ? { type: slot.type, count: slot.count - take } : null;
    } else if (!held) {
      if (!slot) return;
      const take = right ? Math.ceil(slot.count / 2) : slot.count;
      held = { type: slot.type, count: take };
      state[name] = slot.count > take ? { type: slot.type, count: slot.count - take } : null;
    } else {
      const allowed = name === "input" ? held.type === "coal_ore" : held.type === "stick" || held.type === "planks" || held.type === "wood";
      if (!allowed) return;
      if (!slot) {
        const move = right ? 1 : held.count;
        state[name] = { type: held.type, count: move };
        held = held.count > move ? { type: held.type, count: held.count - move } : null;
      } else if (slot.type === held.type && slot.count < maxStack(slot.type)) {
        const move = right ? 1 : Math.min(held.count, maxStack(slot.type) - slot.count);
        state[name] = { type: slot.type, count: slot.count + move };
        held = held.count > move ? { type: held.type, count: held.count - move } : null;
      } else if (!right) {
        state[name] = held;
        held = slot;
      }
    }
    cursorRef.current = held;
    setCursor(held);
    setFurnaceState({ ...state });
  };

  // Aimed block, updated by the render loop: drives E / the mobile button.
  const aimInfoRef = useRef<{ key: string; type: BlockType } | null>(null);
  const interact = () => {
    if (anyMenuOpen()) return false;
    const aim = aimInfoRef.current;
    if (aim?.type === "chest") {
      openChestAt(aim.key);
      return true;
    }
    if (aim?.type === "crafting_table") {
      openCrafting();
      return true;
    }
    if (aim?.type === "furnace") {
      openFurnaceAt(aim.key);
      return true;
    }
    return false;
  };

  // Touch control bridge: the render loop reads these each frame.
  const touchMoveRef = useRef({ x: 0, y: 0 });
  const touchJumpRef = useRef(false);
  const touchPlaceRef = useRef(false);
  const [isTouch, setIsTouch] = useState(false);
  const [portrait, setPortrait] = useState(false);
  const [firstPerson, setFirstPerson] = useState(false);
  // True when the crosshair is on a crafting table or chest (mobile shows its
  // interact button then).
  const [aimTable, setAimTable] = useState(false);
  const aimTableRef = useRef(false);
  const toggleViewRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const coarse = window.matchMedia("(pointer: coarse)");
    const tall = window.matchMedia("(orientation: portrait)");
    const sync = () => {
      const touch = coarse.matches || navigator.maxTouchPoints > 0 || "ontouchstart" in window;
      setIsTouch(touch);
      setPortrait(touch && tall.matches);
    };
    sync();
    coarse.addEventListener("change", sync);
    tall.addEventListener("change", sync);
    window.addEventListener("resize", sync);
    return () => {
      coarse.removeEventListener("change", sync);
      tall.removeEventListener("change", sync);
      window.removeEventListener("resize", sync);
    };
  }, []);





  useEffect(() => {
    usernameRef.current = (username || "Player").trim() || "Player";
    setNameTagRef.current(usernameRef.current);
    linkRef.current?.setName(usernameRef.current);
  }, [username]);

  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xa8c5ce);
    scene.fog = new THREE.FogExp2(0xa8c5ce, 0.012);

    const camera = new THREE.PerspectiveCamera(52, host.clientWidth / host.clientHeight, 0.06, 300);
    camera.position.set(0, 2.4, 5.4);

    // ?lowfx renders without shadows for low-power/software renderers.
    const lowFx = window.location.search.includes("lowfx");
    const renderer = new THREE.WebGLRenderer({ antialias: !lowFx, powerPreference: "high-performance" });
    renderer.setPixelRatio(lowFx ? 1 : Math.min(window.devicePixelRatio, 1.75));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.shadowMap.enabled = !lowFx;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    host.appendChild(renderer.domElement);

    const hemi = new THREE.HemisphereLight(0xd8eff2, 0x526344, 2.2);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2d2, 4.2);
    sun.position.set(-18, 26, 12);
    sun.castShadow = !lowFx;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -18;
    sun.shadow.camera.right = 18;
    sun.shadow.camera.top = 18;
    sun.shadow.camera.bottom = -18;
    scene.add(sun);
    scene.add(sun.target);

    // --- sky: sun, moon, stars, and the colour of the day --------------------
    const moon = new THREE.DirectionalLight(0xbcd2ff, 0);
    scene.add(moon);
    scene.add(moon.target);

    const skyGroup = new THREE.Group();
    scene.add(skyGroup);
    const sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(8, 20, 20),
      new THREE.MeshBasicMaterial({ color: 0xffeaa8, fog: false }),
    );
    const moonMesh = new THREE.Mesh(
      new THREE.SphereGeometry(5.5, 20, 20),
      new THREE.MeshBasicMaterial({ color: 0xe6ecff, fog: false }),
    );
    skyGroup.add(sunMesh, moonMesh);

    const starCount = 500;
    const starPositions = new Float32Array(starCount * 3);
    for (let index = 0; index < starCount; index += 1) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.9 + 0.05);
      starPositions[index * 3] = Math.sin(phi) * Math.cos(theta) * 210;
      starPositions[index * 3 + 1] = Math.cos(phi) * 210;
      starPositions[index * 3 + 2] = Math.sin(phi) * Math.sin(theta) * 210;
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    const starMaterial = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 1.6,
      transparent: true,
      opacity: 0,
      fog: false,
      depthWrite: false,
    });
    const stars = new THREE.Points(starGeometry, starMaterial);
    skyGroup.add(stars);

    const skyDay = new THREE.Color(0xa8c5ce);
    const skyNight = new THREE.Color(0x0a1026);
    const skyDusk = new THREE.Color(0xe0a06a);
    const skyColor = new THREE.Color().copy(skyDay);
    scene.background = skyColor;
    (scene.fog as THREE.FogExp2).color = skyColor;
    // --- shared online world -------------------------------------------------
    const online = sessionRef.current;
    // Everyone in the same world shares one day/night clock, started with it.
    const worldEpoch = online?.startedAt ?? Date.now();
    let link: ReturnType<typeof connectWorld> | null = null;
    // Set up once the player's body exists: spills everything on death.
    let dropInventory: (() => void) | null = null;
    const world = createVoxelWorld(scene, {
      seed: online?.seed ?? 0,
      edits: online?.edits ?? [],
      onEdit: (edit) => link?.sendEdit(edit),
    });
    const remotePlayers = createRemotePlayers(scene, {
      // Other players carry the same block or tool models in their hand.
      makeItem: (type) =>
        isPlaceable(type) ? world.makeBlockMesh(0.19, type) : makeHandItem(type),
    });
    // Filled in once the character exists (below); the server may move us.
    let teleportTo: ((x: number, y: number, z: number) => void) | null = null;
    if (online?.online && online.worldId) {
      link = connectWorld(
        online.worldId,
        {
          onEdit: (edit) => world.applyRemoteEdit(edit),
          onPlayers: (players: RemotePose[]) => {
            remotePlayers.setPlayers(players);
            setPlayerCount(players.length + 1);
          },
          onHealth: (hp) => setHealthValue(hp),
          onHit: () => flashHurt(),
          onHurt: (id) => remotePlayers.flash(id),
          onDrops: (position, items) => {
            const at = new THREE.Vector3(position.x, position.y, position.z);
            for (const item of items) {
              const type = item.type as ItemType;
              const mesh = isPlaceable(type) ? world.makeBlockMesh(0.3, type) : makeHandItem(type);
              if (!mesh) continue;
              world.dropItem(at, type, item.count, mesh, 1200, item.id);
            }
          },
          onPickup: (id) => world.removeDrop(id),
          onTeleport: (position, reason) => {
            if (reason === "respawn") dropInventory?.();
            teleportTo?.(position.x, position.y, position.z);
          },
        },
        {
          name: usernameRef.current?.trim() || "Player",
          editsUpTo: online.editsUpTo,
          seed: online.seed,
        },
      );
      linkRef.current = link;
    }
    let poseTimer = 0;

    // --- inventory -----------------------------------------------------------
    const addToInventory = (type: string, count = 1, dropId?: string) => {
      // Tell everyone else the item is gone so it disappears from their world.
      if (dropId) link?.sendPickup(dropId);
      addStack(type as ItemType, count);
    };
    const takeFromInventory = (index: number) => {
      const slot = invRef.current[index];
      if (!slot) return false;
      const next = slot.count - 1;
      invRef.current[index] = next > 0 ? { type: slot.type, count: next } : null;
      setInventory([...invRef.current]);
      return true;
    };
    const lastAimOrigin = new THREE.Vector3();
    const lastAimDirection = new THREE.Vector3(0, 0, 1);

    const keys: KeyState = {};
    const character = new THREE.Group();
    character.position.set(0.5, world.groundHeight(0.5, 0.5), 0.5);
    scene.add(character);

    // Death: everything the player was carrying spills onto the ground.
    dropInventory = () => {
      const spilled: Array<{ id: string; type: string; count: number }> = [];
      const at = new THREE.Vector3();
      const spill = (type: ItemType, count: number) => {
        const mesh = isPlaceable(type) ? world.makeBlockMesh(0.3, type) : makeHandItem(type);
        if (!mesh) return;
        at.set(character.position.x, character.position.y + 1, character.position.z);
        const id = `${CLIENT_ID}-${Date.now().toString(36)}-${spilled.length}`;
        world.dropItem(at, type, count, mesh, 1200, id);
        spilled.push({ id, type, count });
      };
      const spillAll = (slots: Slot[]) => {
        for (let index = 0; index < slots.length; index += 1) {
          const slot = slots[index];
          if (!slot) continue;
          slots[index] = null;
          spill(slot.type, slot.count);
        }
      };
      spillAll(invRef.current);
      spillAll(craftRef.current);
      spillAll(tableRef.current);
      const held = cursorRef.current;
      if (held) {
        cursorRef.current = null;
        setCursor(null);
        spill(held.type, held.count);
      }
      syncInventory();
      syncCraft();
      syncTable();
      // Everyone else spawns the same drops at the death spot.
      link?.sendDrops({ x: at.x, y: at.y, z: at.z }, spilled);
    };

    // Floating name tag above the player.
    const buildNameTexture = (text: string) => {
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
    };
    const nameSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: buildNameTexture(usernameRef.current?.trim() || "Player"),
        transparent: true,
        depthTest: false,
      }),
    );
    nameSprite.scale.set(1.5, 0.375, 1);
    nameSprite.position.set(0, 1.92, 0);
    nameSprite.renderOrder = 10;
    character.add(nameSprite);
    setNameTagRef.current = (name: string) => {
      const next = name.trim() || "Player";
      usernameRef.current = next;
      const old = nameSprite.material.map;
      nameSprite.material.map = buildNameTexture(next);
      nameSprite.material.needsUpdate = true;
      if (old) old.dispose();
    };

    let model: THREE.Object3D | undefined;
    let modelBaseY = 0;
    let walkTime = 0;
    let verticalVelocity = 0;
    let grounded = true;
    let visualStepOffset = 0;
    let landingImpact = 0;
    let regenTimer = 0;
    teleportTo = (x, y, z) => {
      character.position.set(x, y, z);
      verticalVelocity = 0;
    };
    let airborneBlend = 0;
    let cameraYaw = 0;
    let cameraPitch = 0.12;
    let cameraDistance = 4.2;
    let firstPersonView = false;
    toggleViewRef.current = () => {
      firstPersonView = !firstPersonView;
      cameraPitch = THREE.MathUtils.clamp(cameraPitch, -1.2, 1.2);
      setFirstPerson(firstPersonView);
    };
    // A full voxel can be stepped onto; the model eases up visually below.
    const STEP_TOLERANCE = 0.52; // slabs and each half of a staircase are walkable
    const STEP_CLIMB_SPEED = 4.2; // blocks per second when the ground rises under a standing player
    type AttackMode = "punch" | "combo" | "kick";
    type PoseMap = Map<THREE.Object3D, THREE.Quaternion>;
    const ATTACK_DURATIONS: Record<AttackMode, number> = { punch: 0.72, combo: 1.3, kick: 0.9 };
    let attackTime = 0;
    let attackMode: AttackMode | null = null;
    // True when a punch is chained from a previous punch (held mining): the
    // swing then returns strike -> windup -> strike instead of snapping from
    // the extended strike back to the windup.
    let chainedPunch = false;
    let pendingHits = 0;
    // Progressive (Minecraft-style) block breaking.
    let miningHeld = false;
    let miningProgress = 0;
    let miningBlock: [number, number, number] | null = null;
    let attackBonus = 0;

    // Damage dealt to another player, in half-hearts (2 units = 1 heart):
    // punch/combo 0.5, kick 1, tool 1.5, sword 2 hearts.
    const pvpAim = new THREE.Vector3();
    const meleeDamage = (mode: AttackMode | null) => {
      const item = invRef.current[selectedRef.current]?.type ?? null;
      if (item && item.endsWith("_sword")) return 4;
      if (item && item !== "stick" && !isPlaceable(item)) return 3;
      return mode === "kick" ? 2 : 1;
    };

    let windupPose: PoseMap | undefined;
    let strikePose: PoseMap | undefined;
    let jabWindupPose: PoseMap | undefined;
    let jabStrikePose: PoseMap | undefined;
    let kickWindupPose: PoseMap | undefined;
    let kickStrikePose: PoseMap | undefined;
    let airbornePose: PoseMap | undefined;
    // Held item: one block mesh per type, parented to the right hand.
    let handAttach: THREE.Object3D | null = null;
    let handScale = 1;
    const heldMeshes = new Map<ItemType, THREE.Object3D>();
    let heldType: ItemType | null = null;

    let previousSpeed = 0;
    let previousVerticalVelocity = 0;
    let locomotionBlend = 0;
    let turnImpulse = 0;
    const previousWorldVelocity = new THREE.Vector3();
    const worldVelocity = new THREE.Vector3();
    const worldAcceleration = new THREE.Vector3();
    const localAcceleration = new THREE.Vector3();
    let lastMovingState = false;
    const restRotations = new Map<THREE.Object3D, THREE.Quaternion>();
    const bones: Partial<Record<keyof typeof BONE_NAMES, THREE.Object3D>> = {};
    const springBones: SpringBone[] = [];
    const clock = new THREE.Clock();

    const loader = createModelLoader();
    loader.load(MODEL_URL, (gltf) => {
      const loadedModel = gltf.scene;
      model = loadedModel;
       // The scene root contains the source coordinate-system conversion.
      loadedModel.rotation.set(0, 0, 0);
      loadedModel.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(loadedModel);
      const size = box.getSize(new THREE.Vector3());
      const scale = 1.72 / Math.max(size.y, 0.001);
      loadedModel.scale.setScalar(scale);
      loadedModel.updateMatrixWorld(true);
      const adjustedBox = new THREE.Box3().setFromObject(loadedModel);
      loadedModel.position.y = -adjustedBox.min.y;
      modelBaseY = loadedModel.position.y;
      loadedModel.traverse((node) => {
        if ((node as THREE.Mesh).isMesh) {
          const mesh = node as THREE.Mesh;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        }
        if ((node as THREE.Bone).isBone) restRotations.set(node, node.quaternion.clone());
      });

      for (const [key, value] of Object.entries(BONE_NAMES)) {
        const bone = findBone(loadedModel, value);
        if (bone) bones[key as keyof typeof BONE_NAMES] = bone;
      }

      // Held block: shows the selected hotbar block in the right hand.
      const handBone = findBone(loadedModel, "R_Hand_Attach") ?? findBone(loadedModel, "R_Hand_");
      if (handBone) {
        handBone.updateWorldMatrix(true, false);
        handAttach = handBone;
        handScale = handBone.getWorldScale(new THREE.Vector3()).x || 1;
      }

      // The GLB ships in a T-pose with no animation clips, so bake a relaxed
      // standing pose into the rest rotations by aiming each limb bone at a
      // desired world-space direction (model forward is +Z).
      const aimBone = (
        bone: THREE.Object3D | undefined,
        makeTarget: (currentDirection: THREE.Vector3, side: number) => THREE.Vector3,
        store: Map<THREE.Object3D, THREE.Quaternion> = restRotations,
      ) => {
        if (!bone || !bone.parent) return;
        const childBone = bone.children.find((child) => (child as THREE.Bone).isBone);
        if (!childBone) return;
        loadedModel.updateMatrixWorld(true);
        const origin = bone.getWorldPosition(new THREE.Vector3());
        const direction = childBone.getWorldPosition(new THREE.Vector3()).sub(origin).normalize();
        const side = direction.x >= 0 ? 1 : -1;
        const target = makeTarget(direction, side).normalize();
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
      };

      // Capture a keyframe pose (without disturbing the standing rest pose).
      const capturePose = (
        aims: Array<[THREE.Object3D | undefined, (dir: THREE.Vector3, side: number) => THREE.Vector3]>,
      ) => {
        const pose = new Map<THREE.Object3D, THREE.Quaternion>();
        const saved = new Map<THREE.Object3D, THREE.Quaternion>();
        aims.forEach(([bone]) => { if (bone) saved.set(bone, bone.quaternion.clone()); });
        aims.forEach(([bone, target]) => aimBone(bone, target, pose));
        saved.forEach((quaternion, bone) => bone.quaternion.copy(quaternion));
        loadedModel.updateMatrixWorld(true);
        return pose;
      };

      // Arms hang down from the shoulders instead of stretching sideways.
      aimBone(bones.leftUpperArm, (_dir, side) => new THREE.Vector3(side * 0.3, -0.95, 0.04));
      aimBone(bones.rightUpperArm, (_dir, side) => new THREE.Vector3(side * 0.5, -0.82, -0.2));
      // Left forearm relaxed, right forearm folded in so the hand rests on the hip.
      aimBone(bones.leftLowerArm, (_dir, side) => new THREE.Vector3(side * 0.12, -0.98, 0.1));
      aimBone(bones.rightLowerArm, (_dir, side) => new THREE.Vector3(-side * 0.42, -0.84, 0.32));

      // Legs brought together, knees and feet straightened under the hips.
      aimBone(bones.leftUpperLeg, (_dir, side) => new THREE.Vector3(-side * 0.055, -1, 0));
      aimBone(bones.rightUpperLeg, (_dir, side) => new THREE.Vector3(-side * 0.055, -1, 0));
      aimBone(bones.leftLowerLeg, (_dir, side) => new THREE.Vector3(side * 0.03, -1, 0.02));
      aimBone(bones.rightLowerLeg, (_dir, side) => new THREE.Vector3(side * 0.03, -1, 0.02));
      loadedModel.updateMatrixWorld(true);
      // Other players use the same character, in this same relaxed pose.
      remotePlayers.setTemplate(loadedModel);

      // Attack keyframes: wind up with the right fist drawn back, then a
      // straight punch fully extended forward (model forward is +Z).
      windupPose = capturePose([
        [bones.rightUpperArm, (_d, side) => new THREE.Vector3(side * 0.55, -0.4, -0.6)],
        [bones.rightLowerArm, (_d, side) => new THREE.Vector3(-side * 0.7, 0.15, 0.2)],
        [bones.leftUpperArm, (_d, side) => new THREE.Vector3(side * 0.7, -0.35, 0.4)],
        [bones.leftLowerArm, (_d, side) => new THREE.Vector3(-side * 0.15, 0.05, 0.95)],
      ]);
      strikePose = capturePose([
        [bones.rightUpperArm, (_d, side) => new THREE.Vector3(side * 0.26, -0.14, 0.95)],
        [bones.rightLowerArm, (_d, side) => new THREE.Vector3(side * 0.06, -0.06, 1)],
        [bones.leftUpperArm, (_d, side) => new THREE.Vector3(side * 0.62, -0.45, -0.4)],
        [bones.leftLowerArm, (_d, side) => new THREE.Vector3(-side * 0.4, -0.1, -0.3)],
      ]);

      // Combo first hit: a left jab (right hand stays guarding the face).
      jabWindupPose = capturePose([
        [bones.leftUpperArm, (_d, side) => new THREE.Vector3(side * 0.42, -0.5, -0.62)],
        [bones.leftLowerArm, (_d, side) => new THREE.Vector3(-side * 0.6, 0.12, 0.32)],
        [bones.rightUpperArm, (_d, side) => new THREE.Vector3(side * 0.45, -0.62, 0.3)],
        [bones.rightLowerArm, (_d, side) => new THREE.Vector3(-side * 0.5, 0.2, 0.55)],
      ]);
      jabStrikePose = capturePose([
        [bones.leftUpperArm, (_d, side) => new THREE.Vector3(side * 0.14, -0.1, 0.98)],
        [bones.leftLowerArm, (_d, side) => new THREE.Vector3(side * 0.04, -0.04, 1)],
        [bones.rightUpperArm, (_d, side) => new THREE.Vector3(side * 0.45, -0.62, 0.3)],
        [bones.rightLowerArm, (_d, side) => new THREE.Vector3(-side * 0.5, 0.2, 0.55)],
      ]);

      // Kick: chamber the right knee, then snap the leg straight forward.
      kickWindupPose = capturePose([
        [bones.rightUpperLeg, () => new THREE.Vector3(0, -0.2, 0.98)],
        [bones.rightLowerLeg, () => new THREE.Vector3(0, -0.85, -0.5)],
      ]);
      kickStrikePose = capturePose([
        [bones.rightUpperLeg, () => new THREE.Vector3(0, 0.12, 0.99)],
        [bones.rightLowerLeg, () => new THREE.Vector3(0, 0.05, 1)],
      ]);

      // Airborne balance pose for the arms only; the legs are driven
      // procedurally each frame so the whole limb swings, not just the feet.
      airbornePose = capturePose([
        [bones.leftUpperArm, (_d, side) => new THREE.Vector3(side * 0.62, 0.62, -0.2)],
        [bones.rightUpperArm, (_d, side) => new THREE.Vector3(side * 0.7, 0.3, 0.2)],
        [bones.leftLowerArm, (_d, side) => new THREE.Vector3(side * 0.3, 0.92, 0.1)],
        [bones.rightLowerArm, (_d, side) => new THREE.Vector3(side * 0.35, 0.6, 0.4)],
      ]);


      loadedModel.traverse((node) => {
        const isHair = /Hair\d.*Sec/.test(node.name);
        const isChest = /Bust0[12]_Sec/.test(node.name);
        const isButt = /Hip2Helper1_/.test(node.name);
        const isAccessory = /(?:Tail|BackRope|Weapon_OPN).*Sec/.test(node.name);
        const isCloth = /Front\d.*Sec/.test(node.name);
        if (isHair || isChest || isButt || isCloth || isAccessory) {
          const kind: SpringBone["kind"] = isHair
            ? "hair"
            : isChest
              ? "chest"
              : isButt
                ? "butt"
                : isAccessory
                  ? "accessory"
                  : "cloth";
          const isRoot = node.name.includes("Sec_Root");
          const settledRest = node.quaternion.clone();

          // Set flexible ornament roots toward world-down while preserving
          // their authored spread, keeping front cloth close to the body.
          if ((isAccessory || isCloth) && isRoot && node.parent) {
            const childBone = node.children.find((child) => (child as THREE.Bone).isBone);
            if (childBone) {
              loadedModel.updateMatrixWorld(true);
              const origin = node.getWorldPosition(new THREE.Vector3());
              const direction = childBone.getWorldPosition(new THREE.Vector3()).sub(origin).normalize();
              const downwardBias = isCloth ? 0.82 : 0.58;
              const target = direction.clone().lerp(new THREE.Vector3(0, -1, 0), downwardBias).normalize();
              const worldDelta = new THREE.Quaternion().setFromUnitVectors(direction, target);
              const parentWorld = node.parent.getWorldQuaternion(new THREE.Quaternion());
              settledRest.copy(parentWorld).invert().multiply(worldDelta).multiply(parentWorld).multiply(node.quaternion);
              node.quaternion.copy(settledRest);
            }
          }

          springBones.push({
            bone: node,
            rest: settledRest,
            kind,
            valueX: 0,
            valueZ: 0,
            velocityX: 0,
            velocityZ: 0,
            weight: kind === "hair"
              ? (isRoot ? 0.5 : 0.16)
              : kind === "chest"
                ? (isRoot ? 0.6 : 0.18)
                : kind === "butt"
                  ? 0.48
                  : kind === "accessory"
                    ? (isRoot ? 0.28 : 0.09)
                    : (isRoot ? 0.38 : 0.12),
          });
        }
      });

      character.add(loadedModel);
      setLoaded(true);
      onProgressRef.current?.(100);
      onReadyRef.current?.();
    }, (event) => {
      const total = event.total && event.total > 0 ? event.total : 14_000_000;
      const percent = Math.min(99, Math.round((event.loaded / total) * 100));
      onProgressRef.current?.(percent);
    }, () => {
      onProgressRef.current?.(100);
      onReadyRef.current?.();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (disabledRef.current) return;
      // T toggles the inventory (2x2), E the crafting table (3x3); while any
      // menu is open the world ignores input.
      const isT = event.code === "KeyT";
      const isE = event.code === "KeyE";
      const isEscape = event.code === "Escape";
      if (isT || isE || (isEscape && anyMenuOpen())) {
        event.preventDefault();
        const openMenu = () => {
          for (const code of Object.keys(keys)) keys[code] = false;
          miningHeld = false;
          if (document.pointerLockElement) document.exitPointerLock();
        };
        if (chestOpenRef.current) {
          closeChest();
          if (isT) {
            openMenu();
            invOpenRef.current = true;
            setInvOpen(true);
          }
        } else if (invOpenRef.current) {
          closeInventory();
          if (isE) {
            openMenu();
            // Only the table/chest you are aiming at can open.
            interact();
          }
        } else if (craftOpenRef.current) {
          closeCrafting();
          if (isT) {
            openMenu();
            invOpenRef.current = true;
            setInvOpen(true);
          }
        } else if (furnaceOpenRef.current) {
          closeFurnace();
          if (isT) {
            openMenu();
            invOpenRef.current = true;
            setInvOpen(true);
          }
        } else if (!isEscape) {
          if (isT) {
            openMenu();
            invOpenRef.current = true;
            setInvOpen(true);
          } else {
            // E only works while looking at a chest or crafting table.
            const aim = aimInfoRef.current;
            if (aim?.type === "chest" || aim?.type === "crafting_table" || aim?.type === "furnace") {
              openMenu();
              interact();
            }
          }
        }
        return;
      }
      if (anyMenuOpen()) return;
      keys[event.code] = true;
      if (event.code === "Quote") {
        firstPersonView = !firstPersonView;
        cameraPitch = THREE.MathUtils.clamp(cameraPitch, -1.2, 1.2);
      }
      if (event.code === "Space" && grounded) {
        verticalVelocity = 5.4;
        grounded = false;
      }
      // Number keys pick a hotbar slot.
      const digit = /^Digit([1-9])$/.exec(event.code);
      if (digit) {
        const index = Number(digit[1]) - 1;
        selectedRef.current = index;
        setSelectedSlot(index);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (disabledRef.current) return;
      keys[event.code] = false;
    };
    // Touch look: dragging the screen turns the camera, a still hold mines.
    const touchLook = { id: -1, x: 0, y: 0, moved: 0 };
    const placeSelected = () => {
      const stack = invRef.current[selectedRef.current];
      if (!stack || !isPlaceable(stack.type)) return false;
      const placed = world.placeBlock(
        lastAimOrigin,
        lastAimDirection,
        firstPersonView ? 5.5 : 3.6,
        character.position,
        stack.type,
      );
      if (placed) takeFromInventory(selectedRef.current);
      return placed;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (disabledRef.current || anyMenuOpen()) return;
      const touch = event.pointerType !== "mouse";
      if (touch) {
        touchLook.id = event.pointerId;
        touchLook.x = event.clientX;
        touchLook.y = event.clientY;
        touchLook.moved = 0;
      } else if (document.pointerLockElement !== renderer.domElement) {
        renderer.domElement.requestPointerLock();
      }
      if (event.button === 0) miningHeld = true;
      // Right click places the selected block when the hotbar slot holds one.
      if (event.button === 2 && placeSelected()) return;
      if (attackTime > 0) return;
      if (event.button === 0) {
        attackMode = event.detail >= 2 ? "combo" : "punch";
      } else if (event.button === 2) {
        attackMode = "kick";
      } else {
        return;
      }
      chainedPunch = false;
      attackTime = ATTACK_DURATIONS[attackMode];
      pendingHits = attackMode === "combo" ? 2 : 1;
      poseTimer = 0; // tell everyone else about the swing right away
      setAttackLabel(attackMode === "punch" ? "PUNCH" : attackMode === "combo" ? "COMBO" : "KICK");
    };

    const onContextMenu = (event: Event) => event.preventDefault();
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const dy = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
      cameraDistance = THREE.MathUtils.clamp(cameraDistance * Math.exp(dy * 0.0012), 0.75, 11);
    };

    const onPointerMove = (event: MouseEvent) => {
      if (document.pointerLockElement !== renderer.domElement) return;
      // Mouse right = look right, mouse left = look left (both views).
      cameraYaw -= event.movementX * 0.0023;
      const minPitch = firstPersonView ? -1.2 : -0.08;
      const maxPitch = firstPersonView ? 1.2 : 0.72;
      // Vertical: same direction in both views (mouse up = look up).
      cameraPitch = THREE.MathUtils.clamp(cameraPitch + event.movementY * 0.0018, minPitch, maxPitch);
    };
    const onTouchMove = (event: PointerEvent) => {
      if (event.pointerId !== touchLook.id) return;
      event.preventDefault();
      const dx = event.clientX - touchLook.x;
      const dy = event.clientY - touchLook.y;
      touchLook.x = event.clientX;
      touchLook.y = event.clientY;
      touchLook.moved += Math.hypot(dx, dy);
      // A deliberate drag is a look, not a mine.
      if (touchLook.moved > 14) miningHeld = false;
      cameraYaw -= dx * 0.005;
      const minPitch = firstPersonView ? -1.2 : -0.08;
      const maxPitch = firstPersonView ? 1.2 : 0.72;
      cameraPitch = THREE.MathUtils.clamp(cameraPitch + dy * 0.004, minPitch, maxPitch);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId === touchLook.id) touchLook.id = -1;
      if (event.button === 0) miningHeld = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    document.addEventListener("mousemove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onTouchMove, { passive: false });
    renderer.domElement.addEventListener("contextmenu", onContextMenu);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

    const setBoneRotation = (bone: THREE.Object3D | undefined, x: number, y: number, z: number) => {
      if (!bone) return;
      const rest = restRotations.get(bone);
      if (!rest) return;
      bone.quaternion.copy(rest).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z)));
    };

    let animationFrame = 0;
    // The world keeps simulating while the tab is in the background (browsers
    // stop animation frames there, which used to leave the player floating and
    // silent for everyone else); only drawing is skipped.
    const frame = (visible: boolean) => {
      const delta = Math.min(clock.getDelta(), 0.035);
      // Touch buttons queue a jump / place for the next frame.
      if (touchJumpRef.current) {
        touchJumpRef.current = false;
        if (grounded && !anyMenuOpen()) {
          verticalVelocity = 5.4;
          grounded = false;
        }
      }
      if (touchPlaceRef.current) {
        touchPlaceRef.current = false;
        if (!anyMenuOpen()) placeSelected();
      }
      const stick = touchMoveRef.current;
      const forward =
        Number(Boolean(keys["KeyW"] || keys["ArrowUp"])) -
        Number(Boolean(keys["KeyS"] || keys["ArrowDown"])) -
        stick.y;
      const strafe =
        Number(Boolean(keys["KeyD"] || keys["ArrowRight"])) -
        Number(Boolean(keys["KeyA"] || keys["ArrowLeft"])) +
        stick.x;
      const inputLength = Math.hypot(forward, strafe);
      const sprinting = Boolean(keys["ShiftLeft"] || keys["ShiftRight"]);
      const speed = inputLength > 0.12 ? (sprinting ? 5.2 : 2.7) * Math.min(1, inputLength) : 0;
      const direction = new THREE.Vector3(strafe, 0, -forward);
      if (speed > 0) {
        direction.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), cameraYaw);
        // No auto-jump: any column above the feet blocks movement until the player jumps.
        const step = speed * delta;
        const feetY = character.position.y;
        const canStand = (x: number, z: number) =>
          world.groundHeight(x, z, feetY + STEP_TOLERANCE) <= feetY + STEP_TOLERANCE;
        const nextX = character.position.x + direction.x * step;
        const nextZ = character.position.z + direction.z * step;
        if (canStand(nextX, character.position.z)) character.position.x = nextX;
        if (canStand(character.position.x, nextZ)) character.position.z = nextZ;
        const targetAngle = Math.atan2(direction.x, direction.z);
        let turn = targetAngle - character.rotation.y;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        const appliedTurn = turn * Math.min(1, delta * 9);
        character.rotation.y += appliedTurn;
        turnImpulse = THREE.MathUtils.lerp(turnImpulse, appliedTurn / Math.max(delta, 0.001), Math.min(1, delta * 12));
        worldVelocity.copy(direction).multiplyScalar(speed);
      } else {
        worldVelocity.set(0, 0, 0);
        turnImpulse = THREE.MathUtils.lerp(turnImpulse, 0, Math.min(1, delta * 7));
      }
      // The model's forward axis is +Z, so it must face opposite the camera yaw.
      if (firstPersonView) character.rotation.y = cameraYaw + Math.PI;

      // Ladders: no gravity while touching one. Walk forward (or jump) to go
      // up, crouch to go down, otherwise you simply hang on. The -0.6 check
      // keeps you held for one block above the top rung, so you can climb out
      // onto the ledge instead of getting stuck at the top.
      const onLadder =
        world.isClimbable(character.position.x, character.position.y - 0.6, character.position.z) ||
        world.isClimbable(character.position.x, character.position.y + 0.2, character.position.z) ||
        world.isClimbable(character.position.x, character.position.y + 1.2, character.position.z);
      const aboveLadderTop =
        onLadder &&
        !world.isClimbable(character.position.x, character.position.y + 0.2, character.position.z);
      if (onLadder) {
        verticalVelocity = 0;
        const crouching = Boolean(keys["ControlLeft"] || keys["KeyC"]);
        // Stop climbing once you are a block clear of the top rung.
        if ((speed > 0 || keys["Space"]) && !aboveLadderTop) character.position.y += 3 * delta;
        else if (crouching) character.position.y -= 3 * delta;
      } else {
        verticalVelocity -= 12.5 * delta;
        character.position.y += verticalVelocity * delta;
      }
      const groundY = world.groundHeight(
        character.position.x,
        character.position.z,
        character.position.y + 0.5,
      );
      if (onLadder) {
        if (character.position.y < groundY) character.position.y = groundY;
        grounded = true;
      } else if (character.position.y <= groundY) {
        const heightCorrection = groundY - character.position.y;
        if (grounded && heightCorrection > 0.02) {
          // Climb onto the higher block over a few frames instead of teleporting.
          const climb = Math.min(heightCorrection, STEP_CLIMB_SPEED * delta);
          character.position.y += climb;
        } else {
          if (!grounded && verticalVelocity < -2.2) {
            // Higher falls hit harder: scale superlinearly with impact speed.
            const impactSpeed = -verticalVelocity - 2.2;
            landingImpact = THREE.MathUtils.clamp(impactSpeed * Math.pow(impactSpeed, 0.5), 0, 20);
            // Fall damage: half a heart per block above a ~3 block drop.
            const fallSpeed = -verticalVelocity;
            if (fallSpeed > 9.5) damagePlayer(Math.round((fallSpeed - 9.5) * 1.1));
          }
          character.position.y = groundY;
        }
        verticalVelocity = 0;
        grounded = true;
      } else {
        grounded = false;
      }
      world.update(delta, character.position, addToInventory);
      // Furnaces continue smelting whether their screen is open or closed.
      for (const [key, furnace] of furnaceStoreRef.current) {
        let remaining = Math.min(1, delta);
        while (remaining > 0) {
          const canOutput = !furnace.output || (furnace.output.type === "coal" && furnace.output.count < maxStack("coal"));
          if (!furnace.input || furnace.input.type !== "coal_ore" || !canOutput) {
            furnace.progress = 0;
            break;
          }
          if (furnace.burnLeft <= 0) {
            const fuel = furnace.fuel;
            const duration = fuel?.type === "stick" ? 5 : fuel?.type === "planks" ? 10 : fuel?.type === "wood" ? 20 : 0;
            if (!fuel || duration === 0) break;
            furnace.fuel = fuel.count > 1 ? { type: fuel.type, count: fuel.count - 1 } : null;
            furnace.burnLeft = duration;
            furnace.burnTotal = duration;
          }
          const step = Math.min(remaining, furnace.burnLeft, 5 - furnace.progress);
          furnace.burnLeft -= step;
          furnace.progress += step;
          remaining -= step;
          if (furnace.progress >= 5) {
            furnace.progress = 0;
            furnace.input = furnace.input.count > 1 ? { type: "coal_ore", count: furnace.input.count - 1 } : null;
            furnace.output = furnace.output ? { type: "coal", count: furnace.output.count + 1 } : { type: "coal", count: 1 };
          }
        }
        furnace.updatedAt = performance.now();
        if (furnaceOpenRef.current && furnaceKeyRef.current === key) setFurnaceState({ ...furnace });
      }

      // Health: slow regeneration, and a respawn when it runs out. Online the
      // server handles both (so it also works while this tab is asleep).
      if (link) {
        /* server-authoritative */
      } else if (healthRef.current <= 0) {
        dropInventory?.();
        character.position.set(0.5, world.groundHeight(0.5, 0.5), 0.5);
        verticalVelocity = 0;
        setHealthValue(MAX_HEALTH);
        regenTimer = 0;
      } else if (healthRef.current < MAX_HEALTH) {
        regenTimer += delta;
        if (regenTimer >= 4) {
          regenTimer = 0;
          setHealthValue(healthRef.current + 1);
        }
      } else {
        regenTimer = 0;
      }


      locomotionBlend = THREE.MathUtils.lerp(locomotionBlend, speed > 0 ? 1 : 0, 1 - Math.exp(-delta * (speed > 0 ? 9 : 7)));
      if (speed > 0) walkTime += delta * (sprinting ? 10.5 : 7.2);
      const locomotion = THREE.MathUtils.clamp(speed / 3.2, 0, 1.35) * locomotionBlend;
      const gait = Math.sin(walkTime);
      const stride = gait * 0.5 * locomotion;
      const counter = -stride;
      const kneeL = Math.max(0, -gait) * 0.68 * locomotion;
      const kneeR = Math.max(0, gait) * 0.68 * locomotion;
      const settle = speed === 0 ? Math.sin(clock.elapsedTime * 1.7) * 0.018 : 0;
      const idleSway = (1 - locomotionBlend) * Math.sin(clock.elapsedTime * 0.82);

      setBoneRotation(bones.leftUpperLeg, stride, 0, 0);
      setBoneRotation(bones.rightUpperLeg, counter, 0, 0);
      setBoneRotation(bones.leftLowerLeg, kneeL, 0, 0);
      setBoneRotation(bones.rightLowerLeg, kneeR, 0, 0);
      setBoneRotation(bones.leftFoot, -kneeL * 0.62 - stride * 0.22, 0, 0);
      setBoneRotation(bones.rightFoot, -kneeR * 0.62 - counter * 0.22, 0, 0);
      // Attack animation: pick two keyframe poses per segment, slerp between
      // them, and blend the whole layer in/out. Punch = right cross, combo =
      // left jab into right cross, kick = chambered right-leg snap.
      let attackBlend = 0;
      let twist = 0;
      let leanBack = 0;
      let poseA: PoseMap | undefined;
      let poseB: PoseMap | undefined;
      let segmentT = 0;
      if (attackTime > 0 && attackMode) {
        attackTime = Math.max(0, attackTime - delta);
        const p = 1 - attackTime / ATTACK_DURATIONS[attackMode];
        if (attackMode === "punch") {
          poseA = windupPose; poseB = strikePose;
          if (chainedPunch) {
            // Chained mining swing: start from the extended strike, draw back
            // to the windup, then punch out again — no snap back to idle.
            if (p < 0.34) { segmentT = 2 + p / 0.34; attackBlend = 1; }
            else if (p < 0.66) { segmentT = 3 - (p - 0.34) / 0.32; attackBlend = 1; }
            else if (p < 0.78) { segmentT = 2; attackBlend = 1; }
            else { segmentT = 2; attackBlend = (1 - p) / 0.22; }
            const k = segmentT <= 2 ? segmentT : 4 - segmentT;
            twist = (k - 1) * 0.3 * attackBlend;
          } else {
            if (p < 0.26) { segmentT = p / 0.26; attackBlend = segmentT; }
            else if (p < 0.5) { segmentT = 1 + (p - 0.26) / 0.24; attackBlend = 1; }
            else if (p < 0.68) { segmentT = 2; attackBlend = 1; }
            else { segmentT = 2; attackBlend = (1 - p) / 0.32; }
            twist = (Math.min(segmentT, 2) - 1) * 0.3 * attackBlend;
          }
        } else if (attackMode === "combo") {
          // Two-stage: jab (p 0..0.45) then cross (p 0.45..1).
          if (p < 0.12) { segmentT = p / 0.12; attackBlend = segmentT; poseA = jabWindupPose; poseB = jabStrikePose; twist = -segmentT * 0.28 * attackBlend; }
          else if (p < 0.3) { segmentT = 1 + (p - 0.12) / 0.18; attackBlend = 1; poseA = jabWindupPose; poseB = jabStrikePose; twist = (Math.min(segmentT, 2) - 1) * -0.28; }
          else if (p < 0.45) { segmentT = 2; attackBlend = 1; poseA = jabWindupPose; poseB = jabStrikePose; twist = -0.28 * (1 - (p - 0.3) / 0.15); }
          else if (p < 0.58) { segmentT = (p - 0.45) / 0.13; attackBlend = 1; poseA = windupPose; poseB = strikePose; twist = (segmentT - 1) * 0.38; }
          else if (p < 0.74) { segmentT = 1 + (p - 0.58) / 0.16; attackBlend = 1; poseA = windupPose; poseB = strikePose; twist = (Math.min(segmentT, 2) - 1) * 0.38; }
          else { segmentT = 2; attackBlend = (1 - p) / 0.26; poseA = windupPose; poseB = strikePose; twist = 0.38 * attackBlend; }
        } else {
          // Kick.
          if (p < 0.3) { segmentT = p / 0.3; attackBlend = Math.min(1, segmentT * 1.4); poseA = kickWindupPose; poseB = kickStrikePose; }
          else if (p < 0.48) { segmentT = 1 + (p - 0.3) / 0.18; attackBlend = 1; poseA = kickWindupPose; poseB = kickStrikePose; }
          else if (p < 0.62) { segmentT = 2; attackBlend = 1; poseA = kickWindupPose; poseB = kickStrikePose; }
          else { segmentT = 2; attackBlend = (1 - p) / 0.38; poseA = kickWindupPose; poseB = kickStrikePose; }
          const k = Math.min(segmentT, 2);
          leanBack = (k <= 1 ? -0.12 * k : -0.12 - 0.16 * (k - 1)) * attackBlend;
          twist = -0.18 * (k <= 1 ? k : 2 - k) * attackBlend;
        }
        // Landing frames chip away at the targeted block instead of breaking it.
        const hitPoint = attackMode === "combo" ? (pendingHits === 2 ? 0.3 : 0.74) : attackMode === "kick" ? 0.48 : chainedPunch ? 0.66 : 0.5;
        if (pendingHits > 0 && p >= hitPoint) {
          pendingHits -= 1;
          let hitPlayer = false;
          // PvP: whoever the crosshair is on takes the hit.
          if (link) {
            camera.getWorldDirection(pvpAim);
            const targetId = remotePlayers.hitTest(camera.position, pvpAim, HIT_RANGE);
            if (targetId) {
              hitPlayer = true;
              link.sendHit(targetId, meleeDamage(attackMode));
            }
          }
          // A player absorbs the strike; do not also damage the block behind them.
          if (!hitPlayer) attackBonus += 0.3;
        }

        if (attackTime === 0) {
          attackMode = null;
          chainedPunch = false;
          setAttackLabel(null);
        }
      }

      // The standing pose is baked into the rest rotations, so only layer the
      // walk swing (left arm) and a light idle sway on top of it.
      const swingScale = 1 - attackBlend;
      setBoneRotation(bones.leftUpperArm, 0, (counter * 0.42 - idleSway * 0.018) * swingScale, 0);
      setBoneRotation(bones.rightUpperArm, 0, idleSway * 0.012 * swingScale, 0);
      setBoneRotation(bones.leftLowerArm, 0, -Math.max(0, -counter) * 0.14 * swingScale, 0);
      setBoneRotation(bones.rightLowerArm, 0, 0, 0);
      // Kicks drive the legs too, so fade the walk cycle out of the way.
      if (attackMode === "kick" && attackBlend > 0) {
        const restLegs = [bones.leftUpperLeg, bones.rightUpperLeg, bones.leftLowerLeg, bones.rightLowerLeg, bones.leftFoot, bones.rightFoot];
        restLegs.forEach((bone) => {
          const rest = bone && restRotations.get(bone);
          if (bone && rest) bone.quaternion.slerp(rest, attackBlend);
        });
      }
      if (attackBlend > 0 && poseA && poseB) {
        const target = new THREE.Quaternion();
        poseA.forEach((windup, bone) => {
          const strike = poseB!.get(bone);
          const rest = restRotations.get(bone);
          if (!strike || !rest) return;
          if (segmentT <= 1) target.copy(rest).slerp(windup, segmentT);
          else if (segmentT <= 2) target.copy(windup).slerp(strike, segmentT - 1);
          else target.copy(strike).slerp(windup, segmentT - 2);
          bone.quaternion.slerp(target, attackBlend);
        });
      }

      airborneBlend = THREE.MathUtils.lerp(
        airborneBlend,
        grounded ? 0 : 1,
        1 - Math.exp(-delta * (grounded ? 14 : 16)),
      );
      // Jump pose: hips, thighs, knees and feet all move. Knees tuck up on the
      // way up, then the legs reach down for the landing on the way down.
      let jumpLean = 0;
      if (airborneBlend > 0.001) {
        const rise = THREE.MathUtils.clamp(verticalVelocity / 5.4, 0, 1);
        const fall = THREE.MathUtils.clamp(-verticalVelocity / 5.4, 0, 1);
        const blend = airborneBlend;
        jumpLean = (0.16 * rise - 0.1 * fall) * blend;
        const blendBone = (bone: THREE.Object3D | undefined, x: number, y = 0, z = 0) => {
          if (!bone) return;
          const rest = restRotations.get(bone);
          if (!rest) return;
          const target = rest
            .clone()
            .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z)));
          bone.quaternion.slerp(target, blend);
        };
        // Lead leg tucks high, trail leg trails behind and straightens sooner.
        blendBone(bones.leftUpperLeg, 0.85 * rise + 0.1 * fall, 0, -0.14);
        blendBone(bones.rightUpperLeg, 0.42 * rise - 0.3 * fall, 0, 0.14);
        blendBone(bones.leftLowerLeg, 1.15 * rise + 0.3 * fall, 0, 0);
        blendBone(bones.rightLowerLeg, 0.7 * rise + 0.55 * fall, 0, 0);
        blendBone(bones.leftFoot, -0.4 * rise + 0.25 * fall, 0, 0);
        blendBone(bones.rightFoot, -0.5 * rise + 0.15 * fall, 0, 0);
        if (airbornePose) {
          airbornePose.forEach((quaternion, bone) => {
            bone.quaternion.slerp(quaternion, blend);
          });
        }
      }

      setBoneRotation(bones.hips, settle + leanBack * 0.4 + jumpLean * 0.5, gait * 0.045 * locomotion + twist * 0.5, Math.cos(walkTime) * 0.032 * locomotion + idleSway * 0.018);
      setBoneRotation(bones.spine, -settle * 0.5 + leanBack - jumpLean, -gait * 0.032 * locomotion + twist * 0.7, -Math.cos(walkTime) * 0.018 * locomotion - idleSway * 0.012);
      setBoneRotation(bones.chest, settle * 0.65 - jumpLean * 0.6, Math.sin(walkTime) * 0.025 * locomotion + twist * 0.5, idleSway * 0.007);
      setBoneRotation(bones.head, -settle * 0.35 + jumpLean * 0.4, twist * 0.3, -idleSway * 0.006);


      visualStepOffset = THREE.MathUtils.lerp(visualStepOffset, 0, 1 - Math.exp(-delta * 11));
      if (model) {
        model.position.y = modelBaseY
          + visualStepOffset
          + (speed > 0 ? Math.abs(Math.sin(walkTime * 2)) * 0.024 * locomotion : settle * 0.16);
      }

      const acceleration = (speed - previousSpeed) / Math.max(delta, 0.001);
      previousSpeed = THREE.MathUtils.lerp(previousSpeed, speed, Math.min(1, delta * 8));
      const verticalAcceleration = (verticalVelocity - previousVerticalVelocity) / Math.max(delta, 0.001);
      previousVerticalVelocity = verticalVelocity;
      worldAcceleration.copy(worldVelocity).sub(previousWorldVelocity).divideScalar(Math.max(delta, 0.001));
      previousWorldVelocity.lerp(worldVelocity, Math.min(1, delta * 9));
      localAcceleration.copy(worldAcceleration).applyAxisAngle(new THREE.Vector3(0, 1, 0), -character.rotation.y);
      springBones.forEach((spring, index) => {
        const isChest = spring.kind === "chest";
        const isHair = spring.kind === "hair";
        const isButt = spring.kind === "butt";
        const isAccessory = spring.kind === "accessory";
        const flutter = isHair
          ? Math.sin(clock.elapsedTime * (2.1 + (index % 4) * 0.17) + index) * 0.008
          : 0;
        const gaitBounce = Math.sin(walkTime * 2) * speed * locomotionBlend;
        const breathing = Math.sin(clock.elapsedTime * 2.15) * (isChest ? 0.02 : 0.018);
        const targetX = (
          -acceleration * (isChest ? 0.012 : isButt ? 0.006 : 0.011)
          -localAcceleration.z * (isChest ? 0.005 : isButt ? 0.003 : 0.009)
          -verticalAcceleration * (isChest ? 0.01 : isButt ? 0.005 : 0.004)
          + gaitBounce * (isButt ? 0.026 : 0.018)
        ) * spring.weight + flutter + (isChest ? breathing * spring.weight : 0);
        const directionalSway = -localAcceleration.x * (isHair ? 0.014 : 0.004) - turnImpulse * (isHair ? 0.032 : 0.006);
        const targetZ = (
          directionalSway
          + Math.sin(walkTime + index * 0.24) * speed * (isChest ? 0.012 : isButt ? 0.009 : 0.013)
        ) * spring.weight;
        const stiffness = isChest ? 23 : isHair ? 20 : isButt ? 40 : isAccessory ? 28 : 34;
        const damping = isChest ? 2.5 : isHair ? 3.1 : isButt ? 5.2 : isAccessory ? 6.4 : 7.2;
        if (isChest && landingImpact > 0) {
          spring.velocityX += landingImpact * 0.22 * spring.weight;
          spring.velocityZ += landingImpact * 0.06 * spring.weight;
        }
        spring.velocityX += (targetX - spring.valueX) * stiffness * delta;
        spring.velocityZ += (targetZ - spring.valueZ) * stiffness * delta;
        spring.velocityX *= Math.exp(-damping * delta);
        spring.velocityZ *= Math.exp(-damping * delta);
        spring.valueX += spring.velocityX * delta;
        spring.valueZ += spring.velocityZ * delta;
        const maxAngle = isChest ? 0.38 : isHair ? 0.3 : isButt ? 0.12 : isAccessory ? 0.16 : 0.13;
        spring.valueX = THREE.MathUtils.clamp(spring.valueX, -maxAngle, maxAngle);
        spring.valueZ = THREE.MathUtils.clamp(spring.valueZ, -maxAngle, maxAngle);
        // The walk-cycle bounce is applied directly at step frequency so the
        // chest keeps oscillating while moving instead of only on stop/start.
        const gaitOffset = isChest ? Math.sin(walkTime * 2 + index * 0.35) * 0.05 * locomotionBlend : 0;
        spring.bone.quaternion.copy(spring.rest).multiply(
          new THREE.Quaternion().setFromEuler(new THREE.Euler(spring.valueX + gaitOffset, 0, spring.valueZ)),
        );
      });
      landingImpact = 0;

      const target = character.position.clone().add(new THREE.Vector3(0, 1.05, 0));
      if (firstPersonView) {
        // Place the view just ahead of the face so looking down reveals the body.
        const eye = character.position.clone().add(new THREE.Vector3(0, 1.5, 0));
        eye.add(new THREE.Vector3(-Math.sin(cameraYaw), 0, -Math.cos(cameraYaw)).multiplyScalar(0.13));
        camera.position.copy(eye);
        const look = eye.clone().add(new THREE.Vector3(
          -Math.sin(cameraYaw) * Math.cos(cameraPitch),
          -Math.sin(cameraPitch),
          -Math.cos(cameraYaw) * Math.cos(cameraPitch),
        ));
        camera.lookAt(look);
      } else {
        const offset = new THREE.Vector3(
          Math.sin(cameraYaw) * Math.cos(cameraPitch) * cameraDistance,
          0.9 + Math.sin(cameraPitch) * cameraDistance,
          Math.cos(cameraYaw) * Math.cos(cameraPitch) * cameraDistance,
        );
        // Keep the camera outside the blocks it would otherwise sit inside.
        const desired = target.clone().add(offset);
        const toCamera = desired.clone().sub(target);
        const clearance = world.cameraClearance(target, toCamera);
        if (clearance < 1) desired.copy(target).addScaledVector(toCamera, Math.max(clearance, 0.12));
        camera.position.lerp(desired, 1 - Math.exp(-7 * delta));
        camera.lookAt(target);
      }
      // --- aiming + progressive block breaking -------------------------------
      const aimOrigin = camera.position.clone();
      const aimDirection = new THREE.Vector3();
      if (firstPersonView) {
        camera.getWorldDirection(aimDirection);
      } else {
        aimOrigin.copy(character.position).add(new THREE.Vector3(0, 1.2, 0));
        aimDirection
          .set(Math.sin(character.rotation.y), -0.3, Math.cos(character.rotation.y))
          .normalize();
      }
      lastAimOrigin.copy(aimOrigin);
      lastAimDirection.copy(aimDirection);
      const aimed = world.pickBlock(aimOrigin, aimDirection, firstPersonView ? 5.5 : 3.2);
      world.highlightBlock(aimed);
      const aimedType = aimed ? world.blockTypeAt(aimed) : null;
      aimInfoRef.current =
        aimed && aimedType ? { key: `${aimed[0]},${aimed[1]},${aimed[2]}`, type: aimedType } : null;
      const aimedUsable = aimedType === "crafting_table" || aimedType === "chest" || aimedType === "furnace";
      if (aimedUsable !== aimTableRef.current) {
        aimTableRef.current = aimedUsable;
        setAimTable(aimedUsable);
      }
      const sameBlock =
        aimed && miningBlock
          ? aimed[0] === miningBlock[0] && aimed[1] === miningBlock[1] && aimed[2] === miningBlock[2]
          : false;
      if (!sameBlock) {
        miningBlock = aimed;
        miningProgress = 0;
      }
      // Keep swinging while the mouse stays held on a block. Chain the next
      // punch as soon as the strike lands (skip the recovery pause) so the
      // animation loops without dropping back to idle between swings. Chained
      // swings use the reversed timeline so the arm travels strike -> windup
      // -> strike instead of snapping.
      const punchRecovery = ATTACK_DURATIONS.punch * 0.32;
      if (miningHeld && miningBlock && (attackTime === 0 || (attackMode === "punch" && attackTime <= punchRecovery))) {
        chainedPunch = attackMode === "punch" && attackTime > 0;
        attackMode = "punch";
        attackTime = ATTACK_DURATIONS.punch;
        pendingHits = 1;
        setAttackLabel("PUNCH");
      }
      if (miningBlock && (miningHeld || attackBonus > 0)) {
        const miningType = world.blockTypeAt(miningBlock);
        if (miningHeld) {
          const tool = invRef.current[selectedRef.current]?.type ?? null;
          const speed = miningType ? miningSpeed(tool, miningType) : 1;
          miningProgress += (delta * speed) / (miningType ? BREAK_TIMES[miningType] : 0.95);
        }
        miningProgress += attackBonus;
        attackBonus = 0;
        if (miningProgress >= 1) {
          // A broken chest spills everything it was holding.
          if (miningType === "chest") {
            const chestKey = `${miningBlock[0]},${miningBlock[1]},${miningBlock[2]}`;
            const stored = chestStoreRef.current.get(chestKey);
            if (stored) {
              for (const slot of stored) if (slot) addStack(slot.type, slot.count);
              chestStoreRef.current.delete(chestKey);
            }
            if (chestKeyRef.current === chestKey) closeChest();
          }
          if (miningType === "furnace") {
            const furnaceKey = `${miningBlock[0]},${miningBlock[1]},${miningBlock[2]}`;
            const stored = furnaceStoreRef.current.get(furnaceKey);
            if (stored) {
              for (const slot of [stored.input, stored.fuel, stored.output]) if (slot) addStack(slot.type, slot.count);
              furnaceStoreRef.current.delete(furnaceKey);
            }
            if (furnaceKeyRef.current === furnaceKey) closeFurnace();
          }
          world.removeBlock(miningBlock);
          miningBlock = null;
          miningProgress = 0;
        }
      } else if (!miningHeld) {
        // Cracks heal back when the player stops mining.
        miningProgress = Math.max(0, miningProgress - delta * 0.8);
        attackBonus = 0;
      }
      world.showBreakProgress(miningBlock, miningProgress);
      // Show the selected stack's block in the character's hand.
      const selectedType = invRef.current[selectedRef.current]?.type ?? null;
      const nextHeldType = selectedType ?? null;
      if (nextHeldType !== heldType) {
        const previous = heldType ? heldMeshes.get(heldType) : null;
        if (previous) previous.visible = false;
        heldType = nextHeldType;
        if (nextHeldType && handAttach) {
          let mesh = heldMeshes.get(nextHeldType);
          if (!mesh) {
            mesh = isPlaceable(nextHeldType)
              ? world.makeBlockMesh(0.19, nextHeldType)
              : (makeHandItem(nextHeldType) ?? undefined);
            if (mesh) {
              mesh.scale.setScalar(1 / handScale);
              heldMeshes.set(nextHeldType, mesh);
              handAttach.add(mesh);
            }
          }
          if (mesh) mesh.visible = true;
        }
      }

      // --- day / night cycle -------------------------------------------------
      const worldSeconds = Math.max(0, (Date.now() - worldEpoch) / 1000);
      const cycleT = (worldSeconds % CYCLE_SECONDS) / CYCLE_SECONDS;
      const cycleAngle = cycleT * Math.PI * 2;
      const sunDir = new THREE.Vector3(Math.cos(cycleAngle), Math.sin(cycleAngle), 0.35).normalize();
      const elevation = sunDir.y;
      const dayFactor = THREE.MathUtils.clamp((elevation + 0.05) / 0.35, 0, 1);
      const nightFactor = 1 - dayFactor;

      skyGroup.position.copy(camera.position);
      sunMesh.position.copy(sunDir).multiplyScalar(220);
      moonMesh.position.copy(sunDir).multiplyScalar(-220);
      sunMesh.visible = elevation > -0.2;
      moonMesh.visible = elevation < 0.2;
      starMaterial.opacity = nightFactor * 0.9;

      sun.position.copy(character.position).addScaledVector(sunDir, 40);
      sun.target.position.copy(character.position);
      sun.intensity = 4.2 * dayFactor;
      sun.visible = dayFactor > 0.01;
      moon.position.copy(character.position).addScaledVector(sunDir, -40);
      moon.target.position.copy(character.position);
      moon.intensity = 0.9 * nightFactor;
      hemi.intensity = 0.35 + 1.9 * dayFactor;

      const horizonGlow = THREE.MathUtils.clamp(1 - Math.abs(elevation) / 0.25, 0, 1);
      skyColor.copy(skyNight).lerp(skyDay, dayFactor).lerp(skyDusk, horizonGlow * 0.45);

      nameSprite.visible = !firstPersonView;

      // --- multiplayer sync ---------------------------------------------------
      // Simulate gravity for remote avatars too. This keeps an inactive
      // player's visible body grounded immediately after its support is mined,
      // even if that browser has suspended its own rendering loop.
      remotePlayers.update(delta, (x, z, y) => world.groundHeight(x, z, y));
      poseTimer -= delta;
      if (link && poseTimer <= 0) {
        // ~15 updates a second; the server rebroadcasts at the same rate.
        poseTimer = attackMode ? 0.05 : 0.066;
        link.sendPose({
          x: character.position.x,
          y: character.position.y,
          z: character.position.z,
          ry: character.rotation.y,
          moving: speed > 0,
          attack: attackMode,
          ap: attackMode ? 1 - attackTime / ATTACK_DURATIONS[attackMode] : 0,
          item: invRef.current[selectedRef.current]?.type ?? null,
        });
      }

      const nowMoving = speed > 0;
      if (nowMoving !== lastMovingState) {
        lastMovingState = nowMoving;
        setMoving(nowMoving);
      }
      if (visible) renderer.render(scene, camera);
    };
    const animate = () => {
      animationFrame = requestAnimationFrame(animate);
      if (!document.hidden) frame(true);
    };
    animate();
    const stopBackgroundFrames = startBackgroundTicker(() => {
      if (document.hidden) frame(false);
    }, 50);

    const onResize = () => {
      if (!host) return;
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(animationFrame);
      stopBackgroundFrames();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("mousemove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onTouchMove);
      renderer.domElement.removeEventListener("contextmenu", onContextMenu);
      renderer.domElement.removeEventListener("wheel", onWheel);
      link?.dispose();
      linkRef.current = null;
      remotePlayers.dispose();
      world.dispose();
      renderer.dispose();

      host.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-background text-foreground">
      <div ref={hostRef} className="absolute inset-0" aria-label="Open 3D terrain game" />

      <div className="crosshair" aria-hidden="true">
        <span />
        <span />
      </div>

      {hurt ? <div className="hurt-flash" aria-hidden="true" /> : null}


      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-end gap-2 p-5 sm:p-7">
        <div className="game-status" aria-live="polite">
          TOTAL PLAYERS: {playerCount}
        </div>
      </div>


      {invOpen ? (
        <InventoryPanel
          title="Inventory"
          inventory={inventory}
          craftGrid={craftGrid}
          cursor={cursor}
          cursorPos={cursorPos}
          onSlotClick={handleSlotClick}
          onTakeResult={(right) => handleTakeResult(right, false)}
          onClose={closeInventory}
          onCursorMove={(x, y) => setCursorPos({ x, y })}
        />
      ) : null}

      {craftOpen ? (
        <InventoryPanel
          title="Crafting Table"
          largeGrid
          inventory={inventory}
          craftGrid={tableGrid}
          cursor={cursor}
          cursorPos={cursorPos}
          onSlotClick={(area, index, right) =>
            handleSlotClick(area === "craft" ? "craft3" : area, index, right)
          }
          onTakeResult={(right) => handleTakeResult(right, true)}
          onClose={closeCrafting}
          onCursorMove={(x, y) => setCursorPos({ x, y })}
        />
      ) : null}

      {chestOpen ? (
        <InventoryPanel
          title="Chest"
          inventory={inventory}
          craftGrid={craftGrid}
          chestSlots={chestSlots}
          cursor={cursor}
          cursorPos={cursorPos}
          onSlotClick={handleSlotClick}
          onTakeResult={() => {}}
          onClose={closeChest}
          onCursorMove={(x, y) => setCursorPos({ x, y })}
        />
      ) : null}

      {furnaceOpen && furnaceState ? (
        <FurnacePanel
          inventory={inventory}
          furnace={furnaceState}
          cursor={cursor}
          cursorPos={cursorPos}
          onSlotClick={handleFurnaceSlotClick}
          onClose={closeFurnace}
          onCursorMove={(x, y) => setCursorPos({ x, y })}
        />
      ) : null}

      <div className="hotbar-wrap">
        <div className="hp-bar" role="img" aria-label={`Health ${health} of ${MAX_HEALTH}`}>
          {Array.from({ length: 10 }, (_, index) => {
            const filled = health - index * 2;
            const state = filled >= 2 ? "is-full" : filled === 1 ? "is-half" : "is-empty";
            return <span key={index} className={`heart ${state}`} aria-hidden="true" />;
          })}
        </div>
        <div className="hotbar" role="list" aria-label="Inventory hotbar">
          {inventory.slice(0, HOTBAR_SIZE).map((slot, index) => (
            <button
              key={index}
              type="button"
              role="listitem"
              className={index === selectedSlot ? "hotbar-slot is-active" : "hotbar-slot"}
              onClick={() => {
                selectedRef.current = index;
                setSelectedSlot(index);
              }}
              aria-label={slot ? `${BLOCK_LABEL[slot.type]} x${slot.count}` : `Empty slot ${index + 1}`}
            >
              {slot ? (
                <>
                  <span className={`block-icon is-${slot.type}`} aria-hidden="true" />
                  <span className="slot-count">{slot.count}</span>
                </>
              ) : null}
              <span className="slot-index">{index + 1}</span>
            </button>
          ))}
        </div>
        <p className="hotbar-hint">
          {isTouch
            ? inventory[selectedSlot]
              ? `${BLOCK_LABEL[inventory[selectedSlot]!.type]} — tap PLACE · hold screen to break`
              : "Hold the screen to break blocks · drag to look"
            : inventory[selectedSlot]
              ? `${BLOCK_LABEL[inventory[selectedSlot]!.type]} — right-click to place · T inventory · E interact`
              : "Mine blocks to collect them · T inventory · E interact"}
        </p>
      </div>

      {isTouch ? (
        <button
          type="button"
          className={firstPerson ? "fp-toggle is-active" : "fp-toggle"}
          onClick={() => toggleViewRef.current?.()}
          aria-label={firstPerson ? "Switch to third person view" : "Switch to first person view"}
        >
          {firstPerson ? <PersonStanding size={20} aria-hidden="true" /> : <Eye size={20} aria-hidden="true" />}
        </button>
      ) : null}

      {isTouch && !invOpen && !craftOpen && !chestOpen && !furnaceOpen ? (
        <MobileControls
          onMove={(x, y) => {
            touchMoveRef.current = { x, y };
          }}
          onJump={() => {
            touchJumpRef.current = true;
          }}
          onPlace={() => {
            touchPlaceRef.current = true;
          }}
          onOpenCrafting={interact}
          onOpenInventory={openInventory}
          showCrafting={aimTable}
        />
      ) : null}

      {portrait ? (
        <div className="rotate-notice" role="alert">
          <span className="rotate-glyph" aria-hidden="true" />
          Rotate your device to landscape to play
        </div>
      ) : null}
    </main>
  );
}
