// Deterministic terrain generation shared by the browser (rendering, local
// physics) and the game server (gravity for players whose tab is asleep).
// It must stay free of browser/three.js imports so Node can load it directly.

export const WORLD_RADIUS = 40; // blocks from centre on X/Z
export const MAX_HEIGHT = 10;
export const SCAN_HEIGHT = MAX_HEIGHT + 26; // terrain + tallest tree

export type TerrainBlock = "grass" | "stone" | "wood" | "leaves";

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function hash2(x: number, z: number) {
  const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

export function smoothNoise(x: number, z: number) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const ux = xf * xf * (3 - 2 * xf);
  const uz = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi);
  const b = hash2(xi + 1, zi);
  const c = hash2(xi, zi + 1);
  const d = hash2(xi + 1, zi + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uz);
}

export function columnHeight(x: number, z: number, seed = 0) {
  const ox = seed * 123.456;
  const oz = seed * 789.012;
  const base = smoothNoise((x + ox) * 0.055, (z + oz) * 0.055) * 1.0;
  const mid = smoothNoise((x + ox) * 0.13, (z + oz) * 0.13) * 0.45;
  const fine = smoothNoise((x + ox) * 0.31, (z + oz) * 0.31) * 0.2;
  const ridge = Math.hypot(x, z) > 44 ? (Math.hypot(x, z) - 44) * 0.16 : 0;
  const h = 3 + (base + mid + fine) * 4.2 + ridge;
  return clamp(Math.round(h), 1, MAX_HEIGHT + 6);
}

export const blockKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** Every naturally generated solid block for a seed, keyed by "x,y,z". */
export function generateTerrain(seed: number): Map<string, TerrainBlock> {
  const solid = new Map<string, TerrainBlock>();
  const seedNoise = (x: number, z: number) => hash2(x + seed * 31.7, z - seed * 17.3);

  for (let x = -WORLD_RADIUS; x <= WORLD_RADIUS; x += 1) {
    for (let z = -WORLD_RADIUS; z <= WORLD_RADIUS; z += 1) {
      const top = columnHeight(x, z, seed);
      // Grass/dirt skin is 4-5 blocks deep; everything under it is stone.
      const soil = seedNoise(x * 4.4 + 2.1, z * 6.8 + 9.7) > 0.5 ? 5 : 4;
      for (let y = 0; y < top; y += 1) {
        solid.set(blockKey(x, y, z), y >= top - soil ? "grass" : "stone");
      }
    }
  }

  // --- trees ---------------------------------------------------------------
  const trees: Array<[number, number]> = [];
  for (let x = -WORLD_RADIUS + 3; x <= WORLD_RADIUS - 3; x += 1) {
    for (let z = -WORLD_RADIUS + 3; z <= WORLD_RADIUS - 3; z += 1) {
      if (seedNoise(x * 1.7 + 11.3, z * 2.3 + 7.1) < 0.978) continue;
      if (Math.hypot(x, z) < 5) continue; // keep the spawn area clear
      if (trees.some(([tx, tz]) => Math.abs(tx - x) < 5 && Math.abs(tz - z) < 5)) continue;
      trees.push([x, z]);
      const base = columnHeight(x, z, seed);
      const trunk = 4 + Math.floor(seedNoise(x * 3.1, z * 5.7) * 3);
      for (let y = base; y < base + trunk; y += 1) solid.set(blockKey(x, y, z), "wood");
      const crown = base + trunk;
      // leaf canopy: two wide layers, then a tapered cap
      for (let dy = -2; dy <= 1; dy += 1) {
        const radius = dy <= -1 ? 2 : dy === 0 ? 2 : 1;
        for (let dx = -radius; dx <= radius; dx += 1) {
          for (let dz = -radius; dz <= radius; dz += 1) {
            if (Math.abs(dx) === radius && Math.abs(dz) === radius && radius > 1) continue;
            const ly = crown + dy;
            const lx = x + dx;
            const lz = z + dz;
            if (solid.get(blockKey(lx, ly, lz)) === "wood") continue;
            if (solid.has(blockKey(lx, ly, lz))) continue;
            solid.set(blockKey(lx, ly, lz), "leaves");
          }
        }
      }
      solid.set(blockKey(x, crown + 2, z), "leaves");
    }
  }
  return solid;
}

/** Highest solid top at or below `fromY` for any block map. */
export function groundHeightIn(
  solid: Map<string, unknown>,
  x: number,
  z: number,
  fromY = SCAN_HEIGHT,
) {
  const bx = Math.floor(x);
  const bz = Math.floor(z);
  for (let y = Math.min(SCAN_HEIGHT, Math.ceil(fromY)); y >= 0; y -= 1) {
    if (solid.has(blockKey(bx, y, bz))) return y + 1;
  }
  return 0;
}
