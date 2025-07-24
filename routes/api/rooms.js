const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const roomRedis = require('../../services/redis/roomRedis');
const User = require('../../models/User');
const { rateLimit } = require('express-rate-limit');
let io;

// 속도 제한 설정
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1분
  max: 60, // IP당 최대 요청 수
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
    const isMongoConnected = require('mongoose').connection.readyState === 1;
    const recentRoomId = await redis.zrevrange('room:list', 0, 0);
    const recentRoom = recentRoomId.length > 0 ? await redis.hgetall(`room:${recentRoomId[0]}`) : null;

    const start = process.hrtime();
    await redis.ping()
    const [seconds, nanoseconds] = process.hrtime(start);
    const latency = Math.round((seconds * 1000) + (nanoseconds / 1000000));

    const status = {
      success: true,
      timestamp: new Date().toISOString(),
      services: {
        database: {
          connected: isMongoConnected,
          latency
        }
      },
      lastActivity: recentRoom?.createdAt
    };

    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    res.status(isMongoConnected ? 200 : 503).json(status);

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

    // 검색 필터 구성
    const filter = {};
    if (req.query.search) {
      filter.name = { $regex: req.query.search, $options: 'i' };
    }

    // 채팅방 목록 조회 with 페이지네이션
    const {
      rooms,
      totalCount,
      totalPages,
      hasMore
    } = await roomRedis.getPaginatedRooms({ 
      page, 
      pageSize, 
      sortField, 
      sortOrder, 
      search: req.query.search 
    });

    // 안전한 응답 데이터 구성 
    const safeRooms = rooms.map(room => {
      const creator = room.creator || { _id: 'unknown', name: '알 수 없음', email: '' };
      const participants = Array.isArray(room.participants) ? room.participants : [];
    
      return {
        _id: room._id || 'unknown',
        name: room.name || '제목 없음',
        hasPassword: !!room.hasPassword,
        creator: {
          _id: creator._id || 'unknown',
          name: creator.name || '알 수 없음',
          email: creator.email || ''
        },
        participants: participants
          .filter(p => p && p._id)
          .map(p => ({
            _id: p._id,
            name: p.name || '알 수 없음',
            email: p.email || ''
          })),
        participantsCount: participants.length,
        createdAt: new Date(Number(room.createdAt)) || new Date(),
        isCreator: (creator._id || '') === req.user.id
      };
    }).filter(room => room !== null);    

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

    // 수정 시작
    const room = await roomRedis.createRoom({ name: name.trim(), creator: req.user.id, password });
    const creator = await User.findById(room.creator).select('name email');

    if (io) {
      io.to('room-list').emit('roomCreated', {
        _id: room.roomId,
        name: room.name,
        creator,
        participants: [creator],
        hasPassword: !!password,
        createdAt: new Date(Number(room.createdAt))
      });
    }
    
    res.status(201).json({
      success: true,
      data: {
        _id: room.roomId,
        name: room.name,
        creator,
        participants: [creator],
        hasPassword: !!password,
        createdAt: new Date(Number(room.createdAt))
      }
    });
    // 수정 끝
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
    const room = await roomRedis.getRoom(req.params.roomId);

    if (!room) {
      return res.status(404).json({
        success: false,
        message: '채팅방을 찾을 수 없습니다.'
      });
    }

    const creator = await User.findById(room.creator).select('name email');
    const participantIds = await roomRedis.getParticipants(req.params.roomId);
    const participants = await User.find({ _id: { $in: participantIds } }).select('name email');


    res.json({
      success: true,
      data: {
        _id: req.params.roomId,
        name: room.name,
        creator,
        participants,
        hasPassword: room.hasPassword === 'true',
        createdAt: new Date(Number(room.createdAt))
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
    const room = await roomRedis.getRoom(req.params.roomId);
    
    if (!room) {
      return res.status(404).json({
        success: false,
        message: '채팅방을 찾을 수 없습니다.'
      });
    }

    // 비밀번호 확인
    if (room.hasPassword === 'true') {
      const isPasswordValid = await roomRedis.checkPassword(req.params.roomId, password);
      if (!isPasswordValid) {
        return res.status(403).json({
          success: false,
          message: '비밀번호가 일치하지 않습니다.'
        });
      }
    }

    // 참여자 목록에 추가
    await roomRedis.addParticipant(req.params.roomId, req.user.id);
    const creator = room.creator 
  ? await User.findById(room.creator).select('name email') 
  : null;
    const participants = await User.find({ _id: { $in: room.participants } }).select('name email');

    // Socket.IO를 통해 참여자 업데이트 알림
    if (io) {
      io.to(req.params.roomId).emit('roomUpdate', {
        _id: req.params.roomId,
        name: room.name,
        creator,
        participants,
        hasPassword: room.hasPassword === 'true',
        createdAt: new Date(Number(room.createdAt))
      });
    }

    res.json({
      success: true,
      data: {
        _id: req.params.roomId,
        name: room.name,
        creator,
        participants,
        hasPassword: room.hasPassword === 'true',
        createdAt: new Date(Number(room.createdAt))
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