// Cloudflare Worker: Ліга чемпіонів + АПЛ + Ла Ліга.
// /fixtures?league=  → матчі сезону однієї ліги (розклад + рахунок + статус) з кешу KV
// /standings?league= → таблиця з джерела (авторитетний порядок і тай-брейки ліги)
// /stats?id=&lg=     → статистика матчу (усі показники джерела) з кешу KV; ліниво добирає
// /lineup?id=&lg=    → склади: схема, 11 по лініях, запасні
// /events?id=&lg=    → голи, картки, заміни, VAR
// /event.ics         → подія матчу як text/calendar (для webcal:// на iOS/macOS)
// cron               → опитування в межах ліміту ПЛАНУ: ліміт і залишок читаємо
//                      з заголовків джерела, тож після апгрейду інтервал стискається сам.
// Решта              → статичні ассети (env.ASSETS).
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p === "/event.ics") return eventIcs(url);
    if (p === "/fixtures")  return fixturesRoute(url, env);
    if (p === "/standings") return standingsRoute(url, env);
    if (p === "/stats")     return statsRoute(url, env);
    if (p === "/lineup")    return lineupRoute(url, env);
    if (p === "/events")    return eventsRoute(url, env);
    if (p === "/tg/info")   return tgInfoRoute(env);
    if (p === "/tg/auth")   return tgAuthRoute(request, env);
    if (p === "/logout")    return logoutRoute();
    if (p === "/rsvp")      return request.method === "POST" ? rsvpPost(request, env) : rsvpGet(request, env);
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(poll(env));
  }
};

// ===================== налаштування =====================
const HL_BASE = "https://soccer.highlightly.net";
const SEASON = 2026;
const PAGE = 100;

// реєстр ліг: усе, що відрізняє турнір, зібрано тут
const LEAGUES = {
  ucl:    { id: 2486,   kind: "cup",    prio: 1 },
  apl:    { id: 33973,  kind: "league", prio: 2 },
  laliga: { id: 119924, kind: "league", prio: 3 }
};
const CODES = Object.keys(LEAGUES);
const DEFAULT_LG = "ucl";
const lg = c => (LEAGUES[c] ? c : null);

// назви раундів у джерела різні: у кубку «League Stage - 3», у чемпіонаті «Regular Season - 12»
const LS_RE = /^League Stage - (\d+)$/i;
const RS_RE = /^Regular Season - (\d+)$/i;
const KO_ROUNDS = ["Round of 32", "Round of 16", "Quarter-finals", "Semi-finals", "Final"];
function isMain(code, r) {
  r = r || "";
  return LEAGUES[code].kind === "cup" ? (LS_RE.test(r) || KO_ROUNDS.includes(r)) : RS_RE.test(r);
}

const FREE_FALLBACK = 90;                // скільки вважаємо доступним, поки не знаємо реального залишку
const FULL_TTL   = 24 * 3600 * 1000;     // повний список сезону: домашні ліги майже не змінюються
const STAND_TTL  = 3 * 3600 * 1000;      // таблиця з джерела
const MATCH_MS   = 150 * 60 * 1000;      // вікно «матч іде»
const FINAL_MS   = 180 * 60 * 1000;      // після цього матч вважаємо завершеним
const BACKFILL_FREE = 2, BACKFILL_PAID = 8;

// які показники залишаємо (за displayName у відповіді джерела) — усі, що воно віддає
const WANT = {
  "Possession": "poss",
  "Expected Goals": "xg", "Expected Assists": "xa", "Big Chances Created": "bigch",
  "Shots on target": "sot", "Shots off target": "soff", "Blocked shots": "sblock",
  "Shots within penalty area": "sin", "Shots outside penalty area": "sout", "Shots accuracy": "sacc",
  "Total passes": "pass", "Successful passes": "passok", "Failed passes": "passbad",
  "Passes Own Half": "passown", "Passes Opposition Half": "passopp",
  "Passes Into Final Third": "passf3", "Backward Passes": "passback",
  "Long Passes": "lp", "Successful Long Passes": "lpok", "Key Passes": "keyp",
  "Crosses": "cross", "Successful Crosses": "crossok", "Throw-Ins": "throw",
  "Tackles": "tkl", "Successful Tackles": "tklok",
  "Aerial Duels": "air", "Successful Aerial Duels": "airok",
  "Dribbles": "drib", "Successful Dribbles": "dribok",
  "Interceptions": "intc", "Clearances": "clr", "Goalkeeper saves": "saves", "Goal Kicks": "gk",
  "Fouls": "fouls", "Free Kicks": "fk", "Offsides": "offsides",
  "Yellow cards": "yellow", "Red cards": "red"
};

