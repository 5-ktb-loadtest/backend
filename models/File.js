// models/File.js
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
  }

  static async createFile(fileData) {
    if (!/^[0-9]+_[a-f0-9]+\.[a-z0-9]+$/.test(fileData.filename)) {
      throw new Error('올바르지 않은 파일명 형식입니다.');
    }

    let sanitizedName = fileData.originalname || '';
    sanitizedName = sanitizedName.replace(/[\/\\]/g, '');
    sanitizedName = sanitizedName.normalize('NFC');

    const fileId = await redisDataLayer.createFile({
      filename: fileData.filename,
      originalname: sanitizedName,
      mimetype: fileData.mimetype,
      size: fileData.size,
      userId: fileData.user,
      path: fileData.path
    });

    return FileModel.findById(fileId);
  }

  static async findById(fileId) {
    const raw = await redisDataLayer.getFile(fileId);
    if (!raw) return null;
    return new FileModel(raw);
  }

  async remove() {
    if (this.path) {
      try {
        await fs.unlink(this.path);
      } catch (error) {
        console.error('File removal error:', error);
      }
    }
    await redisDataLayer.deleteFile(this._id);
  }

  getSafeFilename() {
    return this.filename;
  }

  getEncodedFilename() {
    const filename = this.originalname || '';
    try {
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
    return `/api/files/${type}/${encodeURIComponent(this.filename)}`;
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
}

module.exports = FileModel;