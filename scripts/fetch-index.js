#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(ROOT, 'index.json');
const ENV_PATH = path.join(ROOT, '.env');

const readDotEnv = (filePath) => {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw.split('\n').reduce((acc, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return acc;
    const [key, ...rest] = trimmed.split('=');
    acc[key] = rest.join('=').trim();
    return acc;
  }, {});
};

const env = { ...readDotEnv(ENV_PATH), ...process.env };

const CONFIG = {
  cryptoPanicKey: env.CRYPTOPANIC_API_KEY,
  finnhubKey: env.FINNHUB_API_KEY,
  newsApiKey: env.NEWSAPI_KEY,
  goldApiKey: env.GOLD_API_KEY,
  updateFrequency: env.UPDATE_FREQUENCY || '1h',
  weights: {
    macro: Number(env.WEIGHT_MACRO || 0.2),
    micro: Number(env.WEIGHT_MICRO || 0.15),
    stocks: Number(env.WEIGHT_STOCKS || 0.2),
    crypto: Number(env.WEIGHT_CRYPTO || 0.2),
    political: Number(env.WEIGHT_POLITICAL || 0.15),
    sentiment: Number(env.WEIGHT_SENTIMENT || 0.1)
  }
};

const toISODate = (date) => new Date(date).toISOString().slice(0, 10);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const tokenize = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

const POSITIVE_WORDS = new Set([
  'beat', 'beats', 'growth', 'surge', 'surged', 'rally', 'rallies', 'record',
  'strong', 'stronger', 'upgrade', 'upgrades', 'bull', 'bullish', 'positive',
  'optimism', 'optimistic', 'easing', 'pause', 'cut', 'cuts', 'cooling'
]);

const NEGATIVE_WORDS = new Set([
  'miss', 'misses', 'decline', 'declines', 'drop', 'drops', 'fall', 'falls',
  'slump', 'slumps', 'weak', 'weaker', 'downgrade', 'downgrades', 'bear',
  'bearish', 'negative', 'risk', 'risks', 'sanction', 'sanctions', 'war',
  'conflict', 'inflation', 'recession', 'layoff', 'layoffs'
]);

const scoreSentiment = (text) => {
  if (!text) return 0;
  const tokens = tokenize(text);
  let score = 0;
  for (const token of tokens) {
    if (POSITIVE_WORDS.has(token)) score += 1;
    if (NEGATIVE_WORDS.has(token)) score -= 1;
  }
  if (tokens.length === 0) return 0;
  return clamp(score / Math.sqrt(tokens.length), -1, 1);
};

const CATEGORY_RULES = [
  {
    key: 'crypto',
    label: 'Crypto',
    keywords: ['bitcoin', 'btc', 'eth', 'ethereum', 'crypto', 'defi', 'solana', 'etf', 'altcoin', 'stablecoin']
  },
  {
    key: 'political',
    label: 'Political',
    keywords: [
      'election', 'parliament', 'congress', 'senate', 'president', 'prime minister',
      'government', 'policy', 'regulation', 'regulator', 'sanction', 'sanctions',
      'tariff', 'trade war', 'geopolitics', 'conflict', 'war', 'ceasefire', 'invasion',
      'protest', 'coup', 'referendum', 'legislation', 'bill', 'sec'
    ]
  },
  {
    key: 'macro',
    label: 'Macro Economic',
    keywords: [
      'inflation', 'cpi', 'ppi', 'gdp', 'pmi', 'rates', 'rate hike', 'rate cut',
      'central bank', 'fed', 'ecb', 'boj', 'boe', 'unemployment', 'payrolls',
      'jobs', 'retail sales', 'industrial production', 'treasury', 'yield',
      'bond', 'recession', 'soft landing', 'fx', 'dollar', 'euro', 'yuan'
    ]
  },
  {
    key: 'micro',
    label: 'Micro Economic',
    keywords: [
      'earnings', 'guidance', 'revenue', 'profit', 'margin', 'forecast', 'outlook',
      'capex', 'buyback', 'dividend', 'ipo', 'acquisition', 'merger', 'm&a',
      'lawsuit', 'settlement', 'product launch', 'restructuring', 'bankruptcy'
    ]
  },
  {
    key: 'stocks',
    label: 'Stock Markets',
    keywords: ['stock', 'stocks', 'equity', 'nasdaq', 's&p', 'dow', 'index', 'market', 'rally', 'selloff']
  }
];

const classifyCategory = (text) => {
  const haystack = text.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((keyword) => haystack.includes(keyword))) {
      return rule;
    }
  }
  return { key: 'macro', label: 'Macro Economic' };
};