function json(obj, status = 200, cacheSec = 0) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": cacheSec ? `public, max-age=${cacheSec}` : "no-store"
    }
  });
}
const ymd = t => new Date(t).toISOString().slice(0, 10);
const today = () => ymd(Date.now());

// ===================== ключ + квота =====================
// ключ працює і як звичайний Secret (рядок), і як прив'язка Secrets Store (об'єкт з .get())
async function hlKey(env) {
  const b = env.HIGHLIGHTLY_KEY;
  if (!b) return null;
  return typeof b.get === "function" ? await b.get() : b;
}
// квота — за РЕАЛЬНИМИ заголовками джерела, а не власним лічильником
async function quota(env) {
  const v = await env.UCL_KV.get("hl:quota", "json");
  if (!v || v.d !== today() || !v.at || (Date.now() - v.at) > 15 * 60000) {
    // невідомо або застаріло → дозволяємо пробний запит (інакше разовий 429 замикає воркер назавжди)
    return { rem: FREE_FALLBACK, lim: 100, paid: false, unknown: true };
  }
  return { rem: v.rem, lim: v.lim || 100, paid: (v.lim || 100) > 500 };
}
// пишемо квоту НЕ на кожен виклик: у KV безкоштовно лише 1000 записів на добу
async function noteQuota(env, r) {
  const rem = +r.headers.get("x-ratelimit-requests-remaining");
  const lim = +r.headers.get("x-ratelimit-requests-limit");
  if (!isFinite(rem)) return;
  const prev = await env.UCL_KV.get("hl:quota", "json");
  const old = !prev || prev.d !== today() || !prev.at;
  if (old || (Date.now() - prev.at) > 5 * 60000 || Math.abs((prev.rem || 0) - rem) >= 10) {
    await env.UCL_KV.put("hl:quota", JSON.stringify({
      d: today(), rem, lim: isFinite(lim) && lim ? lim : ((prev && prev.lim) || 100), at: Date.now()
    }), { expirationTtl: 172800 });
  }
}
async function hlFetch(env, path) {
  const key = await hlKey(env);
  if (!key) return { ok: false, status: 0, data: null };
  try {
    const r = await fetch(HL_BASE + path, { headers: { "x-rapidapi-key": key } });
    await noteQuota(env, r);
    return { ok: r.ok, status: r.status, data: r.ok ? await r.json() : null };
  } catch (e) { return { ok: false, status: 0, data: null }; }
}

// ===================== список матчів =====================
// "2 - 1" | {current:"2 - 1"} | null  ->  [2,1] | null
function parseScorePair(v) {
  if (!v) return null;
  const s = typeof v === "string" ? v : (v.current || "");
  const mt = String(s).match(/(\d+)\s*[-:]\s*(\d+)/);
  return mt ? [+mt[1], +mt[2]] : null;
}
function mapMatch(m) {
  const st = m.state || {}, sc = st.score || {};
  const h = m.homeTeam || {}, a = m.awayTeam || {};
  return {
    id: m.id,
    round: m.round || "",
    date: (m.date || "").slice(0, 10),
    ts: Date.parse(m.date) || 0,
    home: { id: h.id, name: h.name, logo: h.logo },
    away: { id: a.id, name: a.name, logo: a.logo },
    score: parseScorePair(sc.current),
    pens: parseScorePair(sc.penalties),
    status: st.description || "",
    clock: st.clock == null ? null : st.clock
  };
}

