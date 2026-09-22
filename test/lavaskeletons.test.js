"use strict";
const h = require("./mock-modapi.js");

// Fixed "randomness": jitter cancels out at 0.5, so the aim we measure is the
// solver's own accuracy and not a lucky roll.
Math.random = () => 0.5;

require("../lavaskeletons.js");

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS  " : "FAIL  ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
  if (!cond) fails++;
}

check("queued server code", h.serverCode.length === 1);
h.serverCode[0](true); // run it as the integrated server would

// --- a skeleton 10 blocks away, and a second one loitering near the player ---
const skel = h.makeSkeleton(30, 10, 0, h.player);
const bystander = h.makeSkeleton(31, 1.5, 1, null);
h.world.loadedEntityList = h.javaList([h.player, skel, bystander]);
h.hitboxes.push(h.player, skel, bystander);

let tick = 0;
function step(n) {
  for (let i = 0; i < n; i++) {
    tick++;
    h.fire("tick");
    h.stepProjectiles();
  }
}

// --- the telegraph: it gargles before anything comes out ---
let firstGargle = -1, firstGlob = -1;
for (let i = 0; i < 300 && firstGlob < 0; i++) {
  step(1);
  if (firstGargle < 0 && h.calls.fx.some((f) => f.id === 1009 && Math.abs(f.x - 10) < 2)) firstGargle = tick;
  if (firstGlob < 0 && h.calls.spawned.length > 0) firstGlob = tick;
}
check("skeleton gargles first", firstGargle > 0 && firstGlob > firstGargle, { firstGargle, firstGlob });
check("the gargle is a real warning, not a frame",
  firstGlob - firstGargle >= 8 && firstGlob - firstGargle <= 24,
  { ticks: firstGlob - firstGargle });

step(12); // let the rest of the stream come up
check("a heave is a stream of globs", h.calls.spawned.length === 3, h.calls.spawned.length);
check("globs left the skull, not the feet",
  h.calls.spawned.every((g) => g.y > skel.posY + 1 && Math.hypot(g.x - 10, g.z) < 1.5),
  h.calls.spawned.map((g) => ({ x: +g.x.toFixed(2), y: +g.y.toFixed(2) })));
check("globs are thrown, not fired flat",
  h.calls.spawned.every((g) => g.ay < 0 && g.ax === 0 && g.az === 0 && g.my > 0),
  h.calls.spawned.map((g) => ({ vy: +g.my.toFixed(3), ay: g.ay })));
check("globs are credited to the skeleton that coughed them up",
  h.calls.spawned.every((g) => g.shooter === 30), h.calls.spawned.map((g) => g.shooter));
check("recoil shoves the skeleton back", skel.motionX > 0, { motionX: +skel.motionX.toFixed(3) });

// --- the solved arc actually lands on the player ---
step(40);
check("globs landed", h.calls.impacts.length > 0, h.calls.impacts.length);
const onTarget = h.calls.impacts.filter((p) => Math.hypot(p.x - h.player.posX, p.z - h.player.posZ) < 1.5);
check("the arc is solved well enough to hit",
  onTarget.length === h.calls.impacts.length,
  h.calls.impacts.map((p) => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) })));

// --- the splash ---
check("splash particles played", h.calls.fx.some((f) => f.id === 2002));
check("the player is set alight", h.calls.setFire.some((c) => c.id === 1), h.calls.setFire);
check("burn time is the configured one", h.calls.setFire.every((c) => c.seconds === 5), h.calls.setFire);
check("skeletons don't set each other alight", !h.calls.setFire.some((c) => c.id === 31), h.calls.setFire);

// --- puddles: placed on the floor, never hanging in the air ---
const placed = [...h.blockOverrides.keys()];
check("a puddle was left behind", placed.length > 0, placed);
// the globs landed on the same spot, so their puddles overlap and spread out
check("puddles stay around where a glob landed",
  placed.every((k) => {
    const [x, , z] = k.split(",").map(Number);
    return h.calls.impacts.some((p) => Math.abs(x - Math.floor(p.x)) <= 1 && Math.abs(z - Math.floor(p.z)) <= 1);
  }), { placed: placed, impacts: h.calls.impacts.map((p) => [+p.x.toFixed(1), +p.z.toFixed(1)]) });
check("puddles sit on solid ground and replace only air",
  placed.every((k) => {
    const [x, y, z] = k.split(",").map(Number);
    return y >= 64 && h.world.isAirBlock({ x: x, y: y - 1, z: z }) === 0;
  }), placed);
check("puddles are placed without a neighbour update, so lava can't flow",
  h.calls.setBlock.filter((b) => b.state === "lava").every((b) => b.flags === 2),
  h.calls.setBlock.filter((b) => b.state === "lava"));

// --- and they get put back on their own ---
step(h.calls.setBlock.length ? 110 : 110);
check("puddles revert themselves", placed.every((k) => !h.blockOverrides.has(k)),
  [...h.blockOverrides.keys()]);
check("reverting puts the previous block state back",
  h.calls.setBlock.some((b) => b.state === "air" && b.flags === 2));

// --- it heaves again later, but on a cooldown, not every tick ---
const burstsBefore = h.calls.spawned.length;
for (let i = 0; i < 400 && h.blockOverrides.size === 0; i++) step(1);
check("it comes back for another go", h.calls.spawned.length > burstsBefore,
  { before: burstsBefore, after: h.calls.spawned.length });
check("cooldown keeps it from firehosing", h.calls.spawned.length < 24, h.calls.spawned.length);

