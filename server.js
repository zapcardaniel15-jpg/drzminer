// ═══════════════════════════════════════════════════════
//  DRZ MINER — Backend API
//  Stack: Node.js + Express + PostgreSQL
//  Seguridad: Verificación firma Telegram WebApp
// ═══════════════════════════════════════════════════════

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const { Pool }   = require('pg');
const crypto     = require('crypto');

const app = express();

// ── MIDDLEWARE ──────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

const limiter = rateLimit({ windowMs: 60_000, max: 120, message: { error: 'Too many requests' } });
app.use('/api', limiter);

// ── DATABASE ────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ── TELEGRAM AUTH MIDDLEWARE ────────────────────────────
function verifyTelegramData(req, res, next) {
  // En producción: verificar la firma del initData de Telegram
  if (process.env.NODE_ENV !== 'production') return next();
  
  const initData = req.headers['x-telegram-init-data'];
  if (!initData) return res.status(401).json({ error: 'No auth data' });

  try {
    const params = new URLSearchParams(initData);
    const hash   = params.get('hash');
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData')
      .update(process.env.BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey)
      .update(dataCheckString).digest('hex');

    if (expectedHash !== hash) return res.status(401).json({ error: 'Invalid signature' });
    
    // Verificar expiración (24h)
    const authDate = parseInt(params.get('auth_date'));
    if (Date.now() / 1000 - authDate > 86400) return res.status(401).json({ error: 'Auth expired' });

    next();
  } catch (e) {
    return res.status(401).json({ error: 'Auth verification failed' });
  }
}

app.use('/api', verifyTelegramData);

// ═══════════════════════════════════════════════════════
//  ROUTES: USER
// ═══════════════════════════════════════════════════════

// GET /api/user/:userId — Obtener o crear usuario
app.get('/api/user/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    let result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    
    if (result.rows.length === 0) {
      // Crear nuevo usuario
      result = await pool.query(`
        INSERT INTO users (telegram_id, drz_balance, usdt_balance, energy, max_energy, tap_power, total_clicks, total_spend, ref_code, created_at)
        VALUES ($1, 0, 0, 100, 100, 0.01, 0, 0, $2, NOW())
        RETURNING *
      `, [userId, userId]);
    }

    const user = result.rows[0];
    
    // Obtener transacciones recientes
    const txResult = await pool.query(
      'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
      [user.id]
    );

    // Contar referidos
    const refResult = await pool.query(
      'SELECT COUNT(*) FROM referrals WHERE referrer_id = $1',
      [user.id]
    );

    res.json({
      drz:         parseFloat(user.drz_balance),
      usdt:        parseFloat(user.usdt_balance),
      energy:      user.energy,
      maxEnergy:   user.max_energy,
      tapPower:    parseFloat(user.tap_power),
      totalClicks: user.total_clicks,
      totalSpend:  parseFloat(user.total_spend),
      refCode:     user.ref_code,
      referrals:   parseInt(refResult.rows[0].count),
      transactions: txResult.rows.map(formatTx),
      lastLogin:   user.last_login
    });

    // Actualizar last_login
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database error' });
  }
});

// ═══════════════════════════════════════════════════════
//  ROUTES: MINING lalala
// ═══════════════════════════════════════════════════════

// POST /api/mine/tap — Registrar taps
app.post('/api/mine/tap', async (req, res) => {
  const { userId, quantity = 1, power } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    if (!userResult.rows.length) return res.status(404).json({ error: 'User not found' });
    
    const user     = userResult.rows[0];
    const realQty  = Math.min(quantity, user.energy); // no más de la energía disponible
    const tapPower = parseFloat(user.tap_power);
    const earned   = realQty * tapPower;

    await pool.query(`
      UPDATE users SET
        drz_balance   = drz_balance + $1,
        energy        = GREATEST(0, energy - $2),
        total_clicks  = total_clicks + $2,
        updated_at    = NOW()
      WHERE telegram_id = $3
    `, [earned, realQty, userId]);

    // Reward pasivo a referidor
    const ref = await pool.query(
      'SELECT u.* FROM referrals r JOIN users u ON u.id = r.referrer_id WHERE r.referred_id = $1',
      [userResult.rows[0].id]
    );
    if (ref.rows.length) {
      const refReward = earned * 0.05; // 5% pasivo
      await pool.query(
        'UPDATE users SET drz_balance = drz_balance + $1 WHERE id = $2',
        [refReward, ref.rows[0].id]
      );
    }

    // Comprobar quests
    await checkAndAwardQuests(userResult.rows[0].id, userId);

    const updated = await pool.query('SELECT drz_balance, energy FROM users WHERE telegram_id = $1', [userId]);
    res.json({ drz: parseFloat(updated.rows[0].drz_balance), energy: updated.rows[0].energy });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Mining error' });
  }
});

