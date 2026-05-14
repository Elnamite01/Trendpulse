require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const cron = require('node-cron');
const axios = require('axios');
const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const rss = new Parser();

app.use(express.json());
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-please',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 86400000 }
}));

// ---------- DATA ----------
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const load = (file, fallback) => {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(fallback, null, 2));
  return JSON.parse(fs.readFileSync(p));
};
const save = (file, data) =>
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));

// Seed owner with password 12345678
(async () => {
  const users = load('users.json', []);
  if (!users.find(u => u.role === 'owner')) {
    users.push({
      id: 'owner-1',
      email: process.env.OWNER_EMAIL || 'owner@trendpulse.co.za',
      passwordHash: await bcrypt.hash('12345678', 10),
      role: 'owner',
      mustChangePassword: true
    });
    save('users.json', users);
  }
})();

// ---------- TREND SOURCES ----------
const SA_FEEDS = [
  'https://www.news24.com/fin24/rss',
  'https://ewn.co.za/RSS%20Feeds/Latest%20News',
  'https://feeds.bbci.co.uk/news/world/africa/rss.xml'
];
const GLOBAL_FEEDS = [
  'https://feeds.bbci.co.uk/news/world/rss.xml',
  'https://rss.cnn.com/rss/edition_world.rss'
];

async function fetchTrends() {
  const trends = [];
  for (const feed of [...SA_FEEDS, ...GLOBAL_FEEDS]) {
    try {
      const d = await rss.parseURL(feed);
      d.items.slice(0, 5).forEach(item => trends.push({
        title: item.title, link: item.link, source: d.title,
        region: SA_FEEDS.includes(feed) ? 'SA' : 'Global',
        pubDate: item.pubDate
      }));
    } catch (e) { console.warn('Feed fail:', feed); }
  }
  return trends;
}

// ---------- FREE GROQ AI ----------
const VOICE_PROMPT = `You are a sharp, witty 24-year-old South African writer from Johannesburg.
Write in modern English with light SA slang ("eish", "lekker", "shap shap") used naturally.
Be SMART, OPINIONATED, but OPEN TO CRITICISM. End with "Where I Might Be Wrong" section.
70% SA focus, 30% global. Output JSON: {"headline","subheading","body","takeaway","where_i_might_be_wrong","tags"}`;

async function generateArticle(trend) {
  const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
    model: 'llama-3.3-70b-versatile',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: VOICE_PROMPT },
      { role: 'user', content: `Write a take on:\nTitle: ${trend.title}\nSource: ${trend.source}\nRegion: ${trend.region}` }
    ]
  }, {
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }
  });
  return JSON.parse(res.data.choices[0].message.content);
}

// ---------- PIPELINE ----------
async function runPipeline() {
  console.log('🔄 Fetching trends...');
  const trends = await fetchTrends();
  const articles = load('articles.json', []);
  for (const t of trends.slice(0, 6)) {
    if (articles.find(a => a.sourceLink === t.link)) continue;
    try {
      const ai = await generateArticle(t);
      articles.unshift({
        id: Date.now() + Math.random(),
        ...ai, sourceLink: t.link, source: t.source, region: t.region,
        status: 'pending', createdAt: new Date().toISOString()
      });
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) { console.error('AI err:', e.message); }
  }
  save('articles.json', articles.slice(0, 200));
  console.log('✅ Done');
}
cron.schedule('*/30 * * * *', runPipeline);
setTimeout(runPipeline, 8000);

// ---------- AUTH ----------
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const users = load('users.json', []);
  const u = users.find(x => x.email === email);
  if (!u || !(await bcrypt.compare(password, u.passwordHash)))
    return res.status(401).json({ error: 'Invalid login' });
  req.session.userId = u.id;
  res.json({ mustChangePassword: u.mustChangePassword, role: u.role });
});
app.post('/api/change-password', async (req, res) => {
  if (!req.session.userId) return res.status(401).end();
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8)
    return res.status(400).json({ error: 'Min 8 chars' });
  const users = load('users.json', []);
  const u = users.find(x => x.id === req.session.userId);
  u.passwordHash = await bcrypt.hash(newPassword, 10);
  u.mustChangePassword = false;
  save('users.json', users);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

// ---------- OWNER ----------
const owner = (req, res, next) => {
  const u = load('users.json', []).find(x => x.id === req.session.userId);
  if (!u || u.role !== 'owner') return res.status(403).end();
  next();
};
app.get('/api/pending', owner, (req, res) =>
  res.json(load('articles.json', []).filter(a => a.status === 'pending')));
app.post('/api/approve/:id', owner, (req, res) => {
  const arr = load('articles.json', []);
  const a = arr.find(x => x.id == req.params.id);
  if (a) a.status = 'published';
  save('articles.json', arr); res.json({ ok: true });
});
app.post('/api/reject/:id', owner, (req, res) => {
  save('articles.json', load('articles.json', []).filter(x => x.id != req.params.id));
  res.json({ ok: true });
});

// ---------- PUBLIC ----------
app.get('/api/articles', (req, res) =>
  res.json(load('articles.json', []).filter(a => a.status === 'published').slice(0, 30)));

// ---------- PAYSTACK (free SA payments) ----------
app.post('/api/checkout', async (req, res) => {
  const { plan, email } = req.body;
  const amounts = { trial: 7200, monthly: 18000, yearly: 90000 }; // ZAR cents (approx $4/$10/$50)
  try {
    const r = await axios.post('https://api.paystack.co/transaction/initialize', {
      email, amount: amounts[plan],
      callback_url: `${req.headers.origin}/?success=1`
    }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET}` }});
    res.json({ url: r.data.data.authorization_url });
  } catch (e) {
    res.status(500).json({ error: 'Payment setup failed — add PAYSTACK_SECRET in env' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 TrendPulse SA on port ${PORT}`));