const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS predictions (
        id SERIAL PRIMARY KEY,
        game_type VARCHAR(3),
        date_ist VARCHAR(10),
        time_ist VARCHAR(8),
        hour_ist VARCHAR(2),
        period_id VARCHAR(30),
        actual_num INTEGER,
        actual_size VARCHAR(5),
        actual_color VARCHAR(15),
        pred_num INTEGER,
        pred_size VARCHAR(5),
        pred_color VARCHAR(15),
        pattern_used VARCHAR(50),
        num_win VARCHAR(4),
        size_win VARCHAR(4),
        color_win VARCHAR(4),
        confidence INTEGER DEFAULT 0,
        source VARCHAR(15),
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(game_type, period_id)
      )
    `);
    console.log("[DB] VINIGEMI Tables Ready ✅");
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
