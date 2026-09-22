// Mock of the EaglerForgeInjector ModAPI surface, enough to run both mods in
// Node and watch what they actually do. Not a substitute for the real client,
// but it catches logic errors, NaNs and dead code paths.
"use strict";

const chatLog = [];
const events = {};
const serverCode = [];
const calls = {
  tryMoveToXYZ: [], setAttackTarget: [], setLook: [], breakDoors: 0,
  spawned: [], impacts: [], setFire: [], fx: [], setBlock: [],
  damage: [], armourWear: [], chat: [],
};

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

// --- named blocks, so a mod can ask what a block actually is ---
// Every block and every default state is a singleton, which is what lets
// setBlockState() below tell "put the original back" apart from "change it".
const NON_SOLID = new Set([
  "air", "lava", "tallgrass", "deadbush", "yellow_flower", "red_flower",
  "double_plant", "wheat", "carrots", "potatoes", "beetroots", "melon_stem",
  "pumpkin_stem", "reeds", "vine", "waterlily", "snow_layer", "web",
]);

const blockDefs = {};
const stateDefs = {};

function blockFor(name) {
  if (!blockDefs[name]) {
    blockDefs[name] = {
      __block: name,
      getDefaultState: () => stateFor(name),
      getRef() { return this; },
    };
  }
  return blockDefs[name];
}

function stateFor(name) {
  if (!stateDefs[name]) {
    stateDefs[name] = {
      __state: name,
      getMaterial: () => ({ isSolid: () => (NON_SOLID.has(name) ? 0 : 1) }),
      getBlock: () => blockFor(name),
      getRef() { return this; },
    };
  }
  return stateDefs[name];
}

const BLOCK_NAMES = [
  "air", "lava", "grass", "dirt", "mycelium", "farmland", "grass_path",
  "stone", "stonebrick", "mossy_cobblestone", "cobblestone", "gravel", "sand",
  "sandstone", "red_sandstone", "clay", "snow", "snow_layer", "ice", "leaves",
  "leaves2", "tallgrass", "deadbush", "yellow_flower", "red_flower",
  "double_plant", "wheat", "carrots", "potatoes", "beetroots", "melon_stem",
  "pumpkin_stem", "reeds", "vine", "waterlily", "cactus", "web",
];
const namedBlocks = {};
BLOCK_NAMES.forEach((n) => { namedBlocks[n.toUpperCase()] = blockFor(n); });

const lavaBlock = blockFor("lava");
const lavaState = stateFor("lava");

// vanilla terrain: stone under a layer of grass at y=63, plus the ceiling slab
function kindAt(x, y, z) {
  if (y === 80 && x > -40 && x < 40 && z > -40 && z < 40) return "stone";
  if (y === 63) return "grass";
  if (y < 63) return "stone";
  return "air";
}

// blocks a mod has changed, keyed "x,y,z"; anything not in here is vanilla
const blockOverrides = new Map();
const bkey = (x, y, z) => x + "," + y + "," + z;

function blockState(p) {
  return blockOverrides.get(bkey(p.x, p.y, p.z)) || stateFor(kindAt(p.x, p.y, p.z));
}

const classes = {
  "net.minecraft.util.math.BlockPos": { constructors: [(x, y, z) => ({ x, y, z })] },
  "net.minecraft.entity.monster.EntityZombie": { instanceOf: (o) => !!(o && o.__zombie) },
  "net.minecraft.entity.monster.AbstractSkeleton": { instanceOf: (o) => !!(o && o.__skeleton) },
  "net.minecraft.entity.projectile.EntitySmallFireball": {
    constructors: [(world, shooter, ax, ay, az) => makeFireball(world, shooter, ax, ay, az)],
  },
  "net.minecraft.util.text.TextComponentString": { constructors: [(s) => ({ __text: s })] },
  "net.minecraft.util.DamageSource": {
    staticVariables: { MAGIC: { __src: "magic", getRef() { return this; } } },
    constructors: [(name) => ({ __src: name.__jstr, getRef() { return this; } })],
  },
};

// A worn armour piece: the acid eats its durability, and a piece that runs
// out of durability is gone, the way vanilla breaks one.
function makeStack(name) {
  return {
    __stack: name, damage: 0, maxDamage: 100, stackSize: 1,
    isEmpty() { return this.stackSize <= 0 ? 1 : 0; },
    damageItem(n) {
      this.damage += n;
      calls.armourWear.push({ name: name, n: n, total: this.damage });
      if (this.damage >= this.maxDamage) this.stackSize = 0;
    },
    getRef() { return this; },
  };
}

const armourSlots = [];
const armourInventory = {
  size: () => armourSlots.length,
  get: (i) => armourSlots[i],
};

