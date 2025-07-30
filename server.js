const swaggerUi = require('swagger-ui-express');
const swaggerSpecs = require('./swagger');
const swaggerJsdoc = require('swagger-jsdoc');

const express = require('express');
const cors = require('cors');
const session = require('express-session');
require('dotenv').config();

// BullMQ Worker 초기화
const { n8nWorker } = require('./utils/queue');

const client = require('prom-client');
const collectDefaultMetrics = client.collectDefaultMetrics;
const register = client.register;
collectDefaultMetrics();

// custom metrics 추가
const httpRequestDurationMicroseconds = new client.Histogram({
  name: 'http_request_duration_ms',
  help: 'Duration of HTTP requests in ms',
  labelNames: ['method', 'route', 'code'],
  buckets: [50, 100, 300, 500, 1000, 2000] // milliseconds
});

const requestCount = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'code'],
});


// Passport 설정
const passport = require('./config/passport');

const app = express();
const PORT = process.env.PORT || 8000;

// CORS 설정
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 메트릭 수집용 미들웨어
app.use((req, res, next) => {
  const end = httpRequestDurationMicroseconds.startTimer();
  res.on('finish', () => {
    end({
      method: req.method,
      route: req.route ? req.route.path : req.path,
      code: res.statusCode
    });
    requestCount.inc({
      method: req.method,
      route: req.route ? req.route.path : req.path,
      code: res.statusCode
    });
  });
  next();
});

// 세션 설정 (OAuth 과정에서만 사용)
app.use(session({
  secret: process.env.JWT_SECRET || 'fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 // 24시간
  }
}));

// Passport 초기화
app.use(passport.initialize());
app.use(passport.session());

// 라우트 설정
const authRoutes = require('./routes/auth');
app.use('/auth', authRoutes);
console.log('[Server] Auth routes registered at /auth');

const videoRoutes = require('./routes/videos');
app.use('/api', videoRoutes);
console.log('[Server] Video routes registered at /api');

const channelRoutes = require('./routes/channel');
app.use('/api/channel', channelRoutes);
console.log('[Server] Channel routes registered at /api/channel');

const othersRoutes = require('./routes/others');
app.use('/api/others', othersRoutes);
console.log('[Server] Others routes registered at /api/others');

// Swagger configuration
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Video Analysis API',
      version: '1.0.0',
      description: 'API for video analysis and insights',
    },
    servers: [
      {
        url: `http://localhost:${process.env.PORT || 8000}`,
        description: 'Development server',
      },
    ],
  },
  apis: ['./routes/*.js'], // Path to the API docs
};

const swaggerSpecss = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpecss));

// 기본 라우터
app.get('/', (req, res) => {
  res.send('Backend server is running!');
});

// Prometheus 메트릭 엔드포인트
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}); 

// 서버 실행
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// 테스트용 export
module.exports = app;