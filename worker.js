// Cloudflare Worker для Ліги чемпіонів 2026/27.
// /fixtures  → усі матчі сезону (розклад + рахунок + статус) з кешу KV
// /stats     → статистика матчу (Highlightly) з кешу KV; ліниво добирає за потреби
// /event.ics → подія матчу як text/calendar (для webcal:// на iOS/macOS)
// cron       → розумне опитування в межах безкоштовного ліміту (100/добу):
//              повний список — рідко (2 запити), у день матчів — лише матчі цього дня (1 запит).
// Решта      → статичні ассети (env.ASSETS).
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/event.ics") return eventIcs(url);
    if (url.pathname === "/fixtures")  return fixturesRoute(env);
    if (url.pathname === "/stats")     return statsRoute(url, env);
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(poll(env));
  }
};

// ===================== налаштування =====================
const HL_BASE = "https://soccer.highlightly.net";
const LEAGUE = 2486, SEASON = 2026;      // UEFA Champions League, сезон 2026/27
const PAGE = 100;                        // максимум записів на сторінку в API

const DAILY_BUDGET = 90;                 // зі 100/добу лишаємо запас
const LOW_BUDGET   = 25;                 // нижче цього — розріджуємо опитування
const FULL_TTL     = 8 * 3600 * 1000;    // повний список сезону оновлюємо рідко
const LIVE_MS      = 5 * 60 * 1000;      // у день матчів: оновлення рахунку
const LOW_LIVE_MS  = 15 * 60 * 1000;     // те саме, коли бюджет на межі
const MATCH_MS     = 150 * 60 * 1000;    // вікно «матч іде»
const FINAL_MS     = 180 * 60 * 1000;    // після цього матч вважаємо завершеним
const BACKFILL_MIN_BUDGET = 50;          // добір статистики — лише коли бюджету вдосталь
const BACKFILL_PER_RUN = 2;              // не більше N доборів за прогін крона

// основна сітка турніру: лігова фаза + плей-оф (кваліфікацію не показуємо)
const LS_RE = /^League Stage - (\d+)$/i;
const KO_ROUNDS = ["Round of 32", "Round of 16", "Quarter-finals", "Semi-finals", "Final"];
const isMain = r => LS_RE.test(r || "") || KO_ROUNDS.includes(r || "");

