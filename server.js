require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const XLSX = require("xlsx");
const { Pool } = require("pg");

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
const tokens = new Set();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

async function getSetting(key, fallback = "") {
  const r = await pool.query("select value from consent_settings where key=$1", [key]);
  return r.rows[0]?.value ?? fallback;
}
async function setSetting(key, value) {
  await pool.query(
    "insert into consent_settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value",
    [key, value]
  );
}
async function ensureCohort(name) {
  await setSetting("cohort:" + name, name);
}
async function getCohorts() {
  const r = await pool.query(
    "select value from consent_settings where key like 'cohort:%' union select distinct cohort as value from consent_submissions order by value"
  );
  const list = r.rows.map(x => x.value).filter(Boolean);
  const active = await getSetting("active_cohort", "1기");
  if (!list.includes(active)) list.unshift(active);
  return list;
}
async function isClosed(cohort) {
  return (await getSetting("closed:" + cohort, "false")) === "true";
}
async function init() {
  await pool.query(`create table if not exists consent_submissions(
    id bigserial primary key,
    cohort text not null default '미지정',
    name text not null,
    platoon text not null,
    birth_date text not null,
    agree1 boolean not null,
    agree2 boolean not null,
    agree3 boolean not null,
    agree4 boolean not null,
    agree5 boolean not null,
    signature_data text not null,
    submitted_at timestamptz not null default now()
  )`);
  await pool.query("create table if not exists consent_settings(key text primary key,value text not null)");
  const active = await getSetting("active_cohort", "1기");
  await ensureCohort(active);
  await setSetting("active_cohort", active);
}

app.get("/api/status", async (req, res) => {
  try {
    const activeCohort = await getSetting("active_cohort", "1기");
    res.json({ activeCohort, isClosed: await isClosed(activeCohort) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "상태 조회 실패" });
  }
});

