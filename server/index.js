import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import { db, getKeyByHash, insertKey, updateKeySubscription, addAlert } from './db.js';
import { generateKey, hashKey, signalFromScore, whatChanged } from './utils.js';
import path from 'path';
import fs from 'fs';

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2024-06-20' });

const CACHE = {
  data: null,
  dataUpdatedAt: null,
  marketsUpdatedAt: null
};

const INDEX_JSON_URL = process.env.INDEX_JSON_URL || 'https://yy0x.github.io/InvestmentClimateIndex/index.json';

const fetchJson = async (url, headers = {}) => {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}`);
  return res.json();
};

const fetchBtcMarket = async () => {
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_market_cap=true';
  const data = await fetchJson(url);
  const btc = data.bitcoin || {};
  return { price: btc.usd || null, marketCap: btc.usd_market_cap || null };
};

const fetchGoldMarket = async () => {
  const url = 'https://api.gold-api.com/price/XAU';
  const data = await fetchJson(url);
  return { price: data.price || null, marketCap: null, marketCapEstimate: true };
};

const fetchSpx = async () => {
  const csv = await fetch('https://stooq.com/q/l/?s=^spx&f=sd2t2ohlcv&h&e=csv').then((res) => res.text());
  const lines = csv.trim().split('\n');
  if (lines.length >= 2) {
    const parts = lines[1].split(',');
    const close = Number(parts[6]);
    return Number.isFinite(close) ? close : null;
  }
  return null;
};

const fetchSp500Market = async () => {
  let spxPrice = null;
  try { spxPrice = await fetchSpx(); } catch (e) { spxPrice = null; }
  return { price: spxPrice, marketCap: null, marketCapProxy: 'SPY' };
};

const refreshBaseData = async () => {
  try {
    const payload = await fetchJson(INDEX_JSON_URL);
    CACHE.data = payload;
    CACHE.dataUpdatedAt = new Date().toISOString();
  } catch (err) {
    // keep last cache
  }
};

const refreshMarkets = async () => {
  if (!CACHE.data) return;
  try {
    const [btc, gold, sp500] = await Promise.all([
      fetchBtcMarket(),
      fetchGoldMarket(),
      fetchSp500Market()
    ]);
    CACHE.data.markets = { btc, gold, sp500 };
    CACHE.marketsUpdatedAt = new Date().toISOString();
  } catch (err) {
    // keep last markets
  }
};

// initial load + loops
refreshBaseData();
setInterval(refreshBaseData, 5 * 60 * 1000);
setInterval(refreshMarkets, 15 * 1000);

app.use(cors());
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

const requireKey = (req, res, next) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing API key' });
  const record = getKeyByHash(hashKey(token));
  if (!record || record.status !== 'active') return res.status(403).json({ error: 'Invalid API key' });
  req.apiKey = record;
  next();
};

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/public/index', (req, res) => {
  if (!CACHE.data) return res.status(503).json({ error: 'Index not ready' });
  res.json({
    ...CACHE.data,
    signal: signalFromScore(CACHE.data.score || 0),
    dataUpdatedAt: CACHE.dataUpdatedAt,
    marketsUpdatedAt: CACHE.marketsUpdatedAt
  });
});

app.get('/v1/index', requireKey, (req, res) => {
  const payload = CACHE.data;
  if (!payload) return res.status(503).json({ error: 'Index not ready' });
  const signal = signalFromScore(payload.score || 0);
  res.json({
    version: 'v1',
    updatedAt: payload.updatedAt,
    score: payload.score,
    signal,
    dca: payload.dca,
    whatChanged: whatChanged(payload),
    drivers: payload.drivers,
    markets: payload.markets
  });
});

app.get('/v1/history', requireKey, (req, res) => {
  const payload = CACHE.data;
  if (!payload) return res.status(503).json({ error: 'Index not ready' });
  res.json({ version: 'v1', history: payload.history, dcaHistory: payload.dcaHistory });
});

app.get('/v1/markets', requireKey, (req, res) => {
  const payload = CACHE.data;
  if (!payload) return res.status(503).json({ error: 'Index not ready' });
  res.json({ version: 'v1', markets: payload.markets });
});

app.get('/v1/drivers', requireKey, (req, res) => {
  const payload = CACHE.data;
  if (!payload) return res.status(503).json({ error: 'Index not ready' });
  res.json({ version: 'v1', drivers: payload.drivers, whatChanged: whatChanged(payload) });
});

app.get('/v1/key/verify', requireKey, (req, res) => {
  res.json({
    status: req.apiKey.status,
    plan: req.apiKey.plan,
    email: req.apiKey.email
  });
});

app.post('/v1/alerts/subscribe', requireKey, (req, res) => {
  const { email, telegramChatId } = req.body || {};
  if (!email && !telegramChatId) return res.status(400).json({ error: 'Provide email or telegramChatId' });
  addAlert({ api_key_id: req.apiKey.id, email, telegram_chat_id: telegramChatId || null });
  res.json({ ok: true });
});

app.post('/v1/checkout', async (req, res) => {
  const { email } = req.body || {};
  if (!process.env.STRIPE_PRICE_ID) return res.status(500).json({ error: 'Missing Stripe price id' });
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: email,
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url: `${process.env.PUBLIC_BASE_URL}/api-keys.html?status=success`,
    cancel_url: `${process.env.PUBLIC_BASE_URL}/api-keys.html?status=cancel`
  });
  res.json({ url: session.url });
});

app.post('/v1/webhook', async (req, res) => {
  const signature = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const key = generateKey();
    insertKey({
      key_hash: hashKey(key),
      plan: 'pro',
      status: 'active',
      email: session.customer_email || null,
      stripe_customer_id: session.customer || null,
      stripe_subscription_id: session.subscription || null
    });

    if (session.customer_email && process.env.MAILER_URL) {
      await fetch(process.env.MAILER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: session.customer_email,
          subject: 'Your ICI.ndex API key',
          html: `<p>Your API key: <strong>${key}</strong></p><p>Keep it safe.</p>`
        })
      });
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    updateKeySubscription(subscription.customer, subscription.id, 'inactive');
  }

  res.json({ received: true });
});

app.use(express.static(path.join(process.cwd(), 'server', 'public')));

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`API server listening on ${port}`);
});
