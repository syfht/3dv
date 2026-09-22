import * as THREE from "three";

// Plays the animation clips that ship inside the character GLB. Nothing here
// is hand-authored: every pose comes from a named clip in the model.
//
// Locomotion clips loop (Battle_Idle / Walk / Back_Walk / Run) and one-shot clips
// (attacks, damage reactions, death) play once on top, fading the locomotion
// layer out and back in around them.

export const CLIPS = {
  idle: "Battle_Idle",
  walk: "Walk",
  backWalk: "Back_Walk",
  run: "Run",
  skill: "Skill_06",
  combo1: "Combo_01",
  combo2: "Combo_02",
  combo3: "Combo_03",
  combo31: "Combo_03_1",
  guardCounter: "Guard_Counter",
  guard: "Guard",
  jump: "Combo_04",
  roll: "Roll",
  damageA: "Damage_A",
  damageC: "Damage_C",
  dead: "Dead_A",
} as const;

export type LocomotionClip = typeof CLIPS.idle | typeof CLIPS.walk | typeof CLIPS.backWalk | typeof CLIPS.run;

export function randomDamageClip() {
  return Math.random() < 0.5 ? CLIPS.damageA : CLIPS.damageC;
}

export type PlayOptions = {
  /** Higher priority one-shots interrupt lower ones; equal priority restarts. */
  priority?: number;
  fade?: number;
  /** Hold the last frame instead of returning to locomotion (death). */
  hold?: boolean;
  timeScale?: number;
};

export type CharacterAnimator = ReturnType<typeof createCharacterAnimator>;

export function createCharacterAnimator(root: THREE.Object3D, clips: THREE.AnimationClip[]) {
  const mixer = new THREE.AnimationMixer(root);
  const byName = new Map<string, THREE.AnimationClip>();
  for (const clip of clips) byName.set(clip.name, clip);
  const actions = new Map<string, THREE.AnimationAction>();

  const actionFor = (name: string) => {
    const existing = actions.get(name);
    if (existing) return existing;
    const clip = byName.get(name);
    if (!clip) return null;
    const action = mixer.clipAction(clip);
    actions.set(name, action);
    return action;
  };

  let locomotionName: LocomotionClip = CLIPS.idle;
  let locomotion: THREE.AnimationAction | null = null;
  let oneShot: THREE.AnimationAction | null = null;
  let oneShotName: string | null = null;
  let oneShotPriority = 0;
  let oneShotHold = false;

  const startLocomotion = (fade: number) => {
    const next = actionFor(locomotionName);
    if (!next) return;
    next.enabled = true;
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.setEffectiveTimeScale(1);
    if (locomotion === next) {
      next.paused = false;
      next.fadeIn(fade).play();
      return;
    }
    next.reset().setEffectiveWeight(1).fadeIn(fade).play();
    locomotion?.fadeOut(fade);
    locomotion = next;
  };

  const duration = (name: string) => byName.get(name)?.duration ?? 0;

  /** Switch the looping base layer. Ignored while a one-shot is holding. */
  const setLocomotion = (name: LocomotionClip, fade = 0.22) => {
    if (locomotionName === name && locomotion) return;
    locomotionName = name;
    if (oneShot) return; // applied when the one-shot finishes
    startLocomotion(fade);
  };

  const endOneShot = (fade: number) => {
    if (!oneShot) return;
    oneShot.fadeOut(fade);
    oneShot = null;
    oneShotName = null;
    oneShotPriority = 0;
    oneShotHold = false;
    startLocomotion(fade);
  };

  const onFinished = (event: { action: THREE.AnimationAction }) => {
    if (event.action !== oneShot) return;
    if (oneShotHold) return; // death pose stays until release()
    endOneShot(0.2);
  };
  mixer.addEventListener("finished", onFinished as never);

  /**
   * Play a one-shot clip once. Returns its duration in seconds (0 when the
   * clip is missing or a higher-priority one-shot is already running).
   */
  const play = (name: string, options: PlayOptions = {}) => {
    const { priority = 1, fade = 0.12, hold = false, timeScale = 1 } = options;
    if (oneShot && priority < oneShotPriority) return 0;
    const action = actionFor(name);
    if (!action) return 0;
    if (oneShot && oneShot !== action) oneShot.fadeOut(fade);
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.setEffectiveTimeScale(timeScale);
    action.setEffectiveWeight(1);
    action.fadeIn(fade).play();
    locomotion?.fadeOut(fade);
    oneShot = action;
    oneShotName = name;
    oneShotPriority = priority;
    oneShotHold = hold;
    return duration(name) / Math.max(timeScale, 0.001);
  };

  /** Drop a held one-shot (death) and blend back to locomotion. */
  const release = (fade = 0.25, name?: string) => {
    if (name && oneShotName !== name) return;
    endOneShot(fade);
  };

  const update = (delta: number) => {
    if (!locomotion && !oneShot) startLocomotion(0);
    mixer.update(delta);
  };

  const dispose = () => {
    mixer.removeEventListener("finished", onFinished as never);
    mixer.stopAllAction();
    mixer.uncacheRoot(root);
  };

  return {
    play,
    release,
    setLocomotion,
    update,
    duration,
    dispose,
    has: (name: string) => byName.has(name),
    get currentOneShot() {
      return oneShotName;
    },
    get busy() {
      return oneShot !== null;
    },
  };
}
