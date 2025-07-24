const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const { rateLimit } = require('express-rate-limit');
const Room = require('../../models/Room');
const User = require('../../models/User');
const redisDataLayer = require('../../data/redisDataLayer');
let io;

// 속도 제한 설정
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1분
  max: 60,
  message: {
    success: false,
    error: {
      message: '너무 많은 요청이 발생했습니다. 잠시 후 다시 시도해주세요.',
      code: 'TOO_MANY_REQUESTS'
    }
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Socket.IO 초기화 함수
const initializeSocket = (socketIO) => {
  io = socketIO;
};

// 서버 상태 확인
router.get('/health', async (req, res) => {
  try {
    // Redis 연결 상태 확인: 간단히 ping 또는 사용자 조회 등으로 테스트
    await redisDataLayer.init(); // redis 연결 보장
    const testUser = await User.findByEmail('nonexistent@example.com'); // 존재하지 않는 유저 조회로 에러 없으면 정상작동
    const isRedisConnected = true; // 여기서는 단순히 redis 명령 성공시 true

    // 가장 최근 방 생성 시간 확인 (room:all에서 모든 방 가져와 가장 최근것 확인)
    const roomIds = await redisDataLayer.getAllRoomIds();
    let recentRoomCreatedAt = null;
    if (roomIds.length > 0) {
      const roomsData = [];
      for (const rid of roomIds) {
        const r = await Room.findById(rid);
        if (r) roomsData.push(r);
      }
      if (roomsData.length > 0) {
        roomsData.sort((a, b) => b.createdAt - a.createdAt);
        recentRoomCreatedAt = roomsData[0].createdAt;
      }
    }

    // 간단한 latency 측정: Room 하나 조회 시도
    const start = process.hrtime();
    if (roomIds.length > 0) {
      await Room.findById(roomIds[0]);
    }
    const [seconds, nanoseconds] = process.hrtime(start);
    const latency = Math.round((seconds * 1000) + (nanoseconds / 1000000));

    const status = {
      success: true,
      timestamp: new Date().toISOString(),
      services: {
        database: {
          connected: isRedisConnected,
          latency
        }
      },
      lastActivity: recentRoomCreatedAt || null
    };

    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    res.status(isRedisConnected ? 200 : 503).json(status);

  } catch (error) {
    console.error('Health check error:', error);
    res.status(503).json({
      success: false,
      error: {
        message: '서비스 상태 확인에 실패했습니다.',
        code: 'HEALTH_CHECK_FAILED'
      }
    });
  }
});

// 채팅방 목록 조회 (페이징 적용)
router.get('/', [limiter, auth], async (req, res) => {
  try {
    // 쿼리 파라미터 검증 (페이지네이션)
    const page = Math.max(0, parseInt(req.query.page) || 0);
    const pageSize = Math.min(Math.max(1, parseInt(req.query.pageSize) || 10), 50);
    const skip = page * pageSize;

    // 정렬 설정
    const allowedSortFields = ['createdAt', 'name', 'participantsCount'];
    const sortField = allowedSortFields.includes(req.query.sortField) 
      ? req.query.sortField 
      : 'createdAt';
    const sortOrder = ['asc', 'desc'].includes(req.query.sortOrder)
      ? req.query.sortOrder
      : 'desc';

    // 검색 필터
    const search = req.query.search ? req.query.search.toLowerCase() : '';

    // 모든 방 ID 조회
    const allRoomIds = await redisDataLayer.getAllRoomIds();

    // 모든 방 로드
    const roomsData = [];
    for (const roomId of allRoomIds) {
      const r = await Room.findById(roomId);
      if (r) roomsData.push(r);
    }

    // 검색 필터 적용
    let filtered = roomsData;
    if (search) {
      filtered = filtered.filter(room =>
        room.name.toLowerCase().includes(search)
      );
    }

    // participantsCount 계산
    // 이미 Room 인스턴스에 participants 있을 것이므로 length 사용
    // 정렬
    filtered.sort((a, b) => {
      let valA, valB;
      if (sortField === 'createdAt') {
        valA = a.createdAt.getTime();
        valB = b.createdAt.getTime();
      } else if (sortField === 'name') {
        valA = a.name.toLowerCase();
        valB = b.name.toLowerCase();
      } else if (sortField === 'participantsCount') {
        valA = a.participants.length;
        valB = b.participants.length;
      }

      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });

    const totalCount = filtered.length;
    const paginated = filtered.slice(skip, skip + pageSize);

    // 참가자와 생성자 정보 로드
    // Room 클래스에서는 creator와 participants를 userId 배열로 관리한다고 가정
    async function getUserInfo(userId) {
      const u = await User.findById(userId);
      if (!u) return { _id: 'unknown', name: '알 수 없음', email: '' };
      return {
        _id: u._id.toString(),
        name: u.name,
        email: u.email
      };
    }

    const safeRooms = [];
    for (const room of paginated) {
      const creator = await getUserInfo(room.creator);
      const participants = [];
      for (const pid of room.participants) {
        const pu = await getUserInfo(pid);
        participants.push(pu);
      }

      safeRooms.push({
        _id: room._id,
        name: room.name,
        hasPassword: !!room.hasPassword,
        creator,
        participants,
        participantsCount: participants.length,
        createdAt: room.createdAt,
        isCreator: creator._id === req.user.id
      });
    }

    const totalPages = Math.ceil(totalCount / pageSize);
    const hasMore = skip + paginated.length < totalCount;

    // 캐시 설정
    res.set({
      'Cache-Control': 'private, max-age=10',
      'Last-Modified': new Date().toUTCString()
    });

    // 응답 전송
    res.json({
      success: true,
      data: safeRooms,
      metadata: {
        total: totalCount,
        page,
        pageSize,
        totalPages,
        hasMore,
        currentCount: safeRooms.length,
        sort: {
          field: sortField,
          order: sortOrder
        }
      }
    });

  } catch (error) {
    console.error('방 목록 조회 에러:', error);
    const errorResponse = {
      success: false,
      error: {
        message: '채팅방 목록을 불러오는데 실패했습니다.',
        code: 'ROOMS_FETCH_ERROR'
      }
    };

    if (process.env.NODE_ENV === 'development') {
      errorResponse.error.details = error.message;
      errorResponse.error.stack = error.stack;
    }

    res.status(500).json(errorResponse);
  }
});

// 채팅방 생성
router.post('/', auth, async (req, res) => {
  try {
    const { name, password } = req.body;
    
    if (!name?.trim()) {
      return res.status(400).json({ 
        success: false,
        message: '방 이름은 필수입니다.' 
      });
    }

    // Room 생성
    const room = await Room.create({
      name: name.trim(),
      creator: req.user.id,
      password
    });

    // 참여자 목록에 생성자 추가 (Room.create 내부에서 이미 추가했다고 가정)
    // 방 정보 조회
    const finalRoom = await Room.findById(room._id);

    // creator, participants 정보 로딩
    const creator = await User.findById(finalRoom.creator) || { _id: 'unknown', name: '알 수 없음', email: '' };
    const participants = [];
    for (const pid of finalRoom.participants) {
      const pu = await User.findById(pid);
      participants.push(pu ? {
        _id: pu._id.toString(),
        name: pu.name,
        email: pu.email
      } : { _id: 'unknown', name: '알 수 없음', email: '' });
    }

    if (io) {
      io.to('room-list').emit('roomCreated', {
        _id: finalRoom._id,
        name: finalRoom.name,
        hasPassword: !!finalRoom.hasPassword,
        creator,
        participants,
        participantsCount: participants.length,
        createdAt: finalRoom.createdAt
      });
    }

    res.status(201).json({
      success: true,
      data: {
        _id: finalRoom._id,
        name: finalRoom.name,
        hasPassword: !!finalRoom.hasPassword,
        creator,
        participants,
        participantsCount: participants.length,
        createdAt: finalRoom.createdAt
      }
    });
  } catch (error) {
    console.error('방 생성 에러:', error);
    res.status(500).json({ 
      success: false,
      message: '서버 에러가 발생했습니다.',
      error: error.message 
    });
  }
});

// 특정 채팅방 조회
router.get('/:roomId', auth, async (req, res) => {
  try {
    const room = await Room.findById(req.params.roomId);
    if (!room) {
      return res.status(404).json({
        success: false,
        message: '채팅방을 찾을 수 없습니다.'
      });
    }

    const creator = await User.findById(room.creator) || { _id: 'unknown', name: '알 수 없음', email: '' };
    const participants = [];
    for (const pid of room.participants) {
      const pu = await User.findById(pid);
      participants.push(pu ? {
        _id: pu._id.toString(),
        name: pu.name,
        email: pu.email
      } : { _id: 'unknown', name: '알 수 없음', email: '' });
    }

    res.json({
      success: true,
      data: {
        _id: room._id,
        name: room.name,
        hasPassword: !!room.hasPassword,
        creator,
        participants,
        participantsCount: participants.length,
        createdAt: room.createdAt
      }
    });
  } catch (error) {
    console.error('Room fetch error:', error);
    res.status(500).json({
      success: false,
      message: '채팅방 정보를 불러오는데 실패했습니다.'
    });
  }
});

// 채팅방 입장
router.post('/:roomId/join', auth, async (req, res) => {
  try {
    const { password } = req.body;
    const room = await Room.findById(req.params.roomId);
    
    if (!room) {
      return res.status(404).json({
        success: false,
        message: '채팅방을 찾을 수 없습니다.'
      });
    }

    // 비밀번호 확인
    if (room.hasPassword) {
      const isPasswordValid = await room.checkPassword(password);
      if (!isPasswordValid) {
        return res.status(401).json({
          success: false,
          message: '비밀번호가 일치하지 않습니다.'
        });
      }
    }

    if (!room.participants.includes(req.user.id)) {
      await room.addParticipant(req.user.id);
    }

    // 업데이트된 방 정보 다시 로드
    const updatedRoom = await Room.findById(room._id);
    const creator = await User.findById(updatedRoom.creator) || { _id: 'unknown', name: '알 수 없음', email: '' };
    const participants = [];
    for (const pid of updatedRoom.participants) {
      const pu = await User.findById(pid);
      participants.push(pu ? {
        _id: pu._id.toString(),
        name: pu.name,
        email: pu.email
      } : { _id: 'unknown', name: '알 수 없음', email: '' });
    }

    if (io) {
      io.to(req.params.roomId).emit('roomUpdate', {
        _id: updatedRoom._id,
        name: updatedRoom.name,
        hasPassword: !!updatedRoom.hasPassword,
        creator,
        participants,
        participantsCount: participants.length,
        createdAt: updatedRoom.createdAt
      });
    }

    res.json({
      success: true,
      data: {
        _id: updatedRoom._id,
        name: updatedRoom.name,
        hasPassword: !!updatedRoom.hasPassword,
        creator,
        participants,
        participantsCount: participants.length,
        createdAt: updatedRoom.createdAt
      }
    });
  } catch (error) {
    console.error('방 입장 에러:', error);
    res.status(500).json({
      success: false,
      message: '서버 에러가 발생했습니다.',
      error: error.message
    });
  }
});

module.exports = {
  router,
  initializeSocket
};