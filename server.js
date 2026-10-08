// server.js
require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Telegraf } = require("telegraf");
const { DatabaseSync } = require("node:sqlite");

// ============== КОНФИГ ==============
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter(Boolean);
const PORT = parseInt(process.env.PORT || "3000", 10);
const WEBAPP_URL = process.env.WEBAPP_URL || `http://localhost:${PORT}`;
const CNY_RATE_DEFAULT = parseFloat(process.env.CNY_RATE_DEFAULT || "12.5");
const DELIVERY_PRICE = parseFloat(process.env.DELIVERY_PRICE || "600");
const COMMISSION_PRICE = parseFloat(process.env.COMMISSION_PRICE || "550");

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN не задан в .env");
  process.exit(1);
}

// ============== БАЗА ДАННЫХ ==============
const db = new DatabaseSync("poizon.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE NOT NULL,
    username TEXT,
    first_name TEXT DEFAULT '',
    phone TEXT,
    is_admin INTEGER DEFAULT 0,
    bonus_points INTEGER DEFAULT 0,
    referred_by INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    status TEXT DEFAULT 'created',
    commission REAL DEFAULT 550,
    delivery REAL DEFAULT 600,
    cny_rate REAL DEFAULT 12.5,
    total_rub REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    closed_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    title TEXT DEFAULT '',
    url TEXT DEFAULT '',
    photo_url TEXT DEFAULT '',
    price_cny REAL DEFAULT 0,
    quantity INTEGER DEFAULT 1,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS bonus_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    reason TEXT,
    admin_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inviter_id INTEGER NOT NULL,
    invited_id INTEGER NOT NULL,
    bonus_awarded INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

const rateRow = db.prepare("SELECT value FROM settings WHERE key = 'cny_rate'").get();
if (!rateRow) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
    "cny_rate",
    String(CNY_RATE_DEFAULT)
  );
}

