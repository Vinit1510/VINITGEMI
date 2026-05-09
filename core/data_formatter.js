const { pool } = require("./db");

function getColor(n) {
  if (n === 0) return "RED_VIOLET";
  if (n === 5) return "GREEN_VIOLET";
  if ([1, 3, 7, 9].includes(n)) return "GREEN";
  return "RED";
}

async function getEngineContext(gameType) {
  const res = await pool.query(
    `SELECT actual_num, actual_size, actual_color 
     FROM predictions WHERE game_type = $1 AND actual_size IS NOT NULL
     ORDER BY id DESC LIMIT 20`,
    [gameType]
  );
  
  const history = res.rows.map(r => ({
    number: r.actual_num,
    size: r.actual_size
  }));

  if (history.length === 0) return null;

  const sizes = history.map(h => h.size);
  const nums = history.map(h => h.number);
  
  // Calculate Streak
  let streakLen = 1;
  const firstSize = sizes[0];
  while (streakLen < sizes.length && sizes[streakLen] === firstSize) streakLen++;

  // Calculate 10-Round Ratio
  const sizes10 = sizes.slice(0, 10);
  const bigCount = sizes10.filter(s => s === "BIG").length;
  const ratio = sizes10.length > 0 ? bigCount / sizes10.length : 0.5;

  return {
    recentNums: nums.slice(0, 10).reverse().join(", "), // Oldest to newest
    recentSizes: sizes.slice(0, 10).reverse().join(", "),
    streakLength: streakLen,
    currentStreakDirection: firstSize,
    bigRatio: ratio
  };
}

module.exports = { getColor, getEngineContext };