const kList  = c => `hl:${c}:matches`;
const kStand = c => `hl:${c}:standings`;
const kHave  = c => `hl:${c}:have`;          // що вже добрали (щоб не читати KV по кожному матчу)

async function readList(env, code) {
  const v = await env.UCL_KV.get(kList(code), "json");
  return (v && v.v === 2 && Array.isArray(v.matches)) ? v : { v: 2, ts: 0, dayTs: 0, matches: [] };
}
// пишемо лише коли щось справді змінилось — економія записів KV
async function writeList(env, code, rec) {
  const body = JSON.stringify(rec);
  const prev = await env.UCL_KV.get(kList(code));
  if (prev === body) return;
  await env.UCL_KV.put(kList(code), body);
}

// повне перечитування сезону (2-3 запити на лігу) — рідко
async function fullRefresh(env, code) {
  // пагінація джерела нестабільна: той самий матч може прийти на двох сторінках,
  // а інший загубитись. Тому збираємо у Map за id, а прогалини добере dayRefresh.
  const seen = new Map();
  let offset = 0, total = Infinity;
  while (offset < total) {
    if ((await quota(env)).rem <= 3) break;
    const r = await hlFetch(env, `/matches?leagueId=${LEAGUES[code].id}&season=${SEASON}&limit=${PAGE}&offset=${offset}`);
    if (!r.ok || !Array.isArray(r.data && r.data.data)) break;
    for (const it of r.data.data) if (it && it.id != null) seen.set(it.id, it);
    total = (r.data.pagination && r.data.pagination.totalCount) || seen.size;
    offset += PAGE;
    if (r.data.data.length < PAGE) break;
  }
  if (!seen.size) return null;
  const matches = [...seen.values()].map(mapMatch).filter(m => isMain(code, m.round));
  if (!matches.length) return null;
  const rec = { v: 2, ts: Date.now(), dayTs: Date.now(), matches };
  await writeList(env, code, rec);
  return rec;
}

// оновлення лише матчів конкретного дня (1 запит) — під час туру
async function dayRefresh(env, code, day) {
  const r = await hlFetch(env, `/matches?leagueId=${LEAGUES[code].id}&season=${SEASON}&date=${day}&limit=${PAGE}`);
  if (!r.ok || !Array.isArray(r.data && r.data.data)) return null;
  const fresh = r.data.data.map(mapMatch).filter(m => isMain(code, m.round));
  const rec = await readList(env, code);
  const byId = new Map(rec.matches.map(m => [m.id, m]));
  for (const f of fresh) byId.set(f.id, Object.assign(byId.get(f.id) || {}, f));
  rec.matches = [...byId.values()];
  rec.dayTs = Date.now();
  await writeList(env, code, rec);
  return rec;
}

async function getList(env, code) {
  let rec = await readList(env, code);
  if (!rec.matches.length && (await quota(env)).rem > 3) rec = (await fullRefresh(env, code)) || rec;
  return rec;
}

function pickLg(url) { return lg(url.searchParams.get("league") || url.searchParams.get("lg")) || DEFAULT_LG; }

async function fixturesRoute(url, env) {
  const code = pickLg(url);
  const rec = await getList(env, code);
  return json({
    league: code, kind: LEAGUES[code].kind, season: SEASON,
    updated: rec.dayTs || rec.ts, matches: rec.matches
  }, 200, 30);
}

// знайти матч, не читаючи всі ліги: клієнт передає свою лігу в ?lg=
async function findMatch(env, url) {
  const code = pickLg(url);
  const id = url.searchParams.get("id");
  if (!id) return { code, m: null };
  const rec = await readList(env, code);
  return { code, m: rec.matches.find(x => String(x.id) === String(id)) || null };
}

