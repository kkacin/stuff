// ============================================================
// spidermod v1 — pendulum web-swinging + wall-crawl
// Target: EaglercraftX 1.8.8 via EaglerForgeInjector
// ============================================================

(function () {
  "use strict";

  const CONFIG = {
    // --- keys (letters only; the `key` event ignores esc/chat keys) ---
    KEY_SWING: "KeyV",      // fire / release web
    KEY_CLING: "KeyC",      // toggle wall-crawl
    KEY_DEBUG: "KeyP",      // dump world-object info to console

    // --- swing ---
    MAX_RANGE: 32,          // blocks; anchor search distance
    RAY_STEP: 0.25,         // raycast granularity
    AIM_PITCH: [-35, -25, -15, -5],  // upward bias, degrees
    AIM_YAW: [0, -12, 12, -24, 24],  // fan width for auto-aim
    REEL_SPEED: 0.035,      // rope shortening per tick -> the accelerating arc
    MIN_ROPE: 4,
    DAMPING: 0.995,
    RELEASE_BOOST: 0.16,    // upward kick on release if already rising
    SWING_INPUT: 0.02,      // tangential accel from movement input

    // --- wall-crawl ---
    CLING_DIST: 0.35,       // how close to a wall counts as contact
    CLIMB_SPEED: 0.14,
    CLING_STICK: 0.0,       // motionY while clinging, idle

    // set true if you confirm ModAPI.settings exposes live keybinding state
    USE_LIVE_KEYBINDS: false,
  };

  ModAPI.require("player");
  ModAPI.require("settings");

  // ============================================================
  // EVENT BINDING — tolerant, because event names vary by build
  // ============================================================
  // ModAPI throws "This event does not exist!" on an unknown name, which
  // would kill the whole mod. Try aliases, log what stuck, never throw.
  function on(names, fn) {
    const list = Array.isArray(names) ? names : [names];
    for (const n of list) {
      try {
        ModAPI.addEventListener(n, fn);
        console.log("[spidermod] bound event:", n);
        return n;
      } catch (e) { /* try next alias */ }
    }
    console.warn("[spidermod] NO event matched:", list.join(" / "));
    return null;
  }

  // Run SpiderMod.listEvents() in the console to find the real names.
  function listEvents() {
    console.log("[spidermod] ModAPI keys:", Object.keys(ModAPI));
    for (const k of Object.keys(ModAPI)) {
      const v = ModAPI[k];
      if (v && typeof v === "object") {
        const sub = Object.keys(v);
        if (sub.length && sub.length < 80) {
          console.log("[spidermod] ModAPI." + k + ":", sub.join(", "));
        }
      }
    }
  }

  const state = {
    attached: false,
    anchor: null,
    ropeLen: 0,
    clinging: false,
    clingNormal: null,
    lastAnchorCandidate: null,
    worldRef: null,
    worldPathTried: null,
  };

  // ============================================================
  // WORLD ACCESS  <-- the one thing you must verify first
  // ============================================================
  // The ModAPI docs don't expose a block lookup directly. `mcinstance` is the
  // raw Minecraft object, so the world is reachable but the field name depends
  // on whether your build is minified. Compile with `minifying: false` in
  // build.gradle first, then press KEY_DEBUG in-game and read the console.

  function resolveWorld() {
    const mc = ModAPI.mcinstance;
    if (!mc) return null;
    const candidates = ["theWorld", "world", "field_71441_e"];
    for (const name of candidates) {
      if (mc[name]) {
        state.worldPathTried = name;
        return mc[name];
      }
    }
    return null;
  }

  function debugWorld() {
    const mc = ModAPI.mcinstance;
    console.log("[spidermod] mcinstance keys:", mc ? Object.keys(mc) : "none");
    const w = resolveWorld();
    console.log("[spidermod] world via:", state.worldPathTried, w);
    if (w) console.log("[spidermod] world keys:", Object.keys(w));
    ModAPI.displayToChat({ msg: "spidermod: world info dumped to console" });
  }

  // ADAPTER: fill this in once you know the real call shape.
  // In unobfuscated 1.8 it is roughly:
  //   world.getBlockState(new BlockPos(x,y,z)).getBlock().getMaterial().isSolid()
  function isSolid(x, y, z) {
    if (!state.worldRef) state.worldRef = resolveWorld();
    const w = state.worldRef;
    if (!w) return false;

    try {
      const BlockPos = ModAPI.hooks._classMap["net.minecraft.util.BlockPos"];
      const pos = new BlockPos(Math.floor(x), Math.floor(y), Math.floor(z));
      const bs = w.getBlockState(pos);
      const block = bs.getBlock();
      return block.getMaterial().isSolid();
    } catch (e) {
      if (!isSolid._warned) {
        console.warn("[spidermod] isSolid adapter needs wiring:", e);
        isSolid._warned = true;
      }
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

  function eyePos() {
    const p = ModAPI.player;
    return { x: p.posX, y: p.posY + 1.62, z: p.posZ };
  }

  // ============================================================
  // ANCHOR SEARCH — fan of rays, upward-biased, first hit wins
  // ============================================================
  function castRay(origin, dir, maxDist) {
    for (let d = 1; d < maxDist; d += CONFIG.RAY_STEP) {
      const x = origin.x + dir.x * d;
      const y = origin.y + dir.y * d;
      const z = origin.z + dir.z * d;
      if (isSolid(x, y, z)) {
        return { x: Math.floor(x) + 0.5, y: Math.floor(y) + 0.5, z: Math.floor(z) + 0.5, dist: d };
      }
    }
    return null;
  }

  function findAnchor() {
    const p = ModAPI.player;
    const origin = eyePos();
    let best = null;

    for (const dp of CONFIG.AIM_PITCH) {
      for (const dy of CONFIG.AIM_YAW) {
        const dir = lookVec(p.rotationYaw + dy, p.rotationPitch + dp);
        const hit = castRay(origin, dir, CONFIG.MAX_RANGE);
        // prefer anchors above the player — that's what makes arcs feel right
        if (hit && hit.y > p.posY + 2) {
          if (!best || hit.dist < best.dist) best = hit;
        }
      }
    }
    return best;
  }

  // ============================================================
  // SWING
  // ============================================================
  function attach() {
    const a = findAnchor();
    if (!a) {
      ModAPI.displayToChat({ msg: "\u00a77no anchor in range" });
      return;
    }
    const p = ModAPI.player;
    state.anchor = a;
    state.ropeLen = mag(sub(a, { x: p.posX, y: p.posY, z: p.posZ }));
    state.attached = true;
  }

  function release() {
    if (!state.attached) return;
    const p = ModAPI.player;
    if (p.motionY > 0) p.motionY += CONFIG.RELEASE_BOOST;
    p.reload();
    state.attached = false;
    state.anchor = null;
  }

  function tickSwing() {
    if (!state.attached || !state.anchor) return;
    const p = ModAPI.player;
    const pos = { x: p.posX, y: p.posY, z: p.posZ };
    const d = sub(state.anchor, pos);          // player -> anchor
    const len = mag(d);

    if (len > CONFIG.MAX_RANGE * 1.5) { release(); return; }

    // reel in while below the anchor: this is what accelerates the arc
    if (state.ropeLen > CONFIG.MIN_ROPE && state.anchor.y > p.posY + 1) {
      state.ropeLen -= CONFIG.REEL_SPEED;
    }

    if (len > state.ropeLen) {
      const n = norm(d);
      const radial = dot({ x: p.motionX, y: p.motionY, z: p.motionZ }, n);

      // strip the outward velocity component -> pure pendulum
      if (radial < 0) {
        p.motionX -= n.x * radial;
        p.motionY -= n.y * radial;
        p.motionZ -= n.z * radial;
      }

      // snap position back onto the sphere
      const over = len - state.ropeLen;
      p.posX += n.x * over;
      p.posY += n.y * over;
      p.posZ += n.z * over;
    }

    p.motionX *= CONFIG.DAMPING;
    p.motionZ *= CONFIG.DAMPING;
    p.fallDistance = 0;
    p.reload();
  }

  // ============================================================
  // WALL-CRAWL
  // ============================================================
  function wallNormal() {
    const p = ModAPI.player;
    const y = p.posY + 1;
    const dirs = [
      { x: 1, z: 0 }, { x: -1, z: 0 },
      { x: 0, z: 1 }, { x: 0, z: -1 },
    ];
    for (const dir of dirs) {
      const cx = p.posX + dir.x * (0.3 + CONFIG.CLING_DIST);
      const cz = p.posZ + dir.z * (0.3 + CONFIG.CLING_DIST);
      if (isSolid(cx, y, cz)) return dir;
    }
    return null;
  }

  function tickCling() {
    if (!state.clinging || state.attached) return;
    const p = ModAPI.player;
    const n = wallNormal();
    if (!n) { state.clingNormal = null; return; }
    state.clingNormal = n;

    // cancel gravity, hold to the wall
    p.motionY = CONFIG.CLING_STICK;
    p.fallDistance = 0;

    if (CONFIG.USE_LIVE_KEYBINDS && ModAPI.settings) {
      const s = ModAPI.settings;
      if (s.keyBindJump && s.keyBindJump.pressed) p.motionY = CONFIG.CLIMB_SPEED;
      if (s.keyBindSneak && s.keyBindSneak.pressed) p.motionY = -CONFIG.CLIMB_SPEED;
      if (s.keyBindForward && s.keyBindForward.pressed) p.motionY = CONFIG.CLIMB_SPEED;
    }

    p.reload();
  }

  // ============================================================
  // HUD
  // ============================================================
  on(["drawhud", "drawHUD", "hud", "renderhud", "drawoverlay"], () => {
    const w = ModAPI.getdisplayWidth();
    const h = ModAPI.getdisplayHeight();

    if (state.attached) {
      ModAPI.drawStringWithShadow({
        msg: "WEB  " + state.ropeLen.toFixed(1) + "m",
        x: 6, y: 6, color: 0xFFFF5555,
      });
      // crude web line: a marker toward the anchor until 3D rendering is wired
      ModAPI.drawRect({
        left: w / 2 - 1, top: h / 2 - 10,
        right: w / 2 + 1, bottom: h / 2 - 2,
        color: 0xFFFFFFFF,
      });
    }

    if (state.clinging) {
      ModAPI.drawStringWithShadow({
        msg: state.clingNormal ? "CLING" : "cling (no wall)",
        x: 6, y: 18, color: 0xFF55AAFF,
      });
    }
  });

  // ============================================================
  // EVENTS
  // ============================================================
  on(["key", "keydown", "keypress"], (e) => {
    const k = e.key || e.code || e.keyCode;
    if (k === CONFIG.KEY_SWING) {
      e.preventDefault = true;
      state.attached ? release() : attach();
    } else if (k === CONFIG.KEY_CLING) {
      e.preventDefault = true;
      state.clinging = !state.clinging;
      ModAPI.displayToChat({ msg: "wall-crawl " + (state.clinging ? "on" : "off") });
    } else if (k === CONFIG.KEY_DEBUG) {
      e.preventDefault = true;
      debugWorld();
    }
  });

  // constraint runs after vanilla motion so we override, not fight, gravity
  on(["postmotionupdate", "postmotion", "update", "frame"], () => {
    tickSwing();
    tickCling();
  });

  on(["update", "tick", "frame"], () => {
    if (state.attached && ModAPI.player && ModAPI.player.onGround) {
      // touching down ends the swing
      if (ModAPI.player.motionY <= 0) release();
    }
  });

  window.SpiderMod = { state, CONFIG, debugWorld, findAnchor, isSolid, listEvents, on };
  console.log("[spidermod] loaded");
  listEvents();
})();
