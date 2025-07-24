# 프로젝트 설치 및 실행 방법

1. **env 파일 설정**

2. **의존성 설치**
   ```sh
   npm install
   ```

3. **도커 컴포즈로 서비스 실행**
   ```sh
   docker-compose up -d
   ```

4. **Prisma 마이그레이션 적용**
   - 이미 존재하는 마이그레이션 파일 적용:
     ```sh
     docker exec -it backend sh
     npx prisma migrate deploy
     ```
   - 새로운 마이그레이션 파일 생성 및 적용:
     ```sh
     docker exec -it backend sh
     npx prisma migrate dev --name init
     ```

5. **직접 SQL문으로 DB 다루기 (선택)**
   ```sh
   docker exec -it postgres sh
   psql -U myuser -d mydb 
   ```

   그 다음 sql문 실행