const fetchJson = async (url, headers = {}) => {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Request failed ${res.status}: ${body}`);
  }
  return res.json();
};

const fetchCryptoPanic = async () => {
  if (!CONFIG.cryptoPanicKey) return [];
  const url = `https://cryptopanic.com/api/v1/posts/?auth_token=${CONFIG.cryptoPanicKey}&public=true`;
  const data = await fetchJson(url);
  return (data.results || []).map((item) => ({
    source: 'CryptoPanic',
    title: item.title,
    url: item.url,
    publishedAt: item.published_at,
    sentimentHint: item.votes ? item.votes.positive - item.votes.negative : 0,
    categoryHint: 'crypto'
  }));
};

const fetchFinnhub = async () => {
  if (!CONFIG.finnhubKey) return [];
  const url = `https://finnhub.io/api/v1/news?category=general&token=${CONFIG.finnhubKey}`;
  const data = await fetchJson(url);
  return (data || []).map((item) => ({
    source: 'Finnhub',
    title: item.headline,
    url: item.url,
    publishedAt: item.datetime ? new Date(item.datetime * 1000).toISOString() : null,
    sentimentHint: 0,
    categoryHint: null
  }));
};

const fetchNewsApi = async () => {
  if (!CONFIG.newsApiKey) return [];
  const url = `https://newsapi.org/v2/top-headlines?category=business&language=en&pageSize=50&apiKey=${CONFIG.newsApiKey}`;
  const data = await fetchJson(url);
  return (data.articles || []).map((item) => ({
    source: 'NewsAPI',
    title: item.title,
    url: item.url,
    publishedAt: item.publishedAt,
    sentimentHint: 0,
    categoryHint: null
  }));
};

const fetchBtcMarket = async () => {
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_market_cap=true';
  const data = await fetchJson(url);
  const btc = data.bitcoin || {};
  return {
    price: btc.usd || null,
    marketCap: btc.usd_market_cap || null
  };
};

const fetchGoldMarket = async () => {
  if (!CONFIG.goldApiKey) {
    return { price: null, marketCap: null, marketCapEstimate: true };
  }
  const url = `https://app.goldapi.net/price/XAU/USD?x-api-key=${CONFIG.goldApiKey}`;
  const data = await fetchJson(url);
  return {
    price: data.price || null,
    marketCap: 12000000000000,
    marketCapEstimate: true
  };
};

const fetchSp500Market = async () => {
  if (!CONFIG.finnhubKey) {
    return { price: null, marketCap: null, marketCapProxy: 'SPY' };
  }
  let spxPrice = null;
  try {
    const spx = await fetchJson(`https://finnhub.io/api/v1/quote?symbol=%5EGSPC&token=${CONFIG.finnhubKey}`);
    spxPrice = spx.c || null;
  } catch (err) {
    spxPrice = null;
  }
  let spyPrice = null;
  let spyMarketCap = null;
  try {
    const spyQuote = await fetchJson(`https://finnhub.io/api/v1/quote?symbol=SPY&token=${CONFIG.finnhubKey}`);
    spyPrice = spyQuote.c || null;
  } catch (err) {
    spyPrice = null;
  }
  try {
    const profile = await fetchJson(`https://finnhub.io/api/v1/stock/profile2?symbol=SPY&token=${CONFIG.finnhubKey}`);
    spyMarketCap = profile.marketCapitalization ? profile.marketCapitalization * 1e6 : null;
  } catch (err) {
    spyMarketCap = null;
  }
  return {
    price: spxPrice || spyPrice,
    marketCap: spyMarketCap,
    marketCapProxy: 'SPY'
  };
};

