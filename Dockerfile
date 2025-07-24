# 1. Node.js 공식 이미지 사용 (18 LTS 권장)
FROM node:18-alpine

# 2. 작업 디렉토리 생성 및 설정
WORKDIR /app

# 3. package.json, package-lock.json 복사
COPY package*.json ./

# 4. 의존성 설치
RUN npm ci
RUN npm install --save @opentelemetry/api @opentelemetry/auto-instrumentations-node

# 5. 소스 전체 복사
COPY . .

# 6. uploads 폴더가 없으면 생성 (파일 업로드 경로)
RUN mkdir -p uploads

# 7. 환경변수 포트 지정 (기본 5000)
ENV PORT=5000

# 8. 컨테이너가 5000번 포트 사용
EXPOSE 5000

# 9. 서버 실행 (프로덕션용)
CMD ["npm", "start"]