// ============== ХЕЛПЕРЫ БД ==============
const q = {
  getUser: db.prepare("SELECT * FROM users WHERE telegram_id = ?"),
  getUserById: db.prepare("SELECT * FROM users WHERE id = ?"),
  createUser: db.prepare(`
    INSERT INTO users (telegram_id, username, first_name, is_admin, referred_by)
    VALUES (?, ?, ?, ?, ?)
  `),
  updatePhone: db.prepare("UPDATE users SET phone = ? WHERE id = ?"),
  listUsers: db.prepare("SELECT * FROM users ORDER BY created_at DESC"),
  setAdmin: db.prepare("UPDATE users SET is_admin = ? WHERE id = ?"),
  addBonus: db.prepare("UPDATE users SET bonus_points = bonus_points + ? WHERE id = ?"),
  logBonus: db.prepare(`
    INSERT INTO bonus_log (user_id, amount, reason, admin_id)
    VALUES (?, ?, ?, ?)
  `),
  bonusLog: db.prepare(`
    SELECT * FROM bonus_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 30
  `),
  getRate: db.prepare("SELECT value FROM settings WHERE key = 'cny_rate'"),
  setRate: db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cny_rate', ?)"),
  userOrders: db.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC"),
  orderById: db.prepare("SELECT * FROM orders WHERE id = ?"),
  orderProducts: db.prepare("SELECT * FROM products WHERE order_id = ?"),
  listOrders: db.prepare("SELECT * FROM orders ORDER BY created_at DESC"),
  createOrder: db.prepare(`
    INSERT INTO orders (user_id, commission, delivery, cny_rate, total_rub)
    VALUES (?, ?, ?, ?, ?)
  `),
  createProduct: db.prepare(`
    INSERT INTO products (order_id, title, url, photo_url, price_cny, quantity)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  setStatus: db.prepare("UPDATE orders SET status = ?, closed_at = ? WHERE id = ?"),
  setDelivery: db.prepare("UPDATE orders SET delivery = ?, total_rub = ? WHERE id = ?"),
  createReferral: db.prepare(
    "INSERT INTO referrals (inviter_id, invited_id) VALUES (?, ?)"
  ),
};

function getCnyRate() {
  const row = q.getRate.get();
  return row ? parseFloat(row.value) : CNY_RATE_DEFAULT;
}

// ============== ПРОВЕРКА initData ==============
function verifyInitData(initData) {
  if (!initData) throw new Error("initData отсутствует");
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new Error("Нет hash");
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const calculated = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (calculated !== hash) throw new Error("Неверная подпись");

  const userJson = params.get("user");
  if (!userJson) throw new Error("Нет user в initData");
  return JSON.parse(userJson);
}

// ============== УВЕДОМЛЕНИЯ ==============
async function notifyUser(telegramId, text) {
  try {
    await bot.telegram.sendMessage(telegramId, text, { parse_mode: "HTML" });
  } catch (e) {
    console.error("Не удалось отправить уведомление:", e.message);
  }
}

const STATUS_LABELS = {
  created: "🛒 Оформлен",
  cn_warehouse: "📦 На складе в Китае",
  in_transit: "✈️ В пути в ваш город",
  delivered: "🚚 Доставлен",
  closed: "✅ Завершён",
};

// ============== БОТ ==============
const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  const tg = ctx.from;
  const payload = ctx.startPayload;
  let referredBy = null;

  if (payload && payload.startsWith("ref_")) {
    const id = parseInt(payload.slice(4), 10);
    if (!Number.isNaN(id) && id !== tg.id) referredBy = id;
  }

  let user = q.getUser.get(tg.id);
  const isAdmin = ADMIN_IDS.includes(tg.id);

  if (!user) {
    const info = q.createUser.run(
      tg.id,
      tg.username || null,
      tg.first_name || "друг",
      isAdmin ? 1 : 0,
      referredBy
    );
    user = q.getUserById.get(info.lastInsertRowid);

    if (referredBy) {
      q.createReferral.run(referredBy, tg.id);
    }
  } else if (isAdmin && !user.is_admin) {
    q.setAdmin.run(1, user.id);
    user.is_admin = 1;
  }

  const greeting =
    `👋 Привет, <b>${user.first_name}</b>!\n\n` +
    `📦 Это сервис доставки вещей с Poizon.\n\n` +
    `🧮 Калькулятор стоимости\n` +
    `📋 Ваши заказы и история\n` +
    `🎁 Бонусные баллы за заказы и друзей\n\n` +
    `Нажми кнопку ниже, чтобы открыть магазин 👇`;

  await ctx.replyWithHTML(greeting, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🛍 Открыть магазин", web_app: { url: WEBAPP_URL } }],
      ],
    },
  });
});

bot.command("me", async (ctx) => {
  const user = q.getUser.get(ctx.from.id);
  if (!user) return ctx.reply("Сначала нажми /start");
  await ctx.replyWithHTML(
    `👤 <b>Профиль</b>\n\n` +
      `Имя: ${user.first_name}\n` +
      `Username: @${user.username || "—"}\n` +
      `Телефон: ${user.phone || "—"}\n` +
      `🎁 Баллы: <b>${user.bonus_points}</b>\n` +
      `🛡 Админ: ${user.is_admin ? "✅" : "❌"}`
  );
});

bot.command("ref", async (ctx) => {
  const me = await bot.telegram.getMe();
  const link = `https://t.me/${me.username}?start=ref_${ctx.from.id}`;
  await ctx.replyWithHTML(
    `🔗 <b>Твоя реферальная ссылка:</b>\n\n<code>${link}</code>\n\n` +
      `За каждого друга, который сделает заказ — <b>+200 баллов</b>.`
  );
});

// ============== EXPRESS ==============
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function authMiddleware(req, res, next) {
  try {
    const initData = req.headers["x-telegram-init-data"];
    const tgUser = verifyInitData(initData);
    const user = q.getUser.get(tgUser.id);
    if (!user)
      return res.status(404).json({ error: "Пользователь не найден. Нажми /start в боте." });
    req.user = user;
    next();
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
}

function adminMiddleware(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: "Только для админов" });
  next();
}

