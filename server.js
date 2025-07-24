const swaggerUi = require('swagger-ui-express');
const swaggerSpecs = require('./swagger');

const express = require('express');
const cors = require('cors');
const session = require('express-session');
require('dotenv').config();

const client = require('prom-client');
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics();


// Passport 설정
const passport = require('./config/passport');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS 설정
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3001',
  credentials: true
}));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

const videoRoutes = require('./routes/videos');
app.use('/api', videoRoutes);

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpecs));

// 기본 라우터
app.get('/', (req, res) => {
  res.send('Backend server is running!');
});

app.get('/metrics', (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(client.register.metrics());
});

// 서버 실행
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// 테스트 코드에서 서버 인스턴스(app)를 불러와서 테스트할 수 있도록 내보냄
module.exports = app;
