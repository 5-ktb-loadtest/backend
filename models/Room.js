// models/Room.js
const redisDataLayer = require('../data/redisDataLayer');
const bcrypt = require('bcryptjs');

class Room {
  constructor(data) {
    this._id = data.id;
    this.name = data.name;
    this.creator = data.creator;
    this.hasPassword = data.hasPassword;
    this.createdAt = data.createdAt;
    this.participants = data.participants || [];
  }

  static async create({ name, creator, password }) {
    const roomId = await redisDataLayer.createRoom(name, creator, password);
    return Room.findById(roomId);
  }

  static async findById(roomId) {
    const raw = await redisDataLayer.getRoomById(roomId);
    if (!raw) return null;
    return new Room(raw);
  }

  async addParticipant(userId) {
    await redisDataLayer.addParticipant(this._id, userId);
    this.participants.push(userId);
  }

  async removeParticipant(userId) {
    await redisDataLayer.removeParticipant(this._id, userId);
    this.participants = this.participants.filter(id => id !== userId);
  }

  async checkPassword(password) {
    return await redisDataLayer.checkRoomPassword(this._id, password);
  }
}

module.exports = Room;