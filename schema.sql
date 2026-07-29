CREATE TABLE IF NOT EXISTS community_antennas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manufacturer TEXT NOT NULL,
  model TEXT NOT NULL,
  band_lo_mhz REAL NOT NULL,
  band_hi_mhz REAL NOT NULL,
  gain_dbi REAL NOT NULL,
  pattern TEXT NOT NULL,
  hpbw_az_deg REAL NOT NULL,
  hpbw_el_deg REAL NOT NULL,
  ant_type TEXT,
  submitted_at TEXT DEFAULT (datetime('now')),
  UNIQUE(manufacturer, model)
);
