"use strict";
const h = require("./mock-modapi.js");

const CANBLOCKSTAY = "net.minecraft.block.BlockCactus.canBlockStay";
const vanillaStay = h.hookMethods[CANBLOCKSTAY];

require("../tucson.js");

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS  " : "FAIL  ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
  if (!cond) fails++;
}

check("the client installs the cactus rule at load", h.hookMethods[CANBLOCKSTAY] !== vanillaStay);
// In the game the client and the worker each have their own method table.
// Here they'd share one, so keep the client's patch aside and give the server
// a clean vanilla table to patch, the way it would find it.
const clientStay = h.hookMethods[CANBLOCKSTAY];
h.hookMethods[CANBLOCKSTAY] = vanillaStay;
check("queued server code", h.serverCode.length === 1);
h.serverCode[0](true); // run it as the integrated server would
const T = globalThis.Tucson;
check("the server side is up and patched", !!T && T.sturdy === true);

const stays = (x, y, z) => !!h.hookMethods[CANBLOCKSTAY](null, h.world, { x: x, y: y, z: z });
const vanilla = (x, y, z) => !!vanillaStay(null, h.world, { x: x, y: y, z: z });
const at = (x, y, z) => h.blockState({ x: x, y: y, z: z }).__state;
const put = (x, y, z, name) => h.world.setBlockState({ x: x, y: y, z: z }, h.stateFor(name), 2);

const replies = [];
const sender = { sendMessage: (c) => replies.push(c.__text.__jstr) };
function cmd(text, who) {
  replies.length = 0;
  h.fire("processcommand", { command: text, sender: who || sender, preventDefault: false });
  return replies.slice();
}

function step(n) {
  for (let i = 0; i < n; i++) h.fire("tick");
}

function stand(x, z) {
  h.player.posX = x;
  h.player.posZ = z;
  h.player.posY = 64;
}

// ============================================================
// shapes
// ============================================================
const key = (b) => b[0] + "," + b[1] + "," + b[2];

function shapeProblems(s) {
  const out = [];
  const set = new Set(s.blocks.map(key));
  if (set.size !== s.blocks.length) out.push("duplicate blocks");
  for (let y = 0; y < s.height; y++) if (!set.has("0," + y + ",0")) out.push("trunk gap at " + y);
  for (const b of s.blocks) {
    if (Math.abs(b[0]) > 3 || Math.abs(b[2]) > 3) out.push("reaches too far " + key(b));
    if (b[1] < 0) out.push("below ground " + key(b));
    if (b[1] >= s.height) out.push("taller than the trunk " + key(b));
    // a block right beside the trunk is an elbow: it carries on outwards and
    // there's a gap above it, so the arm reads as an arm
    if (Math.abs(b[0]) + Math.abs(b[2]) === 1) {
      if (!set.has((b[0] * 2) + "," + b[1] + "," + (b[2] * 2))) out.push("elbow goes nowhere " + key(b));
      if (set.has(b[0] + "," + (b[1] + 1) + "," + b[2])) out.push("arm hugs the trunk " + key(b));
    }
  }
  // every block joins the trunk
  const seen = new Set(["0,0,0"]);
  const queue = [[0, 0, 0]];
  while (queue.length) {
    const [x, y, z] = queue.shift();
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const k = (x + dx) + "," + (y + dy) + "," + (z + dz);
      if (set.has(k) && !seen.has(k)) { seen.add(k); queue.push([x + dx, y + dy, z + dz]); }
    }
  }
  if (seen.size !== set.size) out.push("floating blocks");
  return out;
}

const rng = T.rngFrom(42);
const ARMS = { young: [0, 0], spear: [0, 0], arm: [1, 1], twin: [2, 2], candelabra: [3, 4], giant: [3, 4] };
const HEIGHT = { young: [2, 3], spear: [5, 9], arm: [6, 10], twin: [7, 11], candelabra: [9, 13], giant: [12, 16] };
for (const kind of T.SHAPES) {
  const problems = [];
  const heights = new Set();
  let armsOk = true;
  for (let i = 0; i < 300; i++) {
    const s = T.buildShape(rng, kind);
    shapeProblems(s).forEach((p) => problems.push(p));
    heights.add(s.height);
    if (s.height < HEIGHT[kind][0] || s.height > HEIGHT[kind][1]) problems.push("height " + s.height);
    if (s.arms < ARMS[kind][0] || s.arms > ARMS[kind][1]) armsOk = false;
  }
  check(kind + ": 300 of them are all well-formed saguaros", problems.length === 0, problems.slice(0, 5));
  check(kind + ": arm count is right", armsOk);
  check(kind + ": they come in different heights", heights.size > 1, Array.from(heights));
}

const kinked = Array.from({ length: 100 }, () => T.buildShape(rng, "giant"))
  .some((s) => s.blocks.some((b) => Math.abs(b[0]) === 3 || Math.abs(b[2]) === 3));
check("some old giants have crooked arms", kinked);

