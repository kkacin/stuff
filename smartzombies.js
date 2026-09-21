// ============================================================
// smartzombies v1 — zombie AI overhaul
// Target: EaglercraftX 1.12.2 via EaglerForgeInjector
//
// Vanilla zombies walk straight at you and shove each other into walls. These
// ones share targets, come at you from the flanks, lead a running target,
// remember where you went, sidestep out of your crosshair, and get out of the
// sun instead of burning to death.
//
// The AI runs on the integrated (dedicated) server, in the service worker,
// because that's where mobs actually live. Steering them from the client would
// just get corrected on the next position update.
// ============================================================

(function smartzombies() {
  "use strict";

  ModAPI.meta.title("SmartZombies");
  ModAPI.meta.version("1.0.0");
  ModAPI.meta.description(
    "Zombie AI overhaul: horde comms, flanking, target leading, last-known-position search, dodging and sun avoidance. Tune it in-game with /zombies."
  );
  ModAPI.meta.credits("kkacin");

  ModAPI.dedicatedServer.appendCode(function smartZombiesServer() {
    "use strict";

    const CONFIG = {
      ENABLED: true,
      THINK_INTERVAL: 4,       // server ticks between AI passes
      ACTIVE_RANGE: 40,        // only think about zombies this close to a player
      MAX_PER_PASS: 48,        // hard cap on zombies steered per pass, per world

      // --- pack tactics ---
      CHARGERS: 1,             // zombies per target that attack head-on
      FLANK_RADIUS: 6,         // how wide the rest swing out
      ENGAGE_RANGE: 3.5,       // inside this, hand back to vanilla melee AI
      CHASE_SPEED: 1.25,       // navigator speed multiplier, head-on
      FLANK_SPEED: 1.35,       // flankers hustle to get into position

      // --- prediction ---
      LEAD_TICKS: 8,           // how far ahead to aim at a moving target

      // --- memory ---
      MEMORY_TICKS: 200,       // keep hunting a lost target for ~10s
      SEARCH_SPREAD: 4,        // how far around the last known spot to poke about

      // --- horde comms ---
      COMM_RADIUS: 16,         // "he's over here" range
      ALARM_RADIUS: 24,        // range when a zombie is actually being hit

      // --- dodging ---
      DODGE: true,
      DODGE_RANGE: 5,
      DODGE_AIM: 0.94,         // how centred in your crosshair they have to be
      DODGE_PUSH: 0.32,
      DODGE_COOLDOWN: 30,

      // --- self preservation ---
      SUN_AVOID: true,
      SUN_SEARCH: 8,           // blocks to look for shade
      BREAK_DOORS: true,       // every zombie gets the door-breaking task
      UNSTICK: true,           // hop when the path is blocked (also: climb the pile)
      STUCK_TICKS: 12,
    };

    const PRESETS = {
      chill: { CHARGERS: 3, FLANK_RADIUS: 4, LEAD_TICKS: 0, CHASE_SPEED: 1.0, FLANK_SPEED: 1.0, DODGE: false, COMM_RADIUS: 10, MEMORY_TICKS: 100 },
      normal: { CHARGERS: 1, FLANK_RADIUS: 6, LEAD_TICKS: 8, CHASE_SPEED: 1.25, FLANK_SPEED: 1.35, DODGE: true, COMM_RADIUS: 16, MEMORY_TICKS: 200, DODGE_PUSH: 0.32, ALARM_RADIUS: 24 },
      nightmare: { CHARGERS: 1, FLANK_RADIUS: 9, LEAD_TICKS: 12, CHASE_SPEED: 1.45, FLANK_SPEED: 1.6, DODGE: true, COMM_RADIUS: 24, ALARM_RADIUS: 48, MEMORY_TICKS: 400, DODGE_PUSH: 0.42, THINK_INTERVAL: 2 },
    };
    let preset = "normal";

    // slot angles relative to the target's facing: sides first, then behind
    const FLANK_SLOTS = [2.0, -2.0, 2.6, -2.6, Math.PI, 1.4, -1.4];

    // ============================================================
    // VERSION COMPAT
    // ============================================================
    // 1.12 moved BlockPos to net.minecraft.util.math, moved getMaterial() onto
    // IBlockState, renamed EntityPlayer.addChatMessage to sendMessage and
    // MinecraftServer.worldServers to worlds. Class ids are otherwise unchanged.
    const IS_1_12 = !!ModAPI.reflect.getClassById("net.minecraft.util.math.BlockPos");
    const ZombieClass = ModAPI.reflect.getClassById("net.minecraft.entity.monster.EntityZombie");
    const BlockPosClass = ModAPI.reflect.getClassById(
      IS_1_12 ? "net.minecraft.util.math.BlockPos" : "net.minecraft.util.BlockPos"
    );
    const TextClass = ModAPI.reflect.getClassById(
      IS_1_12 ? "net.minecraft.util.text.TextComponentString" : "net.minecraft.util.ChatComponentText"
    );
    const newBlockPos = BlockPosClass ? BlockPosClass.constructors.find((c) => c.length === 3) : null;

    const warned = new Set();
    let errors = 0;

    function softFail(tag, err) {
      if (warned.has(tag)) return;
      warned.add(tag);
      console.warn("[smartzombies] " + tag + " unavailable:", err);
    }

    function hardFail(err) {
      errors++;
      console.error("[smartzombies] AI pass failed:", err);
      if (errors >= 10) {
        CONFIG.ENABLED = false;
        console.error("[smartzombies] disabled after 10 failures; zombies are back to vanilla.");
      }
    }

    const stats = { zombies: 0, steered: 0, flanking: 0, recruited: 0, dodges: 0, searching: 0, shade: 0 };

    if (!ZombieClass) {
      console.error("[smartzombies] EntityZombie not found in this build; AI disabled.");
      CONFIG.ENABLED = false;
    }

    // ============================================================
    // SMALL HELPERS
    // ============================================================
    const num = (v, dflt) => (typeof v === "number" && isFinite(v) ? v : dflt);
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
    // BLOCKS — only used for shade hunting, so keep it cheap
    // ============================================================
    function blockStateAt(world, x, y, z) {
      try {
        if (newBlockPos) return world.getBlockState(newBlockPos(x, y, z));
      } catch (e) {
        softFail("world.getBlockState", e);
      }
      return null;
    }

    function solidAt(world, x, y, z) {
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

    function skylit(world, x, y, z) {
      try {
        if (newBlockPos && typeof world.canSeeSky === "function") {
          return !!world.canSeeSky(newBlockPos(x, y, z));
        }
      } catch (e) {
        softFail("world.canSeeSky", e);
      }
      return false;
    }

    const standable = (world, x, y, z) =>
      !solidAt(world, x, y, z) && !solidAt(world, x, y + 1, z) && solidAt(world, x, y - 1, z);

    // ============================================================
    // BRAINS — per-zombie scratch state, keyed by entity id
    // ============================================================
    const brains = new Map();
    let ticks = 0;

    function brainOf(id) {
      let b = brains.get(id);
      if (!b) {
        b = {
          role: "charge", angle: 0, lastKnown: null, lastSeenTick: -1,
          dodgeCd: 0, shadeCd: 0, stuck: 0, lastPos: null, pathFails: 0,
          doors: false, touched: ticks,
        };
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

    // ============================================================
    // TARGETS
    // ============================================================
    function targetOf(z) {
      const t = call(z, "getAttackTarget", null);
      if (!t) return null;
      try {
        if (t.isDead || call(t, "getHealth", 1) <= 0) return null;
      } catch (e) { /* treat an unreadable target as live */ }
      return t;
    }

    function setTarget(z, target) {
      try {
        const ref = typeof target.getRef === "function" ? target.getRef() : target;
        z.setAttackTarget(ref);
        return true;
      } catch (e) {
        softFail("setAttackTarget", e);
        return false;
      }
    }

    function canSee(z, target) {
      try {
        const senses = z.getEntitySenses();
        const ref = typeof target.getRef === "function" ? target.getRef() : target;
        if (senses && typeof senses.canSee === "function") return !!senses.canSee(ref);
      } catch (e) {
        softFail("entitySenses.canSee", e);
      }
      return true; // if we can't ask, assume the horde knows where you are
    }

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

    function findZombies(world, players) {
      const out = [];
      try {
        const list = world.loadedEntityList;
        const n = list.size();
        for (let i = 0; i < n && out.length < CONFIG.MAX_PER_PASS; i++) {
          const e = list.get(i);
          if (!e) continue;
          const ref = typeof e.getRef === "function" ? e.getRef() : e;
          if (!ZombieClass.instanceOf(ref)) continue;
          if (e.isDead) continue;
          if (!nearAnyPlayer(e, players, CONFIG.ACTIVE_RANGE)) continue;
          out.push(e);
        }
      } catch (e) {
        softFail("world.loadedEntityList", e);
      }
      return out;
    }

    // ============================================================
    // HORDE COMMS — one zombie sees you, the block hears about it
    // ============================================================
    function shareTargets(zombies) {
      const informed = [];
      for (const z of zombies) {
        const t = targetOf(z);
        if (!t) continue;
        // a zombie taking hits shouts a lot louder than one just walking at you
        const hurt = num(z.hurtTime, 0) > 0;
        informed.push({ z: z, t: t, r2: Math.pow(hurt ? CONFIG.ALARM_RADIUS : CONFIG.COMM_RADIUS, 2) });
      }
      if (!informed.length) return;
      for (const z of zombies) {
        if (targetOf(z)) continue;
        for (const src of informed) {
          if (dist2(z, src.z) > src.r2) continue;
          if (setTarget(z, src.t)) {
            const b = brainOf(entityId(z));
            b.lastKnown = pos(src.t);
            b.lastSeenTick = ticks;
            stats.recruited++;
          }
          break;
        }
      }
    }

    // ============================================================
    // TARGET VELOCITY — measured, not read
    // ============================================================
    // A player's motionX/Z server-side comes from packets and is mostly zero;
    // the only honest velocity is the position delta between our own passes.
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
          // smooth it, so one strafe step doesn't send the horde sideways
          t.vx = t.vx * 0.5 + vx * 0.5;
          t.vz = t.vz * 0.5 + vz * 0.5;
        } else {
          t.vx = 0; t.vz = 0;
        }
        t.x = p.x; t.z = p.z; t.tick = ticks;
      }
      return t;
    }

    function velocityOf(target) {
      return tracks.get(entityId(target)) || { vx: 0, vz: 0 };
    }

    // ============================================================
    // ROLES — nearest few charge, everyone else takes a flank slot
    // ============================================================
    function assignRoles(zombies) {
      const groups = new Map();
      for (const z of zombies) {
        const t = targetOf(z);
        if (!t) continue;
        const key = entityId(t);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ z: z, d2: dist2(z, t) });
      }
      groups.forEach((members) => {
        members.sort((a, b) => a.d2 - b.d2);
        members.forEach((m, i) => {
          const b = brainOf(entityId(m.z));
          if (i < CONFIG.CHARGERS) {
            b.role = "charge";
          } else {
            b.role = "flank";
            b.angle = FLANK_SLOTS[(i - CONFIG.CHARGERS) % FLANK_SLOTS.length];
          }
        });
      });
    }

    // ============================================================
    // GOAL POINTS
    // ============================================================
    function interceptPoint(target, d) {
      // aim where you're going to be, not where you are; ~0.25 blocks/tick
      const lead = Math.min(CONFIG.LEAD_TICKS, d / 0.25);
      const v = velocityOf(target);
      return {
        x: num(target.posX, 0) + v.vx * lead,
        y: num(target.posY, 0),
        z: num(target.posZ, 0) + v.vz * lead,
      };
    }

    function flankPoint(target, brain) {
      const yaw = (num(target.rotationYaw, 0) * Math.PI) / 180;
      const fx = -Math.sin(yaw), fz = Math.cos(yaw); // where the target is facing
      const c = Math.cos(brain.angle), s = Math.sin(brain.angle);
      const dx = fx * c - fz * s;
      const dz = fx * s + fz * c;
      // flank where the target is heading, not where they were
      const v = velocityOf(target);
      const lead = CONFIG.LEAD_TICKS * 0.5;
      return {
        x: num(target.posX, 0) + v.vx * lead + dx * CONFIG.FLANK_RADIUS,
        y: num(target.posY, 0),
        z: num(target.posZ, 0) + v.vz * lead + dz * CONFIG.FLANK_RADIUS,
      };
    }

    function searchPoint(brain) {
      const spread = CONFIG.SEARCH_SPREAD;
      return {
        x: brain.lastKnown.x + (Math.random() - 0.5) * 2 * spread,
        y: brain.lastKnown.y,
        z: brain.lastKnown.z + (Math.random() - 0.5) * 2 * spread,
      };
    }

    // ============================================================
    // MOVEMENT
    // ============================================================
    function moveTo(z, goal, speed, brain) {
      let ok = 0;
      try {
        const nav = z.getNavigator();
        if (nav) ok = nav.tryMoveToXYZ(goal.x, goal.y, goal.z, speed);
      } catch (e) {
        softFail("navigator.tryMoveToXYZ", e);
      }
      try {
        const look = z.getLookHelper();
        if (look) look.setLookPosition(goal.x, goal.y + 1.2, goal.z, 30, 30);
      } catch (e) {
        softFail("lookHelper.setLookPosition", e);
      }
      brain.pathFails = ok ? 0 : brain.pathFails + 1;
      return !!ok;
    }

    function pressToward(z, goal, power) {
      const dx = goal.x - num(z.posX, 0);
      const dz = goal.z - num(z.posZ, 0);
      const m = Math.sqrt(dx * dx + dz * dz) || 1;
      z.motionX = num(z.motionX, 0) + (dx / m) * power;
      z.motionZ = num(z.motionZ, 0) + (dz / m) * power;
    }

    function unstick(z, goal, brain) {
      const p = pos(z);
      const moved = brain.lastPos
        ? Math.abs(p.x - brain.lastPos.x) + Math.abs(p.z - brain.lastPos.z)
        : 1;
      brain.lastPos = p;
      if (moved > 0.05) { brain.stuck = 0; return; }

      brain.stuck += CONFIG.THINK_INTERVAL;
      if (brain.stuck < CONFIG.STUCK_TICKS) return;
      brain.stuck = 0;

      // a hop clears fences and single blocks — and the zombie in front of us,
      // which is how a crowd ends up climbing itself to reach a ledge
      if (z.onGround) z.motionY = 0.42;
      pressToward(z, goal, 0.08);
    }

    // ============================================================
    // DODGING — step out of the crosshair
    // ============================================================
    function tryDodge(z, target, brain) {
      if (brain.dodgeCd > 0) { brain.dodgeCd -= CONFIG.THINK_INTERVAL; return false; }

      const dx = num(z.posX, 0) - num(target.posX, 0);
      const dy = num(z.posY, 0) + 1 - (num(target.posY, 0) + 1.62);
      const dz = num(z.posZ, 0) - num(target.posZ, 0);
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > CONFIG.DODGE_RANGE || d < 0.8) return false;

      const yaw = (num(target.rotationYaw, 0) * Math.PI) / 180;
      const pitch = (num(target.rotationPitch, 0) * Math.PI) / 180;
      const cp = Math.cos(pitch);
      const lx = -Math.sin(yaw) * cp, ly = -Math.sin(pitch), lz = Math.cos(yaw) * cp;
      if ((lx * dx + ly * dy + lz * dz) / d < CONFIG.DODGE_AIM) return false;

      // sidestep perpendicular to the aim; odd/even ids break left/right
      const side = entityId(z) % 2 === 0 ? 1 : -1;
      z.motionX = num(z.motionX, 0) + -lz * side * CONFIG.DODGE_PUSH;
      z.motionZ = num(z.motionZ, 0) + lx * side * CONFIG.DODGE_PUSH;
      if (z.onGround && Math.random() < 0.3) z.motionY = 0.38;
      brain.dodgeCd = CONFIG.DODGE_COOLDOWN;
      return true;
    }

    // ============================================================
    // SUN AVOIDANCE — burning is not a strategy
    // ============================================================
    function findShade(world, z, brain) {
      if (brain.shadeCd > 0) { brain.shadeCd -= CONFIG.THINK_INTERVAL; return false; }
      brain.shadeCd = 40;

      const bx = Math.floor(num(z.posX, 0));
      const by = Math.floor(num(z.posY, 0));
      const bz = Math.floor(num(z.posZ, 0));

      for (let r = 2; r <= CONFIG.SUN_SEARCH; r += 2) {
        for (let i = 0; i < 8; i++) {
          const a = (Math.PI * 2 * i) / 8;
          const x = bx + Math.round(Math.cos(a) * r);
          const zz = bz + Math.round(Math.sin(a) * r);
          if (skylit(world, x, by, zz)) continue;
          if (!standable(world, x, by, zz)) continue;
          moveTo(z, { x: x + 0.5, y: by, z: zz + 0.5 }, CONFIG.CHASE_SPEED, brain);
          stats.shade++;
          return true;
        }
      }
      return false;
    }

    // ============================================================
    // PER-ZOMBIE PASS
    // ============================================================
    function steer(world, z, daytime) {
      const brain = brainOf(entityId(z));

      if (CONFIG.BREAK_DOORS && !brain.doors) {
        brain.doors = true;
        try {
          if (typeof z.setBreakDoorsAItask === "function") z.setBreakDoorsAItask(1);
        } catch (e) {
          softFail("setBreakDoorsAItask", e);
        }
      }

      // cooking in the open beats everything else on the priority list
      if (CONFIG.SUN_AVOID && call(z, "isBurning", false) && findShade(world, z, brain)) return;

      const target = targetOf(z);

      if (!target) {
        // lost you recently? go and have a look where you were last seen
        if (brain.lastKnown && ticks - brain.lastSeenTick < CONFIG.MEMORY_TICKS) {
          moveTo(z, searchPoint(brain), CONFIG.CHASE_SPEED, brain);
          stats.searching++;
        } else if (CONFIG.SUN_AVOID && daytime) {
          const p = pos(z);
          if (skylit(world, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))) {
            findShade(world, z, brain);
          }
        }
        return;
      }

      const visible = canSee(z, target);
      if (visible) {
        brain.lastSeenTick = ticks;
        brain.lastKnown = pos(target);
      }

      if (CONFIG.DODGE && visible && tryDodge(z, target, brain)) stats.dodges++;

      const d2 = dist2(z, target);
      if (d2 <= CONFIG.ENGAGE_RANGE * CONFIG.ENGAGE_RANGE) return; // vanilla melee AI takes over

      const d = Math.sqrt(d2);
      let goal, speed;
      if (brain.role === "flank") {
        goal = flankPoint(target, brain);
        const fdx = goal.x - num(z.posX, 0), fdz = goal.z - num(z.posZ, 0);
        if (fdx * fdx + fdz * fdz < 4) {
          // in position — now close in
          goal = interceptPoint(target, d);
          speed = CONFIG.CHASE_SPEED;
        } else {
          speed = CONFIG.FLANK_SPEED;
          stats.flanking++;
        }
      } else {
        goal = interceptPoint(target, d);
        speed = CONFIG.CHASE_SPEED;
      }

      moveTo(z, goal, speed, brain);
      stats.steered++;

      // no path and we can see you? lean on the obstacle instead of giving up
      if (CONFIG.UNSTICK && (brain.pathFails > 2 || visible)) unstick(z, goal, brain);
    }

    // ============================================================
    // TICK
    // ============================================================
    function think() {
      let zombieCount = 0;
      for (const world of worlds()) {
        const players = livePlayers(world);
        if (!players.length) continue;

        const zombies = findZombies(world, players);
        if (!zombies.length) continue;
        zombieCount += zombies.length;

        const daytime = call(world, "isDaytime", false);
        players.forEach(track);
        shareTargets(zombies);
        assignRoles(zombies);
        for (const z of zombies) steer(world, z, daytime);
      }
      stats.zombies = zombieCount;
    }

    ModAPI.addEventListener("tick", function () {
      if (!CONFIG.ENABLED) return;
      ticks++;
      if (ticks % CONFIG.THINK_INTERVAL !== 0) return;
      try {
        think();
        if (ticks % 1200 === 0) prune();
      } catch (e) {
        hardFail(e);
      }
    });

    // ============================================================
    // /zombies — runtime control, because tuning AI by reload is miserable
    // ============================================================
    function reply(sender, lines) {
      [].concat(lines).forEach((line) => {
        try {
          const comp = TextClass.constructors[0](ModAPI.util.str(line));
          if (typeof sender.sendMessage === "function") sender.sendMessage(comp);
          else if (typeof sender.addChatMessage === "function") sender.addChatMessage(comp);
          else console.log("[smartzombies] " + line);
        } catch (e) {
          console.log("[smartzombies] " + line);
        }
      });
    }

    function handle(args) {
      const sub = (args[0] || "status").toLowerCase();

      if (sub === "on" || sub === "off") {
        CONFIG.ENABLED = sub === "on";
        errors = 0;
        return "smartzombies " + sub;
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
        const raw = args[2];
        if (raw === undefined) return key + " = " + CONFIG[key];
        const value = raw === "true" ? true : raw === "false" ? false : parseFloat(raw);
        if (typeof value === "number" && !isFinite(value)) return "not a number: " + raw;
        CONFIG[key] = value;
        preset = "custom";
        return key + " = " + CONFIG[key];
      }

      if (sub === "help") {
        return [
          "/zombies                 status",
          "/zombies on | off        enable or disable the AI",
          "/zombies preset <name>   " + Object.keys(PRESETS).join(" | "),
          "/zombies set KEY [v]     read or write any config value",
        ];
      }

      return [
        "smartzombies: " + (CONFIG.ENABLED ? "on" : "off") + ", preset " + preset +
          ", " + (IS_1_12 ? "1.12" : "1.8") + " adapter",
        "tracking " + stats.zombies + " | steered " + stats.steered + " | flanking " + stats.flanking +
          " | recruited " + stats.recruited,
        "dodges " + stats.dodges + " | searching " + stats.searching + " | shade " + stats.shade +
          " | brains " + brains.size,
      ];
    }

    ModAPI.addEventListener("processcommand", function (event) {
      const raw = String(event.command || "");
      if (!/^\/(smart)?zombies(\s|$)/i.test(raw)) return;
      event.preventDefault = true;
      try {
        reply(event.sender, handle(raw.trim().split(/\s+/).slice(1)));
      } catch (e) {
        console.error("[smartzombies] command failed:", e);
      }
    });

    console.log("[smartzombies] server AI online (" + (IS_1_12 ? "1.12" : "1.8") + " adapter)");
  });

  console.log("[smartzombies] loaded; AI code queued for the integrated server");
})();