// ═══════════════════════════════════════════════════════
//  ROUTES: HARDWARE
// ═══════════════════════════════════════════════════════

// POST /api/hardware/buy
app.post('/api/hardware/buy', async (req, res) => {
  const { userId, itemId, cost, powerAdd, passiveDay } = req.body;
  
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    if (!userResult.rows.length) return res.status(404).json({ error: 'User not found' });
    
    const user = userResult.rows[0];
    if (parseFloat(user.drz_balance) < cost) return res.status(400).json({ error: 'Insufficient DRZ' });

    await pool.query(`
      UPDATE users SET
        drz_balance  = drz_balance - $1,
        tap_power    = tap_power + $2,
        total_spend  = total_spend + $1,
        updated_at   = NOW()
      WHERE telegram_id = $3
    `, [cost, powerAdd, userId]);

    // Guardar hardware
    await pool.query(`
      INSERT INTO user_hardware (user_id, item_id, passive_day, purchased_at)
      VALUES ($1, $2, $3, NOW())
    `, [user.id, itemId, passiveDay]);

    // Registrar TX
    await pool.query(`
      INSERT INTO transactions (user_id, type, type_label, amount, currency, status, created_at)
      VALUES ($1, 'hardware_buy', 'Compra Hardware', $2, 'DRZ', 'complete', NOW())
    `, [user.id, -cost]);

    await checkAndAwardQuests(user.id, userId);

    const updated = await pool.query('SELECT drz_balance, tap_power FROM users WHERE telegram_id = $1', [userId]);
    res.json({
      drz:      parseFloat(updated.rows[0].drz_balance),
      tapPower: parseFloat(updated.rows[0].tap_power)
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Purchase error' });
  }
});

// ═══════════════════════════════════════════════════════
//  ROUTES: WALLET — DEPÓSITO
// ═══════════════════════════════════════════════════════

// GET /api/wallet/deposit-address/:userId
app.get('/api/wallet/deposit-address/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    let result = await pool.query('SELECT deposit_address FROM users WHERE telegram_id = $1', [userId]);
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    
    let address = result.rows[0].deposit_address;
    
    if (!address) {
      // En producción: generar dirección real via BSC
      // Aquí se integraría con un proveedor como BitGo, MathWallet API, o wallet HD
      address = generateDepositAddress(userId);
      await pool.query('UPDATE users SET deposit_address = $1 WHERE telegram_id = $2', [address, userId]);
    }
    
    res.json({ address, network: 'BSC', token: 'USDT' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error getting address' });
  }
});

// POST /api/wallet/verify-deposit (llamado por webhook BSCScan o cron job)
app.post('/api/wallet/verify-deposit', async (req, res) => {
  // Este endpoint es interno — validar secret key
  const secret = req.headers['x-admin-secret'];
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });

  const { address, txHash, amount, tokenSymbol } = req.body;
  
  try {
    if (tokenSymbol !== 'USDT') return res.status(400).json({ error: 'Only USDT accepted' });
    
    // Verificar que no se procese 2 veces
    const existing = await pool.query('SELECT id FROM transactions WHERE tx_hash = $1', [txHash]);
    if (existing.rows.length) return res.json({ message: 'Already processed' });

    const userResult = await pool.query('SELECT * FROM users WHERE deposit_address = $1', [address]);
    if (!userResult.rows.length) return res.status(404).json({ error: 'Address not found' });
    
    const user = userResult.rows[0];
    
    await pool.query(`
      UPDATE users SET usdt_balance = usdt_balance + $1, updated_at = NOW()
      WHERE id = $2
    `, [amount, user.id]);
    
    await pool.query(`
      INSERT INTO transactions (user_id, type, type_label, amount, currency, status, tx_hash, created_at)
      VALUES ($1, 'deposit', 'Depósito USDT', $2, 'USDT', 'complete', $3, NOW())
    `, [user.id, amount, txHash]);

    // Notificar al usuario via bot
    notifyUser(user.telegram_id, `✅ Depósito recibido: ${amount} USDT`);
    
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Deposit processing error' });
  }
});

// ═══════════════════════════════════════════════════════
//  ROUTES: WALLET — RETIRO
// ═══════════════════════════════════════════════════════

