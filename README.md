# stuff

Two EaglerForge mods for **EaglercraftX 1.12.2**:

| File | What it does |
| --- | --- |
| [`spidermod.js`](spidermod.js) | Pendulum web-swinging and wall-crawling. |
| [`smartzombies.js`](smartzombies.js) | Zombie AI overhaul — flanking, horde comms, target leading, dodging. |

Both are plain JavaScript mods for [EaglerForgeInjector](https://github.com/eaglerforge/EaglerForgeInjector).
Run an unminified, unobfuscated EaglercraftX 1.12.2 offline download through the
injector, then load the `.js` files from the **Mods** button in Options.

`spidermod.js` also still works on a 1.8.8 build — it detects the version at
runtime — but 1.12.2 is what it's written and tuned for.

---

## spidermod

| Key | Action |
| --- | --- |
| `V` | Fire a web at whatever is above you / release it |
| `Jump` | Reel in while swinging |
| `Sneak` | Pay out rope while swinging |
| `Forward` | Pump the swing (tangential push in the direction you're looking) |
| `C` | Toggle wall-crawl |
| `P` | Dump adapter state to the console and chat |

Firing a web casts a fan of rays (`AIM_PITCH` × `AIM_YAW`) biased upward and
anchors to the nearest solid block above you. While attached, the mod strips the
velocity component pointing away from the anchor and pulls you back onto the
sphere, so you fall into a real pendulum arc instead of a spline. Slowly reeling
in while below the anchor is what makes the arc accelerate; release while rising
for a boost.

Wall-crawl holds you against any surface you walk into (`Jump`/`Forward` climbs,
`Sneak` descends).

Everything is tunable in the `CONFIG` block at the top of the file, or live from
the browser console via `SpiderMod.CONFIG`. `SpiderMod.state`, `.findAnchor()`
and `.isSolid()` are exposed there too.

### What changed from v1 (1.8.8)

v1 was written against the legacy radmanplays ModAPI and guessed at a lot of
things that the injector's ModAPI just provides:

- **World access.** v1 walked `mcinstance` trying `theWorld` / `world` /
  `field_71441_e`. Now it's `ModAPI.world` after `ModAPI.require("world")` — the
  injector aliases 1.12's `Minecraft.world` back to `theWorld`, so one call site
  covers both versions.
- **Blocks.** 1.12 moved `BlockPos` to `net.minecraft.util.math` and moved
  `getMaterial()` off `Block` onto `IBlockState`. Both are detected at load.
- **Events.** v1 guessed at event names (`drawhud`, `key`, `postmotionupdate`)
  and half of them don't exist. The injector fires `update`, `frame`, `render`,
  `load` and `sendchatmessage` client-side — that's it. Ticking runs on `update`,
  the HUD is a DOM overlay on `frame`, and keys come from the browser directly,
  since there is no key event at all.
- **`player.reload()`** is gone; `ModAPI.player` is a live proxy, so writes to
  `motionX` and friends land immediately.
- **Positions** now go through `setPosition()`, which moves the bounding box
  too. Writing `posX/Y/Z` alone left collision a tick behind and you clipped
  into walls you swung past.
- **Raycasting** walks the voxel grid a block at a time instead of sampling
  every 0.25 blocks — about a quarter of the block lookups for the same result.
- **Wall detection** uses the engine's own `isCollidedHorizontally` instead of
  probing four neighbour blocks, so slabs, stairs and fences work.
- Firing a web from a standing start now hops you off the ground, and a short
  grace window keeps the ground check from cutting the web on the same tick.

---

## smartzombies

Vanilla zombies walk straight at you and shove each other into walls. These:

- **Talk to each other.** One zombie spotting you hands the target to every
  zombie within `COMM_RADIUS`. A zombie *taking damage* shouts further
  (`ALARM_RADIUS`) — hit one and the block hears about it.
- **Flank.** The nearest `CHARGERS` zombies come straight at you; everyone else
  takes a slot around you measured from *your facing*, so they arrive from the
  sides and behind, then close in once they're in position.
- **Lead a moving target.** Goals are aimed where you'll be in `LEAD_TICKS`, not
  where you are, so they cut corners instead of trailing you. Velocity is
  measured from position deltas between AI passes — a player's server-side
  `motionX` comes from packets and is mostly zero.
- **Remember.** Break line of sight and they keep hunting your last known
  position for `MEMORY_TICKS` (~10s), poking around it rather than forgetting
  you the instant you round a corner.
- **Dodge.** A zombie you have centred in your crosshair sidesteps out of it,
  with a cooldown so it's a feint, not a jitter.
- **Not burn to death.** A burning zombie looks for a shaded, standable spot
  within `SUN_SEARCH` blocks and runs for it. Idle zombies caught in daylight do
  the same.
- **Get unstuck.** When the navigator can't find a path but you're visible, they
  hop and lean into the obstacle — which is also how a crowd ends up climbing
  over itself to reach a ledge. Door breaking is on for every zombie.

Inside `ENGAGE_RANGE` the mod backs off and lets vanilla melee AI do the
hitting, so damage, sounds and animations stay normal. Husks and zombie
villagers are `EntityZombie` subclasses, so they get the same brains.

### Where it runs

The AI runs on the **integrated server** (the dedicated server in the service
worker), pushed there with `ModAPI.dedicatedServer.appendCode` — that's where
mobs actually live. Steering them from the client would just be corrected on the
next position update.

So: it works in singleplayer, and for people joining your world over LAN. It
does **nothing** when you join someone else's server, because you aren't running
that server's AI. Nothing about it is a client-side advantage.

### In-game controls

```
/zombies                 status and counters
/zombies on | off        enable or disable the AI
/zombies preset <name>   chill | normal | nightmare
/zombies set KEY [value] read or write any config value, e.g. /zombies set FLANK_RADIUS 9
/zombies help
```

The AI thinks every `THINK_INTERVAL` ticks, only about zombies within
`ACTIVE_RANGE` of a player, and steers at most `MAX_PER_PASS` of them per pass.
If it throws ten times it disables itself and logs why, rather than lagging your
world forever.

---

## Tests

```
node test/run.js
```

`test/mock-modapi.js` is a small mock of the injector's ModAPI — proxied
entities, a java-ish `List`, a fake world with a ground plane and a ceiling slab
— which is enough to run both mods in Node. The suites check the real behaviour:
that a web anchors and the pendulum stays taut and finite, that wall-crawl
climbs, that the nearest zombie charges while the others take different flank
slots, that a running target gets led, that a lost target gets searched for,
that a stared-at zombie sidesteps, that a burning one heads for shade, and that
`/zombies` parses. It is not a substitute for loading the mods in the real
client, but it catches logic errors without a browser.
