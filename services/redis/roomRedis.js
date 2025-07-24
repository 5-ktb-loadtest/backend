// services/redis/roomRedis.js
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const redis = require('../../utils/redisClient'); // ioredis 클라이언트 인스턴스
const userKey = (id) => `user:${id}`;


const ROOM_PREFIX = 'room';

function getRoomKey(roomId) {
  return `${ROOM_PREFIX}:${roomId}`;
}

function getParticipantsKey(roomId) {
  return `${ROOM_PREFIX}:${roomId}:participants`;
}


exports.createRoom = async ({ name, creator, password = null }) => {
  const roomId = uuidv4();
  const key = getRoomKey(roomId);

  const createdAt = Date.now();
  const hasPassword = !!password;
  const hashedPassword = hasPassword
    ? await bcrypt.hash(password, 10)
    : '';

  await redis.hSet(key, {
    name,
    creator,
    hasPassword: hasPassword ? 'true' : 'false',
    password: hashedPassword,
    createdAt: createdAt.toString() // 문자열로 저장됨. 이용할 때 숫자로 복구
  });

  await redis.sAdd(getParticipantsKey(roomId), creator.toString());
  await redis.zAdd('room:list', createdAt, roomId);

  return { roomId, name, creator, createdAt };
};

exports.checkPassword = async (roomId, plainPassword) => {
  const key = getRoomKey(roomId);
  const [hasPassword, storedHash] = await redis.hmGet(key, 'hasPassword', 'password');

  if (hasPassword !== 'true') return true;
  return await bcrypt.compare(plainPassword, storedHash);
};

exports.getRoom = async (roomId) => {
  try {
    const [room, participantIds] = await Promise.all([
      redis.hGetAll(getRoomKey(roomId)),
      redis.sMembers(getParticipantsKey(roomId))
    ]);
    const creatorInfo = await redis.hGetAll(userKey(room.creator));

    if (!room || Object.keys(room).length === 0) return null;

    const participants = await Promise.all(
      participantIds.map(async (id) => {
        const user = await redis.hGetAll(userKey(id));
        return {
          _id: id,
          name: user.name || '',
          email: user.email || ''
        };
      })
    );

    return {
      _id: roomId,
      name: room.name,
      hasPassword: room.hasPassword === 'true',
      creator: {
        _id: room.creator,
        name: creatorInfo.name || '',
        email: creatorInfo.email || ''
      },
      createdAt: new Date(Number(room.createdAt)),
      participants
    };
  } catch (err) {
    return null;
  }
};

exports.getParticipants = async (roomId) => {
  return await redis.sMembers(`room:${roomId}:participants`);
};  

exports.isParticipant = async (roomId, userId) => {
  return await redis.sIsMember(getParticipantsKey(roomId), userId);
};  

exports.addParticipant = async (roomId, userId) => {
  return await redis.sAdd(getParticipantsKey(roomId), userId);
};

exports.removeParticipant = async (roomId, userId) => {
  return await redis.sRem(getParticipantsKey(roomId), userId);
};

exports.deleteRoom = async (roomId) => {
  await redis.del(getRoomKey(roomId));
  await redis.del(getParticipantsKey(roomId));
  await redis.zRem('room:list', roomId);
};

exports.getPaginatedRooms = async ({ page = 0, pageSize = 10 }) => {
  const start = page * pageSize;
  const end = start + pageSize - 1;

  // 최신순 (createdAt 높은 순) → ZREVRANGE
  const roomIds = await redis.zRevRange('room:list', start, end);

  const rooms = await Promise.all(
    roomIds.map(async (roomId) => {
      const room = await redis.hGetAll(getRoomKey(roomId));
  
      if (!room || Object.keys(room).length === 0) {
        await redis.zRem('room:list', roomId); // 정리
        return null;
      }
  
      const creatorInfo = await redis.hGetAll(userKey(room.creator));  // ❗이제야 안전
      if (!creatorInfo || Object.keys(creatorInfo).length === 0) return null;
  
      const participantIds = await redis.sMembers(getParticipantsKey(roomId));
      const participants = await Promise.all(
        participantIds.map(async (id) => {
          const user = await redis.hGetAll(userKey(id));
          return {
            _id: id,
            name: user.name || '',
            email: user.email || ''
          };
        })
      );
  
      return {
        _id: roomId,
        name: room.name,
        hasPassword: room.hasPassword === 'true',
        creator: {
          _id: room.creator || '',
          name: creatorInfo.name || '',
          email: creatorInfo.email || ''
        },
        participants,
        participantsCount: participants.length,
        createdAt: new Date(Number(room.createdAt))
      };
    })
  );
  // null 필터링
  const filteredRooms = rooms.filter(r => r !== null);

  const totalCount = await redis.zCard('room:list');

  return {
    rooms: filteredRooms,
    total: totalCount
  };
};
  