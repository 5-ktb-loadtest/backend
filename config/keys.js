// backend/config/keys.js
require('dotenv').config();

// 기본 키와 솔트 (개발 환경용)
const DEFAULT_ENCRYPTION_KEY = 'e3b1c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // 32바이트를 hex로 표현
const DEFAULT_PASSWORD_SALT = 'b'.repeat(32); // 16바이트를 hex로 표현

module.exports = {
  mongoURI: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  encryptionKey: process.env.ENCRYPTION_KEY || DEFAULT_ENCRYPTION_KEY,
  passwordSalt: process.env.PASSWORD_SALT || DEFAULT_PASSWORD_SALT,
  redisHost: process.env.REDIS_HOST,
  redisPort: process.env.REDIS_PORT,
  openaiApiKey: process.env.OPENAI_API_KEY,
  vectorDbEndpoint: process.env.VECTOR_DB_ENDPOINT,
};