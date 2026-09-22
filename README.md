# stuff

Four EaglerForge mods for **EaglercraftX 1.12.2**:

| File | What it does |
| --- | --- |
| [`spidermod.js`](spidermod.js) | Pendulum web-swinging and wall-crawling. |
| [`smartzombies.js`](smartzombies.js) | Zombie AI overhaul — flanking, horde comms, target leading, dodging. |
| [`lavaskeletons.js`](lavaskeletons.js) | Skeletons gargle and vomit arcing globs of lava at you. |
| [`acidrain.js`](acidrain.js) | Rain that burns you, eats your armour and dissolves the terrain. |

All four are plain JavaScript mods for [EaglerForgeInjector](https://github.com/eaglerforge/EaglerForgeInjector).
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

## lavaskeletons

Get in range of a skeleton and it stops, gargles for most of a second with fire
spilling out of its jaw, and then heaves a stream of lava globs at you.

- **The arc is solved, not guessed.** A glob is a fireball with its thrust taken
  away and gravity hung on it instead, so it loses 5% of its speed every tick
  while falling — which the schoolbook ballistics formula gets badly wrong. The
  mod walks candidate launch angles through the glob's *own* integration step
  and narrows in on the one that passes closest to you, twice. From 3 to 16
  blocks out it lands within a quarter of a block, including downhill off a
  ledge.
- **It won't telegraph a shot it can't make.** If nothing in its angle range
  reaches you — you're too far, or too far above it — it doesn't gargle at all.
- **The gargle is a real warning.** `GARGLE_TICKS` of standing still, dribbling
  fire, before anything comes out, and the glob takes up to a second to arrive.
  Both are dodgeable. Break line of sight mid-heave and the rest is called off.
- **Leading.** Globs are aimed at where you'll be, measured from your position
  between passes, because a player's server-side `motionX` is mostly zero.
- **Splashes.** Where a glob lands, anything inside `SPLASH_RADIUS` catches
  fire and a puddle of lava is left behind.
- **Nothing it puts in your world is permanent.** Every block it places is
  recorded with the state that was there before and put back `LAVA_TICKS` later,
  on `/skeletons off`, on `/skeletons clear`, or if the mod gives up. Puddles go
  down with the neighbour update suppressed, so the lava can't start flowing,
  they only ever replace air over solid ground, and there's a hard cap on how
  many can be live at once. `mobGriefing false` turns them off entirely.
- **They're full of the stuff.** A skeleton doesn't cook in its own splash.
  Daylight still gets them.
- **Kill one and it spills**, which is a reason not to fight them indoors.

Stray and wither skeletons are `AbstractSkeleton` subclasses, so they do it too.
Bows are untouched — this is on top of the vanilla AI, not instead of it.

Like smartzombies, it runs on the **integrated server**, so it works in
singleplayer and for people on your LAN world, and does nothing on someone
else's server.

### In-game controls

```
/skeletons                status and counters
/skeletons on | off       enable or disable it (off cleans up every puddle)
/skeletons clear          put every puddle back right now
/skeletons preset <name>  drizzle | normal | inferno
/skeletons set KEY [value] read or write any config value, e.g. /skeletons set GLOBS 6
/skeletons help
```

`RARITY` decides what fraction of skeletons are the lava-filled kind — it's
hashed off the entity id, so a given skeleton is always the same answer rather
than re-rolling four times a second. Set it below 1 and most skeletons stay
ordinary.

---

## acidrain

It starts raining. You have about two seconds before it starts hurting.

- **Standing in it costs you.** Anywhere the rain actually lands — open sky,
  right biome, right altitude, which is vanilla's own test — you take damage
  every second after `GRACE_TICKS`. Get under anything at all and it stops.
- **It gets worse the longer you're out.** Damage ramps from `DAMAGE` up to
  `RAMP_MAX` times that over `RAMP_TICKS` of unbroken exposure, so sprinting
  between two doorways is survivable and crossing a field is not. Duck under
  cover and the ramp drains at `DRY_RATE`, which is fast — shelter genuinely
  resets the clock.
- **Thunderstorms are worse again** (`THUNDER_MULTIPLIER`), and a thunderstorm
  that grows out of a harmless drizzle turns it acid mid-storm.
- **Armour buys you time and is eaten for it.** Each worn piece takes
  `ARMOUR_REDUCTION` off the damage — a full set is 80% off by default — and
  loses `ARMOUR_WEAR` durability per second you stand in the rain. Iron is
  cheap; a full set is a consumable umbrella, and when it breaks you find out.
  (The damage source bypasses vanilla armour, so this is the only armour
  calculation, not one stacked on top of another.)
- **Water shields you.** So does a hole, a tree, or a one-block overhang.
- **Mobs are out in it too**, at `MOB_MULTIPLIER`. A storm thins out whatever
  was wandering the surface, which is either a gift or a problem depending on
  what you were farming. Creative and spectator players are left alone.
- **It dissolves the terrain.** Blocks with sky above them wear down a step at
  a time: grass and mycelium to dirt, stone to cobblestone to gravel to sand,
  sandstone and clay to sand, and leaves, snow, ice, crops and flowers straight
  to nothing. A block that's been eaten is left alone until it grows back, so
  it erodes evenly rather than drilling one hole.
- **Which means cover moves.** The canopy you're sheltering under is itself
  being eaten, and when the leaves go, the rain finds you.
- **Nothing it does to the world is permanent by default.** Every corroded
  block is recorded with the state that was there before and put back
  `HEAL_TICKS` later, on `/acidrain off`, on `/acidrain heal`, or if the mod
  gives up. There's a hard cap on how many it remembers at once, oldest healed
  first. `mobGriefing false` turns corrosion off entirely, and `PERMANENT true`
  turns it one-way — then it isn't recorded and it never grows back.
- **You get told.** An acid storm announces itself in chat, and a green
  overlay warns you while you're standing in it.

Like smartzombies and lavaskeletons, the damage and the corrosion run on the
**integrated server**, so it works in singleplayer and for people on your LAN
world, and does nothing on someone else's server. The screen warning is the
only client-side piece.

### In-game controls

```
/acidrain                       status and counters
/acidrain on | off              enable or disable it (off heals every scar)
/acidrain heal                  put every corroded block back right now
/acidrain storm on|off|thunder  start or stop the weather
/acidrain preset <name>         mist | normal | caustic
/acidrain set KEY [value]       read or write any config value, e.g. /acidrain set DAMAGE 2
/acidrain help
```

`/acid` is an alias. By default every rainstorm is acid; set `ALWAYS_ACID`
false and `STORM_CHANCE` decides, rolled once when the storm rolls in and held
for that storm. Note that the screen warning is computed client-side from "is
it raining and can I see the sky", so it can't know which way that roll went —
turn `STORM_CHANCE` down and it will cry wolf.

---

## Tests

```
node test/run.js
```

`test/mock-modapi.js` is a small mock of the injector's ModAPI — proxied
entities, a java-ish `List`, a fake world with a ground plane, a ceiling slab,
named blocks you can change, weather you can turn on, armour that wears out, and
a projectile that integrates exactly the way `EntityFireball` does — which is
enough to run all four mods in Node. The suites check the real behaviour: that a web anchors and the pendulum stays taut and
finite, that wall-crawl climbs, that the nearest zombie charges while the others
take different flank slots, that a running target gets led, that a lost target
gets searched for, that a stared-at zombie sidesteps, that a burning one heads
for shade, that a skeleton gargles before it fires and that its solved arc lands
on the player from four blocks, from fifteen and from a ledge above, that a
splash sets the player alight but not other skeletons, that puddles sit on solid
ground and are all put back again, that acid rain leaves you alone until the
grace period is up and then bites harder the longer you stand in it, that a roof
and a puddle of water both stop it, that a full set of armour takes most of it
and is worn down for doing so, that it only eats blocks with sky above them and
only one step down the chain at a time, that every scar grows back, that a storm
rolled non-acid does nothing at all, and that `/zombies`, `/skeletons` and
`/acidrain` parse. It
is not a substitute for loading the mods in the real client, but it catches logic
errors without a browser.