// --- /skeletons clear puts every puddle back at once ---
const replies = [];
const sender = { sendMessage: (c) => replies.push(c.__text.__jstr) };
function cmd(text) { replies.length = 0; h.fire("processcommand", { command: text, sender: sender, preventDefault: false }); return replies; }

check("there are puddles to clear", h.blockOverrides.size > 0, h.blockOverrides.size);
let r = cmd("/skeletons clear");
check("clear command reverts everything now", h.blockOverrides.size === 0 && /cleaned up/.test(r[0]), r);

// --- a dying skeleton spills what it was carrying ---
h.calls.fx.length = 0;
cmd("/skeletons clear");
const doomed = h.makeSkeleton(40, 6, 6, h.player);
h.world.loadedEntityList = h.javaList([h.player, skel, bystander, doomed]);
step(8);                       // seen alive at least once
doomed.isDead = 1;
step(8);
check("a dead skeleton splashes where it fell",
  h.calls.fx.some((f) => f.id === 2002 && Math.hypot(f.x - 6, f.z - 6) < 3),
  h.calls.fx.filter((f) => f.id === 2002));
const spill = [...h.blockOverrides.keys()].filter((k) => {
  const [x, , z] = k.split(",").map(Number);
  return Math.abs(x - 6) <= 2 && Math.abs(z - 6) <= 2;
});
check("one splash lays down at most POOL_BLOCKS puddles",
  spill.length > 0 && spill.length <= 3, spill);

// --- rarity gates who is full of lava ---
cmd("/skeletons clear");
cmd("/skeletons set RARITY 0");
h.calls.spawned.length = 0;
step(300);
check("RARITY 0 means nobody vomits", h.calls.spawned.length === 0, h.calls.spawned.length);
cmd("/skeletons set RARITY 1");

// --- out of range, it keeps its lunch down ---
skel.posX = 34;
bystander._target = null;
doomed.isDead = 1;
h.calls.spawned.length = 0;
step(400);
check("no heaving at something out of range", h.calls.spawned.length === 0, h.calls.spawned.length);
skel.posX = 10;

// --- commands ---
r = cmd("/skeletons");
check("status command answers", r.length === 3 && /lavaskeletons: on/.test(r[0]), r);
r = cmd("/skeletons preset inferno");
check("preset switch", /inferno/.test(r[0]), r);
r = cmd("/skeletons set SPLASH_RADIUS 4");
check("set a value", /SPLASH_RADIUS = 4/.test(r[0]), r);
r = cmd("/skeletons set NOPE 1");
check("rejects unknown keys", /unknown key/.test(r[0]), r);
r = cmd("/skeletons set GLOBS banana");
check("rejects nonsense numbers", /not a number/.test(r[0]), r);
r = cmd("/skeletons help");
check("help lists the subcommands", r.length === 5, r);

cmd("/skeletons preset normal");
h.calls.spawned.length = 0;
r = cmd("/skeletons off");
check("can be turned off", /off/.test(r[0]), r);
check("turning it off cleans up after itself", h.blockOverrides.size === 0, h.blockOverrides.size);
step(300);
check("nothing comes up while off", h.calls.spawned.length === 0, h.calls.spawned.length);
cmd("/skeletons on");

const ev = h.fire("processcommand", { command: "/skeletons", sender: sender, preventDefault: false });
check("our command is consumed", ev.preventDefault === true);
const other = h.fire("processcommand", { command: "/gamemode 1", sender: sender, preventDefault: false });
check("other commands pass through", other.preventDefault === false);
const alias = h.fire("processcommand", { command: "/lavaskeletons", sender: sender, preventDefault: false });
check("the long name works too", alias.preventDefault === true);

// --- the same solver, over a spread of geometries ---
// close, mid, long, and one standing on a ledge spitting down at you
const sweep = [
  h.makeSkeleton(50, 4, 0, h.player),
  h.makeSkeleton(51, 9, 4, h.player),
  h.makeSkeleton(52, 14, -5, h.player),
  h.makeSkeleton(53, 7, 0, h.player, 72),
];
skel._target = null;
// out of everyone's firing lane: a glob that clips a body on the way there is
// supposed to stop and splash on it, which would look like a miss here
bystander.posX = -8; bystander.posZ = -8;
h.world.loadedEntityList = h.javaList([h.player, skel, bystander].concat(sweep));
sweep.forEach((e) => h.hitboxes.push(e));
h.calls.spawned.length = 0;
h.calls.impacts.length = 0;
step(300);

check("every angle got a glob away",
  sweep.every((e) => h.calls.spawned.some((g) => g.shooter === e.getEntityId())),
  sweep.map((e) => ({ id: e.getEntityId(), globs: h.calls.spawned.filter((g) => g.shooter === e.getEntityId()).length })));
const strays = h.calls.impacts.filter((p) => Math.hypot(p.x - h.player.posX, p.z - h.player.posZ) > 2);
check("close, far and from above, the arc still lands on the player",
  h.calls.impacts.length >= 4 && strays.length === 0,
  { impacts: h.calls.impacts.length, strays: strays.map((p) => ({ x: +p.x.toFixed(1), z: +p.z.toFixed(1) })) });

// --- nothing anywhere produced a NaN ---
const clean = [h.player, skel, bystander, doomed].concat(sweep).every((e) =>
  [e.posX, e.posY, e.posZ, e.motionX, e.motionY, e.motionZ].every(Number.isFinite));
check("no NaN on any entity", clean);
check("no NaN on any glob",
  h.projectiles.every((g) => [g.posX, g.posY, g.posZ, g.motionX, g.motionY, g.motionZ].every(Number.isFinite)));

console.log(fails ? "\n" + fails + " FAILURE(S)" : "\nall lavaskeletons checks passed");
process.exit(fails ? 1 : 0);