const normalize = (items) => {
  const seen = new Set();
  return items.filter((item) => {
    if (!item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  }).map((item) => {
    const text = `${item.title || ''}`.trim();
    const sentiment = scoreSentiment(text) + clamp(item.sentimentHint || 0, -1, 1) * 0.2;
    const categoryRule = item.categoryHint === 'crypto'
      ? CATEGORY_RULES.find((rule) => rule.key === 'crypto')
      : classifyCategory(text);
    return {
      ...item,
      title: text,
      sentiment: clamp(sentiment, -1, 1),
      category: categoryRule.key,
      categoryLabel: categoryRule.label
    };
  });
};

const aggregateScores = (items) => {
  const categoryBuckets = {
    macro: [],
    micro: [],
    stocks: [],
    crypto: [],
    political: []
  };

  for (const item of items) {
    if (categoryBuckets[item.category]) {
      categoryBuckets[item.category].push(item);
    }
  }

  const categoryScores = Object.entries(categoryBuckets).map(([key, list]) => {
    const avg = list.length
      ? list.reduce((sum, item) => sum + item.sentiment, 0) / list.length
      : 0;
    return {
      key,
      label: CATEGORY_RULES.find((rule) => rule.key === key)?.label || key,
      score: Math.round(clamp(50 + avg * 50, 0, 100)),
      change: avg * 5,
      summary: list[0]?.title || ''
    };
  });

  const overallSentiment = items.length
    ? items.reduce((sum, item) => sum + item.sentiment, 0) / items.length
    : 0;

  const sentimentScore = Math.round(clamp(50 + overallSentiment * 50, 0, 100));

  const overallScore = categoryScores.reduce((acc, cat) => {
    const weight = CONFIG.weights[cat.key] || 0;
    return acc + cat.score * weight;
  }, sentimentScore * CONFIG.weights.sentiment);

  const categoryMap = Object.fromEntries(categoryScores.map((cat) => [cat.key, cat.score]));
  const stocksDca = Math.round(
    categoryMap.macro * 0.4 +
      categoryMap.micro * 0.3 +
      categoryMap.political * 0.2 +
      sentimentScore * 0.1
  );
  const cryptoDca = Math.round(
    categoryMap.crypto * 0.5 +
      categoryMap.macro * 0.3 +
      categoryMap.political * 0.2
  );

  return {
    categoryScores,
    sentimentScore: Math.round(overallScore),
    dca: {
      stocks: clamp(stocksDca, 0, 100),
      crypto: clamp(cryptoDca, 0, 100)
    }
  };
};

const pickDrivers = (items, direction) => {
  const sorted = [...items].sort((a, b) => direction * (b.sentiment - a.sentiment));
  return sorted.slice(0, 3).map((item) => ({
    title: item.title,
    url: item.url
  }));
};

const updateHistory = (history, score) => {
  const today = toISODate(new Date());
  const filtered = (history || []).filter((point) => point.date !== today);
  filtered.push({ date: today, score });
  return filtered.slice(-30);
};

const updateDcaHistory = (history, dca) => {
  const today = toISODate(new Date());
  const filtered = (history || []).filter((point) => point.date !== today);
  filtered.push({ date: today, stocks: dca.stocks, crypto: dca.crypto });
  return filtered.slice(-30);
};

const main = async () => {
  const [crypto, finnhub, news, btc, gold, sp500] = await Promise.all([
    fetchCryptoPanic().catch(() => []),
    fetchFinnhub().catch(() => []),
    fetchNewsApi().catch(() => []),
    fetchBtcMarket().catch(() => ({ price: null, marketCap: null })),
    fetchGoldMarket().catch(() => ({ price: null, marketCap: null, marketCapEstimate: true })),
    fetchSp500Market().catch(() => ({ price: null, marketCap: null, marketCapProxy: 'SPY' }))
  ]);

  const items = normalize([...crypto, ...finnhub, ...news]);
  const { categoryScores, sentimentScore, dca } = aggregateScores(items);

  const existing = fs.existsSync(OUTPUT_PATH)
    ? JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'))
    : {};

  const updatedAt = new Date().toISOString();
  const history = updateHistory(existing.history, sentimentScore);
  const dcaHistory = updateDcaHistory(existing.dcaHistory, dca);

  const payload = {
    updatedAt,
    score: sentimentScore,
    label: existing.label || null,
    change24h: existing.score ? sentimentScore - existing.score : 0,
    markets: {
      btc,
      gold,
      sp500
    },
    dca,
    categories: categoryScores.map((cat) => ({
      name: cat.label,
      score: cat.score,
      change: Number(cat.change.toFixed(1)),
      summary: cat.summary
    })),
    history,
    dcaHistory,
    drivers: {
      positive: pickDrivers(items, 1),
      negative: pickDrivers(items, -1)
    },
    stats: {
      articlesAnalyzed: items.length,
      dataSources: ['CryptoPanic', 'Finnhub', 'NewsAPI'].filter((name) => {
        if (name === 'CryptoPanic') return Boolean(CONFIG.cryptoPanicKey);
        if (name === 'Finnhub') return Boolean(CONFIG.finnhubKey);
        if (name === 'NewsAPI') return Boolean(CONFIG.newsApiKey);
        return false;
      }).length,
      dataQuality: Math.round(clamp((items.length / 100) * 100, 50, 95)),
      updateFrequency: CONFIG.updateFrequency
    },
    sources: ['CryptoPanic', 'Finnhub', 'NewsAPI'].filter((name) => {
      if (name === 'CryptoPanic') return Boolean(CONFIG.cryptoPanicKey);
      if (name === 'Finnhub') return Boolean(CONFIG.finnhubKey);
      if (name === 'NewsAPI') return Boolean(CONFIG.newsApiKey);
      return false;
    })
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${OUTPUT_PATH} with ${items.length} items.`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
