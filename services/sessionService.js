const redisClient = require('../utils/redisClient');
const crypto = require('crypto');

class SessionService {
  static SESSION_TTL = 24 * 60 * 60; // 24 hours
  static SESSION_PREFIX = 'session:';
  static SESSION_ID_PREFIX = 'sessionId:';
  static USER_SESSIONS_PREFIX = 'user_sessions:';
  static ACTIVE_SESSION_PREFIX = 'active_session:';

  // 데이터 직렬화 헬퍼 메서드
  static _serialize(data) {
    if (typeof data === 'object') {
      return JSON.stringify(data);
    }
    return String(data);
  }

  // 데이터 역직렬화 헬퍼 메서드
  static _deserialize(data) {
    try {
      // 이미 객체인 경우 처리
      if (typeof data === 'object') {
        return data;
      }
      return JSON.parse(data);
    } catch (error) {
      // JSON 파싱 실패 시 원본 반환
      return data;
    }
  }

  static async createSession(userId, metadata = {}) {
    try {
      if (!userId) {
        throw new Error('userId is required');
      }

      await this.removeAllUserSessions(userId);

      const sessionId = this.generateSessionId();
      const sessionData = {
        userId,
        sessionId,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        metadata: {
          userAgent: metadata.userAgent || '',
          ipAddress: metadata.ipAddress || '',
          deviceInfo: metadata.deviceInfo || '',
          ...metadata
        }
      };

      const serializedData = this._serialize(sessionData);

      await Promise.all([
        redisClient.set(this.getSessionKey(userId), serializedData, 'EX', this.SESSION_TTL),
        redisClient.set(this.getSessionIdKey(sessionId), String(userId), 'EX', this.SESSION_TTL),
        redisClient.set(this.getActiveSessionKey(userId), sessionId, 'EX', this.SESSION_TTL),
        redisClient.set(this.getUserSessionsKey(userId), sessionId, 'EX', this.SESSION_TTL)
      ]);

      return {
        sessionId,
        expiresIn: this.SESSION_TTL,
        sessionData
      };

    } catch (error) {
      console.error('Session creation error:', error);
      throw new Error('세션 생성 중 오류가 발생했습니다.');
    }
  }

  static async getActiveSession(userId) {
    try {
      if (!userId) {
        throw new Error('userId is required');
      }

      const [sessionId, sessionDataStr] = await Promise.all([
        redisClient.get(this.getActiveSessionKey(userId)),
        redisClient.get(this.getSessionKey(userId))
      ]);

      if (!sessionId || !sessionDataStr) {
        return null;
      }

      const sessionData = this._deserialize(sessionDataStr);
      if (!sessionData || typeof sessionData !== 'object') {
        console.error('Invalid session data format:', sessionDataStr);
        return null;
      }

      return {
        ...sessionData,
        userId,
        sessionId
      };
    } catch (error) {
      console.error('Get active session error:', error);
      return null;
    }
  }

  static async validateSession(userId, sessionId) {
    try {
      if (!userId || !sessionId) {
        return this._createErrorResponse('INVALID_PARAMETERS', '유효하지 않은 세션 파라미터');
      }

      const [activeSessionId, sessionDataStr] = await Promise.all([
        redisClient.get(this.getActiveSessionKey(userId)),
        redisClient.get(this.getSessionKey(userId))
      ]);

      if (!activeSessionId || activeSessionId !== sessionId) {
        await this.removeAllUserSessions(userId);
        return this._createErrorResponse('INVALID_SESSION', '다른 기기에서 로그인되어 현재 세션이 만료되었습니다.');
      }

      const sessionData = this._deserialize(sessionDataStr);
      if (!sessionData || typeof sessionData !== 'object') {
        console.error('Invalid session data format:', sessionDataStr);
        await this.removeAllUserSessions(userId);
        return this._createErrorResponse('INVALID_SESSION_DATA', '세션 데이터가 손상되었습니다.');
      }

      if (Date.now() - sessionData.lastActivity > this.SESSION_TTL * 1000) {
        await this.removeAllUserSessions(userId);
        return this._createErrorResponse('SESSION_EXPIRED', '세션이 만료되었습니다.');
      }

      sessionData.lastActivity = Date.now();
      const serializedData = this._serialize(sessionData);
      
      await Promise.all([
        redisClient.set(this.getSessionKey(userId), serializedData, 'EX', this.SESSION_TTL),
        redisClient.set(this.getActiveSessionKey(userId), sessionId, 'EX', this.SESSION_TTL),
        redisClient.set(this.getUserSessionsKey(userId), sessionId, 'EX', this.SESSION_TTL),
        redisClient.set(this.getSessionIdKey(sessionId), String(userId), 'EX', this.SESSION_TTL)
      ]);

      return {
        isValid: true,
        session: sessionData
      };

    } catch (error) {
      console.error('Session validation error:', error);
      return this._createErrorResponse('VALIDATION_ERROR', '세션 검증 중 오류가 발생했습니다.');
    }
  }

  static async removeAllUserSessions(userId) {
    try {
      const oldSessionId = await redisClient.get(this.getUserSessionsKey(userId));
      
      const deletePromises = [
        redisClient.del(this.getSessionKey(userId)),
        redisClient.del(this.getUserSessionsKey(userId)),
        redisClient.del(this.getActiveSessionKey(userId))
      ];

      if (oldSessionId) {
        deletePromises.push(redisClient.del(this.getSessionIdKey(oldSessionId)));
      }

      await Promise.all(deletePromises);
      return true;
    } catch (error) {
      console.error('Remove all user sessions error:', error);
      return false;
    }
  }

  static async updateLastActivity(userId) {
    try {
      const sessionKey = this.getSessionKey(userId);
      const sessionDataStr = await redisClient.get(sessionKey);

      if (!sessionDataStr) {
        return false;
      }

      const sessionData = this._deserialize(sessionDataStr);
      if (!sessionData || typeof sessionData !== 'object') {
        return false;
      }

      sessionData.lastActivity = Date.now();
      await redisClient.set(sessionKey, this._serialize(sessionData), 'EX', this.SESSION_TTL);
      return true;
    } catch (error) {
      console.error('Update last activity error:', error);
      return false;
    }
  }

  static _createErrorResponse(error, message) {
    return {
      isValid: false,
      error,
      message
    };
  }

  static generateSessionId() {
    return crypto.randomBytes(32).toString('hex');
  }

  static getSessionKey(userId) {
    return `${this.SESSION_PREFIX}${userId}`;
  }

  static getSessionIdKey(sessionId) {
    return `${this.SESSION_ID_PREFIX}${sessionId}`;
  }

  static getUserSessionsKey(userId) {
    return `${this.USER_SESSIONS_PREFIX}${userId}`;
  }

  static getActiveSessionKey(userId) {
    return `${this.ACTIVE_SESSION_PREFIX}${userId}`;
  }
}

module.exports = SessionService;