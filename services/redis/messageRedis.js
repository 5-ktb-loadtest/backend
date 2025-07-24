// services/redis/messageRedis.js
const { v4: uuidv4 } = require('uuid');
const redis = require('../../utils/redisClient');

const MESSAGE_PREFIX = 'message';

function getMessageKey(messageId) {
  return `${MESSAGE_PREFIX}:${messageId}`;
}

function getRoomMessagesKey(roomId) {
  return `${MESSAGE_PREFIX}:room:${roomId}:messages`;
}

// 메시지 생성 및 저장 (room별 리스트에도 추가)
exports.createMessage = async ({ roomId, content, sender, type = 'text', file = null, aiType = null, mentions = [], timestamp = Date.now(), readers = [], reactions = {}, metadata = {}, isDeleted = false }) => {
  const messageId = uuidv4();
  const key = getMessageKey(messageId);

  const message = {
    _id: messageId,
    room: roomId,
    content,
    sender,
    type,
    file,
    aiType,
    mentions: JSON.stringify(mentions),
    timestamp: timestamp.toString(),
    readers: JSON.stringify(readers),
    reactions: JSON.stringify(reactions),
    metadata: JSON.stringify(metadata),
    isDeleted: isDeleted ? 'true' : 'false'
  };

  await redis.hSet(key, message);
  await redis.rPush(getRoomMessagesKey(roomId), messageId);
  return { ...message, _id: messageId };
};

// 메시지 단건 조회
exports.getMessage = async (messageId) => {
  const data = await redis.hGetAll(getMessageKey(messageId));
  if (!data || Object.keys(data).length === 0) return null;
  return {
    ...data,
    mentions: JSON.parse(data.mentions || '[]'),
    readers: JSON.parse(data.readers || '[]'),
    reactions: JSON.parse(data.reactions || '{}'),
    metadata: JSON.parse(data.metadata || '{}'),
    isDeleted: data.isDeleted === 'true',
    timestamp: Number(data.timestamp)
  };
};

// 특정 방의 메시지 페이징 조회 (최신순)
exports.getRoomMessages = async (roomId, { page = 0, pageSize = 20 } = {}) => {
  const start = -(page + 1) * pageSize;
  const end = -1 - page * pageSize;
  const messageIds = await redis.lRange(getRoomMessagesKey(roomId), start, end);
  const messages = await Promise.all(messageIds.map(exports.getMessage));
  // 최신순 정렬
  return messages.filter(Boolean).sort((a, b) => b.timestamp - a.timestamp);
};

// 메시지 삭제 (soft delete)
exports.softDeleteMessage = async (messageId) => {
  await redis.hSet(getMessageKey(messageId), 'isDeleted', 'true');
};

// 메시지 완전 삭제
exports.deleteMessage = async (messageId, roomId) => {
  await redis.del(getMessageKey(messageId));
  if (roomId) {
    await redis.lRem(getRoomMessagesKey(roomId), 0, messageId);
  }
};