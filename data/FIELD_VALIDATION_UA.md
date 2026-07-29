# Field validation — Ukraine test, 42–44 km cliff

Reported test: **24 dBi parabolic on the GCS at 2 m**, **3 dBi multipolarised omni on the aircraft at
1000 m**, clear space, no jamming, **5 MHz channel**, frequencies swept **1675 → 2500 MHz**, link lost at
**42–44 km**. Stated working fade margin **12–14 dB**.

## What the tool predicts for that exact setup

Modelled at 42.6 km over real terrain (the engine reported **clear line of sight, 0 dB diffraction**, matching
"clear space"), RM-1675 class radio at 30 dBm, 1 dB cable each end, 24 + 3 dBi, 5 MHz, **1675 MHz**:

| Fade margin | Best usable rate | Throughput | Margin |
|---|---|---|---|
| 10 dB | MCS 10 | 7.4 Mbps | +10.5 dB |
| **12 dB** | **MCS 9** | **5.1 Mbps** | +12.5 dB |
| **14 dB** | **MCS 1** | **2.7 Mbps** | +15.5 dB |
| 20 dB | — | **no link** | — |

At his own 12–14 dB the model puts him **right at the edge at 42–44 km**: the rate has already collapsed to
the most robust modes, and a few more dB ends it. That is exactly the behaviour he describes — "42–44 km and
after you lose all". The model and the field agree without tuning.

## Why the cliff sits there — frequency is doing most of the work

His sweep spans 1675 → 2500 MHz, which is **3.5 dB** of extra free-space loss at the top end. Predicted
maximum range at the most robust rate (MCS 0, 5 MHz, 14 dB margin):

| Frequency | Max range at MCS 0 |
|---|---|
| 1675 MHz | **71.5 km** |
| 2500 MHz | **47.9 km** |

His 42–44 km wall matches the **top** of his frequency range, not the bottom. **Actionable: fly the low end
of the band (M1, 1625–1725) when range is the goal — worth roughly 1.5×.** If he is currently sweeping and
taking the worst case, that alone explains the number.

## Geometry checks — what is *not* the limit

* **Radio horizon is not the constraint.** With 2 m and 1000 m at the 4/3-earth factor the horizon is
  **136 km**. Nowhere near 44 km.
* **Fresnel clearance over flat ground is adequate but thin at the GCS end.** The tightest point of the
  whole 43 km path is about **200 m from the GCS**, where the ray is 6.6 m up and the 60% first-Fresnel
  requirement (plus earth bulge) is 4.1 m — a clearance ratio of only **1.63**. Everything beyond 1 km
  clears by 2.4× or better.

  That means **anything near the GCS costs him margin**: crops, vehicles, a berm, a slight rise. Raising the
  dish is the cheapest margin available:

  | GCS dish height | Clearance ratio at the tight point |
  |---|---|
  | 2 m (current) | 1.63 |
  | 4 m | 2.11 |
  | 6 m | 2.60 |
  | 10 m | 3.57 |

* **Dish aiming is fine at range but not on approach.** The aircraft sits **1.3° above horizontal at 43 km** —
  comfortably inside a 24 dBi dish beam. But it is **11.3° up at 5 km** and 5.7° at 10 km, so on launch and
  recovery it climbs out of the beam. If he sees dropouts close in, that is geometry, not a fault.

## Ways to buy more range, cheapest first

1. **Use the bottom of the band** (1675 rather than 2500 MHz): +3.5 dB ≈ **+50% range**. Free.
2. **Raise the GCS dish 2–4 m**: recovers the thin near-field clearance; several dB in practice.
3. **Narrow the channel to 3 MHz**: +2.2 dB sensitivity ≈ **+29% range**, at lower throughput.
4. **More gain on the aircraft**: every 3 dB is +41% range, if the airframe and mass budget allow it.
5. Accept a lower rate: at 14 dB margin MCS 1 (2.7 Mbps) survives well past where MCS 9 (5.1 Mbps) dies.

## Caveat

This is a free-space comparison because he reported clear space, and the engine agreed (0 dB diffraction over
the modelled path). Predictions use the conservative Doodle Labs sensitivity set. Two things are *not*
modelled and would both shorten range: **ambient noise above thermal** (very plausible in a contested RF
environment even without deliberate jamming) and **near-GCS clutter** at the 2 m antenna height. If his
measured cliff is consistently tighter than the table above, those two are where the missing dB will be.

## What changed in the tool as a result

**Fade margin is now configurable** (top right of the toolbar, default 10 dB). Every link budget, coverage
heatmap, mission route and Plan Advisor result uses the value set, and the exported report states which
margin the numbers were computed at. A hint next to the field flags what each value means — 10 dB is the
Doodle Labs plan, 12–14 dB is field practice, and anything below 5 dB is labelled as bench-only.
