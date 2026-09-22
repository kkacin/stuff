"use strict";
const h = require("./mock-modapi.js");

// Deterministic "randomness": the corrosion picks a column at random, so a
// fixed 0.5 would make it pick the same one every time and we'd never see it
// eat more than one block. A seeded generator gives the same spread every run.
let seed = 20250922;
Math.random = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

require("../acidrain.js");

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS  " : "FAIL  ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
  if (!cond) fails++;
}

check("queued server code", h.serverCode.length === 1);
h.serverCode[0](true); // run it as the integrated server would

const replies = [];
const sender = { sendMessage: (c) => replies.push(c.__text.__jstr) };
function cmd(text) {
  replies.length = 0;
  h.fire("processcommand", { command: text, sender: sender, preventDefault: false });
  return replies;
}

function step(n) {
  for (let i = 0; i < n; i++) h.fire("tick");
}

// The mock's ceiling slab covers x,z in (-40, 40); step outside it and you are
// under open sky. OPEN is out in the weather, SHELTER is under the slab.
const OPEN = { x: 100, z: 0 };
const SHELTER = { x: 0, z: 0 };
function stand(where) {
  h.player.posX = where.x;
  h.player.posZ = where.z;
  h.player.posY = 64;
}

function damageDone() {
  return h.calls.damage.filter((d) => d.id === 1).reduce((a, d) => a + d.amount, 0);
}

// The mod is perfectly capable of killing everything in the mock, and a dead
// player is skipped, which would quietly switch off every check after it.
function resetDamage() {
  h.calls.damage.length = 0;
  h.player.health = 20;
  h.player.isDead = 0;
  skel.health = 20;
  skel.isDead = 0;
}

// Sections that are about the terrain, not about you: stop the rain from
// killing the player who is standing in it so the corrosion keeps running.
function harmless() {
  resetDamage();
  cmd("/acidrain set DAMAGE 0");
}

// Put the mod on a predictable footing: no ramp, no grace, no corrosion, so a
// bite is exactly DAMAGE and the arithmetic below is readable.
function flatDamage() {
  cmd("/acidrain set GRACE_TICKS 0");
  cmd("/acidrain set RAMP_MAX 1");
  cmd("/acidrain set DAMAGE 2");
  cmd("/acidrain set CORRODE false");
}

const skel = h.makeSkeleton(70, 0, 0, null);   // under the slab until the mob section
h.world.loadedEntityList = h.javaList([h.player, skel]);

// --- dry weather does nothing at all ---
stand(OPEN);
step(200);
check("no rain, no acid", h.calls.damage.length === 0, h.calls.damage.length);
check("no rain, no corrosion", h.blockOverrides.size === 0, h.blockOverrides.size);

// --- the storm rolls in ---
h.calls.chat.length = 0;
let r = cmd("/acidrain storm on");
check("the mod can start the weather", /storm -> on/.test(r[0]) && h.weather.raining === true, r);
step(20);
check("a storm announces itself", h.calls.chat.some((m) => /sting/i.test(m)), h.calls.chat);

// --- but you get a moment to run for cover ---
cmd("/acidrain set CORRODE false");
stand(SHELTER);
step(60);              // dry off whatever the announcement step above cost us
stand(OPEN);
resetDamage();
step(40);
check("the first seconds out in it are free", h.calls.damage.length === 0, h.calls.damage);
step(60);
check("stand in it and it starts biting", h.calls.damage.length > 0, h.calls.damage.length);
check("the bite is credited to a damage source",
  h.calls.damage.every((d) => d.src === "magic"), h.calls.damage.map((d) => d.src));

// --- and it gets worse the longer you stay out ---
const early = h.calls.damage[0].amount;
step(300);
const late = h.calls.damage[h.calls.damage.length - 1].amount;
check("it bites harder the longer you stand in it", late > early * 1.5, { early, late });
check("the ramp is capped", late <= 2.5 * 1.0001, { late });

// --- shelter works, and drying off resets the ramp ---
resetDamage();
stand(SHELTER);
step(200);
check("a roof stops it dead", h.calls.damage.length === 0, h.calls.damage.length);