// POST /api/wallet/withdraw
app.post('/api/wallet/withdraw', async (req, res) => {
  const { userId, amount, address } = req.body;
  const WITHDRAW_FEE = 1; // 1 USDT fee
  const MIN_WITHDRAW = 10;

  if (amount < MIN_WITHDRAW) return res.status(400).json({ error: `Mínimo ${MIN_WITHDRAW} USDT` });
  if (!address || !address.startsWith('0x') || address.length !== 42)
    return res.status(400).json({ error: 'Dirección inválida' });
  
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    if (!userResult.rows.length) return res.status(404).json({ error: 'User not found' });
    
    const user = userResult.rows[0];
    const total = amount + WITHDRAW_FEE;
    
    if (parseFloat(user.usdt_balance) < total)
      return res.status(400).json({ error: 'Saldo insuficiente (incluir comisión)' });
    
    // Verificar retiros pendientes
    const pending = await pool.query(
      "SELECT id FROM transactions WHERE user_id = $1 AND type = 'withdraw' AND status = 'pending'",
      [user.id]
    );
    if (pending.rows.length >= 3)
      return res.status(400).json({ error: 'Máximo 3 retiros pendientes simultáneos' });

    await pool.query(`
      UPDATE users SET usdt_balance = usdt_balance - $1, updated_at = NOW()
      WHERE id = $2
    `, [total, user.id]);

    const txResult = await pool.query(`
      INSERT INTO transactions (user_id, type, type_label, amount, currency, status, to_address, created_at)
      VALUES ($1, 'withdraw', 'Retiro USDT', $2, 'USDT', 'pending', $3, NOW())
      RETURNING *
    `, [user.id, -amount, address]);

    const txs = await pool.query(
      'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
      [user.id]
    );

    res.json({
      success:      true,
      usdt:         parseFloat(user.usdt_balance) - total,
      transactions: txs.rows.map(formatTx)
    });

    // Notificar admin para procesar
    notifyAdmin(`💸 Retiro solicitado: ${amount} USDT → ${address} (user: ${userId})`);

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Withdrawal error' });
  }
});

