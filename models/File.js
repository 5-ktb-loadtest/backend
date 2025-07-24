const mongoose = require('mongoose');

const FileSchema = new mongoose.Schema({
  filename: {
    type: String,
    required: true,
    index: true,
    validate: {
      validator: function (v) {
        // 기존 로컬 파일명 패턴: 숫자_해시.확장자
        const localPattern = /^[0-9]+_[a-f0-9]+\.[a-z0-9]+$/;

        // S3 파일명 패턴: 타임스탬프-랜덤문자열.확장자
        const s3Pattern = /^\d{13}-[a-z0-9]+\.[a-z0-9]+$/i;

        // 둘 중 하나라도 맞으면 통과
        return localPattern.test(v) || s3Pattern.test(v);
      },
      message: '올바르지 않은 파일명 형식입니다. 로컬 파일(숫자_해시.확장자) 또는 S3 파일(타임스탬프-문자열.확장자) 형식을 사용해주세요.'
    }
  },
  originalname: {
    type: String,
    required: true,
    set: function (name) {
      try {
        if (!name) return '';

        // 파일명에서 경로 구분자 제거
        const sanitizedName = name.replace(/[\/\\]/g, '');

        // 유니코드 정규화 (NFC)
        return sanitizedName.normalize('NFC');
      } catch (error) {
        console.error('Filename sanitization error:', error);
        return name;
      }
    },
    get: function (name) {
      try {
        if (!name) return '';

        // 유니코드 정규화된 형태로 반환
        return name.normalize('NFC');
      } catch (error) {
        console.error('Filename retrieval error:', error);
        return name;
      }
    }
  },
  mimetype: {
    type: String,
    required: true
  },
  size: {
    type: Number,
    required: true,
    min: 0
  },
  user: {
    type: String,
    required: true,
    index: true
  },
  path: {
    type: String,
    required: true
  },
  uploadDate: {
    type: Date,
    default: Date.now,
    index: true
  },
  // S3 관련 필드들 추가
  destination: {
    type: String,
    enum: ['local', 'S3'],
    default: 'local'
  },
  isS3File: {
    type: Boolean,
    default: false
  },
  s3Key: {
    type: String,
    sparse: true // S3 파일에만 존재하므로 sparse 인덱스
  },
  s3Bucket: {
    type: String,
    sparse: true
  },
  url: {
    type: String,
    sparse: true // S3 파일의 경우 직접 접근 URL
  }
}, {
  timestamps: true,
  toJSON: { getters: true },
  toObject: { getters: true }
});

// 복합 인덱스 - S3 파일의 경우 중복 가능하도록 조건부 unique
FileSchema.index({ filename: 1, user: 1 }, {
  unique: true,
  partialFilterExpression: { destination: { $ne: 'S3' } } // S3 파일 제외
});

// S3 파일용 별도 인덱스
FileSchema.index({ s3Key: 1 }, { unique: true, sparse: true });
FileSchema.index({ isS3File: 1 });

// 파일 삭제 전 처리 - S3 파일 고려
FileSchema.pre('remove', async function (next) {
  try {
    if (this.isS3File || this.destination === 'S3') {
      // S3 파일의 경우 S3에서 삭제 로직 추가 (선택사항)
      console.log('S3 file deletion requested:', this.s3Key);
      // TODO: S3 삭제 로직 구현
    } else {
      // 로컬 파일 삭제
      const fs = require('fs').promises;
      if (this.path) {
        await fs.unlink(this.path);
      }
    }
    next();
  } catch (error) {
    console.error('File removal error:', error);
    next(error);
  }
});

// URL 안전한 파일명 생성을 위한 유틸리티 메서드
FileSchema.methods.getSafeFilename = function () {
  return this.filename;
};

// Content-Disposition 헤더를 위한 파일명 인코딩 메서드
FileSchema.methods.getEncodedFilename = function () {
  try {
    const filename = this.originalname;
    if (!filename) return '';

    // RFC 5987에 따른 인코딩
    const encodedFilename = encodeURIComponent(filename)
      .replace(/'/g, "%27")
      .replace(/\(/g, "%28")
      .replace(/\)/g, "%29")
      .replace(/\*/g, "%2A");

    return {
      legacy: filename.replace(/[^\x20-\x7E]/g, ''), // ASCII only for legacy clients
      encoded: `UTF-8''${encodedFilename}` // RFC 5987 format
    };
  } catch (error) {
    console.error('Filename encoding error:', error);
    return {
      legacy: this.filename,
      encoded: this.filename
    };
  }
};

// 파일 URL 생성을 위한 유틸리티 메서드 - S3 지원
FileSchema.methods.getFileUrl = function (type = 'download') {
  if (this.isS3File || this.destination === 'S3') {
    // S3 파일의 경우 직접 URL 반환
    return this.url || this.path;
  } else {
    // 로컬 파일의 경우 기존 로직
    return `/api/files/${type}/${encodeURIComponent(this.filename)}`;
  }
};

// 다운로드용 Content-Disposition 헤더 생성 메서드
FileSchema.methods.getContentDisposition = function (type = 'attachment') {
  const { legacy, encoded } = this.getEncodedFilename();
  return `${type}; filename="${legacy}"; filename*=${encoded}`;
};

// 파일 MIME 타입 검증 메서드
FileSchema.methods.isPreviewable = function () {
  const previewableTypes = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'video/mp4', 'video/webm',
    'audio/mpeg', 'audio/wav',
    'application/pdf'
  ];
  return previewableTypes.includes(this.mimetype);
};

// 파일이 S3에 있는지 확인하는 메서드
FileSchema.methods.isRemoteFile = function () {
  return this.isS3File || this.destination === 'S3';
};

// 파일 접근성 확인 메서드
FileSchema.methods.isAccessible = function () {
  if (this.isRemoteFile()) {
    // S3 파일은 URL이 있으면 접근 가능한 것으로 간주
    return !!(this.url || this.path);
  } else {
    // 로컬 파일은 실제 파일 시스템 확인
    try {
      const fs = require('fs');
      return fs.existsSync(this.path);
    } catch {
      return false;
    }
  }
};

module.exports = mongoose.model('File', FileSchema);