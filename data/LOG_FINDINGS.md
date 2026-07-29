# Mesh Rider log bundle analysis — 6 bundles, 3 client systems

Analysed 29 July 2026 from `longtermlog` support bundles. Raw metrics in
[`log_analysis.json`](log_analysis.json); loadable map layouts in [`layouts/`](layouts).

## What was in the bundles

| Bundle | Radio | Firmware | Channel | Samples | Duration | Link up |
|---|---|---|---|---|---|---|
| Air Flight 7 | RM-915-2KM-XO | 2025-06.5 | 918 MHz / 10 MHz | 481 | 28 min | 100% |
| GCS Flight 7 | RM-915v4-2KM-XO | 2025-06.5 | 918 MHz / 10 MHz | 480 | 28 min | 100% |
| GCS Kratos DD | RM-1675v4-2L-X | 2026-03.1 | 1636 MHz / 20 MHz | 18,718 | 10.7 h | 98.2% |
| Relay Kratos DD | RM-1675v4-2L-X | 2026-03.1 | 1636/1675/1715, 20+26 MHz | 9,318 | 5.4 h | **69.6%** |
| smartradio-…3af4e9 | RM-1675-2KM-XW | 2024-10.1 | 1675 MHz / 10 MHz | 143 | 8 min | 100% |
| smartradio-…50814f | RM-1675-2KM-XO | 2024-10.1 | 1675 MHz / 10 MHz | 141 | 8 min | 100% |

All three pairs are genuine two-ended captures — each radio's logged peer MAC is the other's
mesh-interface MAC. The Kratos GCS additionally sees five peers, so that bundle covers a six-node mesh.

**No bundle contains GPS data.** `meshmap` is disabled (`enabled '0'`) and although `gpsd` is configured
against `/dev/GPS`, no position was ever logged. True locations therefore cannot be recovered from these
files — see *Placing this on the map* below.

---

## Findings

### 1. Flight 7 GCS: one receive chain is ~10 dB down — HIGH confidence, actionable
The GCS radio's two receive chains sit at **−73 and −63 dBm** (median imbalance 10 dB, peaks to 21 dB).
The air unit's chains are balanced (−72 / −71, 2 dB).

> **Correction (issued after the timing audit below).** This finding originally cited a 7 dB reciprocity
> error between the two directions as independent corroboration. **That corroboration is withdrawn.** The two
> Flight 7 logs were captured **32 minutes apart, not simultaneously**, and the aircraft was moving throughout
> (its implied range swings between 130 m and 26 km inside one log). Comparing a median from one half-hour
> against a median from a different half-hour does not measure reciprocity — it measures two different
> geometries. The chain-imbalance finding itself **stands unchanged**, because both chains are sampled at the
> same instant within a single log, so their 10 dB difference cannot be a timing artefact.

Consequence: **neither end ever exceeded MCS 6**, so the second spatial stream was never usable — exactly
what one degraded chain produces on a 2×2 radio. Measured impact: packet-loss ratio median **80–84%**,
**2.7 retries per frame** (air) and **5.1** (GCS), frames abandoned 70–100%, BATMAN TQ **36–55 / 255**.

The link was *associated the whole time* but effectively unusable for video. Signal strength was never the
limit: −62/−67 dBm at 10 MHz supports about MCS 12–13 with a 10 dB fade margin.

**Recommend:** inspect/swap the GCS antenna, pigtail and connector on chain 0, then re-run the same capture
and confirm the chains come within ~2 dB and MCS climbs above 8.

### 2. Flight 7: the 918 MHz channel is busy — HIGH confidence
Channel activity median **70%** (air) and **42%** (GCS); noise floor median −93.7 / −87.5 dBm but peaking to
**−75 / −72 dBm**. The healthy reference pair (below) sits at 9–10% activity with a steady −99/−92 dBm floor.

Bursty co-channel occupancy destroys frames even when average SNR looks fine, which compounds finding 1.

**Recommend:** a spectrum/ACS scan at the site before the next flight, and pick a quieter channel inside
902–928 MHz (the regulatory table in the bundle allows the whole band at 30 dBm).