// ===================== таблиця з джерела =====================
// авторитетний порядок: у Ла Лізі перший тай-брейк — особисті зустрічі, самі ми так не порахуємо
async function fetchStandings(env, code) {
  const r = await hlFetch(env, `/standings?leagueId=${LEAGUES[code].id}&season=${SEASON}`);
  const groups = r.ok && r.data && Array.isArray(r.data.groups) ? r.data.groups : null;
  if (!groups) return null;
  const rec = {
    at: Date.now(),
    groups: groups.map(g => ({
      name: g.name || "",
      rows: (g.standings || []).map(s => ({
        pos: s.position, pts: s.points,
        team: { id: (s.team || {}).id, name: (s.team || {}).name, logo: (s.team || {}).logo },
        t: s.total || {}, h: s.home || {}, a: s.away || {}
      }))
    }))
  };
  await env.UCL_KV.put(kStand(code), JSON.stringify(rec), { expirationTtl: 172800 });
  return rec;
}
async function standingsRoute(url, env) {
  const code = pickLg(url);
  let rec = await env.UCL_KV.get(kStand(code), "json");
  if (!rec && (await quota(env)).rem > 3) rec = await fetchStandings(env, code);
  if (!rec) return json({ status: "none" }, 200, 60);
  return json({ status: "ok", league: code, at: rec.at, groups: rec.groups }, 200, 120);
}

// ===================== статистика =====================
function extractSide(arr) {
  const o = {};
  for (const s of (arr || [])) {
    const key = WANT[s.displayName || s.type];
    if (key && o[key] === undefined) o[key] = s.value;
  }
  // похідні: «усіх ударів» джерело не віддає, лише у створ / мимо / заблоковані
  const n = v => (v == null ? null : +v);
  const parts = [n(o.sot), n(o.soff), n(o.sblock)].filter(v => v != null);
  if (parts.length) o.shots = parts.reduce((a, b) => a + b, 0);
  if (n(o.pass) && n(o.passok) != null) o.passpct = Math.round(100 * o.passok / o.pass);
  return o;
}
async function fetchStats(env, m, isFinal) {
  const r = await hlFetch(env, `/statistics/${m.id}`);
  const arr = r.data;
  if (!Array.isArray(arr) || arr.length < 2) return null;
  const rec = {
    v: 2, updated: Date.now(), final: !!isFinal,
    home: { name: (arr[0].team || {}).name, s: extractSide(arr[0].statistics) },
    away: { name: (arr[1].team || {}).name, s: extractSide(arr[1].statistics) }
  };
  await env.UCL_KV.put("hl:stats:" + m.id, JSON.stringify(rec));   // без TTL = вічна історія
  return rec;
}
async function statsRoute(url, env) {
  const { m } = await findMatch(env, url);
  if (!m) return json({ status: "no-match" }, 200, 300);
  let rec = await env.UCL_KV.get("hl:stats:" + m.id, "json");
  if (rec && rec.v !== 2) rec = null;                              // старий формат — перечитаємо
  const now = Date.now(), started = m.ts && now >= m.ts;
  if (started && (!rec || (!rec.final && (now - rec.updated) > 120000))) {
    if ((await quota(env)).rem > 3) {
      const fresh = await fetchStats(env, m, now >= m.ts + FINAL_MS);
      if (fresh) rec = fresh;
    }
  }
  if (!rec) return json({ status: started ? "pending" : "notstarted" }, 200, 60);
  return json({ status: "ok", matchId: m.id, final: rec.final, updated: rec.updated, home: rec.home, away: rec.away }, 200, 60);
}

