// models/User.js
const redisDataLayer = require('../data/redisDataLayer');
const bcrypt = require('bcryptjs');
const { encryptionKey } = require('../config/keys');
const crypto = require('crypto');

function encryptEmail(email) {
  if (!email) return null;
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(encryptionKey, 'hex'), iv);
    let encrypted = cipher.update(email, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  } catch (error) {
    console.error('Email encryption error:', error);
    return null;
  }
}

function decryptEmail(encryptedEmail) {
  if (!encryptedEmail) return null;
  try {
    const [ivHex, encryptedHex] = encryptedEmail.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(encryptionKey, 'hex'), iv);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error('Email decryption error:', error);
    return null;
  }
}

class User {
  constructor(data) {
    this._id = data.id;
    this.name = data.name;
    this.email = data.email;
    this.encryptedEmail = data.encryptedEmail;
    this.profileImage = data.profileImage || '';
    this.createdAt = data.createdAt;
    this.lastActive = data.lastActive;
    this.passwordHash = data.passwordHash;
  }

  static async create({ name, email, password }) {
    if (!name || !email || !password) {
      throw new Error('Name, email, and password are required');
    }
    const userCheck = await redisDataLayer.findUserByEmail(email.toLowerCase());
    if (userCheck) {
      throw new Error('Email already in use');
    }

    const salt = await bcrypt.genSalt(10);
    const hashed = await bcrypt.hash(password, salt);
    const encrypted = encryptEmail(email.toLowerCase());
    console.log('Encrypting email:');
    console.log('Encryption Key:', encryptionKey);
    console.log('Original Email:', email);
    console.log('Encrypted Email:', encrypted);
    const userId = await redisDataLayer.createUser({
      name,
      email: email.toLowerCase(),
      passwordHash: hashed,
      encryptedEmail: encrypted,
      profileImage: ''
    });
    return User.findById(userId);
  }

  static async findById(userId) {
    const raw = await redisDataLayer.getUserById(userId);
    if (!raw) return null;
    return new User({
      id: raw.id,
      name: raw.name,
      email: raw.email,
      encryptedEmail: raw.encryptedEmail,
      profileImage: raw.profileImage,
      createdAt: raw.createdAt,
      lastActive: raw.lastActive,
      passwordHash: raw.passwordHash
    });
  }

  static async findByEmail(email) {
    const user = await redisDataLayer.findUserByEmail(email.toLowerCase());
    if (!user) return null;
    return new User({
      id: user.id,
      name: user.name,
      email: user.email,
      encryptedEmail: user.encryptedEmail,
      profileImage: user.profileImage,
      createdAt: user.createdAt,
      lastActive: user.lastActive,
      passwordHash: user.passwordHash
    });
  }

  async matchPassword(candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.passwordHash);
  }

  async updateLastActive() {
    await redisDataLayer.updateUserLastActive(this._id);
    this.lastActive = new Date();
  }

  async updateProfile(updateData) {
    const allowedUpdates = ['name', 'profileImage'];
    const updates = {};
    for (const key of Object.keys(updateData)) {
      if (allowedUpdates.includes(key)) updates[key] = updateData[key];
    }
    if (Object.keys(updates).length > 0) {
      await redisDataLayer.updateUser(this._id, updates);
      Object.assign(this, updates);
    }
    return this;
  }

  async changePassword(currentPassword, newPassword) {
    const isMatch = await this.matchPassword(currentPassword);
    if (!isMatch) throw new Error('현재 비밀번호가 일치하지 않습니다.');
    const salt = await bcrypt.genSalt(10);
    const newHash = await bcrypt.hash(newPassword, salt);
    await redisDataLayer.updateUser(this._id, { passwordHash: newHash });
    this.passwordHash = newHash;
    return this;
  }

  async deleteAccount() {
    await redisDataLayer.deleteUser(this._id);
    return true;
  }

  decryptEmail() {
    return decryptEmail(this.encryptedEmail);
  }
}

module.exports = User;