### 3. Kratos GCS and Relay: local antenna chain imbalance on both — HIGH confidence
The GCS shows an imbalance against **every one of its five peers** (5, 6, 7, 5, 2 dB), always with chain 0
weaker. An imbalance that follows the receiver rather than the peer is a **local** antenna/cable fault, not
propagation. The Relay shows the same pattern against its peers (7, 6, 4, 6 dB).

The Relay **never exceeded MCS 6 on any link**, i.e. it ran single-stream throughout, halving its throughput.

**Recommend:** check chain 0 antenna/feed on both units; the fleet-wide consistency suggests an
installation or cable-batch issue rather than two coincidental failures.

### 4. Kratos Relay: linked only 69.6% of the time, and it changed channel mid-mission — needs confirmation
The Relay was associated for 69.6% of samples and operated across **1636, 1675 and 1715 MHz at both 20 and
26 MHz** within one log. The GCS stayed on 1636 MHz / 20 MHz the entire time.

If the Relay is re-scanning (ACS) while the GCS holds a fixed channel, that alone explains the dropouts.
Worth confirming whether automatic channel selection is enabled on the Relay only.

### 5. Signal levels imply bench/ramp ranges, not field ranges — interpretation caveat
Implied separations from the measured levels: Kratos peers **15–60 m** (−24 to −36 dBm), longtermmon pair
**~25–30 m** (−29/−31 dBm). Two genuine over-air links exist in the Relay data (−59 dBm ≈ 330 m and
−77 dBm ≈ 3.7 km).

At −24 to −36 dBm the receive front end can be near compression, which produces *these very symptoms*
(retries and depressed rates despite an enormous signal). Conclusions about rate control drawn at 15 m do
not transfer to field range. For bench work, add attenuators or separate the radios — consistent with
Doodle Labs' own bench-testing guidance.

### 6. Healthy control — useful as the reference
The `smartradio-…3af4e9 ↔ …50814f` pair is clean: **MCS 15 sustained, TQ 255/255, 0% packet loss**, noise
−99/−92 dBm, activity 9–10%. It is the "what good looks like" baseline for the comparisons above. Its only
flag is a **5 dB chain imbalance** on …3af4e9 — not currently hurting it at 25 m, but worth checking before
it is deployed at range.

### 7. Firmware spread across clients — informational
2024-10.1, 2025-06.5 and 2026-03.1 across the three systems. Each pair matches internally, which is what
matters for interoperability; the …3af4e9/…50814f pair is roughly two years behind current.

---

## Two false leads, rejected

Recording these because they would each have been a confident, wrong headline:

* **"TX power is only 15 dBm."** That figure belongs to `wlan1`, the 5 GHz Wi-Fi hotspot (SSID
  `DoodleLabsWiFi`, channel 157). The mesh radio is `wlan0`, running **30 dBm (air) and 32 dBm (GCS)**,
  matching `option txpower` in the config. No power problem.
* **"98.9% CRC error rate."** `wireless_stats/recv_1` shows 109,782 CRC errors out of 110,971 packets — but
  110,638 of those are spectral-scan samples, which the driver counts as PHY errors. Normal for a radio with
  spectral scan enabled, not a fault.

Also note two **implausible noise samples**: the Kratos GCS reports a −43.9 dBm peak and the Relay a
**0.0 dBm** peak. 0.0 dBm is not a physical reading; both are almost certainly captured during a channel
switch or reset. Treated as data-quality artefacts, not interference.

---

## Placing this on the map

Without GPS the true geometry is unrecoverable, so three layouts are provided with **synthetic positions at
the implied separations**, ready to load with 📂 Load:

| File | Contents |
|---|---|
| `layouts/flight7.json` | GCS ↔ air unit, 918 MHz/10 MHz, labelled with measured levels and the chain fault |
| `layouts/kratos-mesh.json` | Six-node Kratos mesh at 1636 MHz/20 MHz around the GCS |
| `layouts/bench-pair-healthy.json` | The clean reference pair |

Each node's label carries its **measured** receive level and its measured defect, so once you drag the nodes
onto the real site the simulator's prediction sits next to the field measurement on the same screen. Loaded
as-is, the Kratos layout already predicts MCS 15 / 83 Mbps for the peer that measured MCS 15 at 15 m.