// ===================== склади =====================
function mapPlayer(p) {
  return { id: p.id, name: p.name, num: p.number, pos: p.position };
}
function mapSide(t) {
  if (!t) return null;
  return {
    name: t.name, logo: t.logo, formation: t.formation || "",
    rows: (t.initialLineup || []).map(row => (row || []).map(mapPlayer)),
    subs: (t.substitutes || []).map(mapPlayer)
  };
}
async function fetchLineup(env, m) {
  const r = await hlFetch(env, `/lineups/${m.id}`);
  const d = r.data;
  if (!d || (!d.homeTeam && !d.awayTeam)) return null;
  const rec = { v: 1, at: Date.now(), home: mapSide(d.homeTeam), away: mapSide(d.awayTeam) };
  if (!rec.home && !rec.away) return null;
  await env.UCL_KV.put("hl:lineup:" + m.id, JSON.stringify(rec));  // без TTL
  return rec;
}
async function lineupRoute(url, env) {
  const { m } = await findMatch(env, url);
  if (!m) return json({ status: "no-match" }, 200, 300);
  let rec = await env.UCL_KV.get("hl:lineup:" + m.id, "json");
  const now = Date.now();
  // джерело відкриває склади за 40 хв до початку; після матчу вони лишаються доступними
  const open = m.ts && now >= m.ts - 45 * 60000;
  if (!rec && open && (await quota(env)).rem > 3) rec = await fetchLineup(env, m);
  if (!rec) return json({ status: open ? "pending" : "notstarted" }, 200, 120);
  return json({ status: "ok", at: rec.at, home: rec.home, away: rec.away }, 200, 300);
}

// ===================== події матчу =====================
async function fetchEvents(env, m, isFinal) {
  const r = await hlFetch(env, `/events/${m.id}`);
  if (!Array.isArray(r.data)) return null;
  const rec = {
    v: 1, at: Date.now(), final: !!isFinal,
    list: r.data.map(e => ({
      time: e.time, type: e.type, player: e.player, assist: e.assist,
      out: e.substituted || null, team: (e.team || {}).name
    }))
  };
  await env.UCL_KV.put("hl:events:" + m.id, JSON.stringify(rec));  // без TTL
  return rec;
}
async function eventsRoute(url, env) {
  const { m } = await findMatch(env, url);
  if (!m) return json({ status: "no-match" }, 200, 300);
  let rec = await env.UCL_KV.get("hl:events:" + m.id, "json");
  const now = Date.now(), started = m.ts && now >= m.ts;
  if (started && (!rec || (!rec.final && (now - rec.at) > 60000))) {
    if ((await quota(env)).rem > 3) {
      const fresh = await fetchEvents(env, m, now >= m.ts + FINAL_MS);
      if (fresh) rec = fresh;
    }
  }
  if (!rec) return json({ status: started ? "pending" : "notstarted" }, 200, 60);
  return json({ status: "ok", final: rec.final, at: rec.at, list: rec.list }, 200, 60);
}

// ===================== фонове опитування =====================
const inWindow = (m, now) => m.ts && now >= m.ts && now < m.ts + MATCH_MS;
const finished = (m, now) => m.ts && now >= m.ts + FINAL_MS;

function liveInterval(q, nLive) {
  if (q.paid) return 3 * 60 * 1000;                  // частіше не має сенсу: крон і так раз на 3 хв
  if (q.rem < 25) return 20 * 60 * 1000;             // бюджет на межі — розріджуємо
  return Math.min(20 * 60 * 1000, 5 * 60 * 1000 * Math.max(1, nLive));
}

async function poll(env) {
  const now = Date.now();
  const q = await quota(env);
  if (q.rem <= 3) return;

  // 1) списки сезонів — по одній лізі за прогін, щоб не вигребти квоту за раз
  for (const code of CODES) {
    const rec = await readList(env, code);
    if (!rec.matches.length || (now - rec.ts) > FULL_TTL) {
      if (q.rem > 6) await fullRefresh(env, code);
      return;
    }
  }

  // 2) живі дні — по одному запиту на лігу, у якої зараз ідуть матчі
  const live = [];
  for (const code of CODES) {
    const rec = await readList(env, code);
    if (rec.matches.some(m => inWindow(m, now))) live.push([code, rec]);
  }
  if (live.length) {
    const iv = liveInterval(q, live.length);
    let spent = 0;
    for (const [code, rec] of live) {
      if (q.rem - spent <= 3) break;
      if ((now - (rec.dayTs || 0)) >= iv) { await dayRefresh(env, code, ymd(now)); spent++; }
    }
    await backfill(env, q, q.paid ? 3 : 1);          // під час матчів — лише трохи
    return;
  }

  // 3) тиша — таблиці і добір статистики/подій/складів
  for (const code of CODES) {
    const st = await env.UCL_KV.get(kStand(code), "json");
    if (!st || (now - st.at) > STAND_TTL) {
      if (q.rem > 10) await fetchStandings(env, code);
      break;                                          // одна ліга за прогін
    }
  }
  await backfill(env, q, q.paid ? BACKFILL_PAID : BACKFILL_FREE);
}

