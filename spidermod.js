// ============================================================
// spidermod v2 — pendulum web-swinging + wall-crawl
// Target: EaglercraftX 1.12.2 via EaglerForgeInjector
// (v1 targeted 1.8.8 on the legacy radmanplays ModAPI — see git history)
// ============================================================

(function spidermod() {
  "use strict";

  const CONFIG = {
    // --- keys (KeyboardEvent.code; ignored while a GUI or chat is open) ---
    KEY_SWING: "KeyV",      // fire / release web
    KEY_CLING: "KeyC",      // toggle wall-crawl
    KEY_DEBUG: "KeyP",      // dump adapter state to the console

    // --- swing ---
    MAX_RANGE: 32,          // blocks; anchor search distance
    AIM_PITCH: [-35, -25, -15, -5],  // upward bias, degrees
    AIM_YAW: [0, -12, 12, -24, 24],  // fan width for auto-aim
    MIN_ANCHOR_RISE: 2,     // anchor must be this far above the player
    REEL_SPEED: 0.035,      // automatic rope shortening per tick -> accelerating arc
    MANUAL_REEL: 0.09,      // jump reels in, sneak pays out, while swinging
    MIN_ROPE: 4,
    MAX_ROPE: 40,
    DAMPING: 0.995,
    RELEASE_BOOST: 0.16,    // upward kick on release if already rising
    SWING_INPUT: 0.02,      // tangential accel while holding forward
    ATTACH_HOP: 0.42,       // kick off the ground when firing a web while standing
    ATTACH_GRACE: 10,       // ticks before a ground touch can end the swing
    ROPE_CORRECTION: 0.7,   // 0..1, how hard the rope snaps back onto the sphere
    GRAVITY_GUESS: 0.08,    // vanilla player gravity, used to predict the next tick

    // --- wall-crawl ---
    CLIMB_SPEED: 0.2,       // parity with ladders
    CLING_STICK: 0.0,       // motionY while clinging, idle

    // --- misc ---
    HUD: true,
    FORCE_DOM_KEYS: false,  // true = ignore GameSettings keybinds, read the browser only
  };

  // ============================================================
  // METADATA
  // ============================================================
  ModAPI.meta.title("SpiderMod");
  ModAPI.meta.version("2.0.0");
  ModAPI.meta.description(
    "Web-swinging and wall-crawling for 1.12.2. V fires/releases a web (jump reels in, sneak pays out), C toggles wall-crawl, P dumps debug info."
  );
  ModAPI.meta.credits("kkacin");

  ModAPI.require("player");
  ModAPI.require("world");

  // ============================================================
  // VERSION COMPAT
  // ============================================================
  // Everything this mod touches kept its name from 1.8 to 1.12 except:
  //   * BlockPos moved to net.minecraft.util.math
  //   * getMaterial() moved off Block onto IBlockState
  //   * Minecraft.theWorld/thePlayer became world/player (the injector aliases
  //     both, so ModAPI.player and ModAPI.world work on either version)
  const IS_1_12 = !!ModAPI.reflect.getClassById("net.minecraft.util.math.BlockPos");
  const BlockPosClass = ModAPI.reflect.getClassById(
    IS_1_12 ? "net.minecraft.util.math.BlockPos" : "net.minecraft.util.BlockPos"
  );
  const newBlockPos = BlockPosClass
    ? BlockPosClass.constructors.find((c) => c.length === 3)
    : null;

  const warned = new Set();
  function warnOnce(tag, err) {
    if (warned.has(tag)) return;
    warned.add(tag);
    console.warn("[spidermod] " + tag + " unavailable:", err);
  }

  function corrective(obj) {
    // TeaVM renames fields like isCollidedHorizontally -> isCollidedHorizontally0.
    // Corrective proxies resolve those suffixes for us.
    try {
      return obj && typeof obj.getCorrective === "function" ? obj.getCorrective() : obj;
    } catch (e) {
      return obj;
    }
  }

  function chat(msg) {
    try { ModAPI.displayToChat(msg); } catch (e) { console.log("[spidermod] " + msg); }
  }

  const state = {
    attached: false,
    anchor: null,
    ropeLen: 0,
    clinging: false,
    clingContact: false,
    graceTicks: 0,
    lastAnchorCandidate: null,
  };

  // ============================================================
  // WORLD ACCESS
  // ============================================================
  // ModAPI.world is a live WorldClient proxy, so block lookups are a plain
  // getBlockState() call — no more digging through mcinstance for a field name.
  const blockCache = new Map();

  function blockStateAt(bx, by, bz) {
    const key = bx + "," + by + "," + bz;
    if (blockCache.has(key)) return blockCache.get(key);
    let s = null;
    try {
      if (ModAPI.world && newBlockPos) s = ModAPI.world.getBlockState(newBlockPos(bx, by, bz));
    } catch (e) {
      warnOnce("world.getBlockState", e);
    }
    blockCache.set(key, s);
    return s;
  }

  function isSolid(x, y, z) {
    const s = blockStateAt(Math.floor(x), Math.floor(y), Math.floor(z));
    if (!s) return false;
    try {
      // 1.12: IBlockState.getMaterial(). 1.8: Block.getMaterial().
      const mat = typeof s.getMaterial === "function" ? s.getMaterial() : s.getBlock().getMaterial();
      return !!(mat && mat.isSolid());
    } catch (e) {
      warnOnce("blockState.getMaterial", e);
      return false;
    }
  }

  // ============================================================
  // MATH
  // ============================================================
  const rad = (d) => (d * Math.PI) / 180;

  function lookVec(yawDeg, pitchDeg) {
    const y = rad(yawDeg), p = rad(pitchDeg);
    const cp = Math.cos(p);
    return { x: -Math.sin(y) * cp, y: -Math.sin(p), z: Math.cos(y) * cp };
  }

  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
  const mag = (v) => Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

  function norm(v) {
    const m = mag(v) || 1;
    return { x: v.x / m, y: v.y / m, z: v.z / m };
  }

  function eyePos(p) {
    let eye = 1.62;
    try {
      if (typeof p.getEyeHeight === "function") eye = p.getEyeHeight();
    } catch (e) {
      warnOnce("player.getEyeHeight", e);
    }
    return { x: p.posX, y: p.posY + eye, z: p.posZ };
  }

  // ============================================================
  // INPUT
  // ============================================================
  // The injector has no key event, so read the browser directly and fall back
  // to it if GameSettings keybindings aren't legible on this build.
  const keysDown = new Set();

  function guiOpen() {
    try {
      return !!corrective(ModAPI.mc).currentScreen;
    } catch (e) {
      return false;
    }
  }

  function keyBind(name) {
    if (CONFIG.FORCE_DOM_KEYS) return null;
    try {
      const kb = ModAPI.settings && ModAPI.settings[name];
      return kb && typeof kb.pressed !== "undefined" ? kb : null;
    } catch (e) {
      warnOnce("settings." + name, e);
      return null;
    }
  }

  function held(bindName, domCode) {
    const kb = keyBind(bindName);
    if (kb) {
      try { return !!kb.pressed; } catch (e) { warnOnce("keybind.pressed", e); }
    }
    return keysDown.has(domCode);
  }

  const heldJump = () => held("keyBindJump", "Space");
  const heldSneak = () => held("keyBindSneak", "ShiftLeft");
  const heldForward = () => held("keyBindForward", "KeyW");

  window.addEventListener("keydown", (e) => {
    keysDown.add(e.code);
    // Held keys repeat ~30x/second; without this, holding V flaps the web.
    if (e.repeat) return;
    if (guiOpen() || !ModAPI.player) return;
    const p = corrective(ModAPI.player);
    if (e.code !== CONFIG.KEY_SWING && e.code !== CONFIG.KEY_CLING && e.code !== CONFIG.KEY_DEBUG) return;

    // these three belong to the mod, so don't let the game act on them too
    e.preventDefault();
    e.stopPropagation();

    if (e.code === CONFIG.KEY_SWING) {
      state.attached ? release(p) : attach(p);
    } else if (e.code === CONFIG.KEY_CLING) {
      state.clinging = !state.clinging;
      chat("wall-crawl " + (state.clinging ? "on" : "off"));
    } else {
      debugDump();
    }
  }, true);

  window.addEventListener("keyup", (e) => keysDown.delete(e.code), true);
  window.addEventListener("blur", () => keysDown.clear());

  // ============================================================
  // ANCHOR SEARCH — fan of rays, upward-biased, nearest hit wins
  // ============================================================
  // Voxel traversal (one block query per block crossed) instead of v1's fixed
  // 0.25-block sampling, so a 32-block ray costs ~32 lookups, not 128.
  function castRay(origin, dir, maxDist) {
    let bx = Math.floor(origin.x), by = Math.floor(origin.y), bz = Math.floor(origin.z);
    const stepX = dir.x > 0 ? 1 : -1;
    const stepY = dir.y > 0 ? 1 : -1;
    const stepZ = dir.z > 0 ? 1 : -1;

    const invX = dir.x !== 0 ? Math.abs(1 / dir.x) : Infinity;
    const invY = dir.y !== 0 ? Math.abs(1 / dir.y) : Infinity;
    const invZ = dir.z !== 0 ? Math.abs(1 / dir.z) : Infinity;

    // distance along the ray to the first grid plane in each axis
    let tX = dir.x !== 0 ? ((dir.x > 0 ? bx + 1 - origin.x : origin.x - bx) * invX) : Infinity;
    let tY = dir.y !== 0 ? ((dir.y > 0 ? by + 1 - origin.y : origin.y - by) * invY) : Infinity;
    let tZ = dir.z !== 0 ? ((dir.z > 0 ? bz + 1 - origin.z : origin.z - bz) * invZ) : Infinity;

    let t = 0;
    while (t <= maxDist) {
      if (t > 1 && isSolid(bx, by, bz)) {
        return { x: bx + 0.5, y: by + 0.5, z: bz + 0.5, dist: t };
      }
      if (tX <= tY && tX <= tZ) {
        bx += stepX; t = tX; tX += invX;
      } else if (tY <= tZ) {
        by += stepY; t = tY; tY += invY;
      } else {
        bz += stepZ; t = tZ; tZ += invZ;
      }
    }
    return null;
  }

  function findAnchor(p) {
    const origin = eyePos(p);
    let best = null;

    for (const dp of CONFIG.AIM_PITCH) {
      for (const dy of CONFIG.AIM_YAW) {
        const dir = lookVec(p.rotationYaw + dy, p.rotationPitch + dp);
        const hit = castRay(origin, dir, CONFIG.MAX_RANGE);
        // prefer anchors above the player — that's what makes arcs feel right
        if (hit && hit.y > p.posY + CONFIG.MIN_ANCHOR_RISE) {
          if (!best || hit.dist < best.dist) best = hit;
        }
      }
    }
    state.lastAnchorCandidate = best;
    return best;
  }

  // ============================================================
  // SWING
  // ============================================================
  function attach(p) {
    const a = findAnchor(p);
    if (!a) {
      chat("§7no anchor in range");
      return;
    }
    const len = mag(sub(a, { x: p.posX, y: p.posY, z: p.posZ }));
    state.anchor = a;
    state.ropeLen = Math.min(Math.max(len, CONFIG.MIN_ROPE), CONFIG.MAX_ROPE);
    state.attached = true;
    // Swinging off from a standing start: hop, and hold off the landing check
    // for a few ticks, or the ground test below would cut the web instantly.
    state.graceTicks = CONFIG.ATTACH_GRACE;
    if (p.onGround && p.motionY <= 0) p.motionY = CONFIG.ATTACH_HOP;
  }

  function release(p) {
    if (!state.attached) return;
    if (p && p.motionY > 0) p.motionY += CONFIG.RELEASE_BOOST;
    state.attached = false;
    state.anchor = null;
    state.graceTicks = 0;
  }

  function setPosition(p, x, y, z) {
    // setPosition() also moves the bounding box; writing posX/Y/Z alone leaves
    // collision a tick behind and the player clips into the wall they swing past.
    try {
      if (typeof p.setPosition === "function") {
        p.setPosition(x, y, z);
        return;
      }
    } catch (e) {
      warnOnce("player.setPosition", e);
    }
    p.posX = x; p.posY = y; p.posZ = z;
  }

  function tickSwing(p) {
    if (!state.attached || !state.anchor) return;
    const pos = { x: p.posX, y: p.posY, z: p.posZ };
    const toAnchor = sub(state.anchor, pos);

    if (mag(toAnchor) > CONFIG.MAX_RANGE * 1.5) { release(p); return; }

    // rope length: jump reels in, sneak pays out, otherwise reel in slowly
    // while below the anchor — that slow reel is what accelerates the arc
    if (heldJump()) {
      state.ropeLen -= CONFIG.MANUAL_REEL;
    } else if (heldSneak()) {
      state.ropeLen += CONFIG.MANUAL_REEL;
    } else if (state.anchor.y > p.posY + 1) {
      state.ropeLen -= CONFIG.REEL_SPEED;
    }
    state.ropeLen = Math.min(Math.max(state.ropeLen, CONFIG.MIN_ROPE), CONFIG.MAX_ROPE);

    const n = norm(toAnchor);

    // pump the swing: push along the tangent, in the direction we're looking
    if (heldForward()) {
      const look = lookVec(p.rotationYaw, p.rotationPitch);
      const tangent = norm(sub(look, { x: n.x * dot(look, n), y: n.y * dot(look, n), z: n.z * dot(look, n) }));
      p.motionX += tangent.x * CONFIG.SWING_INPUT;
      p.motionY += tangent.y * CONFIG.SWING_INPUT;
      p.motionZ += tangent.z * CONFIG.SWING_INPUT;
    }

    // The `update` event fires before vanilla movement, so constrain against
    // where this tick is about to put us rather than where we already are.
    const pred = {
      x: pos.x + p.motionX,
      y: pos.y + p.motionY - CONFIG.GRAVITY_GUESS,
      z: pos.z + p.motionZ,
    };
    const d = sub(state.anchor, pred);
    const len = mag(d);

    if (len > state.ropeLen) {
      const rn = norm(d);
      const radial = dot({ x: p.motionX, y: p.motionY, z: p.motionZ }, rn);

      // strip the outward velocity component -> pure pendulum
      if (radial < 0) {
        p.motionX -= rn.x * radial;
        p.motionY -= rn.y * radial;
        p.motionZ -= rn.z * radial;
      }

      // and pull what's left of the stretch back onto the sphere
      const over = (len - state.ropeLen) * CONFIG.ROPE_CORRECTION;
      setPosition(p, pos.x + rn.x * over, pos.y + rn.y * over, pos.z + rn.z * over);
    }

    p.motionX *= CONFIG.DAMPING;
    p.motionZ *= CONFIG.DAMPING;
    p.fallDistance = 0;
  }

  // ============================================================
  // WALL-CRAWL
  // ============================================================
  // v1 probed the four horizontal neighbours for a solid block. The engine
  // already tracks this, and isCollidedHorizontally handles slabs, stairs and
  // fences correctly for free.
  function tickCling(p) {
    if (!state.clinging || state.attached) return;
    state.clingContact = !!p.isCollidedHorizontally;
    if (!state.clingContact) return;

    if (heldJump() || heldForward()) {
      p.motionY = CONFIG.CLIMB_SPEED;
    } else if (heldSneak()) {
      p.motionY = -CONFIG.CLIMB_SPEED;
    } else {
      p.motionY = CONFIG.CLING_STICK;
    }
    p.fallDistance = 0;
  }

  // ============================================================
  // HUD — a DOM overlay; the injector exposes no font renderer
  // ============================================================
  const hud = CONFIG.HUD ? buildHud() : null;

  function buildHud() {
    const el = document.createElement("div");
    el.style.cssText = [
      "position:fixed", "top:6px", "left:8px", "z-index:200",
      "pointer-events:none", "font:12px monospace", "line-height:1.4",
      "text-shadow:1px 1px 0 #000", "white-space:pre", "display:none",
    ].join(";");
    document.documentElement.appendChild(el);
    return el;
  }

  function updateHud() {
    if (!hud) return;
    const lines = [];
    if (state.attached) lines.push("‹WEB› " + state.ropeLen.toFixed(1) + "m");
    if (state.clinging) lines.push(state.clingContact ? "CLING" : "cling (no wall)");
    const text = lines.join("\n");
    if (text === hud._text) return;
    hud._text = text;
    hud.textContent = text;
    hud.style.color = state.attached ? "#ff5555" : "#55aaff";
    hud.style.display = text ? "block" : "none";
  }

  // ============================================================
  // DEBUG
  // ============================================================
  function debugDump() {
    const p = ModAPI.player ? corrective(ModAPI.player) : null;
    const info = {
      modapiVersion: ModAPI.version,
      detected: IS_1_12 ? "1.12" : "1.8",
      is_1_12_flag: ModAPI.is_1_12,
      blockPosCtor: !!newBlockPos,
      world: !!ModAPI.world,
      blockBelowPlayer: p ? String(blockStateAt(Math.floor(p.posX), Math.floor(p.posY) - 1, Math.floor(p.posZ))) : null,
      solidBelowPlayer: p ? isSolid(p.posX, p.posY - 1, p.posZ) : null,
      keybindsLegible: !!keyBind("keyBindJump"),
      setPosition: p ? typeof p.setPosition : null,
      collidedHorizontally: p ? p.isCollidedHorizontally : null,
      state: state,
    };
    console.log("[spidermod] debug", info);
    chat("spidermod: " + (IS_1_12 ? "1.12" : "1.8") + " adapter, world=" + (!!ModAPI.world) +
      ", blocks=" + (p ? isSolid(p.posX, p.posY - 1, p.posZ) : "?") +
      ", keybinds=" + (!!keyBind("keyBindJump")) + " (details in console)");
  }

  // ============================================================
  // TICK
  // ============================================================
  ModAPI.addEventListener("update", () => {
    blockCache.clear();
    if (!ModAPI.player) return;
    const p = corrective(ModAPI.player);
    try {
      if (state.graceTicks > 0) state.graceTicks--;
      tickSwing(p);
      tickCling(p);
      // touching down ends the swing
      if (state.attached && !state.graceTicks && p.onGround && p.motionY <= 0) release(p);
    } catch (e) {
      warnOnce("tick", e);
    }
  });

  ModAPI.addEventListener("frame", updateHud);

  window.SpiderMod = {
    state, CONFIG, isSolid, findAnchor, castRay, blockStateAt, debugDump,
    is1_12: IS_1_12,
  };
  console.log("[spidermod] loaded (" + (IS_1_12 ? "1.12" : "1.8") + " adapter)");
})();
