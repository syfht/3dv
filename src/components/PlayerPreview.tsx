import { useEffect, useRef } from "react";
import * as THREE from "three";
import { MODEL_URL, createModelLoader } from "@/assets/model";

// Small slowly-rotating render of the player character for menu panels.
export default function PlayerPreview() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 20);
    camera.position.set(0.4, 1.15, 2.7);
    camera.lookAt(0, 0.85, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    host.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xd8eff2, 0x526344, 2.4));
    const key = new THREE.DirectionalLight(0xfff2d2, 3.2);
    key.position.set(2, 3.5, 2.5);
    scene.add(key);

    let model: THREE.Object3D | undefined;
    let disposed = false;
    createModelLoader().load(MODEL_URL, (gltf) => {
      if (disposed) return;
      host.dataset["loaded"] = "true";
      model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const scale = 1.72 / Math.max(size.y, 0.001);
      model.scale.setScalar(scale);
      model.updateMatrixWorld(true);
      const fitted = new THREE.Box3().setFromObject(model);
      model.position.y = -fitted.min.y;
      model.rotation.y = 0.5;
      scene.add(model);
    });

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (model) model.rotation.y += 0.01;
      renderer.render(scene, camera);
    };
    tick();

    const onResize = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (!width || !height) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    window.addEventListener("resize", onResize);
    onResize();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={hostRef} className="player-preview" role="img" aria-label="Player character" />;
}
