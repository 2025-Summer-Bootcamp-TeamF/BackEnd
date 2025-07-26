const { Queue, Worker } = require('bullmq');

// Redis 연결 설정
const connection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379
};

// 작업 큐 생성
const videoQueue = new Queue('video-processing', { connection });

// 경쟁 채널 추가 작업 큐
const competitorQueue = new Queue('competitor-processing', { connection });

// n8n 워크플로우 작업 큐
const n8nQueue = new Queue('n8n-processing', { connection });

module.exports = { 
  videoQueue, 
  competitorQueue, 
  n8nQueue,
  connection 
}; 