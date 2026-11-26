-- Schema for disposable SQLite databases used by tests.
CREATE TABLE sponsor_accounts (
  afdian_id TEXT PRIMARY KEY,
  player_uuid TEXT NOT NULL
);

CREATE TABLE sponsor_names (
  player_uuid TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE sponsor_orders (
  id TEXT PRIMARY KEY,
  player_uuid TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  paid_at INTEGER NOT NULL CHECK (paid_at > 0),
  message TEXT
);

CREATE TABLE domain_revisions (
  domain TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0 CONSTRAINT revision_matches CHECK(version >= 0)
);

CREATE TABLE players (
  id TEXT PRIMARY KEY,
  current_name TEXT NOT NULL,
  role TEXT NOT NULL,
  disabled_at TEXT,
  banned INTEGER NOT NULL DEFAULT 0 CHECK (banned IN (0,1)),
  credentials_changed_at INTEGER NOT NULL DEFAULT 0 CHECK (credentials_changed_at >= 0),
  policy_checked_at INTEGER NOT NULL DEFAULT 0 CHECK (policy_checked_at >= 0)
);

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document)),
  player_uuid TEXT GENERATED ALWAYS AS (json_extract(document,'$.playerUuid')) VIRTUAL,
  expires_at TEXT GENERATED ALWAYS AS (min(json_extract(document,'$.idleExpiresAt'),json_extract(document,'$.absoluteExpiresAt'))) VIRTUAL
);

CREATE INDEX auth_sessions_owner ON auth_sessions(player_uuid,id);

CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);

CREATE TABLE auth_passkeys (
  id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document)),
  player_uuid TEXT GENERATED ALWAYS AS (json_extract(document,'$.playerUuid')) VIRTUAL
);

CREATE INDEX auth_passkeys_owner ON auth_passkeys(player_uuid,id);

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document)),
  expires_at TEXT GENERATED ALWAYS AS (json_extract(document,'$.expiresAt')) VIRTUAL
);

CREATE INDEX auth_challenges_expiry ON auth_challenges(expires_at);

CREATE TABLE auth_codes (id TEXT PRIMARY KEY,document TEXT NOT NULL CHECK(json_valid(document)));

CREATE TABLE auth_webauthn (
  id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document)),
  expires_at TEXT GENERATED ALWAYS AS (json_extract(document,'$.expiresAt')) VIRTUAL
);

CREATE INDEX auth_webauthn_expiry ON auth_webauthn(expires_at);

CREATE TABLE auth_rate_limits (id TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);

CREATE INDEX auth_rate_limits_expiry ON auth_rate_limits(reset_at);

CREATE TABLE buildings (id TEXT PRIMARY KEY, document TEXT NOT NULL);

CREATE INDEX buildings_duplicate_zh ON buildings (
  json_extract(document, '$.coordinates.world'),
  json_extract(document, '$.buildDate'),
  json_extract(document, '$.builders[0].uuid'),
  json_extract(document, '$.name."zh-CN"'), id
);

CREATE INDEX buildings_duplicate_en ON buildings (
  json_extract(document, '$.coordinates.world'),
  json_extract(document, '$.buildDate'),
  json_extract(document, '$.builders[0].uuid'),
  json_extract(document, '$.name.en'), id
);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at INTEGER, document TEXT NOT NULL, draft_key TEXT NOT NULL
);

CREATE INDEX submissions_owner ON submissions(owner, created_at DESC);

CREATE INDEX submissions_status ON submissions(status, created_at DESC);

CREATE INDEX submissions_expiry ON submissions(expires_at);

CREATE UNIQUE INDEX submissions_draft ON submissions(owner,draft_key);

CREATE TABLE image_uploads (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, draft_key TEXT NOT NULL, building_id TEXT NOT NULL,
  request_key TEXT, object_key TEXT, jxl_key TEXT, thumbnail_key TEXT, jxl_preview_bytes INTEGER,
  completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1))
);

CREATE INDEX uploads_owner ON image_uploads(owner, created_at);

CREATE INDEX uploads_expiry ON image_uploads(expires_at);

CREATE UNIQUE INDEX uploads_request ON image_uploads(owner,draft_key,request_key);

CREATE INDEX uploads_building ON image_uploads(building_id);

CREATE TABLE building_image_objects (
  object_key TEXT PRIMARY KEY, due INTEGER, state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','deleting','deleted'))
);

CREATE INDEX image_objects_due ON building_image_objects(due);

CREATE TABLE building_image_refs (
  owner TEXT NOT NULL, object_key TEXT NOT NULL, PRIMARY KEY(owner,object_key)
);

CREATE INDEX image_refs_key ON building_image_refs(object_key);

CREATE TRIGGER uploads_remove_refs AFTER DELETE ON image_uploads BEGIN
  DELETE FROM building_image_refs WHERE owner='upload/' || OLD.id;
END;

CREATE TRIGGER submissions_remove_refs AFTER DELETE ON submissions BEGIN
  DELETE FROM building_image_refs WHERE owner='submission/' || OLD.id;
END;

CREATE TRIGGER buildings_remove_refs AFTER DELETE ON buildings BEGIN
  DELETE FROM building_image_refs WHERE owner='building/' || OLD.id;
END;

CREATE TRIGGER image_ref_active BEFORE INSERT ON building_image_refs
WHEN (SELECT state FROM building_image_objects WHERE object_key=NEW.object_key) <> 'active'
BEGIN
  SELECT RAISE(ABORT,'image_unavailable');
END;

CREATE TABLE member_write_checks (
  active INTEGER NOT NULL CONSTRAINT current_session_required CHECK(active=1),
  member INTEGER NOT NULL CONSTRAINT membership_required CHECK(member=1)
);

CREATE TABLE afdian_sync (
  creator TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL DEFAULT 0,
  orders_complete INTEGER NOT NULL DEFAULT 0 CHECK(orders_complete IN (0,1)),
  lease TEXT,
  next_attempt INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE afdian_sponsors (
  creator TEXT NOT NULL REFERENCES afdian_sync(creator),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY(creator,user_id)
);

CREATE TABLE afdian_orders (
  creator TEXT NOT NULL REFERENCES afdian_sync(creator),
  order_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(amount_minor>=0),
  paid_at INTEGER NOT NULL,
  message TEXT,
  PRIMARY KEY(creator,order_id)
);

CREATE TABLE auth_read_checks (
  valid INTEGER NOT NULL CONSTRAINT auth_read_matches CHECK(valid=1)
);

CREATE INDEX sponsor_orders_player ON sponsor_orders(player_uuid,id);

CREATE INDEX sponsor_accounts_player ON sponsor_accounts(player_uuid,afdian_id);

CREATE INDEX afdian_orders_user ON afdian_orders(creator,user_id,order_id);

CREATE INDEX buildings_date ON buildings(json_extract(document, '$.buildDate') DESC, id);

CREATE INDEX buildings_type_date ON buildings(
  json_extract(document, '$.buildType'), json_extract(document, '$.buildDate') DESC, id
);

INSERT INTO domain_revisions(domain) VALUES ('buildings');
