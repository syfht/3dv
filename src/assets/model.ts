import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import modelAsset from "./mai_shiranui_kof_xv.glb.asset.json";

// The character model is stored as a large asset (too big for the repo) and
// served from its asset URL. It is the original, uncompressed GLB.
export const MODEL_URL = modelAsset.url;

export function createModelLoader() {
  return new GLTFLoader();
}
