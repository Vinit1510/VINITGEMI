require("dotenv").config();
const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { pool, initDB } = require("./core/db");
const { getColor, getEngineContext } = require("./core/data_formatter");

const app = express();
const PORT = process.env.PORT || 3000;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY); 

const state = {
  "1M": { lastPred: null, lastId: null },
  // "30S": { lastPred: null, lastId: null }, // DISABLED TO SAVE API LIMITS
};

const ENDPOINTS = {
  "1M": "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json",
  "30S": "https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json",
};

const FETCH_HEADERS = {
  "accept": "application/json",
  "referer": "https://jalwaapp2.com/",
  "user-agent": "Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36"
};

function nowIST() {
  const istStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
  const ist = new Date(istStr);
  return {
    date: `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, "0")}-${String(ist.getDate()).padStart(2, "0")}`,
    time: `${String(ist.getHours()).padStart(2, "0")}:${String(ist.getMinutes()).padStart(2, "0")}:${String(ist.getSeconds()).padStart(2, "0")}`,
    hour: String(ist.getHours())
  };
}

async function mineLoop(gameType) {
  try {
    const res = await fetch(`${ENDPOINTS[gameType]}?ts=${Date.now()}`, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const json = await res.json();
    const history = json.data.list;
    if (!history || history.length < 3) return;

    const gs = state[gameType];
    const latest = history[0];

    if (gs.lastId === latest.issueNumber) return;
    gs.lastId = latest.issueNumber;

    // 1. Process previous prediction
    if (gs.lastPred && gs.lastPred.targetId === latest.issueNumber) {
      const actualNum = parseInt(latest.number);
      const actualSize = actualNum >= 5 ? "BIG" : "SMALL";
      const actualColor = getColor(actualNum);

      const numWin = (actualNum === gs.lastPred.n ? "WIN" : "LOSS");
      const sizeWin = (actualSize === gs.lastPred.sz ? "WIN" : "LOSS");
      const colorWin = (actualColor.includes(gs.lastPred.col) || gs.lastPred.col.includes(actualColor) ? "WIN" : "LOSS");

      const { date, time, hour } = nowIST();
      await pool.query(
        `INSERT INTO predictions (game_type, date_ist, time_ist, hour_ist, period_id, actual_num, actual_size, actual_color, pred_num, pred_size, pred_color, pattern_used, num_win, size_win, color_win, confidence, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (game_type, period_id) DO NOTHING`,
        [gameType, date, time, hour, latest.issueNumber, actualNum, actualSize, actualColor, gs.lastPred.n, gs.lastPred.sz, gs.lastPred.col, gs.lastPred.method, numWin, sizeWin, colorWin, gs.lastPred.confidence, "GEMINI_AI"]
      );
      console.log(`[${gameType}] ${latest.issueNumber} | Size:${sizeWin} | Strategy: ${gs.lastPred.method}`);
    }

    // 2. Build Context & Call Gemini for next round
    const nextId = String(BigInt(latest.issueNumber) + 1n);
    const context = await getEngineContext(gameType);
    let final;

    if (!context) {
       final = { number: 5, size: "BIG", color: "GREEN", confidence: 50, method: "INITIALIZING" };
    } else {
      const aiPrompt = `
      You are the VINIGEMI Master Algorithmic Analyst. Analyze this sequence of recent casino results (oldest to newest):
      Numbers: ${context.recentNums}
      Sizes: ${context.recentSizes}
      Current BIG Ratio (Last 10): ${context.bigRatio}
      Current Streak: ${context.streakLength} ${context.currentStreakDirection}
      
      Apply the dynamic state machine logic:
      - If ratio <= 0.3 or >= 0.7, trigger EMERGENCY_REVERSAL.
      - If streak >= 3, trigger CLUSTER_MOMENTUM.
      - Otherwise, use TREND_RIDING.
      
      Output ONLY a valid JSON object. No markdown formatting.
      Format exactly like this:
      {"number": 8, "size": "BIG", "color": "RED", "confidence": 85, "method": "GEMINI[EMERGENCY_REVERSAL]"}
      `;

      try {
        const model = genAI.getGenerativeModel({ 
          model: "gemini-2.5-flash",
          generationConfig: { temperature: 0.1 }
        });
        const result = await model.generateContent(aiPrompt);
        const response = await result.response;
        const rawText = response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        final = JSON.parse(rawText);
      } catch (e) {
        console.error(`[GEMINI ERROR]:`, e.message);
        final = { number: 5, size: "BIG", color: "GREEN", confidence: 10, method: "API_FALLBACK" };
      }
    }

    gs.lastPred = { n: final.number, sz: final.size, col: final.color, method: final.method, confidence: final.confidence, targetId: nextId };

  } catch (err) {
    console.error(`[${gameType}] Mining Error:`, err.message);
  }
}

// ─── Express Server ───────────────────────────────────────────
app.use(express.static(require("path").join(__dirname, "public")));
app.use(express.json());

app.get("/api/stats", async (req, res) => {
  try {
    const game = req.query.game === "30S" ? "30S" : "1M";
    const gs = state[game];
    const prediction = gs.lastPred ? {
      number: gs.lastPred.n, size: gs.lastPred.sz, color: gs.lastPred.col,
      method: gs.lastPred.method, confidence: gs.lastPred.confidence, targetId: gs.lastPred.targetId
    } : null;

    const recentRes = await pool.query(`SELECT * FROM predictions WHERE game_type = $1 ORDER BY id DESC LIMIT 15`, [game]);
    res.json({ prediction, recent: recentRes.rows.map(r => ({
      periodId: r.period_id, actualNum: r.actual_num, actualSize: r.actual_size, actualColor: r.actual_color,
      predNum: r.pred_num, predSize: r.pred_size, predColor: r.pred_color, pattern: r.pattern_used,
      numWin: r.num_win, sizeWin: r.size_win, colorWin: r.color_win, confidence: r.confidence
    }))});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function start() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║   VINIGEMI 1M ONLY — FREE TIER MODE      ║`);
    console.log(`╚══════════════════════════════════════════╝\n`);

    // Only start the 1M mining loop
    mineLoop("1M");
    setInterval(() => mineLoop("1M"), 9000); 

    // 30S Loop is removed to protect the 1,500/day API quota
  });
}
start();
