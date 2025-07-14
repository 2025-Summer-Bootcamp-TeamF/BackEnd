const request = require('supertest');
const app = require('../server');

describe('GET /', () => {
  it('should return running message', async () => {
    const res = await request(app).get('/');
    expect(res.text).toBe('Backend server is running!');
  });
});