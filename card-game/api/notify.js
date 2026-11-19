// Sends a real push notification to the other players' devices.
// The game calls this after a chat message is saved. The keys live in Vercel's environment
// variables (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY), never in the code.
const webpush = require("web-push");

// Only the browsers' own push services are accepted as destinations.
const PUSH_HOSTS = [/\.googleapis\.com$/, /\.mozilla\.com$/, /\.notify\.windows\.com$/, /\.push\.apple\.com$/];
const okEndpoint = e => { try { const u = new URL(e); return u.protocol === "https:" && PUSH_HOSTS.some(r => r.test(u.hostname)); } catch { return false; } };
const text = (v, n) => String(v || "").slice(0, n);

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return res.status(500).json({ error: "VAPID keys are not set in Vercel" });
  webpush.setVapidDetails("https://" + (req.headers.host || "localhost"), pub, priv);

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const subs = (Array.isArray(body.subs) ? body.subs : []).filter(s => s && okEndpoint(s.endpoint) && s.keys).slice(0, 10);
  const icon = typeof body.icon === "string" && body.icon.startsWith("https://" + req.headers.host + "/") ? body.icon : "/icon-192.png";
  const payload = JSON.stringify({ title: text(body.title, 60) || "קרב הכתרים", body: text(body.body, 140), icon });

  const gone = [];
  let sent = 0;
  await Promise.all(subs.map(async s => {
    try { await webpush.sendNotification(s, payload, { TTL: 3600, urgency: "high" }); sent++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) gone.push(s.endpoint); }
  }));
  res.status(200).json({ sent, gone });
};