// POST /api/wallet/process-withdraw (llamado por admin/cron para procesar retiros)
app.post('/api/wallet/process-withdraw', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });

  const { txId, txHash } = req.body;
  try {
    const result = await pool.query(`
      UPDATE transactions SET status = 'complete', tx_hash = $1, updated_at = NOW()
      WHERE id = $2 RETURNING user_id
    `, [txHash, txId]);

    if (result.rows.length) {
      const user = await pool.query('SELECT telegram_id FROM users WHERE id = $1', [result.rows[0].user_id]);
      notifyUser(user.rows[0].telegram_id, `✅ Retiro procesado. TX: ${txHash}`);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════
//  ROUTES: SWAP
// ═══════════════════════════════════════════════════════

// POST /api/wallet/swap
app.post('/api/wallet/swap', async (req, res) => {
  const { userId, drzAmount } = req.body;
  const DRZ_RATE   = parseFloat(process.env.DRZ_RATE) || 0.01;
  const MIN_SWAP   = 100; // mín 100 DRZ = 1 USDT

  if (drzAmount < MIN_SWAP) return res.status(400).json({ error: `Mínimo ${MIN_SWAP} DRZ` });
  
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    if (!userResult.rows.length) return res.status(404).json({ error: 'User not found' });
    
    const user     = userResult.rows[0];
    const usdtGain = drzAmount * DRZ_RATE;
    
    if (parseFloat(user.drz_balance) < drzAmount)
      return res.status(400).json({ error: 'Saldo DRZ insuficiente' });

    await pool.query(`
      UPDATE users SET
        drz_balance  = drz_balance - $1,
        usdt_balance = usdt_balance + $2,
        updated_at   = NOW()
      WHERE id = $3
    `, [drzAmount, usdtGain, user.id]);

    await pool.query(`
      INSERT INTO transactions (user_id, type, type_label, amount, currency, status, created_at)
      VALUES ($1, 'swap', 'Swap DRZ→USDT', $2, 'USDT', 'complete', NOW())
    `, [user.id, usdtGain]);

    const txs = await pool.query(
      'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
      [user.id]
    );

    const updated = await pool.query('SELECT drz_balance, usdt_balance FROM users WHERE id = $1', [user.id]);
    res.json({
      success:      true,
      drz:          parseFloat(updated.rows[0].drz_balance),
      usdt:         parseFloat(updated.rows[0].usdt_balance),
      transactions: txs.rows.map(formatTx)
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Swap error' });
  }
});

// ═══════════════════════════════════════════════════════
//  ROUTES: QUESTS
// ═══════════════════════════════════════════════════════

// POST /api/quest/checkin
app.post('/api/quest/checkin', async (req, res) => {
  const { userId } = req.body;
  const DAILY_REWARD = 5;

  try {
    const userResult = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    if (!userResult.rows.length) return res.status(404).json({ error: 'User not found' });
    
    const user = userResult.rows[0];
    const lastLogin = user.last_checkin ? new Date(user.last_checkin) : null;
    const now       = new Date();
    
    if (lastLogin) {
      const daysDiff = (now - lastLogin) / (1000 * 60 * 60 * 24);
      if (daysDiff < 1) return res.json({ message: 'Ya hiciste check-in hoy', reward: 0 });
    }

    await pool.query(`
      UPDATE users SET
        drz_balance  = drz_balance + $1,
        last_checkin = NOW(),
        updated_at   = NOW()
      WHERE id = $2
    `, [DAILY_REWARD, user.id]);

    res.json({ success: true, reward: DAILY_REWARD });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════
//  ROUTES: REFERIDOS
// ═══════════════════════════════════════════════════════

// POST /api/referral/register
app.post('/api/referral/register', async (req, res) => {
  const { userId, refCode } = req.body;
  const REF_REWARD = 10;
  
  try {
    // Encontrar referidor
    const refUser = await pool.query('SELECT * FROM users WHERE ref_code = $1', [refCode]);
    if (!refUser.rows.length) return res.json({ message: 'Invalid ref code' });
    
    const referrer = refUser.rows[0];
    const referred = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [userId]);
    if (!referred.rows.length) return res.json({ message: 'User not found' });

    // Verificar que no estén ya referenciados
    const existing = await pool.query(
      'SELECT id FROM referrals WHERE referred_id = $1',
      [referred.rows[0].id]
    );
    if (existing.rows.length) return res.json({ message: 'Already referred' });

    // Crear referral
    await pool.query(
      'INSERT INTO referrals (referrer_id, referred_id, created_at) VALUES ($1, $2, NOW())',
      [referrer.id, referred.rows[0].id]
    );

    // Premiar al referidor
    await pool.query(
      'UPDATE users SET drz_balance = drz_balance + $1 WHERE id = $2',
      [REF_REWARD, referrer.id]
    );

    notifyUser(referrer.telegram_id, `🎉 Nuevo referido! +${REF_REWARD} DRZ`);
    res.json({ success: true });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════

function formatTx(tx) {
  return {
    id:         tx.id,
    type:       tx.type,
    type_label: tx.type_label,
    amount:     parseFloat(tx.amount),
    currency:   tx.currency,
    status:     tx.status,
    tx_hash:    tx.tx_hash,
    to_address: tx.to_address,
    created_at: tx.created_at
  };
}

function generateDepositAddress(userId) {
  // PLACEHOLDER: En producción usar HD Wallet derivation (BIP44)
  // con librerías como ethers.js + master private key cifrada
  const hash = crypto.createHash('sha256').update(`drz-${userId}-${process.env.WALLET_SEED}`).digest('hex');
  return '0x' + hash.slice(0, 40);
}

async function checkAndAwardQuests(dbUserId, telegramId) {
  // Quest 1: 1000 clics
  const user = await pool.query('SELECT * FROM users WHERE id = $1', [dbUserId]);
  const u = user.rows[0];
  
  if (u.total_clicks >= 1000 && !u.quest1_claimed) {
    await pool.query('UPDATE users SET drz_balance = drz_balance + 50, quest1_claimed = true WHERE id = $1', [dbUserId]);
    notifyUser(telegramId, '🎯 Quest completada: Maestro del Click! +50 DRZ');
  }
  if (parseFloat(u.total_spend) >= 500 && !u.quest2_claimed) {
    await pool.query('UPDATE users SET drz_balance = drz_balance + 100, quest2_claimed = true WHERE id = $1', [dbUserId]);
    notifyUser(telegramId, '💎 Quest completada: Gran Inversor! +100 DRZ');
  }
}

async function notifyUser(telegramId, message) {
  if (!process.env.BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramId, text: message, parse_mode: 'HTML' })
    });
  } catch (e) { console.error('Telegram notify error:', e); }
}

async function notifyAdmin(message) {
  if (!process.env.ADMIN_CHAT_ID) return;
  notifyUser(process.env.ADMIN_CHAT_ID, message);
}

// ── HEALTHCHECK ─────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── START ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 DRZ Miner API running on port ${PORT}`));

module.exports = app;