// ---------- ОБЩИЕ ----------

app.get("/api/rate", (req, res) => {
  res.json({ rate: getCnyRate() });
});

app.get("/api/me", authMiddleware, (req, res) => {
  const u = req.user;
  res.json({
    id: u.id,
    telegram_id: u.telegram_id,
    first_name: u.first_name,
    username: u.username,
    phone: u.phone,
    bonus: u.bonus_points,
    is_admin: !!u.is_admin,
  });
});

app.get("/api/orders", authMiddleware, (req, res) => {
  const orders = q.userOrders.all(req.user.id);
  const withProducts = orders.map((o) => ({
    ...o,
    products: q.orderProducts.all(o.id),
  }));
  res.json(withProducts);
});

// Заказ по ID (для модалки) — владелец или админ
app.get("/api/order/:id", authMiddleware, (req, res) => {
  const orderId = parseInt(req.params.id, 10);
  const order = q.orderById.get(orderId);
  if (!order) return res.status(404).json({ error: "Заказ не найден" });
  if (order.user_id !== req.user.id && !req.user.is_admin) {
    return res.status(403).json({ error: "Доступ запрещён" });
  }
  const products = q.orderProducts.all(orderId);
  res.json({ ...order, products });
});

app.get("/api/bonus", authMiddleware, (req, res) => {
  res.json({
    points: req.user.bonus_points,
    log: q.bonusLog.all(req.user.id),
  });
});

// ---------- АДМИН ----------

app.get("/api/admin/users", authMiddleware, adminMiddleware, (req, res) => {
  res.json(q.listUsers.all());
});

app.get("/api/admin/orders", authMiddleware, adminMiddleware, (req, res) => {
  const orders = q.listOrders.all();
  const withProducts = orders.map((o) => ({
    ...o,
    products: q.orderProducts.all(o.id),
  }));
  res.json(withProducts);
});

app.post("/api/admin/rate", authMiddleware, adminMiddleware, (req, res) => {
  const { rate } = req.body;
  if (!rate || isNaN(rate)) return res.status(400).json({ error: "Неверный курс" });
  q.setRate.run(String(rate));
  res.json({ ok: true });
});

app.post("/api/admin/award", authMiddleware, adminMiddleware, async (req, res) => {
  const { user_id, amount, reason } = req.body;
  if (!user_id || !amount) return res.status(400).json({ error: "Не хватает данных" });

  const user = q.getUserById.get(user_id);
  if (!user) return res.status(404).json({ error: "Пользователь не найден" });

  q.addBonus.run(amount, user_id);
  q.logBonus.run(user_id, amount, reason || "manual", req.user.id);

  await notifyUser(
    user.telegram_id,
    `🎁 Вам начислено <b>${amount}</b> баллов!\n\nПричина: ${reason || "начисление"}`
  );

  res.json({ ok: true });
});

app.post("/api/admin/set_admin", authMiddleware, adminMiddleware, async (req, res) => {
  const { user_id, is_admin } = req.body;
  if (!user_id) return res.status(400).json({ error: "Не указан user_id" });

  const target = q.getUserById.get(user_id);
  if (!target) return res.status(404).json({ error: "Пользователь не найден" });

  q.setAdmin.run(is_admin ? 1 : 0, user_id);

  await notifyUser(
    target.telegram_id,
    is_admin
      ? `🛡 Вам выданы права администратора.`
      : `ℹ️ Ваши права администратора сняты.`
  );

  res.json({ ok: true });
});

