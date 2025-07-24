const redisDataLayer = require('../data/redisDataLayer');
const fs = require('fs').promises;

class FileModel {
  constructor(data) {
    this._id = data._id;
    this.filename = data.filename;
    this.originalname = data.originalname;
    this.mimetype = data.mimetype;
    this.size = data.size;
    this.user = data.user;
    this.path = data.path;
    this.uploadDate = data.uploadDate;
    this.destination = data.destination;
    this.isS3File = data.isS3File;
    this.s3Key = data.s3Key;
    this.s3Bucket = data.s3Bucket;
    this.url = data.url;
  }

  static async createFile(fileData) {
    // fileData에 위의 모든 필드 포함
    const fileId = await redisDataLayer.createFile({
      filename: fileData.filename ?? 'unknown',
      originalname: fileData.originalname ?? fileData.filename ?? 'unknown',
      mimetype: fileData.mimetype ?? 'application/octet-stream',
      size: fileData.size ?? 0,
      user: fileData.user ?? 'unknown',
      path: fileData.path ?? fileData.url ?? '',
      uploadDate: fileData.uploadDate ?? Date.now().toString(),
      destination: fileData.destination ?? 'S3',
      isS3File: fileData.isS3File ?? true,
      s3Key: fileData.s3Key ?? '',
      s3Bucket: fileData.s3Bucket ?? '',
      url: fileData.url ?? fileData.path ?? ''
    });
    return fileId;
  }

  static async findById(fileId) {
    const raw = await redisDataLayer.getFile(fileId);
    if (!raw) return null;
    return new FileModel(raw);
  }

  static async findOne(query) {
    // 예시: filename으로 찾기
    if (query.filename) {
      const file = await redisDataLayer.findFileByFilename(query.filename);
      if (!file) return null;
      return new FileModel(file);
    }
    // 기타 쿼리도 필요시 구현
    return null;
  }

  async remove() {
    if (this.path && this.destination !== 'S3') {
      try {
        await fs.unlink(this.path);
      } catch (error) {
        console.error('File removal error:', error);
      }
    }
    // S3 파일 삭제는 별도 서비스에서 처리 필요
    await redisDataLayer.deleteFile(this._id);
  }

  getSafeFilename() {
    return this.filename;
  }

  getEncodedFilename() {
    try {
      const filename = this.originalname || '';
      const encodedFilename = encodeURIComponent(filename)
        .replace(/'/g, "%27")
        .replace(/\(/g, "%28")
        .replace(/\)/g, "%29")
        .replace(/\*/g, "%2A");
      return {
        legacy: filename.replace(/[^\x20-\x7E]/g, ''),
        encoded: `UTF-8''${encodedFilename}`
      };
    } catch (error) {
      console.error('Filename encoding error:', error);
      return {
        legacy: this.filename,
        encoded: this.filename
      };
    }
  }

  getFileUrl(type = 'download') {
    if (this.isS3File || this.destination === 'S3') {
      return this.url || this.path;
    } else {
      return `/api/files/${type}/${encodeURIComponent(this.filename)}`;
    }
  }

  getContentDisposition(type = 'attachment') {
    const { legacy, encoded } = this.getEncodedFilename();
    return `${type}; filename="${legacy}"; filename*=${encoded}`;
  }

  isPreviewable() {
    const previewableTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'video/mp4', 'video/webm',
      'audio/mpeg', 'audio/wav',
      'application/pdf'
    ];
    return previewableTypes.includes(this.mimetype);
  }

  isRemoteFile() {
    return this.isS3File || this.destination === 'S3';
  }

  isAccessible() {
    if (this.isRemoteFile()) {
      return !!(this.url || this.path);
    } else {
      try {
        const fsSync = require('fs');
        return fsSync.existsSync(this.path);
      } catch {
        return false;
      }
    }
  }
}

module.exports = FileModel;