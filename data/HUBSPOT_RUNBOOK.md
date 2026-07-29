# HubSpot log sweep — runbook and current state

Last updated 2026-07-29.

## Why this exists

Goal: find every Mesh Rider log bundle ever attached to a HubSpot ticket, work out
where and why links fail, whether our recorded fix actually addressed the measured
fault, and feed the measured spread back into the simulator as a variance term.

## State: built and tested, waiting on access

The pipeline is finished and rehearsed end to end against a mock HubSpot. Nothing
is blocked except the connector itself.

| Stage | Tool | State |
|---|---|---|
| 1. Pull tickets + attachments | `tools/hubspot_ingest.py` | built, mock-tested |
| 2. Analyse bundles | `tools/analyze_mesh_rider_logs.py` | handles any N bundles |
| 3. Classify failures + score fixes | `tools/failure_profile.py` | built, validated |
| 4. Radio matrix + variance | not built yet | see "Next" |

### Access check (do this first, it takes one call)

As of the last session HubSpot was **not** reachable. Three independent checks all
came back empty: `list_connectors`, `search_mcp_registry`, and `ToolSearch +hubspot`.
MCP connectors load at session start, so a connector added mid-session will not
appear until a restart.

If the MCP is present, test **attachment retrieval before anything else**. CRM MCP
servers commonly expose records but not file bytes, and the bundles are the whole
point. If bytes are unavailable, fall back to `hubspot_ingest.py`, which uses the
REST API directly and does not depend on the MCP at all.

### Running the ingest

Token goes in the environment, never on the command line or in chat:

```bash
export HUBSPOT_TOKEN=pat-na1-...
python tools/hubspot_ingest.py                 # enumerate only, downloads nothing
python tools/hubspot_ingest.py --download      # fetch + extract
python tools/analyze_mesh_rider_logs.py --bundles data/hubspot_bundles
python tools/failure_profile.py
```

Scopes needed: tickets (read), `crm.objects.companies.read`, files (read).
The script is read-only — GETs and search POSTs only, nothing written back to the CRM.

Enumeration is deliberately separate from download: the first run prints exactly
what it *would* fetch and writes `data/hubspot_manifest.json`, so the scale and cost
are known before a single byte moves. Get explicit approval before `--download`.

### Verified API shapes

- `GET /crm/v3/objects/tickets?associations=notes,emails,companies` — paged, `after` cursor
- `POST /crm/v3/objects/{obj}/batch/read` — 100 per call, **cannot** return associations
- attachments live on the engagement as `hs_attachment_ids`, **semicolon**-separated
- `GET /files/v3/files/{id}` — metadata; private files 404 on the plain `url`
- `GET /files/v3/files/{id}/signed-url` — always use this to download

`hs_resolution` does not exist in every portal. `batch_read` finds the offending
property by elimination and retries without it rather than failing the batch.

## Next: radio matrix and variance (the current ask)

Per radio model, build accuracy and probability-of-success figures, then feed the
spread back into the simulator.

**The distance trap.** Nano and Mini have no GPS, so for most bundles true range is
unknown and predicted-vs-actual *range* accuracy cannot be computed. Do not fake it.
What *is* measurable without distance:

- RSSI is measured, MCS is measured — so `predicted_best_MCS(RSSI, bw)` vs actual MCS
  validates the sensitivity and throughput model directly. `best_mcs_for()` already
  exists in the analyser.
- `connected_pct`, retry ratio, `pl_ratio`, chain imbalance → probability of success.
- The distribution of (actual MCS − predicted MCS) in dB-equivalent terms is the
  empirical variance term, and it connects straight to the configurable `FADE_MARGIN`
  work already shipped: it answers "how much margin does 90% success actually need."

Deliverables the user asked for: a per-radio-type matrix, a full report, an exec
summary, and the variance folded into the live calculations.

## Traps that have already produced confidently wrong answers

1. **`wlan1` is a 5 GHz Wi-Fi hotspot, not the mesh radio.** Taking the first `addr`
   or `txpower` in `iw_dev` yields "TX power is only 15 dBm" (false) and the wrong MAC.
   Always take the mesh interface. The analyser handles this; any new parser must too.
2. **Spectral-scan samples are not PHY errors.** Counting them produced a claimed
   "98.9% CRC error rate" that was false.
3. **Logs from different times cannot be combined into one geometry.** The two Flight 7
   bundles are 32 minutes apart with the aircraft moving. A reciprocity claim was
   withdrawn over this. `solve_mesh_geometry.py` gates on time overlap and the
   triangle inequality for exactly this reason.
4. **Six bundles is not a base rate.** The known set is mostly short-range test
   captures, which is why "bench-test artefact" scored 69%. Percentages only become
   meaningful across the full CRM history — say so in the report.

## Test assets

- `tools/` refactor verified byte-identical on the original six bundles,
  md5 `7353861ccf04eed9f27b7674712b4201` for `data/log_analysis.json`.
- Extracted bundles: session scratchpad `.../scratchpad/bundles/b1..b6`.
- Original tarballs: `C:\Users\jus24\Downloads` (six files).
- End-to-end mock rehearsal: `.../scratchpad/t_e2e.py` — mocks HubSpot, runs all four
  stages, asserts 6 bundles, 3 pairs, and a populated alignment breakdown.
  It overwrites `data/log_analysis.json`; restore with
  `git checkout -- data/log_analysis.json` afterwards.

`data/tickets.json`, `data/hubspot_manifest.json` and `data/hubspot_bundles/` are
gitignored — they carry customer names and ticket text.