app.post("/api/admin/create_order", authMiddleware, adminMiddleware, async (req, res) => {
  const { user_id, products, commission, delivery } = req.body;
  if (!user_id || !Array.isArray(products) || !products.length) {
    return res.status(400).json({ error: "Не хватает данных" });
  }

  const user = q.getUserById.get(user_id);
  if (!user) return res.status(404).json({ error: "Пользователь не найден" });

  const rate = getCnyRate();
  const comm = commission != null ? commission : COMMISSION_PRICE;
  const deliv = delivery != null ? delivery : DELIVERY_PRICE;
  const productsSum = products.reduce((s, p) => s + (p.price_cny || 0) * (p.quantity || 1), 0);
  const totalRub = productsSum * rate + comm + deliv;

  const info = q.createOrder.run(user_id, comm, deliv, rate, totalRub);
  const orderId = info.lastInsertRowid;

  for (const p of products) {
    q.createProduct.run(
      orderId,
      p.title || "",
      p.url || "",
      p.photo_url || "",
      p.price_cny || 0,
      p.quantity || 1
    );
  }

  await notifyUser(
    user.telegram_id,
    `🛒 <b>Ваш заказ №${orderId} оформлен!</b>\n\n` +
      `Товаров: ${products.length}\n` +
      `Итого: <b>${Math.round(totalRub)} ₽</b>\n\n` +
      `📌 Стоимость доставки указана предварительно и будет уточнена после прибытия товара на склад в Китае.`
  );

  res.json({ ok: true, order_id: orderId, total_rub: totalRub });
});

// Обновление стоимости доставки
app.post("/api/admin/order/:id/delivery", authMiddleware, adminMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id, 10);
  const { delivery } = req.body;
  if (delivery == null || isNaN(delivery) || delivery < 0) {
    return res.status(400).json({ error: "Неверная стоимость доставки" });
  }

  const order = q.orderById.get(orderId);
  if (!order) return res.status(404).json({ error: "Заказ не найден" });

  const products = q.orderProducts.all(orderId);
  const productsSum = products.reduce((s, p) => s + p.price_cny * p.quantity, 0);
  const totalRub = productsSum * order.cny_rate + order.commission + delivery;

  q.setDelivery.run(delivery, totalRub, orderId);

  const user = q.getUserById.get(order.user_id);
  if (user) {
    await notifyUser(
      user.telegram_id,
      `📦 <b>Заказ №${orderId}</b>\n\n` +
        `Стоимость доставки уточнена: <b>${Math.round(delivery)} ₽</b>\n\n` +
        `Итого к оплате: <b>${Math.round(totalRub)} ₽</b>`
    );
  }

  res.json({ ok: true, total_rub: totalRub });
});

app.post("/api/admin/order/:id/status", authMiddleware, adminMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id, 10);
  const { status } = req.body;

  if (!STATUS_LABELS[status]) return res.status(400).json({ error: "Неверный статус" });

  const order = q.orderById.get(orderId);
  if (!order) return res.status(404).json({ error: "Заказ не найден" });

  const closedAt = status === "closed" ? new Date().toISOString() : null;
  q.setStatus.run(status, closedAt, orderId);

  const user = q.getUserById.get(order.user_id);
  if (user) {
    let extra = "";
    if (status === "cn_warehouse") {
      extra =
        `\n\n💰 <b>Товар прибыл на склад в Китае.</b>\n` +
        `Теперь необходимо оплатить доставку.\n\n` +
        `Стоимость доставки указана в вашем заказе. ` +
        `Администратор может уточнить её после взвешивания.`;
    }
    await notifyUser(
      user.telegram_id,
      `📦 <b>Заказ №${orderId}</b>\n\nНовый статус: <b>${STATUS_LABELS[status]}</b>${extra}`
    );
  }

  res.json({ ok: true });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// ============== ЗАПУСК ==============
app.listen(PORT, () => {
  console.log(`🌐 Сервер: http://localhost:${PORT}`);
  console.log(`🤖 Mini App URL: ${WEBAPP_URL}`);
});

bot
  .launch()
  .then(() => console.log("🤖 Бот запущен"))
  .catch((e) => console.error("Ошибка запуска бота:", e));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));