stand(OPEN);
step(40);
check("drying off buys the grace period back", h.calls.damage.length === 0, h.calls.damage.length);
step(200);
check("and then it starts again", h.calls.damage.length > 0, h.calls.damage.length);

// --- water washes it off ---
flatDamage();
resetDamage();
h.player.inWater = true;
step(200);
check("water shields you", h.calls.damage.length === 0, h.calls.damage.length);
h.player.inWater = false;
resetDamage();
step(100);
check("out of the water it bites again", h.calls.damage.length === 5, h.calls.damage.length);
check("a flat bite is exactly DAMAGE", h.calls.damage.every((d) => Math.abs(d.amount - 2) < 1e-9),
  h.calls.damage.map((d) => d.amount));

// --- thunder bites harder ---
resetDamage();
cmd("/acidrain storm thunder");
step(100);
check("a thunderstorm doubles it",
  h.calls.damage.length > 0 && h.calls.damage.every((d) => Math.abs(d.amount - 4) < 1e-9),
  h.calls.damage.map((d) => d.amount));
cmd("/acidrain storm on");

// --- armour holds it off, and is eaten for doing so ---
resetDamage();
h.calls.armourWear.length = 0;
h.setArmour(4);
step(100);
const armoured = h.calls.damage[0].amount;
check("a full set takes most of it", Math.abs(armoured - 2 * 0.2) < 1e-9, { armoured });
check("and the set is eaten for it", h.calls.armourWear.length === h.calls.damage.length * 4,
  { wear: h.calls.armourWear.length, bites: h.calls.damage.length });
check("every worn piece corrodes", new Set(h.calls.armourWear.map((w) => w.name)).size === 4,
  h.calls.armourWear.map((w) => w.name));

// --- and once it has been eaten through, there is nothing between you and it ---
resetDamage();
step(60 * 20);
check("armour that runs out stops protecting you",
  h.calls.damage[h.calls.damage.length - 1].amount > armoured,
  { first: h.calls.damage[0].amount, last: h.calls.damage[h.calls.damage.length - 1].amount });
h.setArmour(0);

// --- creative players are left alone ---
resetDamage();
h.player.capabilities = { isCreativeMode: 1 };
step(100);
check("creative players are left alone", h.calls.damage.length === 0, h.calls.damage.length);
delete h.player.capabilities;

// --- mobs are out in it too ---
resetDamage();
skel.posX = 104; skel.posZ = 0;   // out from under the slab
step(100);
const mobHits = h.calls.damage.filter((d) => d.id === 70);
check("mobs caught out in it burn too", mobHits.length > 0, mobHits.length);
skel.posX = 0; skel.posZ = 0;     // back under the slab with us
resetDamage();
step(100);
check("a sheltered mob is fine", !h.calls.damage.some((d) => d.id === 70), h.calls.damage);
skel.posX = 104;
cmd("/acidrain set HURT_MOBS false");
resetDamage();
step(100);
check("HURT_MOBS false leaves them alone", !h.calls.damage.some((d) => d.id === 70), h.calls.damage);
cmd("/acidrain set HURT_MOBS true");

// --- corrosion: grass under open sky goes to dirt ---
harmless();
cmd("/acidrain set CORRODE true");
cmd("/acidrain set CORRODE_CHANCE 1");
cmd("/acidrain set HEAL_TICKS 200");
h.calls.setBlock.length = 0;
stand(OPEN);
step(100);
const eaten = [...h.blockOverrides.entries()];
check("the rain eats the ground", eaten.length > 0, eaten.length);
check("grass corrodes to dirt", eaten.every(([, st]) => st.__state === "dirt"),
  eaten.map(([k, st]) => k + "=" + st.__state));
check("it only eats the surface", eaten.every(([k]) => Number(k.split(",")[1]) === 63),
  eaten.map(([k]) => k));
check("it only eats near the player",
  eaten.every(([k]) => Math.abs(Number(k.split(",")[0]) - OPEN.x) <= 12), eaten.map(([k]) => k));
check("corrosion notifies neighbours, so what it undermines falls over",
  h.calls.setBlock.filter((b) => b.state === "dirt").every((b) => b.flags === 3),
  h.calls.setBlock.filter((b) => b.state === "dirt").map((b) => b.flags));
