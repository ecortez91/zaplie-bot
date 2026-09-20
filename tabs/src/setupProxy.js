const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function (app) {
  // http-proxy-middleware v3+ strips the Express mount path before proxying,
  // so the base path has to live on the target instead.
  app.use(
    '/api',
    createProxyMiddleware({
      target: 'http://localhost:5000/api',
      changeOrigin: true,
    }),
  );
};
