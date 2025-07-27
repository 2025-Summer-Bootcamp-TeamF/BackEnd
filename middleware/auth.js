const { verifyToken } = require('../utils/jwtUtils');

// JWT 인증 미들웨어
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  console.log('Auth header:', authHeader); // 디버깅용 로그 추가
  console.log('Token:', token); // 디버깅용 로그 추가

  if (!token) {
    return res.status(401).json({ 
      success: false, 
      message: 'Access token is required' 
    });
  }

  const user = verifyToken(token);
  console.log('Verified user:', user); // 디버깅용 로그 추가
  
  if (!user) {
    return res.status(403).json({ 
      success: false, 
      message: 'Invalid or expired token' 
    });
  }

  req.user = user;
  next();
};

// 선택적 인증 미들웨어 (토큰이 있으면 사용자 정보 추가, 없어도 통과)
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token) {
    const user = verifyToken(token);
    if (user) {
      req.user = user;
    }
  }

  next();
};

module.exports = {
  authenticateToken,
  optionalAuth
}; 