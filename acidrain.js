// ============================================================
// acidrain v1 — the weather is trying to kill you
// Target: EaglercraftX 1.12.2 via EaglerForgeInjector
//
// When it rains, the rain burns. Stand under open sky in a storm and it eats
// through your armour and then through you; the longer you stay out, the
// harder it bites. It eats the world too — grass goes to dirt, stone goes to
// cobble goes to gravel goes to sand, leaves and crops dissolve — and unless
// you ask for permanence, every block it touches grows back afterwards.
//
// The damage and the corrosion run on the integrated (dedicated) server, in
// the service worker, because that's where the weather, the mobs and the
// blocks live. The only client-side piece is the warning on your screen.
// ============================================================

(function acidrain() {
  "use strict";

  ModAPI.meta.title("AcidRain");
  ModAPI.meta.version("1.0.0");
  ModAPI.meta.description(
    "Rain that burns. Exposure damage that ramps the longer you stand in it, armour that corrodes away holding it off, and terrain that dissolves and grows back. Tune it in-game with /acidrain."
  );
  ModAPI.meta.credits("kkacin");

  // ============================================================
  // SERVER SIDE — damage, corrosion, weather
  // ============================================================
  ModAPI.dedicatedServer.appendCode(function acidRainServer() {
    "use strict";

    const CONFIG = {
      ENABLED: true,
      THINK_INTERVAL: 20,      // server ticks between passes; one bite a second
      ACTIVE_RANGE: 48,        // only look at entities this close to a player
      MAX_PER_PASS: 64,        // hard cap on entities considered per pass, per world

      // --- which storms are acid ---
      ALWAYS_ACID: true,       // every rainstorm burns
      STORM_CHANCE: 0.5,       // if not: fraction of storms that do (rolled once, at the start)
      THUNDER_ALWAYS: true,    // a thunderstorm always does, whatever the roll said
      ANNOUNCE: true,          // say so in chat when a storm turns

      // --- the burn ---
      DAMAGE: 1.0,             // half a heart per pass on a bare, exposed player
      GRACE_TICKS: 40,         // how long you can be caught out before it starts
      RAMP_TICKS: 200,         // exposure needed to reach the full multiplier
      RAMP_MAX: 2.5,           // damage multiplier once you're thoroughly soaked
      THUNDER_MULTIPLIER: 2.0, // thunderstorms bite harder
      DRY_RATE: 4,             // exposure shed per tick once you're under cover
      HURT_MOBS: true,
      MOB_MULTIPLIER: 1.0,
      WATER_SHIELDS: true,     // ducking under water washes it off
      SKIP_CREATIVE: true,

      // --- armour ---
      ARMOUR_SHIELDS: true,
      ARMOUR_REDUCTION: 0.2,   // damage removed per piece worn; four pieces = 80% off
      ARMOUR_WEAR: 2,          // durability each worn piece loses per bite

      // --- corrosion ---
      CORRODE: true,
      CORRODE_RADIUS: 12,      // around each player
      CORRODE_TRIES: 8,        // candidate columns per player per pass
      CORRODE_CHANCE: 0.3,     // per candidate column
      DROPS: false,            // dissolved blocks hand over what mining them would
      PERMANENT: false,        // true = it never grows back and isn't remembered
      HEAL_TICKS: 2400,        // ~2 minutes before a corroded block grows back
      MAX_SCARS: 256,          // hard cap on remembered blocks, oldest healed first

      // --- housekeeping ---
      FX: true,
    };

    const PRESETS = {
      mist:    { DAMAGE: 0.5, GRACE_TICKS: 100, RAMP_MAX: 1.5, THUNDER_MULTIPLIER: 1.5, CORRODE: false, STORM_CHANCE: 0.34, ALWAYS_ACID: false },
      normal:  { DAMAGE: 1.0, GRACE_TICKS: 40, RAMP_MAX: 2.5, RAMP_TICKS: 200, THUNDER_MULTIPLIER: 2.0, CORRODE: true, CORRODE_CHANCE: 0.3, ALWAYS_ACID: true, ARMOUR_REDUCTION: 0.2 },
      caustic: { DAMAGE: 2.0, GRACE_TICKS: 0, RAMP_MAX: 4.0, RAMP_TICKS: 120, THUNDER_MULTIPLIER: 2.5, CORRODE: true, CORRODE_CHANCE: 0.8, CORRODE_TRIES: 16, ALWAYS_ACID: true, ARMOUR_REDUCTION: 0.12, ARMOUR_WEAR: 5 },
    };
    let preset = "normal";

    // Vanilla world event ids — cosmetic, and cheap: the server sends one
    // packet and every client nearby plays the sound and particles itself.
    const FX_SIZZLE = 1009;  // fire extinguish "fizz"
    const FX_SPLASH = 2002;  // splash potion break; data is the particle colour
    const FX_GREEN = 0x8FCE00;

    // ============================================================
    // VERSION COMPAT
    // ============================================================
    // 1.12 moved BlockPos to net.minecraft.util.math, renamed
    // World.playAuxSFX to playEvent and EntityPlayer.addChatMessage to
    // sendMessage, and shouted the Blocks field names.
    const IS_1_12 = !!ModAPI.reflect.getClassById("net.minecraft.util.math.BlockPos");
    const BlockPosClass = ModAPI.reflect.getClassById(
      IS_1_12 ? "net.minecraft.util.math.BlockPos" : "net.minecraft.util.BlockPos"
    );
    const TextClass = ModAPI.reflect.getClassById(
      IS_1_12 ? "net.minecraft.util.text.TextComponentString" : "net.minecraft.util.ChatComponentText"
    );
    const DamageSourceClass = ModAPI.reflect.getClassById("net.minecraft.util.DamageSource");
    const newBlockPos = BlockPosClass ? BlockPosClass.constructors.find((c) => c.length === 3) : null;

    const warned = new Set();
    let errors = 0;

    function softFail(tag, err) {
      if (warned.has(tag)) return;
      warned.add(tag);
      console.warn("[acidrain] " + tag + " unavailable:", err);
    }

    function hardFail(err) {
      errors++;
      console.error("[acidrain] pass failed:", err);
      if (errors >= 10) {
        CONFIG.ENABLED = false;
        healAllScars();
        console.error("[acidrain] disabled after 10 failures; the weather is back to normal.");
      }
    }

    const stats = { storms: 0, acidStorms: 0, exposed: 0, bites: 0, damage: 0, armour: 0, corroded: 0, dropped: 0, healed: 0 };

    // ============================================================
    // SMALL HELPERS
    // ============================================================
    const num = (v, dflt) => (typeof v === "number" && isFinite(v) ? v : dflt);
    const raw = (o) => (o && typeof o.getRef === "function" ? o.getRef() : o);
    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

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
      if (!p) return true;
      try {
        return !!world.isAirBlock(p);
      } catch (e) {
        softFail("world.isAirBlock", e);
        return true;
      }
    }

    function setBlock(world, x, y, z, state) {
      const p = blockPos(x, y, z);
      if (!p || !state) return false;
      try {
        // flag 3 = tell the clients and notify the neighbours, so grass that
        // lost its soil and a flower that lost its grass fall over properly.
        if (typeof world.setBlockState === "function") {
          world.setBlockState(p, raw(state), 3);
          return true;
        }
      } catch (e) {
        softFail("world.setBlockState", e);
      }
      return false;
    }

    function skyAbove(world, x, y, z) {
      const p = blockPos(x, y, z);
      if (!p) return false;
      try {
        if (typeof world.canSeeSky === "function") return !!world.canSeeSky(p);
      } catch (e) {
        softFail("world.canSeeSky", e);
      }
      return false;
    }

    function playFx(world, id, x, y, z, data) {
      if (!CONFIG.FX) return;
      const p = blockPos(x, y, z);
      if (!p) return;
      // 1.12: playEvent. 1.8: playAuxSFX. Same arguments either way.
      callAny(world, ["playEvent", "playAuxSFX"], [null, id, p, data || 0], "world.playEvent");
    }

    let blocksRoot = null;

    function blocks() {
      if (blocksRoot) return blocksRoot;
      blocksRoot =
        ModAPI.blocks ||
        (ModAPI.reflect.getClassById("net.minecraft.init.Blocks") || {}).staticVariables ||
        {};
      return blocksRoot;
    }

    // 1.12 shouts the field names (Blocks.COBBLESTONE), 1.8 whispers them
    // (Blocks.cobblestone). Ask for both and take what's there.
    function blockNamed(name) {
      const b = blocks();
      return b[name.toUpperCase()] || b[name.toLowerCase()] || null;
    }

    function defaultState(block) {
      if (!block) return null;
      const s = call(block, "getDefaultState", null);
      return s ? raw(s) : null;
    }

    // ============================================================
    // CORROSION TABLE — what each block dissolves into
    // ============================================================
    // Stone wears down a step at a time, so a cliff left out in enough storms
    // really does end up as a sand heap. Anything soft just goes.
    const CHAIN = [
      ["grass", "dirt"],
      ["mycelium", "dirt"],
      ["farmland", "dirt"],
      ["grass_path", "dirt"],
      ["stone", "cobblestone"],
      ["stonebrick", "cobblestone"],
      ["mossy_cobblestone", "cobblestone"],
      ["cobblestone", "gravel"],
      ["gravel", "sand"],
      ["sandstone", "sand"],
      ["red_sandstone", "sand"],
      ["clay", "sand"],
      ["snow_layer", null],
      ["snow", null],
      ["ice", null],
      ["leaves", null],
      ["leaves2", null],
      ["tallgrass", null],
      ["deadbush", null],
      ["yellow_flower", null],
      ["red_flower", null],
      ["double_plant", null],
      ["wheat", null],
      ["carrots", null],
      ["potatoes", null],
      ["beetroots", null],
      ["melon_stem", null],
      ["pumpkin_stem", null],
      ["reeds", null],
      ["vine", null],
      ["waterlily", null],
      ["cactus", null],
      ["web", null],
    ];

    let corrosion = null;

    function corrosionTable() {
      if (corrosion) return corrosion;
      corrosion = new Map();
      for (const [fromName, toName] of CHAIN) {
        const from = blockNamed(fromName);
        if (!from) continue;
        const toBlock = toName === null ? blockNamed("air") : blockNamed(toName);
        const to = defaultState(toBlock);
        if (!to) continue;
        corrosion.set(raw(from), { state: to, block: raw(toBlock), gone: toName === null });
      }
      if (!corrosion.size) softFail("Blocks.*", "no corrodible blocks found in this build");
      return corrosion;
    }

    // Hand over what mining the block would have given you. This is vanilla's
    // own drop path, so it honours doTileDrops and the usual odds — leaves give
    // saplings and the occasional apple rather than a guaranteed one.
    function dropItems(world, blockObj, x, y, z, state) {
      const p = blockPos(x, y, z);
      if (!p || !blockObj) return false;
      try {
        if (typeof blockObj.dropBlockAsItem === "function") {
          blockObj.dropBlockAsItem(raw(world), p, state, 0);
          return true;
        }
      } catch (e) {
        softFail("block.dropBlockAsItem", e);
      }
      return false;
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

    // ============================================================
    // SCARS — every block the rain ate, and the block it ate
    // ============================================================
    // Unless PERMANENT is on, nothing the rain does to the terrain is forever:
    // each block is recorded with the state that was there before and put back
    // on a timer, on /acidrain heal, on /acidrain off, or if the mod gives up.
    const scars = [];
    const scarKeys = new Set();
    const worldIds = new Map();

    function worldId(world) {
      const ref = raw(world);
      let id = worldIds.get(ref);
      if (id === undefined) {
        id = worldIds.size;
        worldIds.set(ref, id);
      }
      return id;
    }

    const skey = (world, x, y, z) => worldId(world) + ":" + x + "," + y + "," + z;

    function healScar(scar) {
      scarKeys.delete(scar.key);
      try {
        const now = blockStateAt(scar.world, scar.x, scar.y, scar.z);
        const block = now ? raw(call(now, "getBlock", null)) : null;
        // Somebody has built over it since — leave their block alone.
        if (block && scar.block && block !== scar.block) return;
        if (setBlock(scar.world, scar.x, scar.y, scar.z, scar.prev)) stats.healed++;
      } catch (e) {
        softFail("heal scar", e);
      }
    }

    function expireScars() {
      while (scars.length && scars[0].expire <= ticks) healScar(scars.shift());
    }

    function healAllScars() {
      while (scars.length) healScar(scars.shift());
      scarKeys.clear();
    }

    // ============================================================
    // WEATHER — is this storm an acid one?
    // ============================================================
    // There is no "storm started" event, so we watch the rain flag ourselves.
    // The roll happens once, when the rain begins, and holds for that storm:
    // the sky doesn't get to change its mind four times a minute.
    const storms = new Map();   // world ref -> { raining, acid, thunder }

    function worldInfo(world) {
      return call(world, "getWorldInfo", null);
    }

    function isRaining(world) {
      const direct = call(world, "isRaining", null);
      if (direct !== null) return !!direct;
      const info = worldInfo(world);
      return !!call(info, "isRaining", false);
    }

    function isThundering(world) {
      const direct = call(world, "isThundering", null);
      if (direct !== null) return !!direct;
      const info = worldInfo(world);
      return !!call(info, "isThundering", false);
    }

    function stormOf(world) {
      const ref = raw(world);
      let s = storms.get(ref);
      if (!s) {
        s = { raining: false, acid: false, thunder: false };
        storms.set(ref, s);
      }

      const raining = isRaining(world);
      const thunder = raining && isThundering(world);

      if (raining && !s.raining) {
        // A storm just rolled in. Decide once what kind it is.
        s.acid = CONFIG.ALWAYS_ACID || Math.random() < CONFIG.STORM_CHANCE;
        stats.storms++;
        if (s.acid) stats.acidStorms++;
        s.thunder = false;
        if (CONFIG.ANNOUNCE) {
          announce(world, s.acid ? "The rain stings where it lands. Get under something."
                                 : "It's raining. Just raining.");
        }
      } else if (!raining && s.raining) {
        if (CONFIG.ANNOUNCE && s.acid) announce(world, "The rain has stopped.");
        s.acid = false;
      }

      // A thunderstorm always burns, if that's how it's configured, even if the
      // gentle rain it grew out of didn't.
      if (thunder && !s.thunder && CONFIG.THUNDER_ALWAYS && !s.acid) {
        s.acid = true;
        stats.acidStorms++;
        if (CONFIG.ANNOUNCE) announce(world, "The storm turns. The rain is burning now.");
      }

      s.raining = raining;
      s.thunder = thunder;
      return s;
    }

    // ============================================================
    // EXPOSURE
    // ============================================================
    // Vanilla already knows whether rain is falling on a given block: it
    // checks the sky, the heightmap and whether the biome has rain at that
    // altitude, so deserts stay dry and a mountain top gets snow instead.
    function rainOn(world, e) {
      const x = num(e.posX, 0), y = num(e.posY, 0), z = num(e.posZ, 0);
      const p = blockPos(x, y + 0.5, z);
      if (p) {
        try {
          if (typeof world.isRainingAt === "function") return !!world.isRainingAt(p);
        } catch (err) {
          softFail("world.isRainingAt", err);
        }
      }
      return skyAbove(world, x, y + 0.5, z);
    }

    function sheltered(world, e) {
      if (CONFIG.WATER_SHIELDS && (call(e, "isInWater", false) || call(e, "isInsideOfMaterial", false))) {
        return true;
      }
      return !rainOn(world, e);
    }

    // ============================================================
    // ARMOUR — it holds the acid off, and it's eaten for doing it
    // ============================================================
    function armourPieces(e) {
      const out = [];
      try {
        // 1.12: EntityPlayer.inventory.armorInventory is a NonNullList.
        // 1.8: the same field is a plain ItemStack[], which ModAPI hands over
        // as an object with a .data array.
        const inv = e.inventory;
        const armour = inv && (inv.armorInventory || inv.$armorInventory);
        if (!armour) return out;
        if (typeof armour.size === "function") {
          const n = armour.size();
          for (let i = 0; i < n; i++) out.push(armour.get(i));
        } else if (Array.isArray(armour.data)) {
          armour.data.forEach((s) => out.push(s));
        }
      } catch (err) {
        softFail("player armour inventory", err);
      }
      return out.filter((s) => s && !call(s, "isEmpty", false) && num(s.stackSize, 1) !== 0);
    }

    function wearArmour(e, pieces) {
      if (!CONFIG.ARMOUR_WEAR) return;
      for (const s of pieces) {
        try {
          if (typeof s.damageItem === "function") {
            s.damageItem(CONFIG.ARMOUR_WEAR, raw(e));
            stats.armour++;
          }
        } catch (err) {
          softFail("itemStack.damageItem", err);
          return;
        }
      }
    }

    // ============================================================
    // THE BITE
    // ============================================================
    let acidSource = null;
    let acidSourceLooked = false;

    function damageSource() {
      if (acidSourceLooked) return acidSource;
      acidSourceLooked = true;
      try {
        const statics = DamageSourceClass && DamageSourceClass.staticVariables;
        // MAGIC already bypasses armour in vanilla, which is what we want:
        // armour's effect here is ARMOUR_REDUCTION, applied once, by us.
        const src = statics && (statics.MAGIC || statics.magic || statics.GENERIC || statics.generic);
        if (src) {
          acidSource = raw(src);
          return acidSource;
        }
        const ctor = DamageSourceClass && DamageSourceClass.constructors.find((c) => c.length === 1);
        if (ctor) acidSource = raw(ctor(ModAPI.util.str("acidRain")));
      } catch (err) {
        softFail("DamageSource", err);
        acidSource = null;
      }
      return acidSource;
    }

    function hurt(e, amount) {
      const src = damageSource();
      try {
        if (src && typeof e.attackEntityFrom === "function") {
          e.attackEntityFrom(src, amount);
          return true;
        }
      } catch (err) {
        softFail("entity.attackEntityFrom", err);
      }
      // No damage source in this build: take it off the health bar directly.
      try {
        if (typeof e.setHealth === "function" && typeof e.getHealth === "function") {
          e.setHealth(Math.max(0, e.getHealth() - amount));
          return true;
        }
      } catch (err) {
        softFail("entity.setHealth", err);
      }
      return false;
    }

    function isPlayer(e) {
      return typeof e.inventory !== "undefined" && typeof e.isSpectator === "function";
    }

    function skipEntity(e) {
      if (!e || e.isDead) return true;
      if (typeof e.getHealth !== "function") return true;   // not a living thing
      if (call(e, "getHealth", 1) <= 0) return true;
      if (isPlayer(e)) {
        if (call(e, "isSpectator", false)) return true;
        if (CONFIG.SKIP_CREATIVE) {
          try {
            const caps = e.capabilities;
            if (caps && (caps.isCreativeMode || caps.disableDamage)) return true;
          } catch (err) { /* no capabilities: treat as survival */ }
        }
        return false;
      }
      return !CONFIG.HURT_MOBS;
    }

    // ============================================================
    // BRAINS — per-entity exposure, keyed by entity id
    // ============================================================
    const brains = new Map();
    let ticks = 0;

    function brainOf(id) {
      let b = brains.get(id);
      if (!b) {
        b = { exposure: 0, touched: ticks };
        brains.set(id, b);
      }
      b.touched = ticks;
      return b;
    }

    function prune() {
      brains.forEach((b, id) => {
        if (ticks - b.touched > 1200) brains.delete(id);
      });
    }

    function bite(world, e, storm) {
      const brain = brainOf(entityId(e));

      if (sheltered(world, e)) {
        brain.exposure = Math.max(0, brain.exposure - CONFIG.DRY_RATE * CONFIG.THINK_INTERVAL);
        return false;
      }

      brain.exposure += CONFIG.THINK_INTERVAL;
      stats.exposed++;
      if (brain.exposure <= CONFIG.GRACE_TICKS) return false;

      // The longer you stand in it, the more of you it has got through.
      const soaked = CONFIG.RAMP_TICKS > 0
        ? clamp((brain.exposure - CONFIG.GRACE_TICKS) / CONFIG.RAMP_TICKS, 0, 1)
        : 1;
      let amount = CONFIG.DAMAGE * (1 + soaked * (CONFIG.RAMP_MAX - 1));
      if (storm.thunder) amount *= CONFIG.THUNDER_MULTIPLIER;

      const player = isPlayer(e);
      if (!player) amount *= CONFIG.MOB_MULTIPLIER;

      if (player && CONFIG.ARMOUR_SHIELDS) {
        const pieces = armourPieces(e);
        if (pieces.length) {
          amount *= Math.max(0, 1 - pieces.length * CONFIG.ARMOUR_REDUCTION);
          wearArmour(e, pieces);
        }
      }

      if (!(amount > 0)) return false;
      if (!hurt(e, amount)) return false;

      stats.bites++;
      stats.damage += amount;
      playFx(world, FX_SIZZLE, num(e.posX, 0), num(e.posY, 0) + 1, num(e.posZ, 0), 0);
      return true;
    }

    // ============================================================
    // CORROSION
    // ============================================================
    // Pick a column near a player, find the block the rain would actually be
    // landing on, and see whether it's something the acid can work on.
    function corrodeNear(world, player) {
      const table = corrosionTable();
      if (!table.size) return;

      const px = num(player.posX, 0), py = num(player.posY, 0), pz = num(player.posZ, 0);
      for (let i = 0; i < CONFIG.CORRODE_TRIES; i++) {
        if (Math.random() > CONFIG.CORRODE_CHANCE) continue;
        const angle = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * CONFIG.CORRODE_RADIUS;
        const x = Math.floor(px + Math.cos(angle) * r);
        const z = Math.floor(pz + Math.sin(angle) * r);

        // The topmost block in the column, within reach of where we're standing.
        let y = null;
        for (let dy = 5; dy >= -8; dy--) {
          const cy = Math.floor(py) + dy;
          if (!isAir(world, x, cy, z)) { y = cy; break; }
        }
        if (y === null) continue;
        if (!skyAbove(world, x, y + 1, z)) continue;  // it's under cover; the rain never reaches it

        const state = blockStateAt(world, x, y, z);
        if (!state) continue;
        const blockObj = call(state, "getBlock", null);
        const block = blockObj ? raw(blockObj) : null;
        const into = block ? table.get(block) : null;
        if (!into) continue;

        const key = skey(world, x, y, z);
        if (scarKeys.has(key)) continue;   // already eaten once; let it heal first

        const prev = raw(state);
        // Only blocks the acid dissolves completely drop anything. The ones
        // that merely wear down a step already gave you the block they would
        // have dropped — stone drops cobblestone, and stone *becomes*
        // cobblestone — so dropping as well would just mint it.
        const dropped = CONFIG.DROPS && into.gone && dropItems(world, blockObj, x, y, z, prev);
        if (!setBlock(world, x, y, z, into.state)) continue;
        stats.corroded++;
        if (dropped) stats.dropped++;
        playFx(world, FX_SPLASH, x, y + 1, z, FX_GREEN);

        // A block whose contents we handed over doesn't grow back: putting the
        // leaves back after giving you the sapling would be free saplings every
        // storm. Taking the drop is what makes that one corrosion one-way.
        if (CONFIG.PERMANENT || dropped) continue;
        scarKeys.add(key);
        scars.push({
          world: world,
          key: key,
          x: x, y: y, z: z,
          prev: prev,
          block: into.block,
          expire: ticks + CONFIG.HEAL_TICKS,
        });
        while (scars.length > CONFIG.MAX_SCARS) healScar(scars.shift());
      }
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
          out.push(p);
        }
      } catch (err) {
        softFail("world.playerEntities", err);
      }
      return out;
    }

    function nearAnyPlayer(e, players, range) {
      const r2 = range * range;
      for (const p of players) if (dist2(e, p) <= r2) return true;
      return false;
    }

    function victims(world, players) {
      const out = [];
      for (const p of players) if (!skipEntity(p)) out.push(p);
      if (!CONFIG.HURT_MOBS) return out;
      try {
        const list = world.loadedEntityList;
        const n = list.size();
        for (let i = 0; i < n && out.length < CONFIG.MAX_PER_PASS; i++) {
          const e = list.get(i);
          if (!e || skipEntity(e)) continue;
          if (isPlayer(e)) continue;                 // already in from playerEntities
          if (!nearAnyPlayer(e, players, CONFIG.ACTIVE_RANGE)) continue;
          out.push(e);
        }
      } catch (err) {
        softFail("world.loadedEntityList", err);
      }
      return out;
    }

    // ============================================================
    // TICK
    // ============================================================
    function think() {
      stats.exposed = 0;
      for (const world of worlds()) {
        const storm = stormOf(world);
        if (!storm.raining || !storm.acid) continue;

        const players = livePlayers(world);
        if (!players.length) continue;

        for (const e of victims(world, players)) {
          bite(world, e, storm);
        }

        if (CONFIG.CORRODE && mobGriefing(world)) {
          for (const p of players) corrodeNear(world, p);
        }
      }
    }

    ModAPI.addEventListener("tick", function () {
      if (!CONFIG.ENABLED) return;
      ticks++;
      try {
        expireScars();
        if (ticks % CONFIG.THINK_INTERVAL === 0) think();
        if (ticks % 1200 === 0) prune();
      } catch (err) {
        hardFail(err);
      }
    });

    // ============================================================
    // /acidrain — runtime control
    // ============================================================
    function line(text) {
      return TextClass.constructors[0](ModAPI.util.str(text));
    }

    function say(target, text) {
      try {
        const comp = line(text);
        if (typeof target.sendMessage === "function") target.sendMessage(comp);
        else if (typeof target.addChatMessage === "function") target.addChatMessage(comp);
        else console.log("[acidrain] " + text);
      } catch (err) {
        console.log("[acidrain] " + text);
      }
    }

    function reply(sender, lines) {
      [].concat(lines).forEach((text) => say(sender, text));
    }

    function announce(world, text) {
      livePlayers(world).forEach((p) => say(p, text));
    }

    function setStorm(mode) {
      let touched = 0;
      for (const world of worlds()) {
        const info = worldInfo(world);
        if (!info) continue;
        try {
          if (typeof info.setRaining === "function") info.setRaining(mode !== "off");
          if (typeof info.setThundering === "function") info.setThundering(mode === "thunder");
          // Push the countdown out so the server doesn't undo us immediately.
          if (typeof info.setRainTime === "function") info.setRainTime(12000);
          if (typeof info.setThunderTime === "function") info.setThunderTime(12000);
          touched++;
        } catch (err) {
          softFail("worldInfo.setRaining", err);
        }
      }
      return touched;
    }

    function handle(args) {
      const sub = (args[0] || "status").toLowerCase();

      if (sub === "on" || sub === "off") {
        CONFIG.ENABLED = sub === "on";
        errors = 0;
        if (sub === "off") {
          healAllScars();
          brains.clear();
        }
        return "acidrain " + sub;
      }

      if (sub === "heal") {
        const n = scars.length;
        healAllScars();
        return "healed " + n + " corroded block(s)";
      }

      if (sub === "storm") {
        const mode = (args[1] || "on").toLowerCase();
        if (mode !== "on" && mode !== "off" && mode !== "thunder") return "storm: on | off | thunder";
        const n = setStorm(mode);
        return n ? "storm -> " + mode : "this build won't let me touch the weather";
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
          "/acidrain                  status",
          "/acidrain on | off         enable or disable it (off heals every scar)",
          "/acidrain heal             put every corroded block back right now",
          "/acidrain storm on|off|thunder  start or stop the weather",
          "/acidrain preset <name>    " + Object.keys(PRESETS).join(" | "),
          "/acidrain set KEY [v]      read or write any config value",
        ];
      }

      const weather = [];
      for (const world of worlds()) {
        const s = storms.get(raw(world));
        if (s && s.raining) weather.push(s.acid ? (s.thunder ? "acid thunderstorm" : "acid rain") : "plain rain");
      }

      return [
        "acidrain: " + (CONFIG.ENABLED ? "on" : "off") + ", preset " + preset +
          ", " + (IS_1_12 ? "1.12" : "1.8") + " adapter",
        "weather " + (weather.length ? weather.join(", ") : "dry") +
          " | storms " + stats.storms + " (" + stats.acidStorms + " acid)",
        "out in it " + stats.exposed + " | bites " + stats.bites +
          " | damage " + stats.damage.toFixed(1) + " | armour eaten " + stats.armour,
        "corroded " + stats.corroded + " | dropped " + stats.dropped +
          " | scars " + scars.length + " live / " + stats.healed + " healed",
      ];
    }

    ModAPI.addEventListener("processcommand", function (event) {
      const text = String(event.command || "");
      if (!/^\/acid(rain)?(\s|$)/i.test(text)) return;
      event.preventDefault = true;
      try {
        reply(event.sender, handle(text.trim().split(/\s+/).slice(1)));
      } catch (err) {
        console.error("[acidrain] command failed:", err);
      }
    });

    console.log("[acidrain] server side online (" + (IS_1_12 ? "1.12" : "1.8") + " adapter)");
  });

  // ============================================================
  // CLIENT SIDE — the warning on your screen
  // ============================================================
  // The server does the burning; this only tells you it's happening, because
  // "why am I losing hearts" is a bad way to find out. It reads the client's
  // own copy of the world, so it knows you're in the rain but not whether this
  // particular storm was rolled acid — with the default ALWAYS_ACID that's the
  // same question. Turn STORM_CHANCE down and it will cry wolf; HUD false.
  const CLIENT = {
    HUD: true,
    TINT: true,
    TINT_ALPHA: 0.22,    // how green it gets at full pelt
    FADE_TICKS: 30,      // frames to ramp the tint in and out
  };

  ModAPI.require("player");
  ModAPI.require("world");

  const IS_1_12_CLIENT = !!ModAPI.reflect.getClassById("net.minecraft.util.math.BlockPos");
  const ClientBlockPos = ModAPI.reflect.getClassById(
    IS_1_12_CLIENT ? "net.minecraft.util.math.BlockPos" : "net.minecraft.util.BlockPos"
  );
  const newClientBlockPos = ClientBlockPos
    ? ClientBlockPos.constructors.find((c) => c.length === 3)
    : null;

  const hud = CLIENT.HUD && typeof document !== "undefined" ? buildHud() : null;
  const tint = CLIENT.TINT && typeof document !== "undefined" ? buildTint() : null;
  let soak = 0;

  function buildHud() {
    const el = document.createElement("div");
    el.style.cssText = [
      "position:fixed", "top:6px", "left:8px", "z-index:201",
      "pointer-events:none", "font:12px monospace", "line-height:1.4",
      "text-shadow:1px 1px 0 #000", "white-space:pre", "display:none",
      "color:#9BE01A",
    ].join(";");
    document.documentElement.appendChild(el);
    return el;
  }

  function buildTint() {
    const el = document.createElement("div");
    el.style.cssText = [
      "position:fixed", "inset:0", "z-index:200", "pointer-events:none",
      "opacity:0",
      "background:radial-gradient(ellipse at center, rgba(120,200,20,0) 35%, rgba(120,200,20,0.9) 100%)",
    ].join(";");
    document.documentElement.appendChild(el);
    return el;
  }

  function clientRaining(world) {
    try {
      if (typeof world.isRaining === "function") return !!world.isRaining();
      const info = typeof world.getWorldInfo === "function" ? world.getWorldInfo() : null;
      if (info && typeof info.isRaining === "function") return !!info.isRaining();
    } catch (e) { /* no weather to read; assume dry */ }
    return false;
  }

  function clientExposed(world, player) {
    try {
      const x = Math.floor(player.posX);
      const y = Math.floor(player.posY + 0.5);
      const z = Math.floor(player.posZ);
      const p = newClientBlockPos ? newClientBlockPos(x, y, z) : null;
      if (!p) return false;
      if (typeof world.isRainingAt === "function") return !!world.isRainingAt(p);
      if (typeof world.canSeeSky === "function") return !!world.canSeeSky(p);
    } catch (e) { /* can't tell; don't warn */ }
    return false;
  }

  function updateHud() {
    if (!hud && !tint) return;
    const world = ModAPI.world;
    const player = ModAPI.player;
    const out = !!(world && player && clientRaining(world) && clientExposed(world, player));

    soak = Math.max(0, Math.min(CLIENT.FADE_TICKS, soak + (out ? 1 : -2)));
    const strength = soak / CLIENT.FADE_TICKS;

    if (hud) {
      const text = out ? "☣ ACID RAIN — get under something" : "";
      if (text !== hud._text) {
        hud._text = text;
        hud.textContent = text;
        hud.style.display = text ? "block" : "none";
      }
    }
    if (tint) tint.style.opacity = String(strength * CLIENT.TINT_ALPHA);
  }

  ModAPI.addEventListener("frame", updateHud);

  console.log("[acidrain] loaded; the weather is queued for the integrated server");
})();
