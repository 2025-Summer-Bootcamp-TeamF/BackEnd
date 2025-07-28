// backend/swagger.js
const swaggerJSDoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Channel Assistant API',
      version: '1.0.0',
      description: 'API documentation for TeamF project',
    },
    servers: [
      {
        url: 'http://localhost:8000',
      },
    ],
    components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
      security: [
        {
          bearerAuth: [],
        },
      ],
  },
  apis: ['./routes/*.js'], // JSDoc 주석이 포함된 경로
};

const swaggerSpec = swaggerJSDoc(options);
module.exports = swaggerSpec;