import type { BlockType } from "./voxelWorld";
import { BLOCK_TYPES } from "./voxelWorld";

export type ToolKind = "sword" | "pickaxe" | "axe" | "shovel" | "hoe";
export type ToolMaterial = "wooden" | "stone";
export type ToolType = `${ToolMaterial}_${ToolKind}`;

export type ItemType = BlockType | "stick" | "coal" | ToolType;

export type Slot = { type: ItemType; count: number } | null;

export const HOTBAR_SIZE = 9;
export const INVENTORY_SIZE = 36; // 4 rows x 9 columns (row 0 is the hotbar)
export const STACK_LIMIT = 64;

const PLACEABLE = new Set<string>(BLOCK_TYPES);
export const isPlaceable = (type: ItemType): type is BlockType => PLACEABLE.has(type);

// Tools never stack in Minecraft.
export const maxStack = (type: ItemType) => (isPlaceable(type) || type === "stick" || type === "coal" ? STACK_LIMIT : 1);

export const BLOCK_LABEL: Record<ItemType, string> = {
  grass: "Grass Block",
  stone: "Cobblestone",
  wood: "Wood Log",
  leaves: "Leaves",
  planks: "Planks",
  crafting_table: "Crafting Table",
  chest: "Chest",
  furnace: "Furnace",
  ladder: "Ladder",
  wooden_staircase: "Wooden Staircase",
  wooden_staircase_n: "Wooden Staircase",
  wooden_staircase_s: "Wooden Staircase",
  wooden_staircase_e: "Wooden Staircase",
  wooden_staircase_w: "Wooden Staircase",
  slab: "Wooden Slab",
  coal_ore: "Coal Ore",
  torch: "Torch",
  stick: "Stick",
  coal: "Coal",
  wooden_sword: "Wooden Sword",
  wooden_pickaxe: "Wooden Pickaxe",
  wooden_axe: "Wooden Axe",
  wooden_shovel: "Wooden Shovel",
  wooden_hoe: "Wooden Hoe",
  stone_sword: "Stone Sword",
  stone_pickaxe: "Stone Pickaxe",
  stone_axe: "Stone Axe",
  stone_shovel: "Stone Shovel",
  stone_hoe: "Stone Hoe",
};

// Seconds of continuous mining needed to break each block (bare hands).
export const BREAK_TIMES: Record<BlockType, number> = {
  grass: 0.95,
  stone: 7.5,
  wood: 3.6,
  leaves: 0.3,
  planks: 1.2,
  crafting_table: 1.4,
  chest: 1.6,
  furnace: 6.5,
  ladder: 0.4,
  wooden_staircase: 1.2,
  wooden_staircase_n: 1.2,
  wooden_staircase_s: 1.2,
  wooden_staircase_e: 1.2,
  wooden_staircase_w: 1.2,
  slab: 0.8,
  coal_ore: 7.5,
  torch: 0.2,
};

// Which tool speeds up which block, and by how much.
const TOOL_TARGETS: Record<ToolKind, BlockType[]> = {
  pickaxe: ["stone", "coal_ore", "furnace"],
  axe: ["wood", "planks", "crafting_table", "chest", "ladder", "wooden_staircase", "wooden_staircase_n", "wooden_staircase_s", "wooden_staircase_e", "wooden_staircase_w", "slab"],
  shovel: ["grass"],
  sword: ["leaves"],
  hoe: [],
};

const MATERIAL_SPEED: Record<ToolMaterial, number> = { wooden: 2, stone: 4 };

export function miningSpeed(held: ItemType | null, block: BlockType) {
  if (!held || isPlaceable(held) || held === "stick") return 1;
  const [material, kind] = held.split("_") as [ToolMaterial, ToolKind];
  return TOOL_TARGETS[kind].includes(block) ? MATERIAL_SPEED[material] : 1;
}

// --- crafting ---------------------------------------------------------------
// Patterns use: '#' tool material (planks or cobblestone), 'S' stick,
// 'P' planks, ' ' empty.

type Recipe = {
  rows: string[];
  result: (material: ToolMaterial) => { type: ItemType; count: number };
};

