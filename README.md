# ⛏️ DRZ MINER — Guía de Deploy Completa

## Estructura del Proyecto

```
drz-miner/
├── frontend/
│   └── index.html          ← WebApp Telegram (subir a hosting estático)
└── backend/
    ├── server.js            ← API REST (Express)
    ├── bot.js               ← Bot de Telegram (Telegraf)
    ├── schema.sql           ← Estructura de la BD PostgreSQL
    ├── package.json
    └── .env.example         ← Copiar a .env y completar
```

---

## 1. Crear el Bot en Telegram

1. Hablar con [@BotFather](https://t.me/BotFather)
2. `/newbot` → nombre: **DRZ Miner** → username: `drz_miner_bot`
3. Guardar el **TOKEN** que te da
4. `/setmenubutton` → elegir tu bot → URL de la WebApp
5. `/setdomain` → registrar tu dominio para la WebApp

---

## 2. Base de Datos PostgreSQL

### Opción A: Railway (recomendado, gratis)
1. [railway.app](https://railway.app) → New Project → Add PostgreSQL
2. Copiar la `DATABASE_URL` del panel

### Opción B: Supabase
1. [supabase.com](https://supabase.com) → New Project
2. Settings → Database → Connection string

```bash
# Ejecutar el schema:
psql "postgresql://..." -f schema.sql
```

---

## 3. Frontend — Hosting

El `frontend/index.html` es un archivo estático. Opciones:

| Proveedor   | Plan gratuito | HTTPS | Dominio propio |
|-------------|:---:|:---:|:---:|
| **Vercel**  | ✅ | ✅ | ✅ |
| **Netlify** | ✅ | ✅ | ✅ |
| **Cloudflare Pages** | ✅ | ✅ | ✅ |

```bash
# Vercel (más fácil):
npm i -g vercel
cd frontend && vercel --prod
```

Después de obtener la URL, editar en `index.html`:
```javascript
const API_BASE = 'https://TU-DOMINIO-BACKEND.com/api';
```

---

## 4. Backend — Deploy

### Opción A: Railway
```bash
cd backend
railway login
railway init
railway add
railway up
```

### Opción B: Render.com
1. New Web Service → conectar repo
2. Build command: `npm install`
3. Start command: `npm start`
4. Agregar todas las variables de entorno del `.env.example`

### Opción C: VPS (DigitalOcean, Hetzner)
```bash
# En el servidor:
git clone tu-repo
cd drz-miner/backend
npm install
cp .env.example .env
nano .env  # completar variables

# PM2 para mantenerlo corriendo:
npm install -g pm2
pm2 start server.js --name drz-api
pm2 start bot.js --name drz-bot
pm2 save && pm2 startup
```

---

## 5. Variables de Entorno Obligatorias

| Variable | Descripción | Dónde obtenerla |
|----------|-------------|-----------------|
| `BOT_TOKEN` | Token del bot | @BotFather |
| `DATABASE_URL` | PostgreSQL URL | Railway/Supabase |
| `WEB_APP_URL` | URL del frontend | Vercel/Netlify |
| `ADMIN_SECRET` | Secreto interno | Inventar (random) |
| `WALLET_SEED` | Semilla para wallets | Inventar (seguro) |
| `BSCSCAN_API_KEY` | Para verificar TXs | bscscan.com/apis |

---

## 6. Integración de Depósitos Reales (USDT BEP20)

Para recibir pagos reales necesitas:

### A. Generar wallets HD (BIP44)
```bash
npm install ethers
```
```javascript
const { ethers } = require('ethers');
// Crear HD wallet
const wallet = ethers.HDNodeWallet.fromMnemonic(
  ethers.Mnemonic.fromPhrase(process.env.WALLET_SEED)
);
// Derivar wallet única por usuario
const userWallet = wallet.derivePath(`m/44'/60'/0'/0/${userId}`);
// userWallet.address ← dirección de depósito del usuario
```

### B. Monitor de depósitos con BSCScan API
Ya incluido en `bot.js` — corre cada 5 minutos.
API key gratuita en: https://bscscan.com/apis

### C. Para enviar retiros automáticos:
```javascript
const { ethers } = require('ethers');
const provider = new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org/');
const wallet   = new ethers.Wallet(process.env.OPERATOR_PRIVATE_KEY, provider);
const usdt     = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, wallet);
await usdt.transfer(toAddress, ethers.parseUnits(amount.toString(), 18));
```

---

## 7. Seguridad en Producción

- [ ] `NODE_ENV=production` habilitado
- [ ] Verificación de firma Telegram activa (ya en el código)
- [ ] `ADMIN_SECRET` largo y aleatorio (mín. 32 chars)
- [ ] `.env` en `.gitignore` (NUNCA subir al repo)
- [ ] Rate limiting activo (ya configurado: 120 req/min)
- [ ] HTTPS obligatorio (certificado SSL en el hosting)
- [ ] `OPERATOR_PRIVATE_KEY` en variable secreta del hosting, nunca en código
- [ ] Backup diario de la base de datos

---

## 8. Flujo de Retiros (manual o automático)

### Manual (recomendado al inicio):
1. Administrador consulta: `SELECT * FROM transactions WHERE type='withdraw' AND status='pending'`
2. Envía USDT a la dirección desde su wallet
3. Llama al endpoint para marcar como procesado:
```bash
curl -X POST https://tu-api.com/api/wallet/process-withdraw \
  -H "x-admin-secret: TU_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"txId": 123, "txHash": "0xabc..."}'
```

### Automático:
Implementar en `bot.js` usando `ethers.js` + la private key del operador.

---

## Soporte
Para dudas sobre el deploy, consultar la documentación de:
- [Telegraf.js](https://telegraf.js.org)
- [BSCScan API](https://docs.bscscan.com)
- [Railway](https://docs.railway.app)