const perSpot = {};
h.calls.setBlock.filter((b) => b.state === "dirt").forEach((b) => {
  const k = b.x + "," + b.y + "," + b.z;
  perSpot[k] = (perSpot[k] || 0) + 1;
});
check("a block already eaten isn't eaten again until it has grown back",
  Object.values(perSpot).every((n) => n === 1), perSpot);

// --- it grows back on its own ---
cmd("/acidrain set CORRODE false");
step(240);
check("corroded ground grows back", h.blockOverrides.size === 0, [...h.blockOverrides.keys()]);
check("growing back puts grass back",
  h.calls.setBlock.some((b) => b.state === "grass" && b.flags === 3));

// --- nothing under a roof is touched ---
harmless();
cmd("/acidrain set CORRODE true");
cmd("/acidrain heal");
h.blockOverrides.clear();
stand(SHELTER);
step(200);
check("what's under a roof is never eaten", h.blockOverrides.size === 0, [...h.blockOverrides.keys()]);

// --- stone wears down a step at a time ---
harmless();
cmd("/acidrain heal");
h.blockOverrides.clear();
stand(OPEN);
for (let x = OPEN.x - 14; x <= OPEN.x + 14; x++) {
  for (let z = -14; z <= 14; z++) h.blockOverrides.set(x + ",63," + z, h.stateFor("cobblestone"));
}
const cobbleBefore = h.blockOverrides.size;
step(100);
const gravel = [...h.blockOverrides.values()].filter((st) => st.__state === "gravel");
check("cobblestone wears down to gravel", gravel.length > 0, gravel.length);
check("and nothing skipped a step",
  ![...h.blockOverrides.values()].some((st) => st.__state === "sand" || st.__state === "dirt"),
  [...new Set([...h.blockOverrides.values()].map((st) => st.__state))]);
check("the rest of the patch is untouched", h.blockOverrides.size === cobbleBefore, h.blockOverrides.size);

// --- /acidrain heal puts it all back at once ---
r = cmd("/acidrain heal");
check("heal reports what it put back", /healed \d+ corroded block/.test(r[0]), r);
check("heal leaves no gravel behind",
  ![...h.blockOverrides.values()].some((st) => st.__state === "gravel"),
  [...new Set([...h.blockOverrides.values()].map((st) => st.__state))]);
h.blockOverrides.clear();

// --- PERMANENT means it really is one-way ---
harmless();
cmd("/acidrain set PERMANENT true");
step(100);
const permanent = h.blockOverrides.size;
check("PERMANENT corrodes as usual", permanent > 0, permanent);
cmd("/acidrain heal");
check("but there is nothing to heal", h.blockOverrides.size === permanent, h.blockOverrides.size);
cmd("/acidrain set PERMANENT false");
h.blockOverrides.clear();

// --- a storm that isn't acid is just weather ---
cmd("/acidrain set DAMAGE 2");
cmd("/acidrain set CORRODE true");
cmd("/acidrain storm off");
step(40);              // the mod samples the sky on its own pass, not on command
cmd("/acidrain set ALWAYS_ACID false");
cmd("/acidrain set STORM_CHANCE 0");
cmd("/acidrain set THUNDER_ALWAYS false");
resetDamage();
h.blockOverrides.clear();
h.calls.chat.length = 0;
cmd("/acidrain storm on");
step(300);
check("a plain rainstorm doesn't hurt", h.calls.damage.length === 0, h.calls.damage.length);
check("and says as much", h.calls.chat.some((m) => /just raining/i.test(m)), h.calls.chat);
check("a plain rainstorm doesn't corrode", h.blockOverrides.size === 0, h.blockOverrides.size);

// --- but the thunder that grows out of it does ---
cmd("/acidrain set THUNDER_ALWAYS true");
resetDamage();
h.calls.chat.length = 0;
cmd("/acidrain storm thunder");
step(200);
check("thunder turns a plain storm acid", h.calls.damage.length > 0, h.calls.damage.length);
check("and warns you it has", h.calls.chat.some((m) => /burning/i.test(m)), h.calls.chat);
cmd("/acidrain set ALWAYS_ACID true");
cmd("/acidrain storm on");

