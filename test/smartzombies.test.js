"use strict";
const h = require("./mock-modapi.js");
require("../smartzombies.js");

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS  " : "FAIL  ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
  if (!cond) fails++;
}

check("queued server code", h.serverCode.length === 1);
h.serverCode[0](true); // run it as the integrated server would

// --- a few passes of the AI ---
for (let i = 0; i < 8; i++) h.fire("tick");

check("navigator was driven", h.calls.tryMoveToXYZ.length > 0, h.calls.tryMoveToXYZ.length);
check("zombies were told where to look", h.calls.setLook.length > 0);
check("door-breaking enabled once per zombie", h.calls.breakDoors === h.zombies.length, h.calls.breakDoors);
check("targetless zombie got recruited by the horde", h.calls.setAttackTarget.includes(13), h.calls.setAttackTarget);

// goals: the nearest zombie charges the player, the rest fan out around them
const byId = {};
h.calls.tryMoveToXYZ.forEach((c) => { byId[c.id] = c; });
const goalDist = (c) => Math.hypot(c.gx - h.player.posX, c.gz - h.player.posZ);
check("closest zombie aims at the player", goalDist(byId[10]) < 2.5, byId[10]);
check("flanker aims off to the side", goalDist(byId[11]) > 4, { goal: byId[11], d: goalDist(byId[11]).toFixed(2) });
check("flankers picked different slots",
  Math.hypot(byId[11].gx - byId[12].gx, byId[11].gz - byId[12].gz) > 2,
  { a: byId[11], b: byId[12] });
check("flankers hustle (higher speed)", byId[11].speed > byId[10].speed, { flank: byId[11].speed, charge: byId[10].speed });

// --- target leading: walk the player and check the goal moves ahead of them ---
h.calls.tryMoveToXYZ.length = 0;
for (let i = 0; i < 12; i++) {
  h.player.posX -= 0.21;           // running west at roughly zombie speed
  h.fire("tick");
}
const charger = h.calls.tryMoveToXYZ.filter((c) => c.id === 10).pop();
check("charger leads a running target", charger.gx < h.player.posX - 0.5,
  { goal: charger.gx.toFixed(2), player: h.player.posX.toFixed(2) });

// --- memory: lose the target, they should search the last known spot ---
h.zombies.forEach((z) => { z._target = null; });
const lastKnown = h.player.posX;
h.calls.tryMoveToXYZ.length = 0;
h.player.posX = 20;                // slip away, still within the mod's active range
for (let i = 0; i < 4; i++) h.fire("tick");
const searching = h.calls.tryMoveToXYZ.filter((c) => Math.abs(c.gx - lastKnown) < 12);
check("zombies search the last known position", searching.length > 0,
  { lastKnown: lastKnown.toFixed(1), goals: h.calls.tryMoveToXYZ.map((c) => c.gx.toFixed(1)) });

// --- dodging: player stares down a close zombie ---
h.player.posX = 0; h.player.posZ = 0; h.player.rotationYaw = 0; h.player.rotationPitch = 0;
const dodger = h.zombies[0];
dodger.posX = 0; dodger.posZ = 3; dodger._target = h.player;  // due north, dead centre
dodger.motionX = 0; dodger.motionZ = 0;
for (let i = 0; i < 4; i++) h.fire("tick");
check("zombie sidesteps out of the crosshair", Math.abs(dodger.motionX) > 0.1,
  { motionX: dodger.motionX.toFixed(3) });

// --- burning zombie runs for shade (outside the slab's footprint = sunlit) ---
const burner = h.makeZombie(20, 44, 0, null);
burner.isBurning = () => 1;
h.zombies.push(burner);
h.world.loadedEntityList = h.javaList([h.player].concat(h.zombies));
h.player.posX = 40; h.player.posZ = 0;
h.calls.tryMoveToXYZ.length = 0;
for (let i = 0; i < 8; i++) h.fire("tick");
const shadeGoals = h.calls.tryMoveToXYZ.filter((c) => c.id === 20);
check("burning zombie heads for shade", shadeGoals.length > 0 && shadeGoals.some((c) => c.gx < 40),
  shadeGoals.map((c) => ({ gx: c.gx, gz: c.gz })));

// --- commands ---
const replies = [];
const sender = { sendMessage: (c) => replies.push(c.__text.__jstr) };
function cmd(text) { replies.length = 0; h.fire("processcommand", { command: text, sender: sender, preventDefault: false }); return replies; }

let r = cmd("/zombies");
check("status command answers", r.length === 3 && /smartzombies: on/.test(r[0]), r);
r = cmd("/zombies preset nightmare");
check("preset switch", /nightmare/.test(r[0]), r);
r = cmd("/zombies set FLANK_RADIUS 12");
check("set a value", /FLANK_RADIUS = 12/.test(r[0]), r);
r = cmd("/zombies set NOPE 1");
check("rejects unknown keys", /unknown key/.test(r[0]), r);
r = cmd("/zombies off");
check("can be turned off", /off/.test(r[0]), r);
h.calls.tryMoveToXYZ.length = 0;
for (let i = 0; i < 6; i++) h.fire("tick");
check("no steering while off", h.calls.tryMoveToXYZ.length === 0);
cmd("/zombies on");
const ev = h.fire("processcommand", { command: "/zombies", sender: sender, preventDefault: false });
check("our command is consumed", ev.preventDefault === true);
const other = h.fire("processcommand", { command: "/gamemode 1", sender: sender, preventDefault: false });
check("other commands pass through", other.preventDefault === false);

// --- nothing anywhere produced a NaN ---
const clean = h.zombies.every((z) => [z.posX, z.posY, z.posZ, z.motionX, z.motionY, z.motionZ].every(Number.isFinite));
check("no NaN on any zombie", clean);

console.log(fails ? "\n" + fails + " FAILURE(S)" : "\nall smartzombies checks passed");
process.exit(fails ? 1 : 0);