// добір по зіграних матчах: статистика → події → склади.
// що вже взяли, тримаємо в одному ключі на лігу, щоб не читати KV на кожен матч
async function backfill(env, q, budget) {
  if (budget <= 0 || q.rem < (q.paid ? 50 : 45)) return;
  const now = Date.now();
  let left = budget;
  // чергуємо, з якої ліги починати, інакше ЛЧ з'їдає весь добір, а АПЛ чекає добу
  const off = Math.floor(now / 180000) % CODES.length;
  const order = CODES.slice(off).concat(CODES.slice(0, off));
  for (const code of order) {
    if (left <= 0) break;
    const rec = await readList(env, code);
    const have = (await env.UCL_KV.get(kHave(code), "json")) || {};
    let changed = false;
    const done = rec.matches.filter(m => finished(m, now)).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    for (const m of done) {
      if (left <= 0) break;
      const f = have[m.id] || "";
      if (f === "x" || (f.includes("s") && f.includes("e") && f.includes("l"))) continue;
      if (!f.includes("s")) { if (await fetchStats(env, m, true))  { have[m.id] = f + "s"; changed = true; left--; continue; } }
      if (!f.includes("e")) { if (await fetchEvents(env, m, true)) { have[m.id] = f + "e"; changed = true; left--; continue; } }
      if (!f.includes("l")) { if (await fetchLineup(env, m))       { have[m.id] = f + "l"; changed = true; left--; continue; } }
      if (!f) { have[m.id] = "x"; changed = true; }    // джерело нічого не дало — більше не сіпаємось
    }
    if (changed) await env.UCL_KV.put(kHave(code), JSON.stringify(have), { expirationTtl: 400 * 86400 });
  }
}

// ===================== Telegram-логін + бронювання =====================
const enc = new TextEncoder();
const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");

async function tgToken(env) {
  const b = env.TG_BOT;
  if (!b) return null;
  return typeof b.get === "function" ? await b.get() : b;
}
async function hmac(keyBytes, msg) {
  const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return await crypto.subtle.sign("HMAC", k, enc.encode(msg));
}

// username бота питаємо в самого Telegram і кешуємо — щоб не вписувати його руками
async function botUsername(env) {
  const cached = await env.UCL_KV.get("ucl:bot", "json");
  if (cached && cached.username) return cached.username;
  const token = await tgToken(env);
  if (!token) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const j = await r.json();
    const username = j && j.ok && j.result ? j.result.username : null;
    if (username) await env.UCL_KV.put("ucl:bot", JSON.stringify({ username, at: Date.now() }), { expirationTtl: 604800 });
    return username;
  } catch (e) { return null; }
}
async function tgInfoRoute(env) {
  return json({ username: await botUsername(env) }, 200, 300);
}

// підпис даних від Telegram Login Widget (офіційна схема: HMAC-SHA256, ключ = SHA256(токен))
async function tgVerify(env, data) {
  const token = await tgToken(env);
  if (!token || !data || !data.hash) return null;
  const { hash, ...rest } = data;
  const check = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join("\n");
  const secret = await crypto.subtle.digest("SHA-256", enc.encode(token));
  const sig = toHex(await hmac(secret, check));
  if (sig !== String(hash).toLowerCase()) return null;
  if (Math.abs(Date.now() / 1000 - Number(rest.auth_date || 0)) > 86400) return null;  // не старше доби
  return rest;
}

