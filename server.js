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
  "accept": "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9,hi;q=0.8",
  "referer": "https://jalwaapp2.com/",
  "origin": "https://jalwaapp2.com",
  "sec-ch-ua": '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
  "sec-ch-ua-mobile": "?1",
  "sec-ch-ua-platform": '"Android"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "cross-site",
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

const PROXIES = [
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url) => `https://thingproxy.freeboard.io/fetch/${url}`
];

async function fetchWithProxy(targetUrl, headers, timeout = 8000) {
  // Try direct first
  try {
    const res = await fetch(targetUrl, { headers, signal: AbortSignal.timeout(timeout) });
    if (res.ok) return res;
    console.log(`[PROXY] Direct fetch returned status ${res.status}. Trying proxy pool...`);
  } catch (e) {
    console.log(`[PROXY] Direct fetch failed: ${e.message}. Trying proxy pool...`);
  }

  // Try proxies one by one
  for (let i = 0; i < PROXIES.length; i++) {
    try {
      const proxyUrl = PROXIES[i](targetUrl);
      console.log(`[PROXY] Trying proxy option ${i + 1}...`);
      const res = await fetch(proxyUrl, { headers, signal: AbortSignal.timeout(timeout) });
      if (res.ok) {
        console.log(`[PROXY] Proxy option ${i + 1} succeeded!`);
        return res;
      }
      console.log(`[PROXY] Proxy option ${i + 1} returned status ${res.status}`);
    } catch (e) {
      console.log(`[PROXY] Proxy option ${i + 1} failed: ${e.message}`);
    }
  }
  throw new Error("All proxies and direct fetches failed with 403 or connection errors.");
}

async function mineLoop(gameType) {
  try {
    console.log(`[${gameType}] Fetching lottery data via Old Project API...`);
    const res = await fetch(`https://vinit-enxj.onrender.com/api/stats?game=${gameType}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.log(`[${gameType}] Old API returned status ${res.status}`);
      return;
    }
    const json = await res.json();
    const recentList = json.recent;
    if (!recentList || recentList.length === 0) {
      console.log(`[${gameType}] No valid recent data from Old API.`);
      return;
    }

    const gs = state[gameType];
    const latest = {
      issueNumber: recentList[0].periodId,
      number: String(recentList[0].actualNum)
    };
    console.log(`[${gameType}] Latest Period ID from Old API: ${latest.issueNumber}`);

    if (gs.lastId === latest.issueNumber) {
      console.log(`[${gameType}] Period ${latest.issueNumber} already processed. Skipping.`);
      return;
    }
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
    console.log(`[${gameType}] Preparing prediction for next Period: ${nextId}`);
    const context = await getEngineContext(gameType);
    let final;

    if (!context) {
       console.log(`[${gameType}] No DB context found yet. Starting in INITIALIZING mode.`);
       final = { number: 5, size: "BIG", color: "GREEN", confidence: 50, method: "INITIALIZING" };
    } else {
       console.log(`[${gameType}] DB context generated successfully. Calling Gemini API...`);
      const aiPrompt = `
      You are the VINIGEMI Master Algorithmic Analyst. Analyze this sequence of recent casino results (oldest to newest):
      Numbers: ${context.recentNums}
      Sizes: ${context.recentSizes}
      Current BIG Ratio (Last 10): ${context.bigRatio}
      Current Streak: ${context.streakLength} ${context.currentStreakDirection}
      
      CRITICAL GAME RULES (You MUST strictly follow these):
      - The predicted "number" MUST strictly be a single integer from 0 to 9.
      - The predicted "size" MUST strictly be "BIG" (for numbers 5, 6, 7, 8, 9) or "SMALL" (for numbers 0, 1, 2, 3, 4).
      - The predicted "color" MUST strictly be based on your predicted number:
        * If number is 0, color is "RED_VIOLET"
        * If number is 5, color is "GREEN_VIOLET"
        * If number is 1, 3, 7, 9, color is "GREEN"
        * If number is 2, 4, 6, 8, color is "RED"
      
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
          model: "gemini-1.5-flash",
          generationConfig: { temperature: 0.1 }
        });
        const result = await model.generateContent(aiPrompt);
        const response = await result.response;
        const rawText = response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(rawText);
        
        // Enforce strict mathematical constraints to prevent LLM hallucinations (e.g., number 23, color BLACK)
        let num = parseInt(parsed.number);
        if (isNaN(num) || num < 0 || num > 9) {
          num = 5; // Safe default
        }
        final = {
          number: num,
          size: num >= 5 ? "BIG" : "SMALL",
          color: getColor(num),
          confidence: Math.max(10, Math.min(99, parseInt(parsed.confidence) || 80)),
          method: parsed.method || "GEMINI[TREND_RIDING]"
        };
        console.log(`[${gameType}] Gemini API prediction parsed and strictly validated:`, final);
      } catch (e) {
        console.error(`[GEMINI ERROR]:`, e.message);
        final = { number: 5, size: "BIG", color: "GREEN_VIOLET", confidence: 10, method: "API_FALLBACK" };
      }
    }

    gs.lastPred = { n: final.number, sz: final.size, col: final.color, method: final.method, confidence: final.confidence, targetId: nextId };
    console.log(`[${gameType}] Active prediction updated: Period ${nextId} | Predicted: ${final.number} (${final.size})`);

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

    // Precise 60S Aligned Scheduler to run exactly at the 03s mark of every minute
    function scheduleNextMine() {
      const now = new Date();
      const seconds = now.getSeconds();
      
      let delay = (60 - seconds + 3) * 1000;
      if (seconds < 3) {
        delay = (3 - seconds) * 1000;
      }
      
      setTimeout(async () => {
        try {
          await mineLoop("1M");
        } catch (e) {
          console.error("[SCHEDULER ERROR]:", e.message);
        }
        scheduleNextMine();
      }, delay);
    }
    
    // Start the precise scheduler
    scheduleNextMine();
  });
}
start();
