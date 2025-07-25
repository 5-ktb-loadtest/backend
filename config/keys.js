// backend/config/keys.js
require('dotenv').config();

// 기본 키와 솔트 (개발 환경용)
const DEFAULT_ENCRYPTION_KEY = 'a'.repeat(64); // 32바이트를 hex로 표현
const DEFAULT_PASSWORD_SALT = 'b'.repeat(32); // 16바이트를 hex로 표현

module.exports = {
  jwtSecret: process.env.JWT_SECRET,
  encryptionKey: process.env.ENCRYPTION_KEY || DEFAULT_ENCRYPTION_KEY,
  passwordSalt: process.env.PASSWORD_SALT || DEFAULT_PASSWORD_SALT,
  redisNodes: [
    { host: process.env.REDIS_MASTER1, port: 7000 },  // master1
    { host: process.env.REDIS_MASTER2, port: 7000 },   // master2
    { host: process.env.REDIS_MASTER3, port: 7000 },
    { host: process.env.REDIS_MASTER4, port: 7000 }   // master3
  ],
  openaiApiKey: process.env.OPENAI_API_KEY,
  vectorDbEndpoint: process.env.VECTOR_DB_ENDPOINT,
};