// сесія: підписана кука, без окремого сховища
const SESSION_MS = 180 * 86400000;
async function sessionSign(env, uid) {
  const token = await tgToken(env);
  const payload = `${uid}.${Date.now() + SESSION_MS}`;
  return `${payload}.${toHex(await hmac(enc.encode(token), payload))}`;
}
async function sessionRead(env, cookieHeader) {
  const m = /(?:^|;\s*)s=([^;]+)/.exec(cookieHeader || "");
  if (!m) return null;
  const raw = decodeURIComponent(m[1]);
  const i = raw.lastIndexOf(".");
  if (i < 0) return null;
  const payload = raw.slice(0, i), sig = raw.slice(i + 1);
  const token = await tgToken(env);
  if (!token) return null;
  if (toHex(await hmac(enc.encode(token), payload)) !== sig) return null;
  const dot = payload.lastIndexOf(".");
  const uid = payload.slice(0, dot), exp = Number(payload.slice(dot + 1));
  if (!uid || !exp || Date.now() > exp) return null;
  return uid;
}

async function tgAuthRoute(request, env) {
  let data;
  try { data = await request.json(); } catch (e) { return json({ error: "bad-json" }, 400); }
  const u = await tgVerify(env, data);
  if (!u) return json({ error: "bad-signature" }, 401);
  const uid = "tg:" + u.id;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "Гість";
  await env.DB.prepare(
    `INSERT INTO users(id,name,username,photo,created_at) VALUES(?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, username=excluded.username, photo=excluded.photo`
  ).bind(uid, name, u.username || null, u.photo_url || null, Date.now()).run();
  const cookie = await sessionSign(env, uid);
  return new Response(JSON.stringify({ ok: true, user: { id: uid, name, photo: u.photo_url || null } }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": `s=${encodeURIComponent(cookie)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}`
    }
  });
}
function logoutRoute() {
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": "s=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"
    }
  });
}

async function rsvpGet(request, env) {
  const uid = await sessionRead(env, request.headers.get("Cookie"));
  const rows = (await env.DB.prepare(
    `SELECT r.match_id, r.user_id, r.status, u.name, u.photo, u.username
       FROM rsvp r JOIN users u ON u.id = r.user_id`
  ).all()).results || [];
  let me = null;
  if (uid) me = await env.DB.prepare(`SELECT id,name,photo,username FROM users WHERE id=?`).bind(uid).first();
  return json({ me, rows });
}
async function rsvpPost(request, env) {
  const uid = await sessionRead(env, request.headers.get("Cookie"));
  if (!uid) return json({ error: "unauthorized" }, 401);
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: "bad-json" }, 400); }
  const match = String(b.match || ""), status = String(b.status || "");
  if (!match || !["in", "maybe", "out"].includes(status)) return json({ error: "bad-params" }, 400);
  await env.DB.prepare(
    `INSERT INTO rsvp(match_id,user_id,status,updated_at) VALUES(?,?,?,?)
     ON CONFLICT(match_id,user_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`
  ).bind(match, uid, status, Date.now()).run();
  return json({ ok: true });
}

// ===================== календарна подія =====================
function eventIcs(url) {
  const q = url.searchParams;
  const get = (k, d = "") => (q.get(k) || d);
  const esc = s => String(s)
    .replace(/\\/g, "\\\\").replace(/\n/g, "\\n")
    .replace(/,/g, "\\,").replace(/;/g, "\\;");

  const start = get("start");                 // 20260909T190000Z
  const end   = get("end");
  const title = get("title", "Матч ЛЧ");
  const desc  = get("desc");
  const loc   = get("loc");
  const uid   = get("uid", "ucl2627-" + start) + "@ucl2627";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

  const okTime = t => /^\d{8}T\d{6}Z$/.test(t);
  if (!okTime(start) || !okTime(end)) return new Response("bad start/end", { status: 400 });

  const body = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//WAWA//UCL2627//UK",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    "UID:" + uid,
    "DTSTAMP:" + stamp,
    "DTSTART:" + start,
    "DTEND:" + end,
    "SUMMARY:" + esc(title),
    desc ? "DESCRIPTION:" + esc(desc) : "",
    loc ? "LOCATION:" + esc(loc) : "",
    "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + esc(title), "TRIGGER:-PT30M", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR"
  ].filter(Boolean).join("\r\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="ucl2627.ics"',
      "Cache-Control": "public, max-age=300"
    }
  });
}