const toolRecipes: Recipe[] = [
  { rows: ["#", "#", "S"], result: (m) => ({ type: `${m}_sword`, count: 1 }) },
  { rows: ["###", " S ", " S "], result: (m) => ({ type: `${m}_pickaxe`, count: 1 }) },
  { rows: ["##", "#S", " S"], result: (m) => ({ type: `${m}_axe`, count: 1 }) },
  { rows: ["##", "S#", "S "], result: (m) => ({ type: `${m}_axe`, count: 1 }) },
  { rows: ["#", "S", "S"], result: (m) => ({ type: `${m}_shovel`, count: 1 }) },
  { rows: ["##", " S", " S"], result: (m) => ({ type: `${m}_hoe`, count: 1 }) },
  { rows: ["##", "S ", "S "], result: (m) => ({ type: `${m}_hoe`, count: 1 }) },
];

const plainRecipes: Array<{ rows: string[]; result: { type: ItemType; count: number } }> = [
  { rows: ["P", "P"], result: { type: "stick", count: 4 } },
  { rows: ["PP", "PP"], result: { type: "crafting_table", count: 1 } },
  { rows: ["PPP", "P P", "PPP"], result: { type: "chest", count: 1 } },
  // 8 cobblestone in a ring -> furnace
  { rows: ["CCC", "C C", "CCC"], result: { type: "furnace", count: 1 } },
  // 7 sticks -> 3 ladders
  { rows: ["S S", "SSS", "S S"], result: { type: "ladder", count: 3 } },
  // Six planks in steps -> four wooden staircases.
  { rows: ["P  ", "PP ", "PPP"], result: { type: "wooden_staircase", count: 4 } },
  // Three planks in a row -> six wooden slabs.
  { rows: ["PPP"], result: { type: "slab", count: 6 } },
  // Smelted coal above a stick -> four torches.
  { rows: ["O", "S"], result: { type: "torch", count: 4 } },
];

// Trim empty rows/columns so a recipe can sit anywhere in the grid.
function trimmed(grid: Slot[]) {
  const size = grid.length === 9 ? 3 : 2;
  const cell = (r: number, c: number) => grid[r * size + c] ?? null;
  let top = size;
  let bottom = -1;
  let left = size;
  let right = -1;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (!cell(r, c)) continue;
      top = Math.min(top, r);
      bottom = Math.max(bottom, r);
      left = Math.min(left, c);
      right = Math.max(right, c);
    }
  }
  if (bottom < 0) return null;
  const rows: Array<Array<Slot>> = [];
  for (let r = top; r <= bottom; r += 1) {
    const row: Slot[] = [];
    for (let c = left; c <= right; c += 1) row.push(cell(r, c));
    rows.push(row);
  }
  return rows;
}

function matches(rows: Array<Array<Slot>>, pattern: string[], material: ItemType) {
  if (rows.length !== pattern.length) return false;
  for (let r = 0; r < rows.length; r += 1) {
    const line = pattern[r]!;
    const row = rows[r]!;
    if (row.length !== line.length) return false;
    for (let c = 0; c < row.length; c += 1) {
      const slot = row[c] ?? null;
      const symbol = line[c];
      const want =
        symbol === " "
          ? null
          : symbol === "S"
            ? "stick"
            : symbol === "P"
              ? "planks"
              : symbol === "C"
                ? "stone"
              : symbol === "O"
                ? "coal"
                : material;
      if (want === null) {
        if (slot) return false;
      } else if (!slot || slot.type !== want) {
        return false;
      }
    }
  }
  return true;
}

export function craftResult(grid: Slot[]): Slot {
  const filled = grid.filter((slot): slot is NonNullable<Slot> => Boolean(slot));
  if (filled.length === 0) return null;
  // Shapeless: 1 log -> 4 planks.
  if (filled.length === 1 && filled[0]!.type === "wood") return { type: "planks", count: 4 };

  const rows = trimmed(grid);
  if (!rows) return null;

  for (const recipe of plainRecipes) {
    if (matches(rows, recipe.rows, "planks")) return { ...recipe.result };
  }
  for (const recipe of toolRecipes) {
    for (const material of ["wooden", "stone"] as ToolMaterial[]) {
      const blockType: ItemType = material === "wooden" ? "planks" : "stone";
      if (matches(rows, recipe.rows, blockType)) return recipe.result(material);
    }
  }
  return null;
}
