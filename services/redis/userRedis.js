// services/redis/userRedis.js
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const redis = require('../../utils/redisClient');
const { encryptionKey } = require('../../config/keys');

const getUserKey = (userId) => `user:${userId}`;
const getEmailIndexKey = (email) => `user:email:${email}`;
const getUserListKey = () => 'user:list';

function encryptEmail(email) {
  if (!email) return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(encryptionKey, 'hex'), iv);
  let encrypted = cipher.update(email, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decryptEmail(encryptedEmail) {
    try {
      const [ivHex, encryptedHex] = encryptedEmail.split(':');
      const iv = Buffer.from(ivHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(encryptionKey, 'hex'), iv);
      let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (err) {
      console.error('decryptEmail error:', err);
      return null;
    }
}

exports.createUser = async ({ name, email, password, profileImage = '' }) => {
    const _id = uuidv4();
    if (!encryptionKey || encryptionKey.length !== 64) {
      throw new Error('Encryption key must be 64 hex characters');
    }
  
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = password ? await bcrypt.hash(password, salt) : '';
  
    const encryptedEmail = encryptEmail(email);
  
    const createdAt = Date.now();
  
    await redis.hSet(getUserKey(_id), {
      name,
      encryptedEmail,
      password: hashedPassword,
      profileImage,
      createdAt: String(createdAt),
      lastActive: String(createdAt)
    });
  
    await redis.set(getEmailIndexKey(email), _id);
    await redis.zAdd(getUserListKey(), createdAt, _id);
  
    return { _id, name, email, encryptedEmail, createdAt };
};
  

exports.getUserById = async (userId) => {
    const user = await redis.hGetAll(getUserKey(userId));
    if (!user || Object.keys(user).length === 0) return null;
  
    return {
      _id: userId,
      ...user,
      createdAt: Number(user.createdAt),
      lastActive: Number(user.lastActive)
    };
};

exports.getUsersByIds = async (userIds) => {
  if (!Array.isArray(userIds)) return [];

  const users = await Promise.all(
    userIds.map((userId) => exports.getUserById(userId))
  );

  return users.filter(Boolean); // null 제거
};
  
exports.getUserByEmail = async (email) => {
    const userId = await redis.get(getEmailIndexKey(email));
    if (!userId) return null;
    return await exports.getUserById(userId);
};
  

exports.matchPassword = async (userId, enteredPassword) => {
    const stored = await redis.hGet(getUserKey(userId), 'password');
    if (!stored) return false;
    return await bcrypt.compare(enteredPassword, stored);
  };  

exports.updateLastActive = async (userId) => {
  return await redis.hSet(getUserKey(userId), 'lastActive', Date.now());
};

exports.updateProfile = async (userId, { name, profileImage }) => {
  const updates = {};
  if (name) updates.name = name;
  if (profileImage) updates.profileImage = profileImage;
  await redis.hSet(getUserKey(userId), updates);
  return exports.getUserById(userId);
};


exports.changePassword = async (userId, currentPassword, newPassword) => {
    const isMatch = await exports.matchPassword(userId, currentPassword);
    if (!isMatch) throw new Error('현재 비밀번호가 일치하지 않습니다');
  
    const salt = await bcrypt.genSalt(10);
    const newHashed = await bcrypt.hash(newPassword, salt);
    await redis.hSet(getUserKey(userId), 'password', newHashed);
    return true;
  };  

exports.deleteUser = async (userId) => {
    const user = await redis.hGetAll(getUserKey(userId));
    if (!user || !user.email) return false;
  
    await redis.del(getUserKey(userId));
    await redis.del(getEmailIndexKey(user.email));
    await redis.zRem(getUserListKey(), userId);
    return true;
  };  

exports.decryptEmail = decryptEmail;

exports.getPaginatedUsers = async ({ page = 0, pageSize = 10 }) => {
    const start = page * pageSize;
    const end = start + pageSize - 1;
  
    const userIds = await redis.zRevRange(getUserListKey(), start, end);
  
    const users = await Promise.all(
      userIds.map(async (userId) => {
        const user = await exports.getUserById(userId);
        if (!user) return null;
        return {
          _id: userId,
          name: user.name,
          email: user.email,
          profileImage: user.profileImage || '',
          createdAt: user.createdAt,
          lastActive: user.lastActive
        };
      })
    );
  
    return {
      users: users.filter(u => u !== null),
      total: await redis.zCard(getUserListKey())
    };
  };
  
  exports.updateUser = async (userId, fields) => {
    const key = getUserKey(userId);
    const updates = { ...fields };
  
    // 암호화된 이메일 처리
    if (fields.email) {
      const encryptedEmail = encryptEmail(fields.email);
      updates.encryptedEmail = encryptedEmail;
  
      // 기존 이메일 인덱스 제거
      const existingUser = await redis.hGetAll(key);
      if (existingUser?.encryptedEmail) {
        const oldEmail = decryptEmail(existingUser.encryptedEmail);
        if (oldEmail) {
          await redis.del(getEmailIndexKey(oldEmail));
        }
      }
  
      // 새 이메일 인덱스 저장
      await redis.set(getEmailIndexKey(fields.email), userId);
    }
  
    updates.lastUpdated = Date.now();
  
    await redis.hSet(key, updates);
    return await exports.getUserById(userId);
  };
  