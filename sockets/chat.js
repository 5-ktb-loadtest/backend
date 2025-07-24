const redisDataLayer = require('../data/redisDataLayer');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/keys');
const redisClient = require('../utils/redisClient');
const SessionService = require('../services/sessionService');
const aiService = require('../services/aiService');

const getConnectedUserKey = (userId) => `connected_user:${userId}`;
const getUserRoomKey = (userId) => `user_room:${userId}`;
const getRoomUsersKey = (roomId) => `room_users:${roomId}`;

module.exports = function (io) {
  const messageQueues = new Map();
  const messageLoadRetries = new Map();
  const BATCH_SIZE = 30;
  const LOAD_DELAY = 300;
  const MAX_RETRIES = 3;
  const MESSAGE_LOAD_TIMEOUT = 10000;
  const RETRY_DELAY = 2000;
  const DUPLICATE_LOGIN_TIMEOUT = 10000;

  // 로깅 유틸리티 함수
  const logDebug = (action, data) => {
    console.debug(`[Socket.IO] ${action}:`, {
      ...data,
      timestamp: new Date().toISOString()
    });
  };

  // 메시지 일괄 로드 함수 개선
  const loadMessages = async (socket, roomId, before, limit = BATCH_SIZE) => {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Message loading timed out'));
      }, MESSAGE_LOAD_TIMEOUT);
    });
  
    try {
      const beforeTimestamp = before ? new Date(before).getTime() : null;
      const result = await Promise.race([
        redisDataLayer.getMessagesForRoom(roomId, beforeTimestamp, limit),
        timeoutPromise
      ]);
  
      const { messages, hasMore, oldestTimestamp } = result;
  
      // sender 정보 로딩 추가
      const enhancedMessages = await Promise.all(messages.map(async (msg) => {
        // sender 정보 로딩
        if (msg.sender && msg.sender !== 'system') {
          const senderUser = await redisDataLayer.getUserById(msg.sender);
          msg.sender = senderUser ? {
            _id: senderUser.id,
            name: senderUser.name,
            email: senderUser.email,
            profileImage: senderUser.profileImage
          } : { _id: 'unknown', name: '알 수 없음', email: '', profileImage: '' };
        }
  
        // file 정보 로딩 (필요한 경우)
        if (msg.type === 'file' && msg.file) {
          const file = await redisDataLayer.getFile(msg.file);
          if (file) {
            msg.file = {
              _id: file._id,
              filename: file.filename,
              originalname: file.originalname,
              mimetype: file.mimetype,
              size: file.size
            };
          }
        }
  
        return msg;
      }));
  
      // 읽음 상태 업데이트
      if (messages.length > 0 && socket.user) {
        const messageIds = messages.map(msg => msg._id);
        await redisDataLayer.markMessagesAsRead(socket.user.id, roomId, messageIds);
      }
  
      return { 
        messages: enhancedMessages, 
        hasMore, 
        oldestTimestamp: oldestTimestamp ? new Date(oldestTimestamp) : null 
      };
    } catch (error) {
      if (error.message === 'Message loading timed out') {
        logDebug('message load timeout', { roomId, before, limit });
      } else {
        console.error('Load messages error:', {
          error: error.message,
          stack: error.stack,
          roomId,
          before,
          limit,
        });
      }
      throw error;
    }
  };


  // 재시도 로직을 포함한 메시지 로드 함수
  const loadMessagesWithRetry = async (socket, roomId, before, retryCount = 0) => {
    const retryKey = `${roomId}:${socket.user.id}`;

    try {
      if (messageLoadRetries.get(retryKey) >= MAX_RETRIES) {
        throw new Error('최대 재시도 횟수를 초과했습니다.');
      }

      const result = await loadMessages(socket, roomId, before);
      messageLoadRetries.delete(retryKey);
      return result;

    } catch (error) {
      const currentRetries = messageLoadRetries.get(retryKey) || 0;

      if (currentRetries < MAX_RETRIES) {
        messageLoadRetries.set(retryKey, currentRetries + 1);
        const delay = Math.min(RETRY_DELAY * Math.pow(2, currentRetries), 10000);

        logDebug('retrying message load', {
          roomId,
          retryCount: currentRetries + 1,
          delay
        });

        await new Promise(resolve => setTimeout(resolve, delay));
        return loadMessagesWithRetry(socket, roomId, before, currentRetries + 1);
      }

      messageLoadRetries.delete(retryKey);
      throw error;
    }
  };

  // 중복 로그인 처리 함수
  const handleDuplicateLogin = async (existingSocket, newSocket) => {
    try {
      // 기존 연결에 중복 로그인 알림
      existingSocket.emit('duplicate_login', {
        type: 'new_login_attempt',
        deviceInfo: newSocket.handshake.headers['user-agent'],
        ipAddress: newSocket.handshake.address,
        timestamp: Date.now()
      });

      // 타임아웃 설정
      return new Promise((resolve) => {
        setTimeout(async () => {
          try {
            // 기존 세션 종료
            existingSocket.emit('session_ended', {
              reason: 'duplicate_login',
              message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
            });

            // 기존 연결 종료
            existingSocket.disconnect(true);
            resolve();
          } catch (error) {
            console.error('Error during session termination:', error);
            resolve();
          }
        }, DUPLICATE_LOGIN_TIMEOUT);
      });
    } catch (error) {
      console.error('Duplicate login handling error:', error);
      throw error;
    }
  };

  // 미들웨어: 소켓 연결 시 인증 처리
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      const sessionId = socket.handshake.auth.sessionId;

      if (!token || !sessionId) {
        return next(new Error('Authentication error'));
      }

      const decoded = jwt.verify(token, jwtSecret);
      if (!decoded?.user?.id) {
        return next(new Error('Invalid token'));
      }

      // Redis에서 기존 소켓ID 확인
      const existingSocketId = await redisClient.get(getConnectedUserKey(decoded.user.id));
      if (existingSocketId) {
        const existingSocket = io.sockets.sockets.get(existingSocketId);
        if (existingSocket) {
          // 중복 로그인 처리
          await handleDuplicateLogin(existingSocket, socket);
        }
      }

      const validationResult = await SessionService.validateSession(decoded.user.id, sessionId);
      if (!validationResult.isValid) {
        console.error('Session validation failed:', validationResult);
        return next(new Error(validationResult.message || 'Invalid session'));
      }

      const user = await redisDataLayer.getUserById(decoded.user.id);
      if (!user) {
        return next(new Error('User not found'));
      }

      socket.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        sessionId: sessionId,
        profileImage: user.profileImage
      };

      await SessionService.updateLastActivity(decoded.user.id);
      next();
    } catch (error) {
      console.error('Socket authentication error:', error);

      if (error.name === 'TokenExpiredError') {
        return next(new Error('Token expired'));
      }

      if (error.name === 'JsonWebTokenError') {
        return next(new Error('Invalid token'));
      }

      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    logDebug('socket connected', {
      socketId: socket.id,
      userId: socket.user?.id,
      userName: socket.user?.name
    });

    // 소켓 연결 시 Redis에 연결 정보 저장
    if (socket.user) {
      redisClient.set(getConnectedUserKey(socket.user.id), socket.id);
    }

    // 이전 연결이 있는지 확인
    // redis로 변경
    const previousSocketId = redisClient.get(getConnectedUserKey(socket.user.id));
    if (previousSocketId && previousSocketId !== socket.id) {
      const previousSocket = io.sockets.sockets.get(previousSocketId);
      if (previousSocket) {
        // 이전 연결에 중복 로그인 알림
        previousSocket.emit('duplicate_login', {
          type: 'new_login_attempt',
          deviceInfo: socket.handshake.headers['user-agent'],
          ipAddress: socket.handshake.address,
          timestamp: Date.now()
        });

        // 이전 연결 종료 처리
        setTimeout(() => {
          previousSocket.emit('session_ended', {
            reason: 'duplicate_login',
            message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
          });
          previousSocket.disconnect(true);
        }, DUPLICATE_LOGIN_TIMEOUT);
      }
    }

    // 이전 메시지 로딩 처리 개선
    socket.on('fetchPreviousMessages', async ({ roomId, before }) => {
      const queueKey = `${roomId}:${socket.user.id}`;

      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        if (messageQueues.get(queueKey)) {
          logDebug('message load skipped - already loading', {
            roomId,
            userId: socket.user.id
          });
          return;
        }

        messageQueues.set(queueKey, true);
        socket.emit('messageLoadStart');

        const result = await loadMessagesWithRetry(socket, roomId, before);

        logDebug('previous messages loaded', {
          roomId,
          messageCount: result.messages.length,
          hasMore: result.hasMore,
          oldestTimestamp: result.oldestTimestamp
        });

        socket.emit('previousMessagesLoaded', result);

      } catch (error) {
        console.error('Fetch previous messages error:', error);
        socket.emit('error', {
          type: 'LOAD_ERROR',
          message: error.message || '이전 메시지를 불러오는 중 오류가 발생했습니다.'
        });
      } finally {
        setTimeout(() => {
          messageQueues.delete(queueKey);
        }, LOAD_DELAY);
      }
    });

    // 채팅방 입장 처리 개선
    socket.on('joinRoom', async (roomId) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        // Redis에서 현재 방 확인
        const currentRoom = await redisClient.get(getUserRoomKey(socket.user.id));
        if (currentRoom === roomId) {
          logDebug('already in room', {
            userId: socket.user.id,
            roomId
          });
          socket.emit('joinRoomSuccess', { roomId });
          return;
        }

        // 기존 방에서 나가기
        if (currentRoom) {
          logDebug('leaving current room', {
            userId: socket.user.id,
            roomId: currentRoom
          });
          socket.leave(currentRoom);
          const pipeline = redisClient.cluster.pipeline();
          pipeline.del(getUserRoomKey(socket.user.id));
          pipeline.srem(getRoomUsersKey(currentRoom), socket.user.id);
          await pipeline.exec();

          socket.to(currentRoom).emit('userLeft', {
            userId: socket.user.id,
            name: socket.user.name
          });
        }

        
        // 방 참여자 목록에 추가
        let room = await redisDataLayer.getRoomById(roomId);
        if (!room) {
          throw new Error('채팅방을 찾을 수 없습니다.');
        }

        // 해당 유저 참가자 목록에 추가
        if (!room.participants.includes(socket.user.id)) {
          const [_, room] = await Promise.all([
            redisDataLayer.addParticipant(roomId, socket.user.id),
            redisDataLayer.getRoomById(roomId)
          ]);
        }

        socket.join(roomId);

        // 입장 메시지 생성
        const joinMsgId = await redisDataLayer.createMessage(roomId, {
          type: 'system',
          content: `${socket.user.name}님이 입장하였습니다.`,
          sender: 'system'
        });
        const joinMessage = await redisDataLayer.getMessage(joinMsgId);

        // 초기 메시지 로드
        const messageLoadResult = await loadMessages(socket, roomId);
        const { messages, hasMore, oldestTimestamp } = messageLoadResult;

        // 활성 스트리밍 메시지 조회 (삭제)
        // const activeStreams = Array.from(streamingSessions.values())
        //   .filter(session => session.room === roomId)
        //   .map(session => ({
        //     _id: session.messageId,
        //     type: 'ai',
        //     aiType: session.aiType,
        //     content: session.content,
        //     timestamp: session.timestamp,
        //     isStreaming: true
        //   }));
        
        const participantsData = await Promise.all(
          room.participants.map(async (pid) => {
            const pu = await redisDataLayer.getUserById(pid);
            if (pu) {
              return { _id: pu.id, name: pu.name, email: pu.email, profileImage: pu.profileImage, isAI: false };
            }
            return null;
          })
        );
        const participants = participantsData.filter(Boolean);

        socket.emit('joinRoomSuccess', {
          roomId,
          participants,
          messages,
          hasMore,
          oldestTimestamp,
        });

        io.to(roomId).emit('message', joinMessage);
        io.to(roomId).emit('participantsUpdate', participants);

        logDebug('user joined room', {
          userId: socket.user.id,
          roomId,
          messageCount: messages.length,
          hasMore
        });

      } catch (error) {
        console.error('Join room error:', error);
        socket.emit('joinRoomError', {
          message: error.message || '채팅방 입장에 실패했습니다.'
        });
      }
    });
    // 백엔드 소켓 핸들러의 chatMessage 부분만 수정
    // 기존 코드에서 이 부분만 교체하세요

    // 메시지 전송 처리
    socket.on('chatMessage', async (messageData) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        if (!messageData) {
          throw new Error('메시지 데이터가 없습니다.');
        }

        const { room, type, content, fileData } = messageData;

        if (!room) {
          throw new Error('채팅방 정보가 없습니다.');
        }

        // 세션 유효성 재확인
        // const sessionValidation = await SessionService.validateSession(
        //   socket.user.id, 
        //   socket.user.sessionId
        // );

        // if (!sessionValidation.isValid) {
        //   throw new Error('세션이 만료되었습니다. 다시 로그인해주세요.');
        // }


        // AI 멘션 확인
        const aiMentions = extractAIMentions(content);
        let message;

        // 메시지 타입별 처리
        switch (type) {
          case 'file':
            if (!fileData || !fileData._id) {
              throw new Error('파일 데이터가 올바르지 않습니다.');
            }

            let file;

            // S3 파일 처리
            if (fileData.isS3File || fileData.s3Uploaded || fileData.alreadyUploaded) {
              console.log('Processing S3 file:', {
                fileId: fileData._id,
                filename: fileData.filename,
                url: fileData.url,
                isS3File: true
              });

              // S3 파일 메타데이터 직접 생성/조회
              try {
                // 기존 파일 레코드가 있는지 확인
                file = await FileModel.findById(fileData._id);

                if (!file) {
                  // S3 파일 메타데이터 생성
                  file = new File({
                    _id: fileData._id,
                    filename: fileData.filename,
                    originalname: fileData.originalname,
                    mimetype: fileData.mimetype,
                    size: fileData.size,
                    path: fileData.url, // S3 URL
                    url: fileData.url,   // S3 URL
                    destination: 'S3',
                    fieldname: 'file',
                    encoding: '7bit',
                    user: socket.user.id, // 업로드한 사용자
                    // S3 특화 필드들
                    key: fileData.key || fileData.s3Key,
                    bucket: fileData.bucket || process.env.S3_BUCKET_NAME,
                    uploadedAt: fileData.uploadedAt ? new Date(fileData.uploadedAt) : new Date(),
                    isS3File: true
                  });

                  await file.save();
                  console.log('S3 file metadata saved:', {
                    fileId: file._id,
                    url: file.url,
                    originalname: file.originalname
                  });
                }
              } catch (fileError) {
                console.error('S3 file processing error:', fileError);
                throw new Error('S3 파일 처리 중 오류가 발생했습니다.');
              }

            } else {
              // 로컬 파일 처리 (기존 로직)
              console.log('Processing local file:', fileData._id);

              file = await File.findOne({
                _id: fileData._id,
                user: socket.user.id
              });

              if (!file) {
                throw new Error('파일을 찾을 수 없거나 접근 권한이 없습니다.');
              }
            }

            // 파일 메시지 생성
            message = new Message({
              room,
              sender: socket.user.id,
              type: 'file',
              file: file._id,
              content: content || '',
              timestamp: new Date(),
              reactions: {},
              metadata: {
                fileType: file.mimetype,
                fileSize: file.size,
                originalName: file.originalname,
                isS3File: file.isS3File || false,
                s3Key: file.key,
                s3Bucket: file.bucket
              }
            });

            console.log('File message created:', {
              messageId: message._id,
              fileId: file._id,
              filename: file.filename,
              isS3File: file.isS3File
            });

            break;

          case 'text':
            if (!finalContent || finalContent.length === 0) return;
            messageId = await redisDataLayer.createMessage(room, {
              type: 'text',
              sender: socket.user.id,
              content: finalContent
            });
            break;

          default:
            throw new Error('지원하지 않는 메시지 타입입니다.');
        }

        // 메시지 저장
        // await message.save();
        const msg = await redisDataLayer.getMessage(messageId);
        if (!msg) throw new Error('메시지 생성 중 오류 발생');
        // 메시지 populate
        const senderUser = await redisDataLayer.getUserById(msg.sender);
        console.log('Sender User:', senderUser);
        msg.sender = senderUser ? {
          _id: senderUser.id,
          name: senderUser.name,
          email: senderUser.email,
          profileImage: senderUser.profileImage
        } : { _id: 'unknown', name: '알 수 없음', email: '', profileImage: '' };

        if (msg.type === 'file' && msg.file) {
          const f = await redisDataLayer.getFile(msg.file);
          if (f) {
            msg.file = {
              _id: f._id,
              filename: f.filename,
              originalname: f.originalname,
              mimetype: f.mimetype,
              size: f.size
            };
          }
        }
        // 브로드캐스트
        io.to(room).emit('message', msg);

        // AI 멘션이 있는 경우 AI 응답 생성
        if (aiMentions.length > 0) {
          for (const ai of aiMentions) {
            const query = content.replace(new RegExp(`@${ai}\\b`, 'g'), '').trim();
            await handleAIResponse(io, room, ai, query);
          }
        }

        await SessionService.updateLastActivity(socket.user.id);


      } catch (error) {
        console.error('Message handling error:', error);
        socket.emit('error', {
          code: error.code || 'MESSAGE_ERROR',
          message: error.message || '메시지 전송 중 오류가 발생했습니다.'
        });
      }
    });

    // 채팅방 퇴장 처리
    socket.on('leaveRoom', async (roomId) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        // 실제로 해당 방에 참여 중인지 먼저 확인
        const currentRoom = await redisClient.get(getUserRoomKey(socket.user.id));
        if (!currentRoom || currentRoom !== roomId) {
          console.log(`User ${socket.user.id} is not in room ${roomId}`);
          return;
        }

        socket.leave(roomId);
        const pipeline = redisClient.cluster.pipeline();
        pipeline.del(getUserRoomKey(socket.user.id));
        pipeline.srem(getRoomUsersKey(roomId), socket.user.id);
        await pipeline.exec();

        // 퇴장 메시지 생성 및 저장
        const leaveMsgId = await redisDataLayer.createMessage(roomId, {
          type: 'system',
          content: `${socket.user.name}님이 퇴장하였습니다.`,
          sender: 'system'
        });
        const leaveMessage = await redisDataLayer.getMessage(leaveMsgId);

        // 참가자 목록 업데이트 - profileImage 포함
        await redisDataLayer.removeParticipant(roomId, socket.user.id);
        const updatedRoom = await redisDataLayer.getRoomById(roomId);

        // 스트리밍 세션 정리 (퇴장, disconnect 등에서)
        // for (const [messageId, session] of streamingSessions.entries()) {
        //   if (session.room === roomId && session.userId === socket.user.id) {
        //     streamingSessions.delete(messageId);
        //   }
        // }

        // 메시지 큐 정리
        const queueKey = `${roomId}:${socket.user.id}`;
        messageQueues.delete(queueKey);
        messageLoadRetries.delete(queueKey);

        let participants = [];
        if (updatedRoom) {
          participants = (await Promise.all(
            updatedRoom.participants.map(async (pid) => {
              const pu = await redisDataLayer.getUserById(pid);
              if (pu) {
                return { _id: pu.id, name: pu.name, email: pu.email, profileImage: pu.profileImage };
              }
              return null;
            })
          )).filter(Boolean);
        }

        // 이벤트 발송
        io.to(roomId).emit('message', leaveMessage);
        io.to(roomId).emit('participantsUpdate', participants);

        console.log(`User ${socket.user.id} left room ${roomId} successfully`);

      } catch (error) {
        console.error('Leave room error:', error);
        socket.emit('error', {
          message: error.message || '채팅방 퇴장 중 오류가 발생했습니다.'
        });
      }
    });

    // 연결 해제 처리
    socket.on('disconnect', async (reason) => {
      if (!socket.user) return;

      try {
        const userId = socket.user.id;
        // 연결 정보 삭제
        const connectedSocketId = await redisClient.get(getConnectedUserKey(socket.user.id));
        if (connectedSocketId === socket.id) {
          await redisClient.del(getConnectedUserKey(socket.user.id));
        }
        // 방 정보 삭제
        const roomId = await redisClient.get(getUserRoomKey(socket.user.id));
        if (roomId) {
          const pipeline = redisClient.cluster.pipeline();
          pipeline.del(getUserRoomKey(socket.user.id));
          pipeline.srem(getRoomUsersKey(roomId), socket.user.id);
          await pipeline.exec();
        }

        // 메시지 큐 정리
        const userQueues = Array.from(messageQueues.keys())
          .filter(key => key.endsWith(`:${socket.user.id}`));
        userQueues.forEach(key => {
          messageQueues.delete(key);
          messageLoadRetries.delete(key);
        });
        
        // 스트리밍 세션 정리
        // for (const [messageId, session] of streamingSessions.entries()) {
        //   if (session.userId === socket.user.id) {
        //     streamingSessions.delete(messageId);
        //   }
        // }

        // 현재 방에서 자동 퇴장 처리
        if (roomId) {
          // 다른 디바이스로 인한 연결 종료가 아닌 경우에만 처리
          if (reason !== 'client namespace disconnect' && reason !== 'duplicate_login') {
            const leaveMsgId = await redisDataLayer.createMessage(roomId, {
              type: 'system',
              content: `${socket.user.name}님이 연결이 끊어졌습니다.`,
              sender: 'system'
            });
            const leaveMessage = await redisDataLayer.getMessage(leaveMsgId);

            await redisDataLayer.removeParticipant(roomId, socket.user.id);
            const updatedRoom = await redisDataLayer.getRoomById(roomId);
            if (updatedRoom) {
              const participantsData = (
                await Promise.all(
                  updatedRoom.participants.map(async (pid) => {
                    const pu = await redisDataLayer.getUserById(pid);
                    if (pu) {
                      return { _id: pu.id, name: pu.name, email: pu.email, profileImage: pu.profileImage };
                    }
                    return null;
                  })
                )
              ).filter(Boolean);
  
              io.to(roomId).emit('message', leaveMessage);
              io.to(roomId).emit('participantsUpdate', participantsData);
            }
          }
        }

        logDebug('user disconnected', {
          reason,
          userId: socket.user.id,
          socketId: socket.id,
          lastRoom: roomId
        });

      } catch (error) {
        console.error('Disconnect handling error:', error);
      }
    });

    // 세션 종료 또는 로그아웃 처리
    socket.on('force_login', async ({ token }) => {
      try {
        if (!socket.user) return;

        // 강제 로그아웃을 요청한 클라이언트의 세션 정보 확인
        const decoded = jwt.verify(token, jwtSecret);
        if (!decoded?.user?.id || decoded.user.id !== socket.user.id) {
          throw new Error('Invalid token');
        }

        // 세션 종료 처리
        socket.emit('session_ended', {
          reason: 'force_logout',
          message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
        });

        // 연결 종료
        socket.disconnect(true);

      } catch (error) {
        console.error('Force login error:', error);
        socket.emit('error', {
          message: '세션 종료 중 오류가 발생했습니다.'
        });
      }
    });

    // 메시지 읽음 상태 처리
    socket.on('markMessagesAsRead', async ({ roomId, messageIds }) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        if (!Array.isArray(messageIds) || messageIds.length === 0) {
          return;
        }

        // 읽음 상태 업데이트
        await redisDataLayer.markMessagesAsRead(socket.user.id, roomId, messageIds);

        socket.to(roomId).emit('messagesRead', {
          userId: socket.user.id,
          messageIds
        });

      } catch (error) {
        console.error('Mark messages as read error:', error);
        socket.emit('error', {
          message: '읽음 상태 업데이트 중 오류가 발생했습니다.'
        });
      }
    });

    // 리액션 처리
    socket.on('messageReaction', async ({ messageId, reaction, type }) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        const msg = await redisDataLayer.getMessage(messageId);
        if (!msg) {
          throw new Error('메시지를 찾을 수 없습니다.');
        }

        // 리액션 추가/제거
        if (type === 'add') {
          await redisDataLayer.addReaction(messageId, reaction, socket.user.id);
        } else if (type === 'remove') {
          await redisDataLayer.removeReaction(messageId, reaction, socket.user.id);
        }

        const reactions = await redisDataLayer.getReactions(messageId);
        // 업데이트된 리액션 정보 브로드캐스트
        io.to(msg.room).emit('messageReactionUpdate', {
          messageId,
          reactions
        });

      } catch (error) {
        console.error('Message reaction error:', error);
        socket.emit('error', {
          message: error.message || '리액션 처리 중 오류가 발생했습니다.'
        });
      }
    });
  });

  // AI 멘션 추출 함수
  function extractAIMentions(content) {
    if (!content) return [];

    const aiTypes = ['wayneAI', 'consultingAI'];
    const mentions = new Set();
    const mentionRegex = /@(wayneAI|consultingAI)\b/g;
    let match;

    while ((match = mentionRegex.exec(content)) !== null) {
      if (aiTypes.includes(match[1])) {
        mentions.add(match[1]);
      }
    }

    return Array.from(mentions);
  }

  // AI 응답 처리 함수 개선
  async function handleAIResponse(io, room, aiName, query) {
    const messageId = `${aiName}-${Date.now()}`;
    const timestamp = new Date();

    // 초기 상태 전송
    io.to(room).emit('aiMessageStart', {
      messageId,
      aiType: aiName,
      timestamp
    });

    try {
      // AI 응답 생성 및 스트리밍
      await aiService.generateResponse(query, aiName, {
        onStart: () => {
          logDebug('AI generation started', {
            messageId,
            aiType: aiName
          });
        },
      
        onComplete: async (finalContent) => {
          // AI 메시지 저장
          const aiMsgId = await redisDataLayer.createMessage(room, {
            type: 'ai',
            aiType: aiName,
            content: finalContent.content,
            metadata: {
              query,
              generationTime: Date.now() - timestamp,
              completionTokens: finalContent.completionTokens,
              totalTokens: finalContent.totalTokens
            }
          });

          const aiMessage = await redisDataLayer.getMessage(aiMsgId);

          // 완료 메시지 전송
          io.to(room).emit('aiMessageComplete', {
            messageId,
            _id: aiMessage._id,
            content: finalContent.content,
            aiType: aiName,
            timestamp: new Date(),
            isComplete: true,
            query,
            reactions: {}
          });

          logDebug('AI response completed', {
            messageId,
            aiType: aiName,
            contentLength: finalContent.content.length,
            generationTime: Date.now() - timestamp
          });
        },
        onError: (error) => {
          console.error('AI response error:', error);

          io.to(room).emit('aiMessageError', {
            messageId,
            error: error.message || 'AI 응답 생성 중 오류가 발생했습니다.',
            aiType: aiName
          });

          logDebug('AI response error', {
            messageId,
            aiType: aiName,
            error: error.message
          });
        }
      });
    } catch (error) {
      console.error('AI service error:', error);

      io.to(room).emit('aiMessageError', {
        messageId,
        error: error.message || 'AI 서비스 오류가 발생했습니다.',
        aiType: aiName
      });
    }
  }

  return io;
};