CREATE TABLE points (
  id INTEGER PRIMARY KEY,
  map TEXT NOT NULL,
  floor INTEGER NOT NULL,
  kind TEXT NOT NULL,
  item TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  UNIQUE (map, floor, kind, item, x, y)
);
CREATE INDEX points_by_map ON points (map, hidden);

CREATE TABLE reports (
  id INTEGER PRIMARY KEY,
  point INTEGER NOT NULL REFERENCES points (id),
  verdict INTEGER NOT NULL CHECK (verdict IN (0, 1)),
  device TEXT NOT NULL,
  ip_day TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX reports_by_point ON reports (point, device, verdict, ts);

CREATE TABLE tips (
  id INTEGER PRIMARY KEY,
  point INTEGER NOT NULL REFERENCES points (id),
  body TEXT NOT NULL,
  lang TEXT NOT NULL,
  device TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 0 CHECK (status IN (0, 1, 2)),
  ts INTEGER NOT NULL
);
CREATE INDEX tips_by_point ON tips (point, status, ts);

CREATE TABLE limits (
  k TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  n INTEGER NOT NULL
);
CREATE INDEX limits_by_day ON limits (day);
