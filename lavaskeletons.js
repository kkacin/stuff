// ============================================================
// lavaskeletons v1 — skeletons that vomit lava at you
// Target: EaglercraftX 1.12.2 via EaglerForgeInjector
//
// A skeleton that has you in its sights stops, gargles for a moment with fire
// spilling out of its jaw, then heaves an arcing stream of lava globs at you.
// The globs are real projectiles on a real ballistic arc — the mod solves the
// launch angle against the glob's own drag and gravity every shot, so they land
// on you rather than near you. Where one lands it splashes: anything close
// catches fire and a short-lived puddle of lava is left behind, which the mod
// cleans up again a few seconds later.
//
// Like smartzombies, this runs on the integrated (dedicated) server, in the
// service worker, because that's where mobs and projectiles live.
// ============================================================

(function lavaskeletons() {
  "use strict";

  ModAPI.meta.title("LavaSkeletons");
  ModAPI.meta.version("1.0.0");
  ModAPI.meta.description(
    "Skeletons gargle and vomit arcing globs of lava at you. Splashes set things alight and leave puddles that clean themselves up. Tune it in-game with /skeletons."
  );
  ModAPI.meta.credits("kkacin");

  ModAPI.dedicatedServer.appendCode(function lavaSkeletonsServer() {
    "use strict";

    const CONFIG = {
      ENABLED: true,
      THINK_INTERVAL: 4,       // server ticks between AI passes
      ACTIVE_RANGE: 40,        // only think about skeletons this close to a player
      MAX_PER_PASS: 32,        // hard cap on skeletons considered per pass, per world
      RARITY: 1.0,             // fraction of skeletons that can do it (stable per mob)

      // --- the vomit ---
      RANGE_MIN: 3,            // too close and they just shoot you normally
      RANGE_MAX: 16,
      GARGLE_TICKS: 16,        // telegraph: you get this long to stop standing there
      GLOBS: 3,                // globs per heave
      GLOB_DELAY: 2,           // ticks between them, so it's a stream not a shotgun
      SPEED: 1.6,              // launch speed in blocks/tick
      GRAVITY: 0.09,           // downward acceleration on a glob in flight
      SPREAD: 0.05,            // aim jitter in radians
      LEAD_TICKS: 6,           // aim ahead of a moving target
      COOLDOWN: 120,
      COOLDOWN_JITTER: 60,
      KICKBACK: 0.05,          // recoil, because it's coming up with some force
      HOLD_STILL: true,        // stop moving while gargling

      // --- the splash ---
      SPLASH_RADIUS: 2.5,
      BURN_SECONDS: 5,
      FRIENDLY_FIRE: false,    // splashes light up other skeletons too
      LAVA_POOLS: true,
      LAVA_CHANCE: 0.6,        // per candidate block
      POOL_BLOCKS: 3,          // most blocks one splash can lay down
      LAVA_TICKS: 100,         // how long a puddle lasts before it's put back
      MAX_POOLS: 24,           // hard cap on live puddles, oldest reverted first

      // --- housekeeping ---
      FIREPROOF: true,         // they're full of the stuff; it doesn't cook them
      DEATH_SPLASH: true,      // kill one and it spills
      MAX_GLOBS: 40,           // hard cap on globs tracked in flight
      GLOB_TTL: 120,           // stop tracking a glob that never landed
    };

    const PRESETS = {
      drizzle:  { RARITY: 0.34, GLOBS: 1, COOLDOWN: 200, GARGLE_TICKS: 24, SPLASH_RADIUS: 2.0, LAVA_POOLS: false, RANGE_MAX: 12 },
      normal:   { RARITY: 1.0, GLOBS: 3, COOLDOWN: 120, GARGLE_TICKS: 16, SPLASH_RADIUS: 2.5, LAVA_POOLS: true, LAVA_CHANCE: 0.6, RANGE_MAX: 16, SPEED: 1.6 },
      inferno:  { RARITY: 1.0, GLOBS: 6, COOLDOWN: 50, GARGLE_TICKS: 8, SPLASH_RADIUS: 3.5, LAVA_POOLS: true, LAVA_CHANCE: 0.9, POOL_BLOCKS: 5, RANGE_MAX: 20, SPEED: 1.9, BURN_SECONDS: 8 },
    };
    let preset = "normal";

    // Vanilla world event ids — cosmetic, and cheap: the server sends one packet
    // and every client nearby plays the sound and particles itself.
    const FX_GARGLE = 1009;  // fire extinguish "fizz" — a wet, unpleasant gurgle
    const FX_LAUNCH = 1018;  // blaze shoot
    const FX_SPLASH = 2002;  // splash potion break; data is the particle colour
    const FX_COLOUR = 0xFF6A00;

    // The glob is a vanilla EntityFireball under the hood, which integrates as
    // pos += motion; motion = (motion + acceleration) * 0.95. We zero the
    // horizontal acceleration and point the vertical one down, which turns a
    // blaze's flat dart into a thrown arc.
    const DRAG = 0.95;

    // ============================================================
    // VERSION COMPAT
    // ============================================================
    // 1.12 moved BlockPos to net.minecraft.util.math, split EntitySkeleton into
    // AbstractSkeleton (+ stray, + wither skeleton), renamed
    // World.spawnEntityInWorld to spawnEntity and playAuxSFX to playEvent.
    const IS_1_12 = !!ModAPI.reflect.getClassById("net.minecraft.util.math.BlockPos");
    const SkeletonClass =
      ModAPI.reflect.getClassById("net.minecraft.entity.monster.AbstractSkeleton") ||
      ModAPI.reflect.getClassById("net.minecraft.entity.monster.EntitySkeleton");
    const FireballClass = ModAPI.reflect.getClassById("net.minecraft.entity.projectile.EntitySmallFireball");
    const BlockPosClass = ModAPI.reflect.getClassById(
      IS_1_12 ? "net.minecraft.util.math.BlockPos" : "net.minecraft.util.BlockPos"
    );
    const TextClass = ModAPI.reflect.getClassById(
      IS_1_12 ? "net.minecraft.util.text.TextComponentString" : "net.minecraft.util.ChatComponentText"
    );
    const newBlockPos = BlockPosClass ? BlockPosClass.constructors.find((c) => c.length === 3) : null;
    // EntitySmallFireball(World, EntityLivingBase shooter, double ax, ay, az) —
    // the shooter form, so damage is credited to the skeleton and the glob
    // doesn't immediately raytrace into its own ribcage.
    const newFireball = FireballClass ? FireballClass.constructors.find((c) => c.length === 5) : null;

    const warned = new Set();
    let errors = 0;

    function softFail(tag, err) {
      if (warned.has(tag)) return;
      warned.add(tag);
      console.warn("[lavaskeletons] " + tag + " unavailable:", err);
    }

    function hardFail(err) {
      errors++;
      console.error("[lavaskeletons] pass failed:", err);
      if (errors >= 10) {
        CONFIG.ENABLED = false;
        queue.length = 0;
        globs.length = 0;
        revertAllPools();
        console.error("[lavaskeletons] disabled after 10 failures; skeletons are back to vanilla.");
      }
    }

    const stats = { skeletons: 0, gargling: 0, bursts: 0, globs: 0, splashes: 0, ignited: 0, pools: 0 };

    if (!SkeletonClass) {
      console.error("[lavaskeletons] no skeleton class in this build; disabled.");
      CONFIG.ENABLED = false;
    }
    if (!newFireball) {
      console.error("[lavaskeletons] EntitySmallFireball has no (world, shooter, x, y, z) constructor; disabled.");
      CONFIG.ENABLED = false;
    }

    // ============================================================
    // SMALL HELPERS
    // ============================================================
    const num = (v, dflt) => (typeof v === "number" && isFinite(v) ? v : dflt);
    const raw = (o) => (o && typeof o.getRef === "function" ? o.getRef() : o);
    const pos = (e) => ({ x: num(e.posX, 0), y: num(e.posY, 0), z: num(e.posZ, 0) });

    function dist2(a, b) {
      const dx = num(a.posX, 0) - num(b.posX, 0);
      const dy = num(a.posY, 0) - num(b.posY, 0);
      const dz = num(a.posZ, 0) - num(b.posZ, 0);
      return dx * dx + dy * dy + dz * dz;
    }

    function call(obj, name, dflt) {
      try {
        if (obj && typeof obj[name] === "function") return obj[name]();
      } catch (e) {
        softFail(name, e);
      }
      return dflt;
    }

    // 1.8 and 1.12 disagree on a few method names; take whichever is there.
    function callAny(obj, names, args, tag) {
      for (const name of names) {
        try {
          if (obj && typeof obj[name] === "function") return obj[name].apply(obj, args);
        } catch (e) {
          softFail(tag || name, e);
          return undefined;
        }
      }
      softFail(tag || names[0], "no such method");
      return undefined;
    }

    function entityId(e) {
      const id = call(e, "getEntityId", null);
      return id === null ? num(e.entityId, -1) : id;
    }

    let worldsKey = null;

    function worlds() {
      const server = ModAPI.server;
      if (!server) return [];
      const ref = typeof server.getRef === "function" ? server.getRef() : server;
      if (!worldsKey) {
        // 1.12: MinecraftServer.worlds. 1.8: MinecraftServer.worldServers.
        worldsKey = ["$worlds", "$worldServers"]
          .map((k) => ModAPI.util.getNearestProperty(ref, k))
          .find((k) => ref[k] && Array.isArray(ref[k].data)) || null;
        if (!worldsKey) {
          worldsKey = Object.keys(ref)
            .find((k) => k.startsWith("$world") && ref[k] && Array.isArray(ref[k].data)) || null;
        }
        if (!worldsKey) {
          softFail("MinecraftServer.worlds", "no world array field found");
          return [];
        }
      }
      const out = [];
      ref[worldsKey].data.forEach((w) => {
        if (w) out.push(ModAPI.util.wrap(w, {}, true));
      });
      return out;
    }

    // ============================================================
    // BLOCKS
    // ============================================================
    function blockPos(x, y, z) {
      try {
        if (newBlockPos) return newBlockPos(Math.floor(x), Math.floor(y), Math.floor(z));
      } catch (e) {
        softFail("new BlockPos", e);
      }
      return null;
    }

    function blockStateAt(world, x, y, z) {
      const p = blockPos(x, y, z);
      if (!p) return null;
      try {
        return world.getBlockState(p);
      } catch (e) {
        softFail("world.getBlockState", e);
        return null;
      }
    }

    function isAir(world, x, y, z) {
      const p = blockPos(x, y, z);
      if (!p) return false;
      try {
        return !!world.isAirBlock(p);
      } catch (e) {
        softFail("world.isAirBlock", e);
        return false;
      }
    }

    function isSolid(world, x, y, z) {
      const s = blockStateAt(world, x, y, z);
      if (!s) return false;
      try {
        // 1.12: IBlockState.getMaterial(). 1.8: Block.getMaterial().
        const mat = typeof s.getMaterial === "function" ? s.getMaterial() : s.getBlock().getMaterial();
        return !!(mat && mat.isSolid());
      } catch (e) {
        softFail("blockState.getMaterial", e);
        return false;
      }
    }

    function setBlock(world, x, y, z, state) {
      const p = blockPos(x, y, z);
      if (!p) return false;
      try {
        // flag 2 = tell the clients, but don't notify neighbours. Without the
        // neighbour update the lava never gets a chance to start flowing, so
        // the puddle stays exactly where we put it until we take it away.
        if (typeof world.setBlockState === "function") {
          world.setBlockState(p, raw(state), 2);
          return true;
        }
      } catch (e) {
        softFail("world.setBlockState", e);
      }
      return false;
    }

    let lavaBlock = null;
    let lavaState = null;
    let lavaLooked = false;

    function lava() {
      if (lavaLooked) return lavaState;
      lavaLooked = true;
      try {
        const blocks =
          ModAPI.blocks ||
          (ModAPI.reflect.getClassById("net.minecraft.init.Blocks") || {}).staticVariables;
        // 1.12 names it LAVA, 1.8 names it lava. Still lava, not flowing: a
        // static liquid doesn't spread on its own.
        const b = blocks && (blocks.LAVA || blocks.lava);
        if (!b) throw new Error("Blocks.LAVA not found");
        lavaBlock = raw(b);
        lavaState = raw(b.getDefaultState());
      } catch (e) {
        softFail("Blocks.LAVA", e);
        lavaState = null;
      }
      return lavaState;
    }

    function mobGriefing(world) {
      try {
        const rules = world.getGameRules();
        if (rules && typeof rules.getBoolean === "function") {
          return !!rules.getBoolean(ModAPI.util.str("mobGriefing"));
        }
      } catch (e) {
        softFail("gameRules.mobGriefing", e);
      }
      return true;
    }

    function playFx(world, id, x, y, z, data) {
      const p = blockPos(x, y, z);
      if (!p) return;
      // 1.12: playEvent. 1.8: playAuxSFX. Same arguments either way.
      callAny(world, ["playEvent", "playAuxSFX"], [null, id, p, data || 0], "world.playEvent");
    }

    // ============================================================
    // LAVA PUDDLES — placed, remembered, and taken away again
    // ============================================================
    // Nothing this mod puts into the world is permanent. Every block we set is
    // recorded with the state that was there before, and put back on a timer,
    // when the mod is turned off, or when it gives up after too many failures.
    const pools = [];

    function revertPool(pool) {
      try {
        const now = blockStateAt(pool.world, pool.x, pool.y, pool.z);
        const block = now ? raw(call(now, "getBlock", null)) : null;
        // Somebody replaced our lava in the meantime — leave their block alone.
        if (block && lavaBlock && block !== lavaBlock) return;
        setBlock(pool.world, pool.x, pool.y, pool.z, pool.prev);
      } catch (e) {
        softFail("revert puddle", e);
      }
    }

    function placePool(world, x, y, z) {
      const state = lava();
      if (!state) return false;
      if (!isAir(world, x, y, z)) return false;
      if (!isSolid(world, x, y - 1, z)) return false; // no puddles hanging in mid-air

      const prev = blockStateAt(world, x, y, z);
      if (!setBlock(world, x, y, z, state)) return false;

      pools.push({
        world: world,
        ref: raw(world),
        x: Math.floor(x), y: Math.floor(y), z: Math.floor(z),
        prev: prev ? raw(prev) : null,
        expire: ticks + CONFIG.LAVA_TICKS,
      });
      stats.pools++;
      while (pools.length > CONFIG.MAX_POOLS) revertPool(pools.shift());
      return true;
    }

    function expirePools() {
      while (pools.length && pools[0].expire <= ticks) revertPool(pools.shift());
    }

    function revertAllPools() {
      while (pools.length) revertPool(pools.shift());
    }

    function nearAPool(world, e) {
      const x = num(e.posX, 0), y = num(e.posY, 0), z = num(e.posZ, 0);
      const ref = raw(world);
      for (const p of pools) {
        if (p.ref !== ref) continue;
        if (Math.abs(p.x + 0.5 - x) <= 1.5 && Math.abs(p.z + 0.5 - z) <= 1.5 && Math.abs(p.y - y) <= 2) {
          return true;
        }
      }
      return false;
    }

    // ============================================================
    // BRAINS — per-skeleton scratch state, keyed by entity id
    // ============================================================
    const brains = new Map();
    let ticks = 0;

    function brainOf(id) {
      let b = brains.get(id);
      if (!b) {
        b = { cooldown: Math.floor(Math.random() * CONFIG.COOLDOWN), gargleUntil: -1, lastBurst: -999, lastPos: null, touched: ticks };
        brains.set(id, b);
      }
      b.touched = ticks;
      return b;
    }

    function prune() {
      brains.forEach((b, id) => {
        if (ticks - b.touched > 1200) brains.delete(id);
      });
      tracks.forEach((t, id) => {
        if (ticks - t.tick > 1200) tracks.delete(id);
      });
    }

    // Whether a given skeleton is one of the lava-filled ones. Hashed off the
    // entity id so it's the same answer every pass — a skeleton doesn't get to
    // re-roll its luck four times a second.
    function isLavaFilled(id) {
      if (CONFIG.RARITY >= 1) return true;
      if (CONFIG.RARITY <= 0) return false;
      const h = Math.abs(Math.sin(id * 127.1) * 43758.5453);
      return h - Math.floor(h) < CONFIG.RARITY;
    }

    // ============================================================
    // TARGETS
    // ============================================================
    function targetOf(s) {
      const t = call(s, "getAttackTarget", null);
      if (!t) return null;
      try {
        if (t.isDead || call(t, "getHealth", 1) <= 0) return null;
      } catch (e) { /* treat an unreadable target as live */ }
      return t;
    }

    function canSee(s, target) {
      try {
        const senses = s.getEntitySenses();
        if (senses && typeof senses.canSee === "function") return !!senses.canSee(raw(target));
      } catch (e) {
        softFail("entitySenses.canSee", e);
      }
      return true;
    }

    // Target velocity, measured from position deltas between passes: a player's
    // server-side motionX comes from packets and is mostly zero.
    const tracks = new Map();

    function track(target) {
      const id = entityId(target);
      const p = pos(target);
      let t = tracks.get(id);
      if (!t) {
        t = { x: p.x, z: p.z, tick: ticks, vx: 0, vz: 0 };
        tracks.set(id, t);
        return t;
      }
      const dt = ticks - t.tick;
      if (dt > 0) {
        const vx = (p.x - t.x) / dt;
        const vz = (p.z - t.z) / dt;
        if (dt <= CONFIG.THINK_INTERVAL * 4) {
          t.vx = t.vx * 0.5 + vx * 0.5;
          t.vz = t.vz * 0.5 + vz * 0.5;
        } else {
          t.vx = 0; t.vz = 0;
        }
        t.x = p.x; t.z = p.z; t.tick = ticks;
      }
      return t;
    }

    const velocityOf = (target) => tracks.get(entityId(target)) || { vx: 0, vz: 0 };

    // ============================================================
    // GATHERING
    // ============================================================
    function livePlayers(world) {
      const out = [];
      try {
        const list = world.playerEntities;
        const n = list.size();
        for (let i = 0; i < n; i++) {
          const p = list.get(i);
          if (!p || p.isDead) continue;
          if (call(p, "isSpectator", false)) continue;
          out.push(p);
        }
      } catch (e) {
        softFail("world.playerEntities", e);
      }
      return out;
    }

    function nearAnyPlayer(e, players, range) {
      const r2 = range * range;
      for (const p of players) if (dist2(e, p) <= r2) return true;
      return false;
    }

    function findSkeletons(world, players) {
      const out = [];
      try {
        const list = world.loadedEntityList;
        const n = list.size();
        for (let i = 0; i < n && out.length < CONFIG.MAX_PER_PASS; i++) {
          const e = list.get(i);
          if (!e) continue;
          if (!SkeletonClass.instanceOf(raw(e))) continue;
          const id = entityId(e);
          if (e.isDead) {
            // It stays in the list for a tick after it dies, which is our one
            // chance to spill what it was carrying.
            const b = brains.get(id);
            if (b && !b.spilled) {
              b.spilled = true;
              if (CONFIG.DEATH_SPLASH && b.lastPos && isLavaFilled(id)) {
                splash(world, b.lastPos.x, b.lastPos.y + 0.5, b.lastPos.z, id);
              }
            }
            continue;
          }
          if (!isLavaFilled(id)) continue;
          if (!nearAnyPlayer(e, players, CONFIG.ACTIVE_RANGE)) continue;
          out.push(e);
        }
      } catch (e) {
        softFail("world.loadedEntityList", e);
      }
      return out;
    }

    // ============================================================
    // AIMING — solve the arc instead of guessing at it
    // ============================================================
    // A glob loses 5% of its speed every tick and gains GRAVITY downward, so
    // the schoolbook ballistics formula misses badly. Walking a few dozen
    // candidate launch angles through the glob's own integration step is a
    // couple of hundred multiplications and it actually hits.
    const AIM_SAMPLES = 32;
    const AIM_MIN = -1.0;    // radians; straight-ish down, off a ledge
    const AIM_MAX = 1.05;    // ~60 degrees, the lob for something behind cover
    const AIM_STEPS = 120;
    const AIM_REFINE = 2;    // rounds of narrowing in around the best angle
    const AIM_TOLERANCE = 2.5;

    // How far above or below the target this launch angle passes, or null if it
    // never gets there at all. This is the glob's own integration step, so the
    // answer is the one the world will give.
    function arcMiss(pitch, dHoriz, dy, speed, gravity) {
      let vh = Math.cos(pitch) * speed;
      let vy = Math.sin(pitch) * speed;
      let h = 0, y = 0;
      for (let t = 0; t < AIM_STEPS; t++) {
        const prevH = h, prevY = y;
        h += vh;
        y += vy;
        vh *= DRAG;
        vy = (vy - gravity) * DRAG;
        if (h >= dHoriz) {
          // interpolate where the arc crossed the target's distance
          const f = h === prevH ? 0 : (dHoriz - prevH) / (h - prevH);
          return Math.abs(prevY + (y - prevY) * f - dy);
        }
        if (y < dy - 40) return null;   // fell short
        if (vh < 0.01) return null;     // out of puff
      }
      return null;
    }

    function solveArc(dHoriz, dy, speed, gravity) {
      if (!(dHoriz > 0) || !isFinite(dy)) return null;
      let best = null;
      let lo = AIM_MIN, hi = AIM_MAX, samples = AIM_SAMPLES;
      for (let round = 0; round <= AIM_REFINE; round++) {
        const width = (hi - lo) / samples;
        for (let i = 0; i <= samples; i++) {
          const pitch = lo + width * i;
          const err = arcMiss(pitch, dHoriz, dy, speed, gravity);
          if (err !== null && (!best || err < best.err)) best = { pitch: pitch, err: err };
        }
        if (!best) return null;
        // narrow to the neighbours of the best angle and look again
        lo = Math.max(AIM_MIN, best.pitch - width);
        hi = Math.min(AIM_MAX, best.pitch + width);
        samples = 6;
      }
      // Still missing by a couple of blocks means it simply can't reach.
      return best.err < AIM_TOLERANCE ? best : null;
    }

    // ============================================================
    // THE VOMIT ITSELF
    // ============================================================
    const globs = [];
    const queue = [];   // scheduled globs: a heave is a stream, not one lump

    function spawnGlob(world, skel, from, vx, vy, vz) {
      try {
        const fb = ModAPI.util.wrap(newFireball(raw(world), raw(skel), vx, vy, vz), {}, true);
        fb.setPosition(from.x, from.y, from.z);
        fb.motionX = vx;
        fb.motionY = vy;
        fb.motionZ = vz;
        // The constructor points a blaze's flat 0.1/tick thrust at the target;
        // we take it away and hang gravity on the glob instead, which is what
        // turns the dart into an arc.
        fb.accelerationX = 0;
        fb.accelerationY = -CONFIG.GRAVITY;
        fb.accelerationZ = 0;
        callAny(world, ["spawnEntity", "spawnEntityInWorld"], [raw(fb)], "world.spawnEntity");
        globs.push({ e: fb, world: world, x: from.x, y: from.y, z: from.z, age: 0, owner: entityId(skel) });
        while (globs.length > CONFIG.MAX_GLOBS) globs.shift();
        stats.globs++;
        return true;
      } catch (e) {
        softFail("spawn glob", e);
        return false;
      }
    }

    // Where the glob starts, where it's going, and the launch angle that gets
    // it there — or null if nothing in the mod's angle range reaches. Asked
    // once before the gargle starts and again at the moment of each glob, so a
    // skeleton never telegraphs a shot it can't make.
    function arcTo(skel, target) {
      const eye = num(call(skel, "getEyeHeight", 1.62), 1.62);
      const from = {
        x: num(skel.posX, 0),
        y: num(skel.posY, 0) + eye * 0.9,
        z: num(skel.posZ, 0),
      };

      // Aim at the chest, ahead of where they're running.
      const v = velocityOf(target);
      const aim = {
        x: num(target.posX, 0) + v.vx * CONFIG.LEAD_TICKS,
        y: num(target.posY, 0) + num(call(target, "getEyeHeight", 1.62), 1.62) * 0.55,
        z: num(target.posZ, 0) + v.vz * CONFIG.LEAD_TICKS,
      };

      const dx = aim.x - from.x;
      const dz = aim.z - from.z;
      const dHoriz = Math.sqrt(dx * dx + dz * dz);
      const solution = solveArc(dHoriz, aim.y - from.y, CONFIG.SPEED, CONFIG.GRAVITY);
      if (!solution) return null;
      return { from: from, dx: dx, dz: dz, dHoriz: dHoriz, pitch: solution.pitch };
    }

    function heave(world, skel, target, brain) {
      const arc = arcTo(skel, target);
      if (!arc) return false;

      const from = arc.from, dx = arc.dx, dz = arc.dz, dHoriz = arc.dHoriz;
      const yaw = Math.atan2(dz, dx) + (Math.random() - 0.5) * 2 * CONFIG.SPREAD;
      const pitch = arc.pitch + (Math.random() - 0.5) * CONFIG.SPREAD;
      const vh = Math.cos(pitch) * CONFIG.SPEED;

      // Start the glob just outside the skull so it doesn't clip the owner.
      const mouth = {
        x: from.x + (dx / (dHoriz || 1)) * 0.4,
        y: from.y,
        z: from.z + (dz / (dHoriz || 1)) * 0.4,
      };

      if (!spawnGlob(world, skel, mouth, Math.cos(yaw) * vh, Math.sin(pitch) * CONFIG.SPEED, Math.sin(yaw) * vh)) {
        return false;
      }

      playFx(world, FX_LAUNCH, from.x, from.y, from.z, 0);
      if (CONFIG.KICKBACK > 0) {
        skel.motionX = num(skel.motionX, 0) - (dx / (dHoriz || 1)) * CONFIG.KICKBACK;
        skel.motionZ = num(skel.motionZ, 0) - (dz / (dHoriz || 1)) * CONFIG.KICKBACK;
      }
      brain.lastBurst = ticks;
      return true;
    }

    function flushQueue() {
      for (let i = queue.length - 1; i >= 0; i--) {
        const shot = queue[i];
        if (shot.at > ticks) continue;
        queue.splice(i, 1);
        try {
          if (shot.skel.isDead) continue;
          const target = targetOf(shot.skel);
          if (!target) continue;                       // lost you mid-heave
          if (!canSee(shot.skel, target)) continue;    // ducked behind something
          heave(shot.world, shot.skel, target, brainOf(entityId(shot.skel)));
        } catch (e) {
          hardFail(e);
        }
      }
    }

    function startHeave(world, skel, brain) {
      const id = entityId(skel);
      brain.gargleUntil = ticks + CONFIG.GARGLE_TICKS;
      brain.cooldown = CONFIG.GARGLE_TICKS + CONFIG.COOLDOWN + Math.floor(Math.random() * CONFIG.COOLDOWN_JITTER);
      for (let i = 0; i < CONFIG.GLOBS; i++) {
        queue.push({ skel: skel, world: world, at: ticks + CONFIG.GARGLE_TICKS + i * CONFIG.GLOB_DELAY, id: id });
      }
      stats.bursts++;
    }

    // ============================================================
    // THE SPLASH
    // ============================================================
    function ignite(world, x, y, z, ownerId) {
      const r2 = CONFIG.SPLASH_RADIUS * CONFIG.SPLASH_RADIUS;
      let lit = 0;
      try {
        const list = world.loadedEntityList;
        const n = Math.min(list.size(), 256);
        for (let i = 0; i < n; i++) {
          const e = list.get(i);
          if (!e || e.isDead) continue;
          // Living things only — no torching the dropped items or our own globs.
          if (typeof e.setFire !== "function" || typeof e.getHealth !== "function") continue;
          const id = entityId(e);
          if (id === ownerId) continue;
          if (!CONFIG.FRIENDLY_FIRE && SkeletonClass.instanceOf(raw(e)) && isLavaFilled(id)) continue;
          if (call(e, "isImmuneToFire", false)) continue;
          const dx = num(e.posX, 0) - x;
          const dy = num(e.posY, 0) - y;
          const dz = num(e.posZ, 0) - z;
          if (dx * dx + dy * dy + dz * dz > r2) continue;
          e.setFire(CONFIG.BURN_SECONDS);
          lit++;
        }
      } catch (e) {
        softFail("splash ignite", e);
      }
      stats.ignited += lit;
      return lit;
    }

    function splash(world, x, y, z, ownerId) {
      stats.splashes++;
      playFx(world, FX_SPLASH, x, y, z, FX_COLOUR);
      playFx(world, FX_GARGLE, x, y, z, 0);
      ignite(world, x, y, z, ownerId);

      if (!CONFIG.LAVA_POOLS || !mobGriefing(world)) return;

      const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
      const spots = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
      let laid = 0;
      for (const [ox, oz] of spots) {
        if (laid >= CONFIG.POOL_BLOCKS) break;
        if (Math.random() > CONFIG.LAVA_CHANCE) continue;
        // Land it on the floor: the impact point, or the block under it.
        if (placePool(world, bx + ox, by, bz + oz) || placePool(world, bx + ox, by - 1, bz + oz)) laid++;
      }
    }

    function updateGlobs() {
      for (let i = globs.length - 1; i >= 0; i--) {
        const g = globs[i];
        let dead = false;
        try {
          dead = !!g.e.isDead;
          // Read it either way: a glob that has just been killed is sitting on
          // the thing it hit, which is exactly where the splash belongs.
          g.x = num(g.e.posX, g.x);
          g.y = num(g.e.posY, g.y);
          g.z = num(g.e.posZ, g.z);
        } catch (e) {
          dead = true; // entity went away under us; splash where we last saw it
        }
        g.age++;
        if (dead) {
          globs.splice(i, 1);
          try {
            splash(g.world, g.x, g.y, g.z, g.owner);
          } catch (e) {
            hardFail(e);
          }
        } else if (g.age > CONFIG.GLOB_TTL) {
          globs.splice(i, 1); // still flying somewhere; stop caring about it
        }
      }
    }

    // ============================================================
    // PER-SKELETON PASS
    // ============================================================
    function consider(world, skel, brain) {
      brain.lastPos = pos(skel);

      // Full of lava, so their own splashes don't cook them. Daylight still
      // does: this only puts out a fire they're standing in.
      if (CONFIG.FIREPROOF && call(skel, "isBurning", false)) {
        if (ticks - brain.lastBurst < 40 || nearAPool(world, skel)) call(skel, "extinguish", null);
      }

      if (brain.cooldown > 0) brain.cooldown -= CONFIG.THINK_INTERVAL;

      if (ticks < brain.gargleUntil) {
        // Mid-gargle: stand still, look at them, dribble fire.
        stats.gargling++;
        const p = pos(skel);
        playFx(world, FX_GARGLE, p.x, p.y + 1, p.z, 0);
        if (CONFIG.HOLD_STILL) {
          try {
            const nav = skel.getNavigator();
            if (nav && typeof nav.clearPath === "function") nav.clearPath();
            else if (nav && typeof nav.clearPathEntity === "function") nav.clearPathEntity();
          } catch (e) {
            softFail("navigator.clearPath", e);
          }
          skel.motionX = num(skel.motionX, 0) * 0.2;
          skel.motionZ = num(skel.motionZ, 0) * 0.2;
        }
        return;
      }

      if (brain.cooldown > 0) return;

      const target = targetOf(skel);
      if (!target) return;

      const d2 = dist2(skel, target);
      if (d2 < CONFIG.RANGE_MIN * CONFIG.RANGE_MIN) return;
      if (d2 > CONFIG.RANGE_MAX * CONFIG.RANGE_MAX) return;
      if (!canSee(skel, target)) return;
      if (!arcTo(skel, target)) return;   // can't be reached; don't bother gargling

      try {
        const look = skel.getLookHelper();
        if (look) look.setLookPosition(num(target.posX, 0), num(target.posY, 0) + 1.6, num(target.posZ, 0), 30, 30);
      } catch (e) {
        softFail("lookHelper.setLookPosition", e);
      }

      startHeave(world, skel, brain);
    }

    // ============================================================
    // TICK
    // ============================================================
    function think() {
      let seen = 0;
      stats.gargling = 0;
      for (const world of worlds()) {
        const players = livePlayers(world);
        if (!players.length) continue;

        const skeletons = findSkeletons(world, players);
        if (!skeletons.length) continue;
        seen += skeletons.length;

        players.forEach(track);
        for (const s of skeletons) {
          consider(world, s, brainOf(entityId(s)));
        }
      }
      stats.skeletons = seen;
    }

    ModAPI.addEventListener("tick", function () {
      if (!CONFIG.ENABLED) return;
      ticks++;
      try {
        flushQueue();
        updateGlobs();
        expirePools();
        if (ticks % CONFIG.THINK_INTERVAL === 0) think();
        if (ticks % 1200 === 0) prune();
      } catch (e) {
        hardFail(e);
      }
    });

    // ============================================================
    // /skeletons — runtime control
    // ============================================================
    function reply(sender, lines) {
      [].concat(lines).forEach((line) => {
        try {
          const comp = TextClass.constructors[0](ModAPI.util.str(line));
          if (typeof sender.sendMessage === "function") sender.sendMessage(comp);
          else if (typeof sender.addChatMessage === "function") sender.addChatMessage(comp);
          else console.log("[lavaskeletons] " + line);
        } catch (e) {
          console.log("[lavaskeletons] " + line);
        }
      });
    }

    function handle(args) {
      const sub = (args[0] || "status").toLowerCase();

      if (sub === "on" || sub === "off") {
        CONFIG.ENABLED = sub === "on";
        errors = 0;
        if (sub === "off") {
          queue.length = 0;
          globs.length = 0;
          revertAllPools();
        }
        return "lavaskeletons " + sub;
      }

      if (sub === "clear") {
        const n = pools.length;
        revertAllPools();
        return "cleaned up " + n + " puddle(s)";
      }

      if (sub === "preset") {
        const name = (args[1] || "").toLowerCase();
        if (!PRESETS[name]) return "presets: " + Object.keys(PRESETS).join(", ");
        Object.assign(CONFIG, PRESETS[name]);
        preset = name;
        return "preset -> " + name;
      }

      if (sub === "set") {
        const key = (args[1] || "").toUpperCase();
        if (!(key in CONFIG)) return "unknown key " + key;
        const value = args[2];
        if (value === undefined) return key + " = " + CONFIG[key];
        const parsed = value === "true" ? true : value === "false" ? false : parseFloat(value);
        if (typeof parsed === "number" && !isFinite(parsed)) return "not a number: " + value;
        CONFIG[key] = parsed;
        preset = "custom";
        return key + " = " + CONFIG[key];
      }

      if (sub === "help") {
        return [
          "/skeletons                status",
          "/skeletons on | off       enable or disable the lava (off cleans up)",
          "/skeletons clear          put every puddle back right now",
          "/skeletons preset <name>  " + Object.keys(PRESETS).join(" | "),
          "/skeletons set KEY [v]    read or write any config value",
        ];
      }

      return [
        "lavaskeletons: " + (CONFIG.ENABLED ? "on" : "off") + ", preset " + preset +
          ", " + (IS_1_12 ? "1.12" : "1.8") + " adapter",
        "tracking " + stats.skeletons + " | gargling " + stats.gargling + " | heaves " + stats.bursts +
          " | globs " + stats.globs,
        "splashes " + stats.splashes + " | set alight " + stats.ignited + " | puddles " + pools.length +
          " live / " + stats.pools + " total",
      ];
    }

    ModAPI.addEventListener("processcommand", function (event) {
      const raw2 = String(event.command || "");
      if (!/^\/(lava)?skeletons(\s|$)/i.test(raw2)) return;
      event.preventDefault = true;
      try {
        reply(event.sender, handle(raw2.trim().split(/\s+/).slice(1)));
      } catch (e) {
        console.error("[lavaskeletons] command failed:", e);
      }
    });

    console.log("[lavaskeletons] server side online (" + (IS_1_12 ? "1.12" : "1.8") + " adapter)");
  });

  console.log("[lavaskeletons] loaded; lava queued for the integrated server");
})();