const opposite = Array.from({ length: 100 }, () => T.buildShape(rng, "twin")).some((s) => {
  const elbows = s.blocks.filter((b) => Math.abs(b[0]) + Math.abs(b[2]) === 1);
  return elbows.length === 2 && elbows[0][0] === -elbows[1][0] && elbows[0][2] === -elbows[1][2];
});
check("some twins hold their arms out opposite, like the postcard", opposite);

const mix = {};
for (let i = 0; i < 1000; i++) {
  const k = T.pickShape(rng);
  mix[k] = (mix[k] || 0) + 1;
}
check("every shape turns up in the wild", T.SHAPES.every((k) => mix[k] > 20), mix);

const a = T.buildShape(T.rngFrom(7), "candelabra");
const b = T.buildShape(T.rngFrom(7), "candelabra");
check("the same seed grows the same saguaro", JSON.stringify(a) === JSON.stringify(b));

// ============================================================
// planting a desert
// ============================================================
const DESERT = { x: 1100, z: 100 };
stand(DESERT.x, DESERT.z);
step(400);

const desert = T.planted.filter((s) => s.x >= h.DESERT_X);
const desertChunks = T.stats.chunks;
check("walking into the desert grows saguaros", desert.length >= 30, desert.length);
check("and in all sorts of shapes", new Set(desert.map((s) => s.kind)).size >= 5,
  Array.from(new Set(desert.map((s) => s.kind))));
check("every block of every one is cactus",
  desert.every((s) => s.blocks.every(([x, y, z]) => at(x, y, z) === "cactus")));
check("every trunk stands on the sand", desert.every((s) => at(s.x, s.y - 1, s.z) === "sand"));
check("they're placed without waking the neighbours",
  h.calls.setBlock.filter((c) => c.state === "cactus").every((c) => c.flags === 2));

const chunkCorner = (s) => [Math.floor(s.x / 16) * 16, Math.floor(s.z / 16) * 16];
check("each planted chunk is marked for next time",
  desert.every((s) => { const [cx, cz] = chunkCorner(s); return at(cx, 1, cz) === "sandstone"; }));

const armBlocks = [];
desert.forEach((s) => s.blocks.forEach((p) => { if (p[0] !== s.x || p[2] !== s.z) armBlocks.push(p); }));
check("there are arms to hold up", armBlocks.length > 20, armBlocks.length);
check("vanilla alone would knock the arms off", armBlocks.some((p) => !vanilla(p[0], p[1], p[2])));
check("with the patch, every block of every saguaro stays",
  desert.every((s) => s.blocks.every((p) => stays(p[0], p[1], p[2]))));
check("and the client agrees, so it doesn't knock them off its own copy",
  desert.every((s) => s.blocks.every((p) => !!clientStay(null, h.world, { x: p[0], y: p[1], z: p[2] }))));

// nothing touches: every saguaro's blocks have no solid non-cactus neighbours
const crowded = desert.some((s) => s.blocks.some(([x, y, z]) =>
  [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => {
    const n = at(x + dx, y, z + dz);
    return n !== "air" && n !== "cactus";
  })));
check("no saguaro is jammed against anything", !crowded);

// ============================================================
// replanting
// ============================================================
const before = T.stats.planted;
const s0 = desert[0];
const [mcx, mcz] = chunkCorner(s0);
T.plantChunk(h.world, mcx / 16, mcz / 16, 64);
check("a marked chunk is never planted twice (even after a restart)", T.stats.planted === before);

step(200);
check("standing still doesn't keep planting", T.stats.planted === before, T.stats.planted - before);

// ============================================================
// no saguaros in the pond
// ============================================================
let pondChunks = T.stats.chunks;
stand(1205, 1205);
step(400);
pondChunks = T.stats.chunks - pondChunks;
const nearPond = T.planted.filter((s) => s.x > 1195 && s.x < 1215 && s.z > 1195 && s.z < 1215);
const wet = T.planted.some((s) => s.blocks.some(([x, y, z]) => x >= 1198 && x < 1212 && z >= 1198 && z < 1212));
check("nothing grows in or right beside water", !wet, nearPond.map((s) => [s.x, s.z]));

// ============================================================
// the rest of the world
// ============================================================
const plainsBefore = T.planted.filter((s) => s.x < h.DESERT_X).length;
for (let x = 100; x <= 900; x += 64) {
  stand(x, 500);
  step(120);
}
const plains = T.planted.filter((s) => s.x < h.DESERT_X && s.x > -h.DESERT_X);
check("saguaros turn up outside the desert too", plains.length > plainsBefore, plains.length);
const plainsChunks = T.stats.chunks - desertChunks - pondChunks;
const perDesert = desert.length / desertChunks, perPlains = plains.length / plainsChunks;
check("but far fewer per chunk than in it", perPlains > 0 && perPlains * 4 < perDesert,
  { plains: perPlains.toFixed(2), desert: perDesert.toFixed(2) });
check("off the sand, each one brings its own patch of sand",
  plains.every((s) => at(s.x, s.y - 1, s.z) === "sand"));
check("and stands up too", plains.every((s) => s.blocks.every((p) => stays(p[0], p[1], p[2]))));

