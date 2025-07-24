// models/Message.js
const redisDataLayer = require('../data/redisDataLayer');
class Message {
  constructor(data) {
    this._id = data._id;
    this.room = data.room;
    this.content = data.content;
    this.sender = data.sender;
    this.type = data.type;
    this.file = data.file;
    this.aiType = data.aiType;
    this.mentions = data.mentions || [];
    this.timestamp = data.timestamp;
    this.readers = data.readers || [];
    this.reactions = data.reactions || {};
    this.metadata = data.metadata || {};
    this.isDeleted = data.isDeleted;
  }

  static async create(messageData) {
    // 필수 필드 검증
    if (!messageData.room) {
      throw new Error('Room ID is required');
    }
    if (!messageData.sender) {
      throw new Error('Sender is required');
    }
    if (!messageData.type) {
      messageData.type = 'text'; // 기본값 설정
    }

    // 타입별 검증
    if (messageData.type === 'text' && (!messageData.content || messageData.content.trim().length === 0)) {
      throw new Error('Content is required for text messages');
    }
    if (messageData.type === 'file' && !messageData.file) {
      throw new Error('File reference is required for file messages');
    }
    if (messageData.type === 'ai' && !messageData.aiType) {
      throw new Error('AI type is required for AI messages');
    }
    if (messageData.content && messageData.content.length > 10000) {
      throw new Error('메시지는 10000자를 초과할 수 없습니다.');
    }

    // 멘션 처리
    if (messageData.mentions && messageData.mentions.length > 0) {
      messageData.mentions = [...new Set(messageData.mentions.map(m => m.trim()))];
    }

    // Redis에 메시지 생성
    const messageId = await redisDataLayer.createMessage(messageData.room, {
      type: messageData.type,
      content: messageData.content ? messageData.content.trim() : '',
      sender: messageData.sender,
      fileId: messageData.file,
      aiType: messageData.aiType
    });

    return Message.findById(messageId);
  }

  static async findById(messageId) {
    const raw = await redisDataLayer.getMessage(messageId);
    if (!raw) return null;
    const reactions = await redisDataLayer.getReactions(messageId);
    // readers: message:<id>:readers
    const readers = await redisDataLayer.client.sMembers(`message:${messageId}:readers`);
    raw.reactions = reactions;
    raw.readers = readers.map(r => ({ userId: r, readAt: new Date() }));
    return new Message(raw);
  }

  static async markAsRead(messageIds, userId) {
    if (!messageIds?.length || !userId) return 0;
    await redisDataLayer.markMessagesAsRead(userId, null, messageIds);
    return messageIds.length;
  }

  async addReaction(emoji, userId) {
    await redisDataLayer.addReaction(this._id, emoji, userId);
    return await redisDataLayer.getReactions(this._id);
  }

  async removeReaction(emoji, userId) {
    await redisDataLayer.removeReaction(this._id, emoji, userId);
    return await redisDataLayer.getReactions(this._id);
  }

  async softDelete() {
    await redisDataLayer.updateMessage(this._id, { isDeleted: '1' });
    this.isDeleted = true;
  }

  toJSON() {
    return {
      _id: this._id,
      room: this.room,
      content: this.content,
      sender: this.sender,
      type: this.type,
      file: this.file,
      aiType: this.aiType,
      mentions: this.mentions,
      timestamp: this.timestamp,
      readers: this.readers,
      reactions: this.reactions,
      metadata: this.metadata
    };
  }
}

module.exports = Message;