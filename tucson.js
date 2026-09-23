// ============================================================
// tucson v1 — saguaros, everywhere
// Target: EaglercraftX 1.12.2 via EaglerForgeInjector
//
// Walk into a desert and it's full of saguaros: young ones knee-high, tall
// bare spears, the classic one-armed and two-armed shapes, many-armed
// candelabras and the occasional old giant with arms that kink out and up.
// Outside the desert they're rarer but still about, standing on a little patch
// of sand, because this is Tucson now.
//
// Vanilla cactus can't do this on its own: a cactus block breaks the moment
// anything solid touches its side, another cactus included, so an arm would
// fall off the first time a neighbour updated. The mod teaches cactus that a
// block joined to other cactus is fine as long as the plant it's part of is
// still rooted in sand. Cut a saguaro off at the base and the whole thing
// comes down, the way cutting a vanilla cactus does.
//
// Planting runs on the integrated (dedicated) server, in the service worker,
// as you explore: each chunk near you is visited once, rolled from the world
// seed, and marked so it isn't planted twice, even after a restart. The
// cactus rule is installed on both sides, so your client agrees with the
// server about which blocks stay up.
// ============================================================

(function tucson() {
  "use strict";

  ModAPI.meta.title("Tucson");
  ModAPI.meta.version("1.0.0");
  ModAPI.meta.description(
    "Saguaro cactus everywhere: young ones, bare spears, one-armed, two-armed, candelabras and old giants, grown into the world as you explore. Tune it in-game with /tucson."
  );
  ModAPI.meta.credits("kkacin");

  // One function for both sides. The integrated server gets the whole thing;
  // the client calls it with "client" and only installs the cactus rule.
  // It has to be self-contained: appendCode ships its source to the worker.
  function tucsonCore(mode) {
    "use strict";

    const CLIENT = mode === "client";
    const TAG = CLIENT ? "[tucson/client]" : "[tucson]";

    const CONFIG = {
      ENABLED: true,
      STURDY: true,            // cactus joined to cactus stays up while the plant is rooted

      // --- where ---
      THINK_INTERVAL: 5,       // server ticks between planting passes
      RADIUS: 4,               // chunks around each player that get planted
      CHUNKS_PER_PASS: 4,      // most chunks visited per pass
      DENSITY_DESERT: 1.6,     // saguaros per chunk in deserts, mesas and savannas
      DENSITY_ELSEWHERE: 0.2,  // ...and everywhere else that isn't frozen (0 = deserts only)
      TRIES_PER_SITE: 4,       // shapes tried on a spot before giving up on it
      SAND_PATCH: true,        // off the sand, plant on a little patch of it
      MARKER: true,            // mark visited chunks in the world so a restart doesn't replant
      MARKER_Y: 1,

      // --- shapes: relative weights ---
      W_YOUNG: 14,             // 2–3 tall, no arms yet
      W_SPEAR: 18,             // straight up, no arms
      W_ARM: 24,               // one arm
      W_TWIN: 22,              // two arms
      W_CANDELABRA: 14,        // three or four
      W_GIANT: 8,              // very tall, three or four arms, some kinked
    };

    const PRESETS = {
      tucson:  { DENSITY_DESERT: 1.6, DENSITY_ELSEWHERE: 0.2 },
      desert:  { DENSITY_DESERT: 1.6, DENSITY_ELSEWHERE: 0 },
      sparse:  { DENSITY_DESERT: 0.5, DENSITY_ELSEWHERE: 0.05 },
      forest:  { DENSITY_DESERT: 4, DENSITY_ELSEWHERE: 1 },
    };
    let preset = "tucson";

    // ============================================================
    // VERSION COMPAT
    // ============================================================
    const IS_1_12 = !!ModAPI.reflect.getClassById("net.minecraft.util.math.BlockPos");
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
      console.warn(TAG + " " + tag + " unavailable:", err);
    }

    // ============================================================
    // SMALL HELPERS
    // ============================================================
    const num = (v, dflt) => (typeof v === "number" && isFinite(v) ? v : dflt);
    const raw = (o) => (o && typeof o.getRef === "function" ? o.getRef() : o);
    const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    function call(obj, name, dflt) {
      try {
        if (obj && typeof obj[name] === "function") return obj[name]();
      } catch (e) {
        softFail(name, e);
      }
      return dflt;
    }

    function callAny(obj, names, args, tag) {
      for (const name of names) {
        try {
          if (obj && typeof obj[name] === "function") return obj[name].apply(obj, args);
        } catch (e) {
          softFail(tag || name, e);
          return undefined;
        }
      }
      return undefined;
    }

    function jstr(s) {
      if (typeof s === "string") return s;
      try {
        return s ? String(ModAPI.util.unstr(s)) : "";
      } catch (e) {
        return "";
      }
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

    function posXYZ(p) {
      const w = p && typeof p.getX !== "function" ? ModAPI.util.wrap(p) : p;
      if (!w) return null;
      const x = typeof w.getX === "function" ? w.getX() : w.x;
      const y = typeof w.getY === "function" ? w.getY() : w.y;
      const z = typeof w.getZ === "function" ? w.getZ() : w.z;
      return typeof x === "number" && typeof y === "number" && typeof z === "number" ? [x, y, z] : null;
    }

    function stateAt(world, x, y, z) {
      const p = blockPos(x, y, z);
      if (!p) return null;
      try {
        return world.getBlockState(p);
      } catch (e) {
        softFail("world.getBlockState", e);
        return null;
      }
    }

    function blockOf(state) {
      const b = state ? call(state, "getBlock", null) : null;
      return b ? raw(b) : null;
    }

    function material(state) {
      return state ? call(state, "getMaterial", null) : null;
    }

    function isSolid(state) {
      return !!call(material(state), "isSolid", false);
    }

    function isLiquid(state) {
      return !!call(material(state), "isLiquid", false);
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

    const blockCache = {};

    // 1.12 shouts the field names (Blocks.CACTUS), 1.8 whispers them.
    function blockNamed(name) {
      if (name in blockCache) return blockCache[name];
      const b = blocks();
      const found = b[name.toUpperCase()] || b[name.toLowerCase()] || null;
      blockCache[name] = found ? raw(found) : null;
      return blockCache[name];
    }

    function defaultState(name) {
      const s = call(blockNamed(name), "getDefaultState", null);
      return s ? raw(s) : null;
    }

    function isBlock(block, names) {
      if (!block) return false;
      for (const n of names) if (block === blockNamed(n)) return true;
      return false;
    }

    // ============================================================
    // THE CACTUS RULE
    // ============================================================
    // Vanilla: a cactus stays if nothing solid is beside it and it stands on
    // cactus or sand. Saguaro: a cactus may also have cactus beside it, as long
    // as the plant it's joined to still touches sand somewhere. That's what
    // lets an arm hang off the trunk, and what makes a felled saguaro fall.
    const SUPPORT_LIMIT = 128;   // a cactus sculpture bigger than this just stays

    function saguaroStays(world, x, y, z) {
      const cactus = blockNamed("cactus");
      if (!cactus) return false;

      // Nothing solid but cactus beside it, and no lava.
      for (const [dx, dz] of SIDES) {
        const s = stateAt(world, x + dx, y, z + dz);
        if (!s) return false;
        const b = blockOf(s);
        if (b === cactus) continue;
        if (isBlock(b, ["lava", "flowing_lava"]) || isSolid(s)) return false;
      }

      // Rooted: some block of the plant stands on sand.
      const seen = new Set();
      const queue = [[x, y, z]];
      seen.add(x + "," + y + "," + z);
      while (queue.length) {
        const [cx, cy, cz] = queue.shift();
        const below = blockOf(stateAt(world, cx, cy - 1, cz));
        if (below === blockNamed("sand")) return true;
        const around = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];
        for (const [dx, dy, dz] of around) {
          const nx = cx + dx, ny = cy + dy, nz = cz + dz;
          const k = nx + "," + ny + "," + nz;
          if (seen.has(k)) continue;
          if (blockOf(stateAt(world, nx, ny, nz)) !== cactus) continue;
          seen.add(k);
          if (seen.size > SUPPORT_LIMIT) return true;
          queue.push([nx, ny, nz]);
        }
      }
      return false;
    }

    let sturdyInstalled = false;

    function installSturdy() {
      try {
        const hooks = ModAPI.hooks && ModAPI.hooks.methods;
        const find = ModAPI.util && ModAPI.util.getMethodFromPackage;
        if (!hooks || typeof find !== "function") {
          softFail("ModAPI.hooks", "this build can't patch methods; saguaro arms will be fragile");
          return false;
        }
        const name = find("net.minecraft.block.BlockCactus", "canBlockStay");
        const vanilla = hooks[name];
        if (typeof vanilla !== "function") {
          softFail("BlockCactus.canBlockStay", "method not found; saguaro arms will be fragile");
          return false;
        }
        hooks[name] = function ($this, $world, $pos) {
          const ok = vanilla.apply(this, arguments);
          if (ok || !CONFIG.STURDY) return ok;
          try {
            const at = posXYZ($pos);
            if (!at) return ok;
            return saguaroStays(ModAPI.util.wrap($world), at[0], at[1], at[2]) ? 1 : 0;
          } catch (e) {
            softFail("saguaro rule", e);
            return ok;
          }
        };
        sturdyInstalled = true;
        return true;
      } catch (e) {
        softFail("cactus patch", e);
        return false;
      }
    }

    installSturdy();
    if (CLIENT) return;

    // ============================================================
    // RANDOMNESS — the same world seed grows the same saguaros
    // ============================================================
    function mix(h, n) {
      h ^= n | 0;
      h = Math.imul(h, 0x01000193);
      h ^= h >>> 15;
      return h | 0;
    }

    function rngFrom(seed) {
      let a = seed | 0;
      return function mulberry32() {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

    let seedParts = null;

    function worldSeed(world) {
      if (seedParts) return seedParts;
      let v = null;
      try {
        v = callAny(world, ["getSeed"], []);
        if (v === undefined || v === null) v = call(call(world, "getWorldInfo", null), "getSeed", null);
      } catch (e) {
        softFail("world seed", e);
      }
      if (typeof v === "number" && isFinite(v)) seedParts = [v | 0, Math.floor(v / 4294967296) | 0];
      else if (typeof v === "bigint") seedParts = [Number(BigInt.asIntN(32, v)), Number(BigInt.asIntN(32, v >> 32n))];
      else if (v && typeof v === "object" && "lo" in v && "hi" in v) seedParts = [v.lo | 0, v.hi | 0];
      else {
        const s = String(v === null || v === undefined ? "tucson" : v);
        let h = 0x811C9DC5;
        for (let i = 0; i < s.length; i++) h = mix(h, s.charCodeAt(i));
        seedParts = [h, 0];
      }
      return seedParts;
    }

    function chunkRng(world, cx, cz, salt) {
      const [lo, hi] = worldSeed(world);
      let h = 0x811C9DC5;
      h = mix(h, lo);
      h = mix(h, hi);
      h = mix(h, cx);
      h = mix(h, cz);
      h = mix(h, salt || 0x5A6);
      return rngFrom(h);
    }

    // ============================================================
    // SHAPES
    // ============================================================
    // A saguaro is a list of [dx, dy, dz] offsets from the base of its trunk.
    // Arms leave the trunk two blocks before they turn up, so there's a gap
    // between arm and trunk and it reads as an arm rather than a fat trunk.
    // Nothing reaches further than 3 blocks from the trunk.
    const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const SHAPES = ["young", "spear", "arm", "twin", "candelabra", "giant"];

    function pickShape(rng) {
      const w = SHAPES.map((s) => Math.max(0, num(CONFIG["W_" + s.toUpperCase()], 0)));
      const total = w.reduce((a, b) => a + b, 0);
      if (!(total > 0)) return "spear";
      let r = rng() * total;
      for (let i = 0; i < SHAPES.length; i++) {
        r -= w[i];
        if (r < 0) return SHAPES[i];
      }
      return SHAPES[SHAPES.length - 1];
    }

    function shuffle(rng, arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    }

    // One arm, heading out in `dir` from the trunk. Returns its blocks.
    function arm(rng, dir, height, kinked) {
      const [ux, uz] = dir;
      const out = [];
      const tipMax = height - 2;                    // arm tips stay below the trunk's
      const bends = kinked ? 1 : 0;
      const hiElbow = tipMax - 2 - bends;           // leave room to rise at least 2
      const loElbow = Math.max(2, Math.floor(height * 0.3));
      if (hiElbow < loElbow) return out;
      const elbow = randInt(rng, loElbow, hiElbow);

      out.push([ux, elbow, uz], [ux * 2, elbow, uz * 2]);
      let reach = 2, y = elbow;
      if (kinked) {
        // out, up a step, out again: the crooked arm of an old saguaro
        out.push([ux * 2, elbow + 1, uz * 2], [ux * 3, elbow + 1, uz * 3]);
        reach = 3;
        y = elbow + 1;
      }
      const tip = randInt(rng, y + 2, tipMax);
      for (let ry = y + 1; ry <= tip; ry++) out.push([ux * reach, ry, uz * reach]);
      return out;
    }

    function buildShape(rng, kind) {
      const SPEC = {
        young:      { h: [2, 3],   arms: [0, 0] },
        spear:      { h: [5, 9],   arms: [0, 0] },
        arm:        { h: [6, 10],  arms: [1, 1] },
        twin:       { h: [7, 11],  arms: [2, 2] },
        candelabra: { h: [9, 13],  arms: [3, 4] },
        giant:      { h: [12, 16], arms: [3, 4] },
      };
      const spec = SPEC[kind] || SPEC.spear;
      const height = randInt(rng, spec.h[0], spec.h[1]);
      const blocksOut = [];
      for (let y = 0; y < height; y++) blocksOut.push([0, y, 0]);

      // Twins sometimes hold their arms out opposite, like the postcard; the
      // rest point wherever.
      let dirs = shuffle(rng, DIRS.slice());
      if (kind === "twin" && rng() < 0.6) dirs = [dirs[0], [-dirs[0][0], -dirs[0][1]]];
      const n = randInt(rng, spec.arms[0], spec.arms[1]);
      let arms = 0;
      for (let i = 0; i < n && i < dirs.length; i++) {
        const a = arm(rng, dirs[i], height, kind === "giant" && rng() < 0.5);
        if (a.length) arms++;
        blocksOut.push.apply(blocksOut, a);
      }
      return { kind: kind, height: height, arms: arms, blocks: blocksOut };
    }

    // ============================================================
    // SITES — where a saguaro can go
    // ============================================================
    const REPLACEABLE = ["air", "tallgrass", "deadbush", "yellow_flower", "red_flower"];
    const PLANTABLE = ["sand", "grass", "dirt", "hardened_clay", "stained_hardened_clay"];

    function isAirAt(world, x, y, z) {
      const p = blockPos(x, y, z);
      if (!p) return false;
      try {
        return !!world.isAirBlock(p);
      } catch (e) {
        softFail("world.isAirBlock", e);
        return false;
      }
    }

    // The top block of a column: the one rain would land on.
    function groundY(world, x, z, hintY) {
      const p = blockPos(x, 0, z);
      if (p) {
        const top = callAny(world, ["getPrecipitationHeight", "getTopSolidOrLiquidBlock"], [p], "world.getPrecipitationHeight");
        const at = top ? posXYZ(top) : null;
        if (at && at[1] > 0) {
          // precipitation height skips plants, so step back down onto whatever
          // is solid or wet
          let y = at[1] - 1;
          while (y > 0 && !isSolid(stateAt(world, x, y, z)) && !isLiquid(stateAt(world, x, y, z))) y--;
          return y;
        }
      }
      // No height map in this build: look down from a bit above the player.
      const start = Math.min(255, Math.floor(num(hintY, 64)) + 32);
      for (let y = start; y > Math.max(0, start - 96); y--) {
        const s = stateAt(world, x, y, z);
        if (isSolid(s) || isLiquid(s)) return y;
      }
      return null;
    }

    function biomeKind(world, x, z) {
      try {
        const p = blockPos(x, 64, z);
        const biome = callAny(world, ["getBiome", "getBiomeGenForCoords"], [p], "world.getBiome");
        if (!biome) return null;
        let name = callAny(biome, ["getBiomeName"], []);
        if (name === undefined) name = biome.biomeName || biome.$biomeName;
        name = jstr(name).toLowerCase();
        if (!name) return null;
        if (/desert|mesa|badlands|savanna/.test(name)) return "desert";
        if (/snow|ice|frozen|cold/.test(name)) return "cold";
        return "elsewhere";
      } catch (e) {
        softFail("biome name", e);
        return null;
      }
    }

    // Does this shape fit with its trunk at (x, gy + 1, z)? Every block it'll
    // occupy has to be air or a plant, and nothing solid can touch its sides.
    function fits(world, x, gy, z, shape) {
      const ground = stateAt(world, x, gy, z);
      if (!isBlock(blockOf(ground), PLANTABLE)) return "ground";
      if (!isSolid(stateAt(world, x, gy - 1, z))) return "hollow";

      // no saguaros standing in the surf
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          if (isLiquid(stateAt(world, x + dx, gy, z + dz)) || isLiquid(stateAt(world, x + dx, gy + 1, z + dz))) {
            return "water";
          }
        }
      }

      const own = new Set(shape.blocks.map(([dx, dy, dz]) => dx + "," + dy + "," + dz));
      for (const [dx, dy, dz] of shape.blocks) {
        const bx = x + dx, by = gy + 1 + dy, bz = z + dz;
        if (by > 255) return "sky";
        if (!isAirAt(world, bx, by, bz) && !isBlock(blockOf(stateAt(world, bx, by, bz)), REPLACEABLE)) {
          return "blocked";
        }
        for (const [sx, sz] of SIDES) {
          if (own.has((dx + sx) + "," + dy + "," + (dz + sz))) continue;
          const s = stateAt(world, bx + sx, by, bz + sz);
          if (isSolid(s) || isLiquid(s)) return "crowded";
        }
      }
      return null;
    }

    // ============================================================
    // PLANTING
    // ============================================================
    const stats = { chunks: 0, marked: 0, planted: 0, tried: 0, blocks: 0, removed: 0 };
    const byKind = {};
    SHAPES.forEach((s) => { byKind[s] = 0; });
    const planted = [];          // this session's saguaros, for /tucson clear
    const MAX_REMEMBERED = 1024;

    function setBlock(world, x, y, z, state) {
      const p = blockPos(x, y, z);
      if (!p || !state) return false;
      try {
        // flag 2: send it to the clients but don't poke the neighbours, so the
        // plant goes up whole instead of being judged half-built.
        world.setBlockState(p, raw(state), 2);
        return true;
      } catch (e) {
        softFail("world.setBlockState", e);
        return false;
      }
    }

    function plant(world, x, gy, z, shape) {
      const cactus = defaultState("cactus");
      const sand = defaultState("sand");
      if (!cactus || !sand) {
        softFail("Blocks.CACTUS", "no cactus in this build");
        return false;
      }

      // Cactus only roots in sand. Off the sand, bring a little with it.
      if (blockOf(stateAt(world, x, gy, z)) !== blockNamed("sand")) {
        setBlock(world, x, gy, z, sand);
        if (CONFIG.SAND_PATCH) {
          for (const [dx, dz] of SIDES) {
            const s = stateAt(world, x + dx, gy, z + dz);
            if (isBlock(blockOf(s), ["grass", "dirt"]) && isSolid(stateAt(world, x + dx, gy - 1, z + dz))) {
              setBlock(world, x + dx, gy, z + dz, sand);
            }
          }
        }
      }

      const placed = [];
      for (const [dx, dy, dz] of shape.blocks) {
        const bx = x + dx, by = gy + 1 + dy, bz = z + dz;
        if (setBlock(world, bx, by, bz, cactus)) placed.push([bx, by, bz]);
      }
      stats.planted++;
      stats.blocks += placed.length;
      byKind[shape.kind] = (byKind[shape.kind] || 0) + 1;
      planted.push({ world: world, x: x, y: gy + 1, z: z, kind: shape.kind, blocks: placed });
      while (planted.length > MAX_REMEMBERED) planted.shift();
      return true;
    }

    // Try a few spots and shapes; plant the first that fits.
    function trySite(world, rng, x0, z0, hintY, forceKind) {
      for (let t = 0; t < CONFIG.TRIES_PER_SITE; t++) {
        stats.tried++;
        const shape = buildShape(rng, forceKind || pickShape(rng));
        const gy = groundY(world, x0, z0, hintY);
        if (gy === null) return "no ground";
        const why = fits(world, x0, gy, z0, shape);
        if (!why) {
          plant(world, x0, gy, z0, shape);
          return null;
        }
        if (forceKind && t === CONFIG.TRIES_PER_SITE - 1) return why;
        if (why === "ground" || why === "water" || why === "hollow") return why;   // a smaller one won't help
      }
      return "no room";
    }

    // ============================================================
    // CHUNKS — each visited once
    // ============================================================
    const seen = new Set();

    function chunkLoaded(world, cx, cz) {
      const p = blockPos(cx * 16 + 8, 64, cz * 16 + 8);
      const loaded = callAny(world, ["isBlockLoaded"], [p], "world.isBlockLoaded");
      if (loaded !== undefined && !loaded) return false;
      // Wait for vanilla to finish decorating it, so a tree doesn't land in
      // a saguaro's arms.
      const chunk = callAny(world, ["getChunkFromChunkCoords", "getChunk"], [cx, cz], "world.getChunk");
      const populated = chunk ? callAny(chunk, ["isPopulated", "isTerrainPopulated"], []) : undefined;
      return populated === undefined || !!populated;
    }

    function markerBlock() {
      return blockNamed("sandstone");
    }

    function alreadyPlanted(world, cx, cz) {
      if (!CONFIG.MARKER) return false;
      return blockOf(stateAt(world, cx * 16, CONFIG.MARKER_Y, cz * 16)) === markerBlock();
    }

    function mark(world, cx, cz) {
      if (!CONFIG.MARKER) return;
      if (setBlock(world, cx * 16, CONFIG.MARKER_Y, cz * 16, defaultState("sandstone"))) stats.marked++;
    }

    function plantChunk(world, cx, cz, hintY) {
      stats.chunks++;
      if (alreadyPlanted(world, cx, cz)) return;

      const rng = chunkRng(world, cx, cz);
      const kind = biomeKind(world, cx * 16 + 8, cz * 16 + 8);
      let density;
      if (kind === "desert") density = CONFIG.DENSITY_DESERT;
      else if (kind === "cold") density = 0;
      else if (kind === "elsewhere") density = CONFIG.DENSITY_ELSEWHERE;
      else {
        // Can't read the biome: go by what's underfoot.
        const cxm = cx * 16 + 8, czm = cz * 16 + 8;
        const gy = groundY(world, cxm, czm, hintY);
        const onSand = gy !== null && blockOf(stateAt(world, cxm, gy, czm)) === blockNamed("sand");
        density = onSand ? CONFIG.DENSITY_DESERT : CONFIG.DENSITY_ELSEWHERE;
      }
      density = Math.max(0, num(density, 0));
      const count = Math.floor(density) + (rng() < density - Math.floor(density) ? 1 : 0);

      for (let i = 0; i < count; i++) {
        // Keep every block of it inside this chunk: trunks at 4..11 and
        // nothing reaches more than 3 out.
        const x = cx * 16 + randInt(rng, 4, 11);
        const z = cz * 16 + randInt(rng, 4, 11);
        trySite(world, rng, x, z, hintY, null);
      }
      mark(world, cx, cz);
    }

    function overworld() {
      const server = ModAPI.server;
      if (!server) return null;
      const ref = typeof server.getRef === "function" ? server.getRef() : server;
      const key = ["$worlds", "$worldServers"]
        .map((k) => ModAPI.util.getNearestProperty(ref, k))
        .find((k) => ref[k] && Array.isArray(ref[k].data));
      const arr = key ? ref[key].data : null;
      return arr && arr[0] ? ModAPI.util.wrap(arr[0], {}, true) : null;
    }

    function livePlayers(world) {
      const out = [];
      try {
        const list = world.playerEntities;
        const n = list.size();
        for (let i = 0; i < n; i++) {
          const p = list.get(i);
          if (p && !p.isDead) out.push(p);
        }
      } catch (err) {
        softFail("world.playerEntities", err);
      }
      return out;
    }

    function think() {
      const world = overworld();
      if (!world) return;
      const players = livePlayers(world);
      if (!players.length) return;

      // Every unvisited chunk in range of anyone, nearest first.
      const todo = new Map();
      for (const p of players) {
        const pcx = Math.floor(num(p.posX, 0) / 16), pcz = Math.floor(num(p.posZ, 0) / 16);
        for (let dx = -CONFIG.RADIUS; dx <= CONFIG.RADIUS; dx++) {
          for (let dz = -CONFIG.RADIUS; dz <= CONFIG.RADIUS; dz++) {
            const d = dx * dx + dz * dz;
            if (d > CONFIG.RADIUS * CONFIG.RADIUS + 1) continue;
            const k = (pcx + dx) + "," + (pcz + dz);
            if (seen.has(k)) continue;
            const prev = todo.get(k);
            if (!prev || prev.d > d) todo.set(k, { cx: pcx + dx, cz: pcz + dz, d: d, y: num(p.posY, 64) });
          }
        }
      }
      const queue = Array.from(todo.entries()).sort((a, b) => a[1].d - b[1].d);

      let done = 0;
      for (const [k, c] of queue) {
        if (done >= CONFIG.CHUNKS_PER_PASS) break;
        if (!chunkLoaded(world, c.cx, c.cz)) continue;
        seen.add(k);
        plantChunk(world, c.cx, c.cz, c.y);
        done++;
      }
    }

    let tickCount = 0;

    ModAPI.addEventListener("tick", function () {
      if (!CONFIG.ENABLED) return;
      tickCount++;
      if (tickCount % Math.max(1, CONFIG.THINK_INTERVAL) !== 0) return;
      try {
        think();
      } catch (err) {
        errors++;
        console.error(TAG + " pass failed:", err);
        if (errors >= 10) {
          CONFIG.ENABLED = false;
          console.error(TAG + " stopped planting after 10 failures.");
        }
      }
    });

    // ============================================================
    // /tucson — runtime control
    // ============================================================
    function line(text) {
      return TextClass.constructors[0](ModAPI.util.str(text));
    }

    function say(target, text) {
      try {
        const comp = line(text);
        if (typeof target.sendMessage === "function") target.sendMessage(comp);
        else if (typeof target.addChatMessage === "function") target.addChatMessage(comp);
        else console.log(TAG + " " + text);
      } catch (err) {
        console.log(TAG + " " + text);
      }
    }

    function reply(sender, lines) {
      [].concat(lines).forEach((text) => say(sender, text));
    }

    function senderPos(sender) {
      if (sender && typeof sender.posX === "number") {
        return { x: sender.posX, y: sender.posY, z: sender.posZ, yaw: num(sender.rotationYaw, 0) };
      }
      const world = overworld();
      const p = world ? livePlayers(world)[0] : null;
      return p ? { x: p.posX, y: p.posY, z: p.posZ, yaw: num(p.rotationYaw, 0) } : null;
    }

    function plantHere(sender, kind) {
      const at = senderPos(sender);
      const world = overworld();
      if (!at || !world) return "nowhere to plant it";
      if (kind && kind !== "random" && SHAPES.indexOf(kind) < 0) return "shapes: random, " + SHAPES.join(", ");
      const yaw = (at.yaw * Math.PI) / 180;
      const x = Math.floor(at.x - Math.sin(yaw) * 5);
      const z = Math.floor(at.z + Math.cos(yaw) * 5);
      const rng = rngFrom((Date.now() ^ (x * 73856093) ^ (z * 19349663)) | 0);
      const pick = kind && kind !== "random" ? kind : pickShape(rng);
      const before = stats.planted;
      const why = trySite(world, rng, x, z, at.y, pick);
      if (stats.planted > before) {
        const s = planted[planted.length - 1];
        return "planted a " + s.kind + " saguaro at " + s.x + " " + s.y + " " + s.z;
      }
      return "no room for a " + pick + " there (" + why + ")";
    }

    function clearNear(sender, radius) {
      const at = senderPos(sender);
      if (!at) return "not sure where you are";
      const r2 = radius * radius;
      const cactus = blockNamed("cactus");
      const air = defaultState("air");
      let n = 0;
      for (let i = planted.length - 1; i >= 0; i--) {
        const s = planted[i];
        const dx = s.x - at.x, dz = s.z - at.z;
        if (dx * dx + dz * dz > r2) continue;
        // top down, and only the blocks that are still ours
        for (let j = s.blocks.length - 1; j >= 0; j--) {
          const [bx, by, bz] = s.blocks[j];
          if (blockOf(stateAt(s.world, bx, by, bz)) === cactus) setBlock(s.world, bx, by, bz, air);
        }
        planted.splice(i, 1);
        n++;
      }
      stats.removed += n;
      return "cleared " + n + " saguaro(s) planted this session within " + radius + " blocks";
    }

    function handle(sender, args) {
      const sub = (args[0] || "status").toLowerCase();

      if (sub === "on" || sub === "off") {
        CONFIG.ENABLED = sub === "on";
        errors = 0;
        return "tucson " + sub + (sub === "off" ? " (existing saguaros stay; /tucson clear removes them)" : "");
      }

      if (sub === "plant") return plantHere(sender, (args[1] || "random").toLowerCase());

      if (sub === "clear") {
        const r = parseFloat(args[1] || "64");
        return clearNear(sender, isFinite(r) && r > 0 ? r : 64);
      }

      if (sub === "shapes") return "shapes: " + SHAPES.join(", ") + " — /tucson plant <shape>";

      if (sub === "preset") {
        const name = (args[1] || "").toLowerCase();
        if (!PRESETS[name]) return "presets: " + Object.keys(PRESETS).join(", ");
        Object.assign(CONFIG, PRESETS[name]);
        preset = name;
        return "preset -> " + name + " (applies to chunks you haven't been to yet)";
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
          "/tucson                 status",
          "/tucson on | off        start or stop planting new chunks",
          "/tucson plant [shape]   grow one a few blocks in front of you",
          "/tucson shapes          " + SHAPES.join(", "),
          "/tucson clear [radius]  remove saguaros planted this session nearby",
          "/tucson preset <name>   " + Object.keys(PRESETS).join(" | "),
          "/tucson set KEY [v]     read or write any config value",
        ];
      }

      return [
        "tucson: " + (CONFIG.ENABLED ? "on" : "off") + ", preset " + preset +
          ", " + (IS_1_12 ? "1.12" : "1.8") + " adapter" +
          (sturdyInstalled ? "" : " — cactus patch missing, arms are fragile"),
        "saguaros " + stats.planted + " (" + stats.blocks + " blocks) in " + stats.chunks + " chunks visited",
        SHAPES.map((s) => s + " " + byKind[s]).join(" | "),
      ];
    }

    ModAPI.addEventListener("processcommand", function (event) {
      const text = String(event.command || "");
      if (!/^\/tucson(\s|$)/i.test(text)) return;
      event.preventDefault = true;
      try {
        reply(event.sender, handle(event.sender, text.trim().split(/\s+/).slice(1)));
      } catch (err) {
        console.error(TAG + " command failed:", err);
      }
    });

    // For poking at it from the worker console, and for the tests.
    globalThis.Tucson = {
      CONFIG, PRESETS, SHAPES, stats, byKind, planted,
      buildShape, pickShape, rngFrom, saguaroStays, fits, plantChunk, groundY,
      get sturdy() { return sturdyInstalled; },
    };

    console.log(TAG + " server side online (" + (IS_1_12 ? "1.12" : "1.8") + " adapter)");
  }

  ModAPI.dedicatedServer.appendCode(tucsonCore);

  // The client needs the same cactus rule, or it would knock the arms off its
  // own copy of the world every time a block next to one changed.
  tucsonCore("client");

  console.log("[tucson] loaded; the saguaros are queued for the integrated server");
})();