// --- turning it off cleans up and stops ---
harmless();
cmd("/acidrain heal");
h.blockOverrides.clear();
step(100);
check("there is something to clean up", h.blockOverrides.size > 0, h.blockOverrides.size);
r = cmd("/acidrain off");
check("can be turned off", /acidrain off/.test(r[0]), r);
check("turning it off heals everything", h.blockOverrides.size === 0, [...h.blockOverrides.keys()]);
resetDamage();
step(300);
check("nothing happens while off",
  h.calls.damage.length === 0 && h.blockOverrides.size === 0, h.calls.damage.length);
cmd("/acidrain on");

// --- commands ---
r = cmd("/acidrain");
check("status command answers", r.length === 4 && /acidrain: on/.test(r[0]), r);
check("status says what the sky is doing", /acid/.test(r[1]), r[1]);
r = cmd("/acidrain preset caustic");
check("preset switch", /caustic/.test(r[0]), r);
r = cmd("/acidrain preset nope");
check("unknown presets list the real ones", /mist, normal, caustic/.test(r[0]), r);
r = cmd("/acidrain set DAMAGE 3");
check("set a value", /DAMAGE = 3/.test(r[0]), r);
r = cmd("/acidrain set DAMAGE");
check("read a value back", /DAMAGE = 3/.test(r[0]), r);
r = cmd("/acidrain set NOPE 1");
check("rejects unknown keys", /unknown key/.test(r[0]), r);
r = cmd("/acidrain set DAMAGE banana");
check("rejects nonsense numbers", /not a number/.test(r[0]), r);
r = cmd("/acidrain set CORRODE false");
check("booleans survive the trip", /CORRODE = false/.test(r[0]), r);
r = cmd("/acidrain storm sideways");
check("rejects weather it can't make", /on \| off \| thunder/.test(r[0]), r);
r = cmd("/acidrain help");
check("help lists the subcommands", r.length === 6, r);

const ev = h.fire("processcommand", { command: "/acidrain", sender: sender, preventDefault: false });
check("our command is consumed", ev.preventDefault === true);
const alias = h.fire("processcommand", { command: "/acid", sender: sender, preventDefault: false });
check("the short name works too", alias.preventDefault === true);
const other = h.fire("processcommand", { command: "/gamemode 1", sender: sender, preventDefault: false });
check("other commands pass through", other.preventDefault === false);
const near = h.fire("processcommand", { command: "/acidic", sender: sender, preventDefault: false });
check("a command that merely starts the same is not ours", near.preventDefault === false);

// --- the client-side warning ---
// Two overlays: the text and the green vignette, in that order.
const [hudEl, tintEl] = h.domElements;
h.weather.raining = true;
stand(OPEN);
for (let i = 0; i < 40; i++) h.fire("frame");
check("the client warns you when you're out in it", /ACID RAIN/.test(hudEl.textContent), hudEl.textContent);
check("and tints the screen", parseFloat(tintEl.style.opacity) > 0.2, tintEl.style.opacity);

stand(SHELTER);
for (let i = 0; i < 40; i++) h.fire("frame");
check("and shuts up once you're under cover", hudEl.textContent === "" && hudEl.style.display === "none",
  { text: hudEl.textContent, display: hudEl.style.display });
check("and the tint fades out", parseFloat(tintEl.style.opacity) === 0, tintEl.style.opacity);

h.weather.raining = false;
stand(OPEN);
for (let i = 0; i < 40; i++) h.fire("frame");
check("dry weather says nothing", hudEl.textContent === "", hudEl.textContent);

// --- nothing anywhere produced a NaN ---
check("no NaN in the damage it dealt", h.calls.damage.every((d) => Number.isFinite(d.amount)));
check("no NaN on any entity",
  [h.player, skel].every((e) => [e.posX, e.posY, e.posZ, e.health].every(Number.isFinite)));

console.log(fails ? "\n" + fails + " FAILURE(S)" : "\nall acidrain checks passed");
process.exit(fails ? 1 : 0);
