// ═══════════════════════════════════════════════════════
//  DRZ MINER — Telegram Bot
//  Maneja comandos del bot + webhooks + cron jobs
// ═══════════════════════════════════════════════════════

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { Pool }             = require('pg');
const cron                 = require('node-cron');

const bot  = new Telegraf(process.env.BOT_TOKEN);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const WEB_APP_URL = process.env.WEB_APP_URL; // URL del frontend

// ═══════════════════════════════════════════════════════
//  COMANDOS DEL BOT
// ═══════════════════════════════════════════════════════

// /start — Bienvenida + botón para abrir WebApp
bot.start(async (ctx) => {
  const user     = ctx.from;
  const refCode  = ctx.startPayload; // código de referido en el link

  // Registrar usuario en BD si no existe
  await pool.query(`
    INSERT INTO users (telegram_id, username, first_name, ref_code)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (telegram_id) DO UPDATE
      SET username = $2, first_name = $3, last_login = NOW()
  `, [user.id, user.username || '', user.first_name || '', String(user.id)]);

  // Si vino por referido, registrarlo
  if (refCode && refCode !== String(user.id)) {
    const referrer = await pool.query('SELECT * FROM users WHERE ref_code = $1', [refCode]);
    if (referrer.rows.length) {
      const referred = await pool.query('SELECT id FROM users WHERE telegram_id = $1', [user.id]);
      const existing = await pool.query('SELECT id FROM referrals WHERE referred_id = $1', [referred.rows[0].id]);
      if (!existing.rows.length) {
        await pool.query(
          'INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2)',
          [referrer.rows[0].id, referred.rows[0].id]
        );
        const REF_REWARD = 10;
        await pool.query(
          'UPDATE users SET drz_balance = drz_balance + $1 WHERE id = $2',
          [REF_REWARD, referrer.rows[0].id]
        );
        await ctx.telegram.sendMessage(referrer.rows[0].telegram_id,
          `🎉 <b>¡Nuevo referido!</b>\n${user.first_name} se unió usando tu enlace.\n+${REF_REWARD} DRZ acreditados 💰`,
          { parse_mode: 'HTML' }
        );
      }
    }
  }

  await ctx.replyWithPhoto(
    { url: 'https://via.placeholder.com/800x400/07080a/f0c040?text=DRZ+MINER' },
    {
      caption: `⛏️ <b>¡Bienvenido a DRZ MINER, ${user.first_name}!</b>\n\n` +
        `Mina DRZ tokens haciendo clic, compra hardware para aumentar tu poder, y retira ganancias en USDT.\n\n` +
        `💰 <b>Rate actual:</b> 1 DRZ = $0.01 USDT\n` +
        `🔋 <b>Energía:</b> Se recarga 1 por minuto\n` +
        `👥 <b>Referidos:</b> +10 DRZ por amigo invitado`,
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.webApp('⛏️ ABRIR MINER', WEB_APP_URL)],
        [Markup.button.callback('📊 Mi Balance', 'balance'), Markup.button.callback('👥 Referidos', 'refs')]
      ])
    }
  );
});

// Botón: balance
bot.action('balance', async (ctx) => {
  await ctx.answerCbQuery();
  const user = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [ctx.from.id]);
  if (!user.rows.length) return ctx.reply('Usa /start primero.');
  const u = user.rows[0];
  await ctx.reply(
    `💳 <b>Tu Balance</b>\n\n` +
    `⛏️ DRZ: <b>${parseFloat(u.drz_balance).toFixed(2)}</b>\n` +
    `💵 USDT: <b>${parseFloat(u.usdt_balance).toFixed(2)}</b>\n` +
    `⚡ Energía: <b>${u.energy} / ${u.max_energy}</b>\n` +
    `🖱️ Clicks: <b>${u.total_clicks.toLocaleString()}</b>\n` +
    `⚡ Poder/tap: <b>${parseFloat(u.tap_power).toFixed(4)} DRZ</b>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.webApp('Abrir Miner', WEB_APP_URL)]]) }
  );
});

// Botón: referidos
bot.action('refs', async (ctx) => {
  await ctx.answerCbQuery();
  const user = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [ctx.from.id]);
  if (!user.rows.length) return ctx.reply('Usa /start primero.');
  const refCount = await pool.query('SELECT COUNT(*) FROM referrals WHERE referrer_id = $1', [user.rows[0].id]);
  const link = `https://t.me/${ctx.botInfo.username}?start=${user.rows[0].ref_code}`;
  await ctx.reply(
    `👥 <b>Programa de Referidos</b>\n\n` +
    `Referidos: <b>${refCount.rows[0].count}</b>\n` +
    `Por cada amigo: <b>+10 DRZ</b>\n\n` +
    `🔗 Tu enlace:\n<code>${link}</code>`,
    { parse_mode: 'HTML' }
  );
});