Separations assume 30–32 dBm TX (as reported by each radio), 3 dBi omnis at both ends and free space;
bearings are arbitrary. **They are a starting geometry, not a survey.**

## To get positions on the next capture

Enable position logging before the next flight and these bundles become directly mappable:

* set `meshmap.main.enabled=1` (currently `0` on every unit)
* confirm `gpsd` has a fix on `/dev/GPS` — it is enabled but nothing was logged

With that, the same analysis can plot the track, colour it by measured MCS/RSSI, and compare it
position-by-position against the simulator's terrain-aware prediction.

---

## Can the radios be positioned from these logs? No — and the data says why

Asked whether the transmitters could be located from signal strength alone. The tooling
(`tools/solve_mesh_geometry.py`) reconstructs relative geometry from pairwise ranges by stress
majorisation, and it **refused to solve** on this dataset. Three independent reasons, each fatal on its own:

**1. No pair was captured at the same time.** Positioning needs simultaneous measurements.

| System | Radio A window (UTC) | Radio B window (UTC) | Overlap |
|---|---|---|---|
| Flight 7 | 2025-09-30 18:31–18:59 | 2025-09-30 19:31–19:59 | **none, 32 min apart** |
| Kratos | 2022-05-06 02:14–12:54 | 2022-05-05 13:26–18:51 | **none, different day** |
| Bench pair | 2022-05-05 13:58–14:06 | 2022-05-05 14:21–14:29 | **none, 15 min apart** |

**2. The Kratos ranges are geometrically impossible together.** The GCS measures peer 21:07 at 15 m and the
Relay at 55 m, while the Relay measures that same peer at 3.7 km. Two nodes 55 m apart cannot disagree by
3.6 km about a third. The triangle inequality is violated by **3593 m** on that triple and 251 m on another —
arithmetic proof that the samples describe different moments, not one layout.

**3. Each pair yields only one range anyway.** One range is a circle, not a point. A position needs
**three or more mutual ranges**, or one known position plus a known bearing.

### What *is* defensible: the static links

Where a link's implied range is stable and its apparent closing rate is ~0, the distance is real. Filtering
the placeholder samples (some records report 0 dBm, which no receiver does) and measuring the implied
closing rate between consecutive samples separates the static links from the moving ones:

| Link | Implied separation | Apparent motion | Verdict |
|---|---|---|---|
| Bench pair, both directions | **20 m and 25 m** | 0% of steps implausible | Static, ~20–25 m apart |
| Kratos 23:1b ↔ 21:13 | **18 m** | 0% | Static |
| Kratos 20:fb ↔ 2d:81 | **18 m** | 0% | Static |
| Kratos 23:1b ↔ 22:ff | **23 m** | 0.3% | Static |
| Flight 7, both directions | median 2.9 km / 2.1 km | **63–66%** | Airborne — a median is meaningless |
| Kratos 23:1b ↔ 20:fb | median 52–58 m | 17–23% | Partly moving |

"Implausible" means the level changed faster than a platform could physically move (>60 m/s). On the Flight 7
link the 95th-percentile apparent closing rate is **1200 m/s**, so on that link **RSSI is being driven by
fading, not by distance** — which is exactly why sample-level RSSI-to-range does not work there.

### What does work without GPS: range versus time

`tools/range_vs_time.py` emits a per-link CSV of implied range against time
(`data/range_profiles/`). For a UAS that is the flight profile in one dimension, recovered from the radio
alone: how far out it went, when it was closest, how fast the geometry changed. It cannot say *where*, but it
says *how far, over time* — and it labels the fraction of each trace that is fading rather than distance.

### To make the next capture positionable

* **Pull the logs from every radio over the same clock window.** Every sample already carries a UTC
  timestamp, so time-aligned solving works the moment the windows overlap.
* **Three or more radios that all hear each other**, or two radios whose positions are known.
* **Enable `meshmap.main.enabled=1` on the OEM and Wearable units** — those have GPS. Once they report
  position they become survey anchors, and the Nano/Mini ranges resolve into a real fix rather than a ring.