const coldBefore = T.planted.length;
stand(-1200, 0);
step(400);
check("frozen biomes stay saguaro-free",
  T.planted.length === coldBefore && T.planted.every((s) => s.x > -h.DESERT_X + 64));

// ============================================================
// the cactus rule
// ============================================================
// a hand-built saguaro out on the plains, on sand: trunk, and an arm to the east
const X = 300, Y = 64, Z = -300;
put(X, Y - 1, Z, "sand");
for (let y = Y; y < Y + 6; y++) put(X, y, Z, "cactus");
put(X + 1, Y + 2, Z, "cactus");
put(X + 2, Y + 2, Z, "cactus");
put(X + 2, Y + 3, Z, "cactus");
put(X + 2, Y + 4, Z, "cactus");

check("you can build your own and it stays", [0, 1, 2, 3, 4, 5].every((dy) => stays(X, Y + dy, Z)) &&
  stays(X + 1, Y + 2, Z) && stays(X + 2, Y + 4, Z));

put(X - 1, Y + 1, Z, "stone");
check("a cactus with stone beside it still breaks, like vanilla", !stays(X, Y + 1, Z));
put(X - 1, Y + 1, Z, "air");

// Vanilla judges one block at a time, when a neighbour changes: whatever
// fails breaks, which changes its neighbours, and so on until it settles.
const HAND = [[X, Y + 1, Z], [X, Y + 2, Z], [X, Y + 3, Z], [X, Y + 4, Z], [X, Y + 5, Z],
  [X + 1, Y + 2, Z], [X + 2, Y + 2, Z], [X + 2, Y + 3, Z], [X + 2, Y + 4, Z]];
function settle(blocks) {
  let broke = true;
  while (broke) {
    broke = false;
    for (const [x, y, z] of blocks) {
      if (at(x, y, z) === "cactus" && !stays(x, y, z)) { put(x, y, z, "air"); broke = true; }
    }
  }
}
put(X, Y, Z, "air");
settle(HAND);
check("cut it at the base and the whole thing comes down", HAND.every(([x, y, z]) => at(x, y, z) === "air"));

T.CONFIG.STURDY = false;
put(X, Y, Z, "cactus");
put(X, Y + 1, Z, "cactus");
put(X, Y + 2, Z, "cactus");
put(X + 1, Y + 2, Z, "cactus");
check("STURDY false puts vanilla's rule back", !stays(X + 1, Y + 2, Z));
T.CONFIG.STURDY = true;
check("a lone vanilla cactus is none the wiser", vanilla(X, Y, Z) === stays(X, Y, Z));

// ============================================================
// /tucson
// ============================================================
let r = cmd("/tucson");
check("/tucson reports status", /tucson: on/.test(r[0]) && /saguaros \d+/.test(r[1]), r);

const planter = Object.assign({}, h.player, {
  posX: 1300, posY: 64, posZ: 700, rotationYaw: 0,
  sendMessage: (c) => replies.push(c.__text.__jstr),
});
r = cmd("/tucson plant giant", planter);
check("/tucson plant grows one in front of you", /planted a giant saguaro at 1300 64 705/.test(r[0]), r);
const mine = T.planted[T.planted.length - 1];
check("and it's a real one", mine.kind === "giant" && mine.blocks.length >= 12 &&
  mine.blocks.every((p) => at(p[0], p[1], p[2]) === "cactus"));

r = cmd("/tucson plant giant", planter);
check("...but not on top of the last one", /no room/.test(r[0]), r);

r = cmd("/tucson plant teapot", planter);
check("an unknown shape lists the real ones", /shapes:.*candelabra/.test(r[0]), r);

r = cmd("/tucson clear 10", planter);
check("/tucson clear removes it", /cleared 1 /.test(r[0]) &&
  mine.blocks.every((p) => at(p[0], p[1], p[2]) === "air"), r);

r = cmd("/tucson set DENSITY_DESERT 3");
check("/tucson set writes config", T.CONFIG.DENSITY_DESERT === 3, r);
r = cmd("/tucson preset desert");
check("/tucson preset desert keeps them in the desert", T.CONFIG.DENSITY_ELSEWHERE === 0, r);
r = cmd("/tucson preset nope");
check("an unknown preset lists the real ones", /presets:/.test(r[0]), r);

const off = cmd("/tucson off");
const n = T.stats.chunks;
stand(3000, 3000);
step(100);
check("/tucson off stops planting", /tucson off/.test(off[0]) && T.stats.chunks === n);
cmd("/tucson on");

const ev = h.fire("processcommand", { command: "/tucson help", sender: sender, preventDefault: false });
check("our command is consumed", ev.preventDefault === true);
const other = h.fire("processcommand", { command: "/tucsonx", sender: sender, preventDefault: false });
check("a command that merely starts the same is not ours", other.preventDefault === false);

check("nothing went NaN", h.calls.setBlock.every((c) => isFinite(c.x) && isFinite(c.y) && isFinite(c.z)));

console.log(fails ? "\n" + fails + " tucson check(s) failed" : "\nall tucson checks passed");
process.exit(fails ? 1 : 0);
