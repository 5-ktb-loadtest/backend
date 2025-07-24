// utils/redisClient.js
const Redis = require('ioredis');  // ioredis로 변경

class RedisClient {
  constructor() {
    this.cluster = null;
    this.isConnected = false;
    this.init();
  }

  init() {
    try {
      // 환경변수에서 클러스터 노드 정보 읽기
      const clusterNodes = (process.env.REDIS_CLUSTER_NODES || 'localhost:7000')
        .split(',')
        .map(addr => {
          const [host, port] = addr.trim().split(':');
          return { host, port: Number(port) };
        });

      console.log('클러스터 노드 목록:', clusterNodes);

      this.cluster = new Redis.Cluster(clusterNodes, {
        redisOptions: {
          connectTimeout: 10000,
          maxRetriesPerRequest: 3
        },
        clusterRetryStrategy: (times) => {
          if (times > 3) return null;
          return Math.min(times * 1000, 3000);
        },
        enableReadyCheck: true,
        scaleReads: 'slave',
        maxRedirections: 3,
        retryDelayOnFailover: 1000
      });

      this.cluster.on('connect', () => {
        console.log('Redis Cluster Connected');
        this.isConnected = true;
      });

      this.cluster.on('error', (err) => {
        console.error('Redis Cluster Error:', err);
        this.isConnected = false;
      });

      this.cluster.on('node:error', (err) => {
        console.error('Redis Cluster Node Error:', err);
      });

    } catch (error) {
      console.error('Redis Cluster Initialization Error:', error);
      throw error;
    }
  }

  async get(key) {
    try {
      const result = await this.cluster.get(key);
      if (!result) return null;
      try {
        return JSON.parse(result);
      } catch {
        return result;
      }
    } catch (error) {
      console.error('Redis get error:', error);
      return null;
    }
  }

  async set(key, value, options = {}) {
    try {
      const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
      if (options.ttl) {
        return await this.cluster.setex(key, options.ttl, stringValue);
      }
      return await this.cluster.set(key, stringValue);
    } catch (error) {
      console.error('Redis set error:', error);
      return false;
    }
  }

  async del(key) {
    try {
      return await this.cluster.del(key);
    } catch (error) {
      console.error('Redis del error:', error);
      return false;
    }
  }

  async hSet(key, value) {
    try {
      const hash = typeof value === 'object' ? 
        Object.entries(value).reduce((acc, [k, v]) => {
          acc[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
          return acc;
        }, {}) : 
        value;
      return await this.cluster.hset(key, hash);
    } catch (error) {
      console.error('Redis hSet error:', error);
      return false;
    }
  }

  async hGet(key, field) {
    try {
      return await this.cluster.hget(key, field);
    } catch (error) {
      console.error('Redis hGet error:', error);
      return null;
    }
  }

  async hGetAll(key) {
    try {
      return await this.cluster.hgetall(key);
    } catch (error) {
      console.error('Redis hGetAll error:', error);
      return null;
    }
  }

  async sAdd(key, member) {
    try {
      return await this.cluster.sadd(key, member);
    } catch (error) {
      console.error('Redis sAdd error:', error);
      return false;
    }
  }

  async sMembers(key) {
    try {
      return await this.cluster.smembers(key);
    } catch (error) {
      console.error('Redis sMembers error:', error);
      return [];
    }
  }

  async sRem(key, member) {
    try {
      return await this.cluster.srem(key, member);
    } catch (error) {
      console.error('Redis sRem error:', error);
      return false;
    }
  }

  async expire(key, seconds) {
    try {
      return await this.cluster.expire(key, seconds);
    } catch (error) {
      console.error('Redis expire error:', error);
      return false;
    }
  }
}

module.exports = new RedisClient();