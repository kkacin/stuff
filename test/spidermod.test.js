"use strict";
const h = require("./mock-modapi.js");
require("../spidermod.js");

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS  " : "FAIL  ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
  if (!cond) fails++;
}

const S = global.window.SpiderMod || h.ModAPI._spider;
check("mod exposed SpiderMod", !!S);
check("detected 1.12 adapter", S.is1_12 === true);

// world probe: ground below, ceiling at y=80
check("isSolid ground", S.isSolid(0, 63, 0) === true);
check("isSolid air", S.isSolid(0, 70, 0) === false);
check("isSolid ceiling", S.isSolid(0, 80, 0) === true);

// anchor search: looking up at the slab 16 blocks above
h.player.posY = 64;
h.player.rotationPitch = -20;
const a = S.findAnchor(h.player);
check("anchor found above player", !!a && a.y > h.player.posY + 2, a);

// fire a web
h.key("KeyV");
check("attached", S.state.attached === true);
check("rope length sane", S.state.ropeLen >= S.CONFIG.MIN_ROPE && S.state.ropeLen <= S.CONFIG.MAX_ROPE, S.state.ropeLen);
check("hopped off the ground", h.player.motionY > 0, h.player.motionY);

// swing for 60 ticks with forward held, watch for NaN / runaway
h.ModAPI.settings.keyBindForward.pressed = 1;
let maxSpeed = 0, moved = 0, finite = true;
const start = { x: h.player.posX, z: h.player.posZ };
for (let i = 0; i < 60; i++) {
  h.player.onGround = 0;
  h.fire("update");
  // crude vanilla integration so the pendulum has something to work against
  h.player.motionY -= 0.08;
  h.player.motionY *= 0.98;
  h.player.posX += h.player.motionX;
  h.player.posY += h.player.motionY;
  h.player.posZ += h.player.motionZ;
  const sp = Math.hypot(h.player.motionX, h.player.motionY, h.player.motionZ);
  maxSpeed = Math.max(maxSpeed, sp);
  if (![h.player.posX, h.player.posY, h.player.posZ, sp].every(Number.isFinite)) finite = false;
}
moved = Math.hypot(h.player.posX - start.x, h.player.posZ - start.z);
check("no NaN during swing", finite);
check("player actually swung", moved > 2, { moved: moved.toFixed(2) });
check("speed stayed sane", maxSpeed < 3, { maxSpeed: maxSpeed.toFixed(3) });
check("rope kept taut (within rope length of anchor)", (() => {
  const d = Math.hypot(h.player.posX - S.state.anchor.x, h.player.posY - S.state.anchor.y, h.player.posZ - S.state.anchor.z);
  return d <= S.state.ropeLen + 1.5;
})());
h.ModAPI.settings.keyBindForward.pressed = 0;

// key repeats must not flap the web
h.key("KeyV", true);
h.key("KeyV", true);
check("held V does not re-fire", S.state.attached === true);

// release
h.key("KeyV");
check("released", S.state.attached === false);

// landing auto-release, but not during the grace window
h.key("KeyV");
h.player.onGround = 1;
h.player.motionY = -0.1;
h.fire("update");
check("grace window survives ground contact", S.state.attached === true);
for (let i = 0; i < 20 && S.state.attached; i++) {
  h.fire("update");
  // standing on a block: vanilla clamps downward motion to 0 every tick
  h.player.motionY = Math.min(h.player.motionY - 0.08, 0);
}
check("auto-released after landing", S.state.attached === false);

// wall crawl
if (S.state.attached) h.key("KeyV");
h.key("KeyC");
check("cling toggled on", S.state.clinging === true);
h.player.isCollidedHorizontally = 1;
h.player.motionY = -0.5;
h.ModAPI.settings.keyBindJump.pressed = 1;
h.fire("update");
check("climbs while jumping against a wall", h.player.motionY === S.CONFIG.CLIMB_SPEED, h.player.motionY);
h.ModAPI.settings.keyBindJump.pressed = 0;
h.fire("update");
check("sticks to the wall when idle", h.player.motionY === S.CONFIG.CLING_STICK, h.player.motionY);
h.player.isCollidedHorizontally = 0;
h.fire("update");
check("no wall contact = no cling", S.state.clingContact === false);

// hud + debug paths must not throw
h.fire("frame");
h.key("KeyP");
check("debug dump ran", h.chatLog.some((m) => m.indexOf("spidermod:") === 0), h.chatLog);

console.log(fails ? "\n" + fails + " FAILURE(S)" : "\nall spidermod checks passed");
process.exit(fails ? 1 : 0);
