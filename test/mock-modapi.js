// Mock of the EaglerForgeInjector ModAPI surface, enough to run both mods in
// Node and watch what they actually do. Not a substitute for the real client,
// but it catches logic errors, NaNs and dead code paths.
"use strict";

const chatLog = [];
const events = {};
const serverCode = [];
const calls = { tryMoveToXYZ: [], setAttackTarget: [], setLook: [], breakDoors: 0 };

function fire(name, data) {
  (events[name] || []).forEach((f) => f(data || {}));
  return data;
}

// --- fake world: ground below y=64, a ceiling slab at y=80 ---
function solid(x, y, z) {
  if (y < 64) return true;
  if (y === 80 && x > -40 && x < 40 && z > -40 && z < 40) return true;
  return false;
}

function blockState(p) {
  const s = solid(p.x, p.y, p.z);
  return { getMaterial: () => ({ isSolid: () => (s ? 1 : 0) }) };
}

const classes = {
  "net.minecraft.util.math.BlockPos": { constructors: [(x, y, z) => ({ x, y, z })] },
  "net.minecraft.entity.monster.EntityZombie": { instanceOf: (o) => !!(o && o.__zombie) },
  "net.minecraft.util.text.TextComponentString": { constructors: [(s) => ({ __text: s })] },
};

const player = {
  posX: 0, posY: 64, posZ: 0,
  motionX: 0, motionY: 0, motionZ: 0,
  prevPosX: 0, prevPosZ: 0,
  rotationYaw: 0, rotationPitch: -20,
  onGround: 1, fallDistance: 0, isCollidedHorizontally: 0, isDead: 0,
  hurtTime: 0,
  getEyeHeight: () => 1.62,
  setPosition(x, y, z) { this.posX = x; this.posY = y; this.posZ = z; },
  isSpectator: () => 0,
  getHealth: () => 20,
  getEntityId: () => 1,
  getCorrective() { return this; },
  getRef() { return this; },
};

function makeZombie(id, x, z, target) {
  const z0 = {
    __zombie: true,
    posX: x, posY: 64, posZ: z,
    motionX: 0, motionY: 0, motionZ: 0,
    rotationYaw: 0, onGround: 1, isDead: 0, hurtTime: 0,
    _target: target || null,
    getEntityId: () => id,
    getAttackTarget() { return this._target; },
    setAttackTarget(t) { this._target = t; calls.setAttackTarget.push(id); },
    getNavigator() {
      return {
        tryMoveToXYZ: (gx, gy, gz, speed) => {
          calls.tryMoveToXYZ.push({ id, gx, gy, gz, speed });
          return 1;
        },
      };
    },
    getLookHelper() {
      return { setLookPosition: (lx, ly, lz) => calls.setLook.push({ id, lx, ly, lz }) };
    },
    getEntitySenses() { return { canSee: () => 1 }; },
    isBurning: () => 0,
    setBreakDoorsAItask() { calls.breakDoors++; },
    getCorrective() { return this; },
    getRef() { return this; },
  };
  return z0;
}

function javaList(arr) {
  return { size: () => arr.length, get: (i) => arr[i] };
}

const zombies = [
  makeZombie(10, 12, 0, player),   // closest -> charger
  makeZombie(11, 18, 3, player),
  makeZombie(12, 20, -6, player),
  makeZombie(13, 24, 8, null),     // no target -> should be recruited
];

const world = {
  playerEntities: javaList([player]),
  loadedEntityList: javaList([player].concat(zombies)),
  getBlockState: (p) => blockState(p),
  // under the slab you're shaded; step outside its footprint and you're in the sun
  canSeeSky: (p) => (p.y < 80 && p.x > -40 && p.x < 40 && p.z > -40 && p.z < 40 ? 0 : 1),
  isDaytime: () => 1,
  getCorrective() { return this; },
  getRef() { return this; },
};

const ModAPI = {
  version: "mock-1.0",
  is_1_12: true,
  isServer: false,
  meta: { title() {}, version() {}, description() {}, credits() {}, icon() {}, config() {} },
  require() {},
  addEventListener(name, fn) { (events[name] = events[name] || []).push(fn); },
  removeEventListener() {},
  displayToChat(m) { chatLog.push(String((m && m.msg) || m)); },
  reflect: { getClassById: (id) => classes[id] },
  util: {
    str: (s) => ({ __jstr: s }),
    unstr: (s) => (s && s.__jstr) || "",
    getNearestProperty(obj, prop) {
      if (!obj) return null;
      if (Object.keys(obj).includes(prop)) return prop;
      return Object.keys(obj).filter((k) => k.startsWith(prop)).sort((a, b) => a.length - b.length)[0] || prop;
    },
    wrap: (o) => o,
  },
  dedicatedServer: { appendCode(fn) { serverCode.push(fn); } },
  settings: { keyBindJump: { pressed: 0 }, keyBindSneak: { pressed: 0 }, keyBindForward: { pressed: 0 } },
  mc: { currentScreen: null, getCorrective() { return this; } },
  player: player,
  world: world,
  server: { getRef: () => ({ $worlds: { data: [world] } }) },
};

// --- minimal DOM ---
const domListeners = {};
global.window = {
  addEventListener(t, f) { (domListeners[t] = domListeners[t] || []).push(f); },
};
global.document = {
  createElement: () => ({ style: {}, textContent: "", appendChild() {} }),
  documentElement: { appendChild() {} },
};
global.ModAPI = global.PluginAPI = ModAPI;

function key(code, repeat) {
  (domListeners.keydown || []).forEach((f) =>
    f({ code: code, repeat: !!repeat, preventDefault() {}, stopPropagation() {} })
  );
}

module.exports = { ModAPI, fire, key, chatLog, serverCode, calls, player, zombies, world, events, javaList, makeZombie };