app.post("/api/consents", async (req, res) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    const name = String(b.name || "").trim();
    const birthDate = String(b.birthDate || "").trim();
    const platoon = String(b.platoon || "").trim();
    const agrees = ["agree1","agree2","agree3","agree4","agree5"].map(k => b[k] === "on" || b[k] === true);
    if (!name || !platoon || !birthDate || !b.signature || agrees.some(v => !v)) {
      return res.status(400).json({ error: "필수 항목을 확인해 주세요." });
    }

    const cohort = await getSetting("active_cohort", "1기");
    if (await isClosed(cohort)) {
      return res.status(403).json({ error: "현재 기수는 마감되어 제출할 수 없습니다." });
    }
    await ensureCohort(cohort);

    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [cohort + "|" + name + "|" + birthDate]);
    const existing = await client.query(
      `select id from consent_submissions
       where cohort=$1 and name=$2 and birth_date=$3
       order by submitted_at desc limit 1`,
      [cohort, name, birthDate]
    );

    let mode;
    if (existing.rows.length) {
      await client.query(
        `update consent_submissions set
         platoon=$1, agree1=$2, agree2=$3, agree3=$4, agree4=$5, agree5=$6,
         signature_data=$7, submitted_at=now()
         where id=$8`,
        [platoon, ...agrees, b.signature, existing.rows[0].id]
      );
      mode = "updated";
    } else {
      await client.query(
        `insert into consent_submissions
         (cohort,name,platoon,birth_date,agree1,agree2,agree3,agree4,agree5,signature_data)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [cohort, name, platoon, birthDate, ...agrees, b.signature]
      );
      mode = "created";
    }
    await client.query("commit");
    res.json({ ok: true, cohort, mode });
  } catch (e) {
    await client.query("rollback").catch(() => {});
    console.error(e);
    res.status(500).json({ error: "서버 오류" });
  } finally {
    client.release();
  }
});

app.post("/api/admin/login", (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return res.status(500).json({ error: "ADMIN_PASSWORD 환경변수를 설정하세요." });
  if (String(req.body.password || "").trim() !== String(expected).trim()) {
    return res.status(401).json({ error: "비밀번호가 틀렸습니다." });
  }
  const token = crypto.randomBytes(24).toString("hex");
  tokens.add(token);
  res.json({ token });
});
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : req.query.token;
  if (!token || !tokens.has(token)) return res.status(401).json({ error: "관리자 인증 필요" });
  next();
}

app.get("/api/admin/cohorts", auth, async (req, res) => {
  try {
    const cohorts = await getCohorts();
    const activeCohort = await getSetting("active_cohort", "1기");
    const closed = {};
    for (const c of cohorts) closed[c] = await isClosed(c);
    res.json({ cohorts, activeCohort, closed });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "기수 목록 조회 실패" });
  }
});
app.post("/api/admin/cohorts", auth, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "기수명을 입력하세요." });
    await ensureCohort(name);
    await setSetting("active_cohort", name);
    res.json({ ok: true, activeCohort: name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "기수 생성 실패" });
  }
});
app.post("/api/admin/cohorts/active", auth, async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "기수를 선택하세요." });
  await ensureCohort(name);
  await setSetting("active_cohort", name);
  res.json({ ok: true });
});
app.post("/api/admin/cohorts/close", auth, async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "기수를 선택하세요." });
  await ensureCohort(name);
  await setSetting("closed:" + name, "true");
  res.json({ ok: true });
});
app.post("/api/admin/cohorts/open", auth, async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "기수를 선택하세요." });
  await ensureCohort(name);
  await setSetting("closed:" + name, "false");
  res.json({ ok: true });
});
app.delete("/api/admin/cohorts", auth, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "기수를 선택하세요." });
    await pool.query("delete from consent_submissions where cohort=$1", [name]);
    await pool.query("delete from consent_settings where key=$1 or key=$2", ["cohort:" + name, "closed:" + name]);
    let cohorts = (await getCohorts()).filter(c => c !== name);
    const next = cohorts[0] || "1기";
    await ensureCohort(next);
    await setSetting("active_cohort", next);
    res.json({ ok: true, activeCohort: next });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "기수 삭제 실패" });
  }
});

app.get("/api/admin/consents", auth, async (req, res) => {
  try {
    const search = `%${req.query.q || ""}%`;
    const cohort = req.query.cohort || await getSetting("active_cohort", "1기");
    const r = await pool.query(
      `select * from consent_submissions
       where (name ilike $1 or platoon ilike $1) and cohort=$2
       order by submitted_at desc`,
      [search, cohort]
    );
    const stats = { c1:0,c2:0,c3:0,c4:0 };
    for (const x of r.rows) {
      const n = String(x.platoon).charAt(0);
      if (stats["c" + n] !== undefined) stats["c" + n]++;
    }
    res.json({ total:r.rows.length, stats, rows:r.rows, cohort });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "서버 오류" });
  }
});
app.delete("/api/admin/consents/:id", auth, async (req, res) => {
  await pool.query("delete from consent_submissions where id=$1", [req.params.id]);
  res.json({ ok:true });
});

app.get("/api/admin/consents.xlsx", auth, async (req, res) => {
  try {
    const cohort = req.query.cohort || await getSetting("active_cohort", "1기");
    const r = await pool.query(
      `select cohort,name,platoon,birth_date,agree1,agree2,agree3,agree4,agree5,submitted_at
       from consent_submissions where cohort=$1 order by platoon,name`,
      [cohort]
    );
    const rows = r.rows.map(x => ({
      "기수":x.cohort,
      "이름":x.name,
      "소대번호":x.platoon,
      "생년월일":x.birth_date,
      "개인정보 수집·이용":x.agree1 ? "동의" : "미동의",
      "보안 서약":x.agree2 ? "동의" : "미동의",
      "고유식별정보 처리":x.agree3 ? "동의" : "미동의",
      "개인정보 처리":x.agree4 ? "동의" : "미동의",
      "개인정보·민감정보":x.agree5 ? "동의" : "미동의",
      "제출시간":x.submitted_at
    }));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, cohort.slice(0,31));
    const buf = XLSX.write(wb, { type:"buffer", bookType:"xlsx" });
    res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(cohort + "_동의서.xlsx")}`);
    res.send(buf);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "엑셀 다운로드 실패" });
  }
});

app.get("/api/health", (req,res) => res.json({ ok:true }));
init().then(() => app.listen(PORT, () => console.log("Server running on", PORT))).catch(e => {
  console.error(e);
  process.exit(1);
});