function setArmour(pieces) {
  armourSlots.length = 0;
  for (let i = 0; i < pieces; i++) armourSlots.push(makeStack("plate" + i));
  return armourSlots;
}

const player = {
  health: 20,
  inventory: { armorInventory: armourInventory },
  attackEntityFrom(src, amount) {
    calls.damage.push({ id: 1, amount: amount, src: src && src.__src });
    this.health -= amount;
    if (this.health <= 0) this.isDead = 1;
    return 1;
  },
  setHealth(h) { this.health = h; },
  isInWater() { return this.inWater ? 1 : 0; },
  sendMessage(comp) { calls.chat.push((comp && comp.__text && comp.__text.__jstr) || String(comp)); },
  posX: 0, posY: 64, posZ: 0,
  motionX: 0, motionY: 0, motionZ: 0,
  prevPosX: 0, prevPosZ: 0,
  rotationYaw: 0, rotationPitch: -20,
  onGround: 1, fallDistance: 0, isCollidedHorizontally: 0, isDead: 0,
  hurtTime: 0,
  getEyeHeight: () => 1.62,
  setFire(seconds) { calls.setFire.push({ id: 1, seconds: seconds }); this.fire = seconds; },
  isImmuneToFire: () => 0,
  setPosition(x, y, z) { this.posX = x; this.posY = y; this.posZ = z; },
  isSpectator: () => 0,
  getHealth() { return this.health; },
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

function makeSkeleton(id, x, z, target, y) {
  return {
    __skeleton: true,
    posX: x, posY: y === undefined ? 64 : y, posZ: z,
    motionX: 0, motionY: 0, motionZ: 0,
    rotationYaw: 0, onGround: 1, isDead: 0, hurtTime: 0, fire: 0,
    _target: target || null,
    health: 20,
    getEntityId: () => id,
    getEyeHeight: () => 1.62,
    getHealth() { return this.health; },
    setHealth(h) { this.health = h; },
    attackEntityFrom(src, amount) {
      calls.damage.push({ id: id, amount: amount, src: src && src.__src });
      this.health -= amount;
      if (this.health <= 0) this.isDead = 1;
      return 1;
    },
    isInWater() { return this.inWater ? 1 : 0; },
    getAttackTarget() { return this._target; },
    setAttackTarget(t) { this._target = t; },
    getNavigator() { return { tryMoveToXYZ: () => 1, clearPath() {} }; },
    getLookHelper() {
      return { setLookPosition: (lx, ly, lz) => calls.setLook.push({ id, lx, ly, lz }) };
    },
    getEntitySenses() { return { canSee: () => 1 }; },
    isBurning() { return this.fire > 0; },
    setFire(seconds) { calls.setFire.push({ id: id, seconds: seconds }); this.fire = seconds; },
    extinguish() { this.fire = 0; },
    isImmuneToFire: () => 0,
    getCorrective() { return this; },
    getRef() { return this; },
  };
}

// A stand-in for EntitySmallFireball with the acceleration fields the mod
// rewrites. stepProjectiles() below integrates it exactly the way
// EntityFireball.onUpdate does, so the aiming code is tested against the real
// flight model rather than against a guess.
const projectiles = [];
let fireballIds = 900;

function makeFireball(world, shooter, ax, ay, az) {
  const id = fireballIds++;
  return {
    __fireball: true,
    posX: shooter ? shooter.posX : 0,
    posY: shooter ? shooter.posY : 0,
    posZ: shooter ? shooter.posZ : 0,
    motionX: 0, motionY: 0, motionZ: 0,
    accelerationX: ax, accelerationY: ay, accelerationZ: az,
    isDead: 0, age: 0, shooter: shooter,
    getEntityId: () => id,
    setPosition(x, y, z) { this.posX = x; this.posY = y; this.posZ = z; },
    getCorrective() { return this; },
    getRef() { return this; },
  };
}

// pos += motion; motion = (motion + acceleration) * 0.95, with the move swept
// in sub-steps so a fast glob can't tunnel through a wall or a player — that's
// what vanilla's forwards raycast does for it.
function hitAt(f, x, y, z) {
  if (solid(Math.floor(x), Math.floor(y), Math.floor(z))) return true;
  for (const e of hitboxes) {
    if (e === f.shooter || e.isDead) continue;
    const dx = x - e.posX, dz = z - e.posZ;
    if (dx * dx + dz * dz < 0.36 && y > e.posY && y < e.posY + 1.9) return true;
  }
  return false;
}

function stepProjectiles() {
  for (const f of projectiles) {
    if (f.isDead) continue;
    f.age++;
    const x0 = f.posX, y0 = f.posY, z0 = f.posZ;
    const steps = Math.max(1, Math.ceil(Math.hypot(f.motionX, f.motionY, f.motionZ) / 0.2));
    let hit = false;
    for (let i = 1; i <= steps && !hit; i++) {
      f.posX = x0 + (f.motionX * i) / steps;
      f.posY = y0 + (f.motionY * i) / steps;
      f.posZ = z0 + (f.motionZ * i) / steps;
      hit = hitAt(f, f.posX, f.posY, f.posZ);
    }
    f.motionX = (f.motionX + f.accelerationX) * 0.95;
    f.motionY = (f.motionY + f.accelerationY) * 0.95;
    f.motionZ = (f.motionZ + f.accelerationZ) * 0.95;

    if (hit || f.age > 200) {
      f.isDead = 1;
      calls.impacts.push({ x: f.posX, y: f.posY, z: f.posZ, age: f.age });
    }
  }
}

// entities a glob can collide with; the skeleton suite fills this in
const hitboxes = [];

function javaList(arr) {
  return { size: () => arr.length, get: (i) => arr[i] };
}

const zombies = [
  makeZombie(10, 12, 0, player),   // closest -> charger
  makeZombie(11, 18, 3, player),
  makeZombie(12, 20, -6, player),
  makeZombie(13, 24, 8, null),     // no target -> should be recruited
];

// --- weather, which the acid rain mod both reads and sets ---
const weather = { raining: false, thundering: false };
const worldInfo = {
  isRaining: () => (weather.raining ? 1 : 0),
  isThundering: () => (weather.thundering ? 1 : 0),
  setRaining(v) { weather.raining = !!v; },
  setThundering(v) { weather.thundering = !!v; },
  setRainTime() {},
  setThunderTime() {},
  getRef() { return this; },
};

const world = {
  playerEntities: javaList([player]),
  loadedEntityList: javaList([player].concat(zombies)),
  getBlockState: (p) => blockState(p),
  isAirBlock: (p) => (blockState(p).__state === "air" ? 1 : 0),
  setBlockState(p, state, flags) {
    calls.setBlock.push({ x: p.x, y: p.y, z: p.z, state: state && state.__state, flags: flags });
    // Putting back exactly what vanilla generates there is not an override,
    // so a mod that cleans up after itself leaves blockOverrides empty.
    if (state === stateFor(kindAt(p.x, p.y, p.z))) blockOverrides.delete(bkey(p.x, p.y, p.z));
    else blockOverrides.set(bkey(p.x, p.y, p.z), state);
    return 1;
  },
  playEvent(playerIn, id, p, data) { calls.fx.push({ id: id, x: p.x, y: p.y, z: p.z, data: data }); },
  getGameRules: () => ({ getBoolean: () => 1 }),
  spawnEntity(e) {
    // snapshot the launch, since the entity itself keeps moving afterwards
    calls.spawned.push({
      e: e,
      shooter: e.shooter ? e.shooter.getEntityId() : -1,
      x: e.posX, y: e.posY, z: e.posZ,
      mx: e.motionX, my: e.motionY, mz: e.motionZ,
      ax: e.accelerationX, ay: e.accelerationY, az: e.accelerationZ,
    });
    projectiles.push(e);
    return 1;
  },
  // under the slab you're shaded; step outside its footprint and you're in the sun
  canSeeSky: (p) => (p.y < 80 && p.x > -40 && p.x < 40 && p.z > -40 && p.z < 40 ? 0 : 1),
  isDaytime: () => 1,
  isRaining: () => (weather.raining ? 1 : 0),
  isThundering: () => (weather.thundering ? 1 : 0),
  // vanilla's own test: rain only lands where the sky does
  isRainingAt(p) { return weather.raining && this.canSeeSky(p) ? 1 : 0; },
  getWorldInfo: () => worldInfo,
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
  blocks: namedBlocks,
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
const domElements = [];
global.document = {
  createElement() {
    const el = { style: {}, textContent: "", appendChild() {} };
    domElements.push(el);
    return el;
  },
  documentElement: { appendChild() {} },
};
global.ModAPI = global.PluginAPI = ModAPI;

function key(code, repeat) {
  (domListeners.keydown || []).forEach((f) =>
    f({ code: code, repeat: !!repeat, preventDefault() {}, stopPropagation() {} })
  );
}

module.exports = {
  ModAPI, fire, key, chatLog, serverCode, calls, player, zombies, world, events, javaList,
  makeZombie, makeSkeleton, stepProjectiles, projectiles, hitboxes, blockOverrides, lavaState,
  weather, worldInfo, setArmour, armourSlots, stateFor, blockFor, kindAt, domElements,
};
