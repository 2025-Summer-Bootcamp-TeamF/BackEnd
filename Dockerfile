# Node.js 18 이미지 사용
FROM node:18

# 컨테이너 작업 디렉토리 설정
WORKDIR /app

# package.json과 package-lock.json 복사
COPY package*.json ./

# npm 패키지 설치
RUN npm install

# 전체 소스 복사
COPY . .

RUN npx prisma generate

# 컨테이너에서 열 포트
EXPOSE 3000

# 개발 서버 시작
CMD ["npm", "run", "dev"]