// /help
bot.command('help', (ctx) => ctx.reply(
  `📖 <b>Comandos DRZ Miner</b>\n\n` +
  `/start — Abrir el juego\n` +
  `/balance — Ver tu balance\n` +
  `/referidos — Tu enlace de invitación\n` +
  `/retiros — Estado de tus retiros`,
  { parse_mode: 'HTML' }
));

// /referidos
bot.command('referidos', async (ctx) => {
  const user = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [ctx.from.id]);
  if (!user.rows.length) return ctx.reply('Usa /start primero.');
  const link = `https://t.me/${ctx.botInfo.username}?start=${user.rows[0].ref_code}`;
  await ctx.reply(`🔗 <code>${link}</code>`, { parse_mode: 'HTML' });
});

// /retiros — ver historial
bot.command('retiros', async (ctx) => {
  const user = await pool.query('SELECT id FROM users WHERE telegram_id = $1', [ctx.from.id]);
  if (!user.rows.length) return ctx.reply('Usa /start primero.');
  const txs = await pool.query(
    "SELECT * FROM transactions WHERE user_id = $1 AND type = 'withdraw' ORDER BY created_at DESC LIMIT 5",
    [user.rows[0].id]
  );
  if (!txs.rows.length) return ctx.reply('No tienes retiros aún.');
  const list = txs.rows.map(tx =>
    `• ${Math.abs(parseFloat(tx.amount)).toFixed(2)} USDT — ${tx.status.toUpperCase()} — ${new Date(tx.created_at).toLocaleDateString('es')}`
  ).join('\n');
  ctx.reply(`📤 <b>Tus Retiros</b>\n\n${list}`, { parse_mode: 'HTML' });
});

// ═══════════════════════════════════════════════════════
//  CRON JOBS
// ═══════════════════════════════════════════════════════

// Cada minuto: regenerar energía de todos los usuarios
cron.schedule('* * * * *', async () => {
  try {
    await pool.query(`
      UPDATE users
      SET energy = LEAST(max_energy, energy + 1), updated_at = NOW()
      WHERE energy < max_energy
    `);
  } catch (e) { console.error('Energy regen error:', e); }
});

// Cada hora: distribuir ganancias pasivas del hardware
cron.schedule('0 * * * *', async () => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.telegram_id, SUM(h.passive_day) as daily_total
      FROM user_hardware h
      JOIN users u ON u.id = h.user_id
      GROUP BY u.id, u.telegram_id
    `);
    
    for (const row of result.rows) {
      const hourlyEarning = parseFloat(row.daily_total) / 24;
      if (hourlyEarning > 0) {
        await pool.query(
          'UPDATE users SET drz_balance = drz_balance + $1 WHERE id = $2',
          [hourlyEarning, row.id]
        );
      }
    }
    console.log(`✅ Passive income distributed to ${result.rows.length} users`);
  } catch (e) { console.error('Passive income error:', e); }
});

// Cada 5 minutos: verificar depósitos pendientes en BSC
cron.schedule('*/5 * * * *', async () => {
  if (!process.env.BSCSCAN_API_KEY) return;
  try {
    const monitors = await pool.query(
      "SELECT dm.*, u.id as uid FROM deposit_monitors dm JOIN users u ON u.id = dm.user_id WHERE dm.status = 'watching' AND dm.expires_at > NOW()"
    );
    
    for (const m of monitors.rows) {
      const url = `https://api.bscscan.com/api?module=account&action=tokentx&address=${m.address}&contractaddress=${process.env.USDT_CONTRACT}&sort=desc&apikey=${process.env.BSCSCAN_API_KEY}`;
      const resp = await fetch(url);
      const data = await resp.json();
      
      if (data.result && Array.isArray(data.result)) {
        for (const tx of data.result) {
          // USDT tiene 18 decimales en BSC
          const amount = parseFloat(tx.value) / 1e18;
          if (amount < 5) continue; // mínimo 5 USDT
          
          // Verificar si ya fue procesada
          const existing = await pool.query(
            'SELECT id FROM transactions WHERE tx_hash = $1', [tx.hash]
          );
          if (existing.rows.length) continue;
          
          // Acreditar
          await pool.query(
            'UPDATE users SET usdt_balance = usdt_balance + $1 WHERE id = $2',
            [amount, m.uid]
          );
          await pool.query(
            "INSERT INTO transactions (user_id, type, type_label, amount, currency, status, tx_hash, created_at) VALUES ($1, 'deposit', 'Depósito USDT', $2, 'USDT', 'complete', $3, NOW())",
            [m.uid, amount, tx.hash]
          );
          await bot.telegram.sendMessage(m.user_id,
            `✅ <b>Depósito confirmado!</b>\n+${amount.toFixed(2)} USDT acreditados\nTX: <code>${tx.hash.slice(0,16)}...</code>`,
            { parse_mode: 'HTML' }
          );
        }
      }
    }
  } catch (e) { console.error('Deposit check error:', e); }
});

// ═══════════════════════════════════════════════════════
//  LANZAR BOT
// ═══════════════════════════════════════════════════════
bot.launch();
console.log('🤖 DRZ Miner Bot launched');

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

module.exports = bot;
