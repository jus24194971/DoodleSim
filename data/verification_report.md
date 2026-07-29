# Antenna Spreadsheet Verification Report

Verified against manufacturer datasheets, July 29 2026. Full detail incl. source URLs in `data/antennas_verified_master.json`.

**Summary: 90 rows checked — 31 confirmed, 19 corrected, 20 not_a_product, 14 partially_verified, 6 unverifiable**

## Rows that are NOT real orderable products (family labels, platforms, or nonexistent model numbers) — remove or fix in master sheet (20)

- **Row 12 — Synergy Telecom Pvt Ltd 2.4 GHz Omni (12 dBi)** (RM-2450): Generic family label, no model number. Synergy Telecom (synergyantenna.com) exists but its omni catalog shows no 2.4 GHz 12 dBi fiberglass omni; their 12 dBi products are LPDA directionals.
- **Row 15 — ? 2.4/5.8 GHz Whip** (RM-2450 series (2.4) / RM-5600 & RM-5400 & RM-5200 series (5.8)): Generic dual-band whip category with no manufacturer, model number, or datasheet URL; not a specific verifiable product.
- **Row 16 — Astra Microwave Products AMP-PATTS-203 (Example)** (RM-2450): Model is explicitly labeled '(Example)' and no 'AMP-PATTS-203' exists in any search result. Astra MWP does make S-band telemetry subsystems, but this row is a placeholder, not a purchasable catalog item. Site returns 307 to fetchers.
- **Row 30 — Verdant Telemetry & Antenna Systems multi-band** (RM-2025/RM-5200): Family/portfolio row only; no specific model number to verify.
- **Row 42 — Netgear ANT2408** (RM-2025): No Netgear ANT2408 exists: sheet URL 404s and no vendor/reseller listing found. Sheet's own doubt confirmed. Closest real models: Netgear ANT2409 (9 dBi omni) and ANT24O5 (5 dBi).
- **Row 56 — Astra Microwave Products Ltd. (Portfolio)** (RM-2025 (1.6–2.5 GHz) / RM-2450 / RM-5200 / RM-5400 / RM-5600): Portfolio row, no specific model. Astra Microwave (Hyderabad, est. 1991) is a real defense/space RF house; astramwp.com/antenna/ returned a 307 redirect, families confirmed via search/IndiaMART.
- **Row 72 — Cobham Antenna Systems C-Band** (RM-5200): Family label only; no specific model. Cobham antenna business now trades as European Antennas/Cobham Aerospace lines.
- **Row 74 — L-com (HyperLink) HG4958-18** (RM-5200): No 'HG4958-18' exists anywhere (L-com, distributors, archives). Real 4.9-5.8 panels: HG4958-19DP (19 dBi dual-pol), HG4958-23P (23 dBi). Sheet URL 404s. Likely fabricated model number.
- **Row 75 — L-com (HyperLink) HG4958-24D** (RM-5200): No 'HG4958-24D' found in any source. Real 4.9-5.8 dishes: HG4958DP-25D (25 dBi), HG4958DP-30D, HG4958DP-34D. Sheet URL 404s.
- **Row 76 — L-com (HyperLink) HG4958-22D** (RM-5200): No 'HG4958-22D' found. Closest real model: HG4958-22EG (22 dBi die-cast GRID, not solid dish, V/H selectable). Sheet URL 404s.
- **Row 77 — L-com (HyperLink) HG4958-19** (RM-5200): Plain 'HG4958-19' not a product. Almost certainly means HG4958-19DP: 4.9-5.8 GHz 19 dBi DUAL-polarized flat panel, 2x N-Female (not simple linear). Sheet URL 404s.
- **Row 78 — L-com (HyperLink) HG4958-29D** (RM-5200): No 'HG4958-29D' found. Closest: HG4958DP-30D (30 dBi dual-pol dish, 4.9-5.8) or HG5158DP-29D (28.5 dBi, 5.1-5.8). Sheet cites MikroTik, not L-com. Sheet URL 404s.
- **Row 79 — L-com (HyperLink) HG4958-15U** (RM-5200): No 'HG4958-15U' found; L-com's 4.9-5.8 omni line (HGV-4958-xxU) tops out at 12 dBi. No 15 dBi broadband 4.9-5.8 omni exists in catalog. Sheet URL 404s.
- **Row 80 — L-com (HyperLink) HG4958-12** (RM-5200): Model as written not sold. Very likely means HGV-4958-12U: 4.9-5.8 GHz 12 dBi omni, N-Female, vertical pol — matches sheet specs. Recommend correcting model number. Sheet URL 404s.
- **Row 83 — L-com (HyperLink) HG4958-14** (RM-5200): No 'HG4958-14' found anywhere. Real 4.9-5.8 panels are 7 (PCR), 17 (DP-090 sector), 19 (19DP), 23 (23P) dBi — no 14 dBi model. Sheet URL 404s.
- **Row 84 — Cambium Networks 450i** (RM-5200): PMP 450i is a radio platform, not an antenna. Sheet URL points to one accessory (5 GHz 60° sector); the 17 dBi figure cannot be attributed without a specific antenna SKU.
- **Row 92 — Cambium Networks ePMP** (RM-5200): ePMP is a radio platform family, not an antenna model. The 15 dBi likely refers to the ePMP 5 GHz sector antenna accessory at the sheet URL, but no SKU is specified.
- **Row 93 — CommScope 5 GHz** (RM-5200): '5 GHz' is a frequency/family label, not a CommScope model. No product to verify; the 18 dBi figure cannot be attributed to any SKU.
- **Row 94 — Hascall-Denke 2.2–2.5/4.4–5.875 GHz (custom models)** (RM-2025): Family/custom-capability row; model field is a band string, not a part number. Hascall-Denke does offer S/C-band custom antennas.
- **Row 95 — Telemart India (reseller) (reseller** (RM-2025/RM-5200): Reseller row with no model number (cell truncated '(reseller'). telemartindia.com returned HTTP 403; Telemart India is an electronics retailer, not an antenna manufacturer. Distinct from Telimart India.

## Model numbers that could not be verified anywhere — likely wrong or discontinued (6)

- **Row 47 — L-com (HyperLink/HyperGain) HG2415P** (RM-2025): No L-com product 'HG2415P' found; sheet URL 404s. Real models: HG2415P-180 (15 dBi 180-deg sector, vertical) and HG2414P (14 dBi flat panel). Sheet may have truncated/mangled the model number.
- **Row 51 — L-com (HyperLink) HG2406CU** (RM-2025): No 'HG2406CU' found on L-com or any distributor; ceiling CU line only has HG2403CU (3 dBi). HGV-2406U is a 6 dBi omni but not ceiling-mount. Sheet URL 404s.
- **Row 52 — L-com (HyperLink) HG2410U** (RM-2025): 'HG2410U' as written not in current L-com catalog (likely discontinued legacy HyperLink number). Closest current: HG2410DPU (10 dBi dual-pol omni) or HG2412U-PRO. Sheet URL 404s.
- **Row 55 — L-com (HyperLink) HG2405U** (RM-2025): Plain 'HG2405U' not sold; real variants are HG2405UP-NF (5 dBi outdoor omni, N-F) and HG2405U-NMO / HG2405UR-NMO (5 dBi mobile NMO mount). Sheet URL 404s.
- **Row 66 — CSG Networks (REN brand) REN 65824 SGPN** (RM-5600 / RM-5400): Model appears only as a dead csgnets.com URL; site unreachable, no spec sheet found. Numbering convention (658xx=5.8 GHz, 24=dBi) implies 5.8 GHz 24 dBi but that is inference, not verification.
- **Row 82 — Benelec 2759 (02759)** (RM-5200): Sheet URL dead (benelec.com.au cert now benelec.au; /product/02759/ 404s). No 02759 in Benelec's current catalog or web searches; likely a legacy/withdrawn part. Cannot verify any spec.

## Real products where the sheet's specs are WRONG — corrections found (19)

- **Row 9 — INPAQ Technology ACA-8010-A1-MC-S** (RM-2450): Not an Eteily product: 'ET-' prefixed model not found anywhere. Real part is INPAQ ACA-8010-A1-MC-S. Gain 1.9 dBi peak (48% efficiency), not 2.5. SMD pads, no connector.
- **Row 10 — Select Antenna (Select Telecom) SEL 24-17** (RM-2450): Model written as SEL-2417 in sheet; official page lists it as 'SEL 24-17'. Page's 5/7 deg beamwidths look implausibly narrow for 17 dBi (expect ~15-20 deg) - treat with caution.
- **Row 20 — Gleam Light India Pvt. Ltd. GLI/OMNI/01** (RM-1700 series (900 MHz) / RM-2450 ): Manufacturer page lists GLI/OMNI/01 as a 2 dBi indoor omni, 700-2700 MHz. Sheet gain 5-7 dBi is wrong; band upper edge is 2.7 not 2.4 GHz.
- **Row 23 — Gleam Light India Pvt. Ltd. COMNIID040 / WIFIFOMID2** (RM-1700 series (900 MHz) / RM-2450 series (2.4 GHz)): Row merges two different Gleam Light products; both exist on manufacturer pages, but sheet gain (2 dBi) matches neither and the two have different bands/types.
- **Row 28 — Verdant Telemetry & Antenna Systems Pvt. Ltd. JD 350 B** (RM1300/RM1400): Official Verdant page used instead of ec21 reseller link. Sheet omits the 960-1240 MHz L-band; 100W CW, 4kW peak L-band. VSWR segments run to 410 MHz.
- **Row 31 — Southwest Antennas 1009-015** (RM-2025): Sheet pattern wrong: this is a directional panel (55°/32° HPBW), not an omni whip. Band/gain/vertical pol confirmed.
- **Row 32 — Cisco AIR-ANT2524V4C-R** (RM-2025): Sheet's single 4 dBi figure is 5 GHz only; 2.4 GHz is 2 dBi. Cisco.com blocked fetch (403); specs cross-checked via Cisco install guide title and resellers.
- **Row 34 — Poynting OMNI-402** (RM-2025): EOL/discontinued per Poynting (successors OMNI-493/OMNI-414). It is an LTE/5G marine omni, not a 2.4/5 GHz WiFi antenna; does not cover 5 GHz WiFi.
- **Row 35 — Poynting XPOL-2-5G** (RM-2025): Cellular LTE/5G antenna, not WiFi. Same model appears in row 69 with a different claimed band; datasheet range is 617-4200 MHz for current V3. IP65.
- **Row 36 — Aruba (HPE) AP-ANT-13B (JW001A)** (RM-2025): Gain is per-band (4.4/3.3 dBi), not a flat 4 dBi. Legacy 802.11a/b/g/n accessory (AP-124/AP-204 era); arubanetworks.com page blocked (403), verified via HPE resellers.
- **Row 37 — MikroTik mANT19s** (RM-2025): mANT19s denotes the standalone antenna (MTAS-5G-19D120), not the integrated mANTBox 19s radio (RB921GS-5HPacD-19S) that the sheet's URL points to. 5 GHz only, not 2.4/5.
- **Row 41 — Alfa Network AOA-2458-59-TF** (RM-2025): Model suffix 59 = 5/9 dBi: 9 dBi applies only to 5 GHz; 2.4 GHz is 5 dBi. Sheet's flat 9 overstates 2.4 GHz gain by 4 dB.
- **Row 46 — MikroTik mANT15s** (RM-2025): Sheet band 2.4/5 GHz is wrong; MTAS-5G-15D120 is 5 GHz only. Sheet URL slug (mant15s) now 404s; current page is /product/MTAS-5G-15D120.
- **Row 53 — Hascall-Denke FXPR1350-2700-D** (RM-2025): Sheet lists only top-of-range gain; datasheet says 20–26 dBi. Isolation 32–45 dB; parabolic dish (P/N 1Y28200).
- **Row 58 — Celestial (Celestial Space Technologies) CST-S-9882 (sheet: 'Celestial S-Band Patch')** (RM-2100): Band wider than sheet claims: 2.05–2.30 GHz per satsearch. Gain/pol/type confirmed.
- **Row 67 — SEC Antenna (Smart Electronics Communication) SSP58SPG29** (RM-5600/ RM-5400): Two corrections: manufacturer is SEC Antenna (secantenna.com, Smart Electronics Communication), NOT Select Antenna; and sheet had no model number - resolved to SSP58SPG29 (5.8 GHz single-polarized solid dish). Specs otherwise match. F/B >=35 dB.
- **Row 69 — Poynting XPOL-2-5G** (RM-5200): Duplicate of row 35 with conflicting claims. Datasheet: cellular antenna, 617-4200 MHz max; unusable for RM-5200's 4.4-6.0 GHz band. Both sheet rows' band/gain are wrong.
- **Row 71 — Poynting OMNI-600** (RM-5200): EOL/discontinued per Poynting (alternatives OMNI-214/OMNI-293/XPOL-1-5G). Cellular antenna topping out at 3800 MHz; incompatible with RM-5200 band claim.
- **Row 73 — Southwest Antennas 1001-126** (RM-5200): Sheet pattern wrong: 1001-126 is an omni spring-base dipole, not a directional panel. Gain conflict noted (1.5 official vs 2.3 in some listings).

## Partially verified — some fields confirmed, others unavailable or conflicting (14)

- **Row 6 — Antenna Experts JCM6-2450** (RM-2450): Datasheet contradicts itself: header says 6 dBi, electrical spec table says 'Gain - Typical 9 dBi'. Sheet's 6 dBi matches header only.
- **Row 11 — Select Antenna (Select Telecom) SEL 24-24** (RM-2450): Sheet's noted 24-30 conflict is real: official page titled 24 dBi but spec table says 30 dBi. 24 dBi is physically plausible for 1000x600mm at 2.4 GHz; 30 is not. imimg URL in sheet is an unreadable scan.
- **Row 13 — Telimart India Pvt. Ltd. TM26D-HVPANEL-14** (RM-2450): Model exists on Telimart's own TradeIndia store. Gain conflicts: suffix implies 14 dBi but listings state 8 dBi or 7/10 dBi. Marketplace-grade evidence only.
- **Row 14 — CSG Networks CSG 62411 ODN** (RM-2450): csgnets.com unreachable (connection drops on http and https; also via browser). Model exists - datasheet filename is Google-indexed - but gain/connector/VSWR could not be independently read. Retry when site is back up.
- **Row 17 — Telimart India Pvt. Ltd. TM26L-SPDISH-15/21** (RM-2450): '-15/21' is a gain-range family label, not a SKU. TM26L SPDISH family confirmed via Telimart TradeIndia listings; per-SKU specs not published.
- **Row 18 — Eteily Technologies ET-9153R-SMMO** (RM-1700): Official page confirms model, gain, type, connector; marketed as 915 MHz. Sheet's 824-960 range not stated on page (plausible for GSM but unconfirmed). VSWR/power not published. IP65, 108 mm long.
- **Row 19 — Eteily Technologies ET-91518Y2-2L20C-NFS** (RM-1700): Official page confirms model, 18 dBi, yagi, N-F connector. Sheet band 824-960 not stated; page markets it as 915 MHz. 18 dBi is high for a compact 915 MHz yagi - unvalidated by pattern data. VSWR/power/beamwidth unpublished.
- **Row 21 — Gleam Light India Pvt. Ltd. OMNIODA070** (RM-1700): Exact code OMNIODA070 not found anywhere; Gleam Light's OMNIODA coding is real (OMNIODA120 exists) and a matching 7 dBi 860-870 MHz LoRa omni is on their IndiaMART page.
- **Row 22 — Gleam Light India Pvt. Ltd. OMNIOD4120** (RM-1700 series (900 MHz) / RM-2025): OMNIOD4120 as written not found; almost certainly a typo of OMNIODA120 (824-960 MHz, 12 dBi). The 1710-2700 MHz claim only appears as a loose wideband note on the listing.
- **Row 57 — Celestial (Celestial Space Technologies) CST-L-7070** (Partial overlap → RM-2100): Model exists; satellite TT&C patch, full-duplex CCSDS. Gain/pol/freq details only in gated datasheet. Sheet 'Omni/Vertical' unverified; patch pol likely circular.
- **Row 63 — Telimart India Pvt. Ltd. TM55L-SPDISH-23/38** (RM-5400/ RM-5200): '-23/38' is a gain-range family label, not a SKU. Telimart 4.9-5.9 GHz dish family (up to 38 dBi/6 ft) confirmed via TradeIndia and telimart.com.
- **Row 64 — Eteily Technologies ET-5812FG5-NMS** (RM-5600/ RM-5400): Official page confirms model, 12 dBi, N-Male, fiberglass. Marketed as 5.8 GHz; sheet's 5100-5800 range not stated on page. VSWR/power/beamwidth/polarization unpublished. 350 mm is short for 12 dBi at 5.8 GHz but feasible.
- **Row 65 — CSG Networks (REN brand); design equiv. Madhu Subtronic MES REN 65817 BFN** (RM-5600/ RM-5400): csgnets.com (REN seller) unreachable and archive blocked; specs taken from identically-numbered MES 65817 BFN (Madhu Subtronic). REN branding confirmed elsewhere (e.g. REN62424SGPN).
- **Row 68 — Southwest Antennas 1004-005** (RM-5200): Removed from southwestantennas.com (404). RFMW: 'Antenna, Panel, 4.0-6.4 GHz, 9dBi, SMA(F), Kydex, Side Mount' — 9 dBi panel suggests directional, contradicting sheet omni.

## Fully confirmed — sheet matches manufacturer data (31)

- **Row 5 — Antenna Experts JC12-2450** (RM-2450): Datasheet PDF fully verified. Marketed as jammer antenna; 8 deg vertical HPBW, 150 W.
- **Row 7 — Antenna Experts JC10-2450** (RM-2450): Verified from official product page (URL in sheet is the web page, not a PDF). Beamwidth not published there.
- **Row 8 — Antenna Experts AY-2450** (RM-2450): Datasheet PDF fully verified. F/B 18 dB, bandwidth 200 MHz.
- **Row 24 — Smart Electronics Communication (SEC Antenna) SGP-4/5/6/8 series** (RM-1700 series / RM-2450 series / RM-2025): Series row (4 dish sizes), not one SKU. Beamwidth spans 25° down to 2.9° across band/sizes; connector customizable, no single value. SGP-4 existence confirmed on IndiaMART.
- **Row 25 — Verdant Telemetry & Antenna Systems Pvt. Ltd. JD 401** (Partial overlap → RM-1700 series (900 MHz)): Official Verdant datasheet (hosted by distributor Elcom Systems). DC grounded, MIL 810F, for aircraft/UAV.
- **Row 26 — Verdant Telemetry & Antenna Systems Pvt. Ltd. JD 201** (RM1300/RM1400): Sheet's 'Verdant Antennas' resolves to Verdant Telemetry & Antenna Systems, Cochin. Datasheet matches sheet fully.
- **Row 27 — Verdant Telemetry & Antenna Systems Pvt. Ltd. JD 322 N** (RM1300/RM1400): Linked PDF is Verdant's official product brochure; JD 322 N datasheet page extracted directly and matches sheet.
- **Row 29 — Antenna Experts (India) AH-4959** (RM-5400- / RM-5400- / RM-5200- / RM-5200-): Manufacturer datasheet fully matches sheet. F/B 18 dB, 50 ohm, fiberglass radome, 300 mm long.
- **Row 33 — Cisco AIR-ANT2422DW-R** (RM-2025): All sheet values check out. Cisco.com datasheet fetch blocked (403); verified via Cisco install-guide listing and resellers.
- **Row 38 — TP-Link TL-ANT2409A** (RM-2025): Sheet's datasheet_url path is dead (404); live TP-Link URL differs. Datasheet lists vertical HPBW (76 deg) wider than horizontal (60 deg).
- **Row 39 — TP-Link TL-ANT2424B** (RM-2025): F/B ratio >30 dB. Polarization is selectable V or H by grid orientation. Sheet URL dead (404); current TP-Link URL differs.
- **Row 40 — Alfa Network APA-M04** (RM-2025): Sheet left pattern/type blank; filled from datasheet. Indoor-only panel. alfa.com.tw rate-limited (429) during check; datasheet PDF via authorized distributor.
- **Row 43 — D-Link ANT24-0700** (RM-2025): Indoor 802.11b/g-era antenna, long discontinued at D-Link (sold via legacy channels); specs verified from archived official datasheet.
- **Row 44 — Ubiquiti AMO-2G10** (RM-2025): Connector and power handling not stated on Ubiquiti spec page (weatherproof RF jumpers included for Rocket M).
- **Row 45 — Ubiquiti AM-2G15-120** (RM-2025): Azimuth beamwidth quoted by Ubiquiti at 6 dB, not 3 dB HPBW. Connector/power not stated.
- **Row 48 — Pasternack Enterprises PE51078** (RM-2025): Official Pasternack datasheet verified. Headline gain 5 dBi vs spec-table 5.5 dBi; sheet used 5.5. 198 mm long, -40 to +60 C.
- **Row 49 — L-com (HyperLink) HG2403CU** (RM-2025): Active product. Datasheet omits beamwidth and power rating (360-deg azimuth by design). Sheet's datasheet_url 404s; correct page found.
- **Row 50 — L-com (HyperLink) HG2424EG** (RM-2025): Datasheet marketing text says 8-deg beamwidth but spec table says 9 H / 11 V. F/B >=30 dB. Sheet's datasheet_url 404s.
- **Row 59 — Verdant Telemetry & Antenna Systems Pvt. Ltd. JL 50** (Partial overlap → RM-2100- / RM-2100-): Linked datasheet is actually JL 50 B, the lightweight variant of JL 50 (same 1430-1540 MHz band); quoted specs are for JL 50 B.
- **Row 60 — Select Antenna (Select Telecom) SEL-SEC-5816M** (RM-5400/ RM-5400 / RM-5200-): All sheet fields confirmed. Caution: max input power is only 5 W - incompatible with the 20 W Triad BDA paired in the sheet. Port isolation >30 dB, IP65.
- **Row 61 — Telimart India Pvt. Ltd. TM55D-HVOMNI-12** (RM-5400/ RM-5200): Specs from Telimart's vendor-authored ExportersIndia listing (marketplace-grade). E-plane 7°, DC-ground lightning protection, 75x585 mm.
- **Row 62 — Telimart India Pvt. Ltd. TM55D-HVSCTR-16** (RM-5400/ RM-5200): Telimart's own TradeIndia storefront listing; marketplace-grade evidence but internally consistent with sheet.
- **Row 70 — Hascall-Denke FXDP4.4-6.0-6-D** (RM-5200): All values confirmed from official datasheet (P/N 1Y47650). Ground-plane independent dipole for HCLOS/TRILOS.
- **Row 81 — MARS Antennas MA-WO56-DP10** (RM-5200): Sheet's datasheet_url (solidsignal.com homepage) is just a retailer; official MARS page confirms specs. V-pol gain dips to 8 dBi at 4.9-5.1 GHz.
- **Row 85 — Ubiquiti AM-5G20-90** (RM-5200): Beamwidths quoted at 6 dB. Connector/power not in QSG spec table.
- **Row 86 — Ubiquiti AM-5G19-120** (RM-5200): Sheet's flat 19 dBi is top of the 18.6-19.1 range. Beamwidths at 6 dB.
- **Row 87 — Ubiquiti AMO-5G10** (RM-5200): Band is upper 5 GHz only (5.45-5.85), narrower than a generic '5.0 GHz' label. Connector/power not stated.
- **Row 88 — Ubiquiti RD-5G30-LW** (RM-5200): LW = lightweight version of RD-5G30. F/B ratio 30 dB. Connector/power not stated (weatherproof RF connectors included).
- **Row 89 — Ubiquiti RD-5G34** (RM-5200): Connector/power not in QSG spec table.
- **Row 90 — MikroTik mANT30** (RM-5200): Band extends below 5 GHz (4.7-5.875), useful for RM-5200 4.4-5.0 GHz work. Sheet URL slug (mant30) now 404s; current page is /product/MTAD-5G-30D3.
- **Row 91 — MikroTik mANT30PA** (RM-5200): RF-identical to mANT30 (MTAD-5G-30D3); only the precision alignment mount differs.