// які показники залишаємо (за displayName у відповіді Highlightly)
const WANT = {
  "Possession": "possession",
  "Expected Goals": "xg",
  "Shots on target": "sot",
  "Total shots": "shots", "Total Shots": "shots",
  "Big Chances Created": "bigch",
  "Corners": "corners",
  "Offsides": "offsides",
  "Fouls": "fouls",
  "Yellow cards": "yellow",
  "Red cards": "red"
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

// ===================== ключ + бюджет =====================
// ключ працює і як звичайний Secret (рядок), і як прив'язка Secrets Store (об'єкт з .get())
async function hlKey(env) {
  const b = env.HIGHLIGHTLY_KEY;
  if (!b) return null;
  return typeof b.get === "function" ? await b.get() : b;
}
// бюджет — за РЕАЛЬНИМ залишком з заголовка Highlightly, а не власним лічильником
async function budgetLeft(env) {
  const v = await env.UCL_KV.get("ucl:remaining", "json");
  if (!v || v.d !== today()) return DAILY_BUDGET;
  // застаріла або старого формату (без at) → дозволяємо пробний запит, щоб дізнатись реальний залишок
  // (ламає дедлок, коли разовий 429 записав rem:0 і Worker перестав ходити до API)
  if (!v.at || (Date.now() - v.at) > 15 * 60000) return DAILY_BUDGET;
  return v.rem;
}
async function hlFetch(env, path) {
  const key = await hlKey(env);
  if (!key) return null;
  try {
    const r = await fetch(HL_BASE + path, { headers: { "x-rapidapi-key": key } });
    const rem = r.headers.get("x-ratelimit-requests-remaining");
    if (rem != null) {
      await env.UCL_KV.put("ucl:remaining", JSON.stringify({ d: today(), rem: +rem, at: Date.now() }), { expirationTtl: 172800 });
    }
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
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

async function readList(env) {
  const v = await env.UCL_KV.get("ucl:matches", "json");
  return (v && v.v === 1 && Array.isArray(v.matches)) ? v : { v: 1, ts: 0, dayTs: 0, matches: [] };
}
async function writeList(env, rec) {
  await env.UCL_KV.put("ucl:matches", JSON.stringify(rec));
}

// повне перечитування сезону (2-3 запити) — рідко
async function fullRefresh(env) {
  // пагінація Highlightly нестабільна: один і той самий матч може прийти на двох сторінках,
  // а інший — загубитись. Тому збираємо у Map за id (дедуплікація), а прогалини добере dayRefresh.
  const seen = new Map();
  let offset = 0, total = Infinity;
  while (offset < total) {
    if ((await budgetLeft(env)) <= 3) break;
    const r = await hlFetch(env, `/matches?leagueId=${LEAGUE}&season=${SEASON}&limit=${PAGE}&offset=${offset}`);
    if (!r || !Array.isArray(r.data)) break;
    for (const it of r.data) if (it && it.id != null) seen.set(it.id, it);
    total = (r.pagination && r.pagination.totalCount) || seen.size;
    offset += PAGE;
    if (r.data.length < PAGE) break;
  }
  if (!seen.size) return null;
  const matches = [...seen.values()].map(mapMatch).filter(m => isMain(m.round));
  if (!matches.length) return null;
  const rec = { v: 1, ts: Date.now(), dayTs: Date.now(), matches };
  await writeList(env, rec);
  return rec;
}

// оновлення лише матчів конкретного дня (1 запит) — під час туру
async function dayRefresh(env, day) {
  const r = await hlFetch(env, `/matches?leagueId=${LEAGUE}&season=${SEASON}&date=${day}&limit=${PAGE}`);
  if (!r || !Array.isArray(r.data)) return null;
  const fresh = r.data.map(mapMatch).filter(m => isMain(m.round));
  const rec = await readList(env);
  const byId = new Map(rec.matches.map(m => [m.id, m]));
  for (const f of fresh) byId.set(f.id, Object.assign(byId.get(f.id) || {}, f));
  rec.matches = [...byId.values()];
  rec.dayTs = Date.now();
  await writeList(env, rec);
  return rec;
}

// список для клієнта (з самолікуванням, якщо кеш порожній)
async function getList(env) {
  let rec = await readList(env);
  if (!rec.matches.length && (await budgetLeft(env)) > 3) rec = (await fullRefresh(env)) || rec;
  return rec;
}

async function fixturesRoute(env) {
  const rec = await getList(env);
  return json({ season: SEASON, updated: rec.dayTs || rec.ts, matches: rec.matches }, 200, 30);
}

// ===================== статистика =====================
function extractSide(arr) {
  const o = {};
  for (const s of (arr || [])) {
    const key = WANT[s.displayName || s.type];
    if (key && o[key] === undefined) o[key] = s.value;
  }
  return o;
}
async function fetchStats(env, m, isFinal) {
  const r = await hlFetch(env, `/statistics/${m.id}`);
  if (!Array.isArray(r) || r.length < 2) return null;
  const rec = {
    updated: Date.now(), final: !!isFinal,
    home: { name: (r[0].team || {}).name, s: extractSide(r[0].statistics) },
    away: { name: (r[1].team || {}).name, s: extractSide(r[1].statistics) }
  };
  await env.UCL_KV.put("ucl:stats:" + m.id, JSON.stringify(rec)); // без TTL = вічна історія
  return rec;
}

async function statsRoute(url, env) {
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "bad-params" }, 400);
  const rec0 = await readList(env);
  const m = rec0.matches.find(x => String(x.id) === String(id));
  if (!m) return json({ status: "no-match" }, 200, 300);
  let rec = await env.UCL_KV.get("ucl:stats:" + m.id, "json");
  const now = Date.now(), started = m.ts && now >= m.ts;
  // лінивий добір: не було зовсім / застаріле під час гри / завершено-але-не-фінал
  if (started && (!rec || (!rec.final && (now - rec.updated) > 120000))) {
    if ((await budgetLeft(env)) > 3) {
      const fresh = await fetchStats(env, m, now >= m.ts + FINAL_MS);
      if (fresh) rec = fresh;
    }
  }
  if (!rec) return json({ status: started ? "pending" : "notstarted" }, 200, 60);
  return json({ status: "ok", matchId: m.id, final: rec.final, updated: rec.updated, home: rec.home, away: rec.away }, 200, 60);
}

// ===================== фонове опитування (cron кожні 3 хв) =====================
async function poll(env) {
  const now = Date.now();
  let rec = await readList(env);

  // 1) повний список — якщо порожній або застарів
  if (!rec.matches.length || (now - rec.ts) > FULL_TTL) {
    if ((await budgetLeft(env)) > 5) await fullRefresh(env);
    return;
  }
  // 2) якщо просто зараз ідуть матчі — оновлюємо тільки сьогоднішній день (1 запит)
  const live = rec.matches.some(m => m.ts && now >= m.ts && now < m.ts + MATCH_MS);
  if (live) {
    const budget = await budgetLeft(env);
    const iv = budget < LOW_BUDGET ? LOW_LIVE_MS : LIVE_MS;
    if (budget > 3 && (now - (rec.dayTs || 0)) >= iv) await dayRefresh(env, ymd(now));
    return;
  }
  // 3) тиша — потроху добираємо статистику зіграних матчів (лише коли бюджету вдосталь)
  if ((await budgetLeft(env)) < BACKFILL_MIN_BUDGET) return;
  let done = 0;
  for (const m of rec.matches) {
    if (done >= BACKFILL_PER_RUN) break;
    if (!m.ts || now < m.ts + FINAL_MS) continue;          // ще не завершився
    const has = await env.UCL_KV.get("ucl:stats:" + m.id, "json");
    if (has && has.final) continue;
    await fetchStats(env, m, true);
    done++;
  }
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
