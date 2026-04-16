-- ═══════════════════════════════════════════════════════
--  DRZ MINER — Schema PostgreSQL
--  Ejecutar en orden para crear todas las tablas
-- ═══════════════════════════════════════════════════════

-- ── EXTENSIONES ──────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── TABLA: USUARIOS ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                SERIAL PRIMARY KEY,
  telegram_id       VARCHAR(20) UNIQUE NOT NULL,
  username          VARCHAR(100),
  first_name        VARCHAR(100),
  
  -- Balances
  drz_balance       DECIMAL(18, 6)  NOT NULL DEFAULT 0,
  usdt_balance      DECIMAL(18, 6)  NOT NULL DEFAULT 0,
  
  -- Mining
  energy            INTEGER         NOT NULL DEFAULT 100,
  max_energy        INTEGER         NOT NULL DEFAULT 100,
  tap_power         DECIMAL(10, 4)  NOT NULL DEFAULT 0.01,
  total_clicks      BIGINT          NOT NULL DEFAULT 0,
  total_spend       DECIMAL(18, 6)  NOT NULL DEFAULT 0,
  
  -- Wallet
  deposit_address   VARCHAR(42),           -- Dirección BEP20 asignada
  
  -- Sistema de referidos
  ref_code          VARCHAR(50) UNIQUE,
  
  -- Quests completadas
  quest1_claimed    BOOLEAN DEFAULT FALSE,
  quest2_claimed    BOOLEAN DEFAULT FALSE,
  quest3_claimed    BOOLEAN DEFAULT FALSE,
  
  -- Timestamps
  last_login        TIMESTAMP WITH TIME ZONE,
  last_checkin      TIMESTAMP WITH TIME ZONE,
  created_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Índices de búsqueda
  CONSTRAINT drz_non_negative  CHECK (drz_balance  >= 0),
  CONSTRAINT usdt_non_negative CHECK (usdt_balance >= 0)
);

-- ── TABLA: TRANSACCIONES ─────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Tipo: deposit | withdraw | swap | hardware_buy | mining_reward | referral_reward | quest_reward
  type         VARCHAR(30) NOT NULL,
  type_label   VARCHAR(100),
  
  -- Monto (positivo = ingreso, negativo = egreso)
  amount       DECIMAL(18, 6) NOT NULL,
  currency     VARCHAR(10)    NOT NULL, -- DRZ | USDT
  
  -- Estado: pending | complete | failed | cancelled
  status       VARCHAR(20)    NOT NULL DEFAULT 'pending',
  
  -- Blockchain
  tx_hash      VARCHAR(70) UNIQUE,    -- Hash de TX en BSC
  to_address   VARCHAR(42),          -- Dirección destino en retiros
  
  -- Metadata
  metadata     JSONB,
  
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ── TABLA: HARDWARE DE USUARIO ───────────────────────────
CREATE TABLE IF NOT EXISTS user_hardware (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id      INTEGER NOT NULL,    -- 0=Antminer S9, 1=RTX4090, 2=ASIC S21
  passive_day  DECIMAL(10,4),       -- DRZ pasivos por día
  purchased_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ── TABLA: REFERIDOS ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS referrals (
  id           SERIAL PRIMARY KEY,
  referrer_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reward_paid  BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (referred_id) -- Un usuario sólo puede tener un referidor
);

-- ── TABLA: SESIONES DE DEPÓSITO ──────────────────────────
-- Registro de monitoreo de depósitos pendientes (para el monitor BSCScan)
CREATE TABLE IF NOT EXISTS deposit_monitors (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  address      VARCHAR(42) NOT NULL,
  expected_amount DECIMAL(18,6),
  status       VARCHAR(20) DEFAULT 'watching', -- watching | confirmed | expired
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at   TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '24 hours')
);

-- ── TABLA: CONFIGURACIÓN ADMIN ───────────────────────────
CREATE TABLE IF NOT EXISTS admin_config (
  key   VARCHAR(100) PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Valores iniciales
INSERT INTO admin_config (key, value) VALUES
  ('drz_rate',       '0.01'),
  ('min_withdraw',   '10'),
  ('withdraw_fee',   '1'),
  ('min_deposit',    '5'),
  ('ref_reward_l1',  '10'),
  ('ref_reward_l2',  '3'),
  ('daily_reward',   '5'),
  ('energy_regen_s', '60')
ON CONFLICT (key) DO NOTHING;

-- ── ÍNDICES ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_telegram_id   ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_deposit_addr  ON users(deposit_address);
CREATE INDEX IF NOT EXISTS idx_users_ref_code      ON users(ref_code);
CREATE INDEX IF NOT EXISTS idx_transactions_user   ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_hash   ON transactions(tx_hash);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer  ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred  ON referrals(referred_id);

-- ── FUNCIÓN: auto-update updated_at ──────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_transactions_updated_at
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── VISTA: LEADERBOARD ───────────────────────────────────
CREATE OR REPLACE VIEW leaderboard AS
SELECT
  telegram_id,
  first_name,
  username,
  drz_balance,
  total_clicks,
  tap_power,
  RANK() OVER (ORDER BY drz_balance DESC) AS rank
FROM users
ORDER BY drz_balance DESC
LIMIT 100;

-- ── VISTA: ESTADÍSTICAS GLOBALES ────────────────────────
CREATE OR REPLACE VIEW global_stats AS
SELECT
  COUNT(*) AS total_users,
  SUM(drz_balance) AS total_drz_circulating,
  SUM(usdt_balance) AS total_usdt_held,
  SUM(total_clicks) AS total_clicks_all,
  AVG(tap_power) AS avg_tap_power
FROM users;
