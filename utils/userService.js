const pool = require('../db');

async function findOrCreateUser({ youtube_user_id, email }) {
  // 1. 이메일로 유저 조회
  const selectQuery = 'SELECT * FROM "User" WHERE email = $1 AND is_deleted = false LIMIT 1';
  const selectResult = await pool.query(selectQuery, [email]);
  if (selectResult.rows.length > 0) {
    return selectResult.rows[0];
  }
  // 2. 없으면 새로 생성
  const insertQuery = `
    INSERT INTO "User" (youtube_user_id, email, is_deleted, created_at, updated_at)
    VALUES ($1, $2, false, NOW(), NOW())
    RETURNING *;
  `;
  const insertResult = await pool.query(insertQuery, [youtube_user_id, email]);
  return insertResult.rows[0];
}

module.exports = { findOrCreateUser }; 