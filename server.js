const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { createProxyMiddleware } = require('http-proxy-middleware');

const dev = process.env.NODE_ENV !== 'production';
const hostname = 'localhost';
const port = process.env.PORT || 5577;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      const { pathname } = parsedUrl;

      // Handle API proxy
      if (pathname.startsWith('/api/')) {
        const proxy = createProxyMiddleware({
          target: 'http://localhost:3001',
          changeOrigin: true,
          logLevel: 'silent',
        });
        return proxy(req, res);
      }

      // Handle Next.js pages
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred handling', req.url, err);
      res.statusCode = 500;
      res.end('internal server error');
    }
  });

  // WebSocket proxy setup
  server.on('upgrade', (request, socket, head) => {
    const { pathname } = parse(request.url);
    
    if (pathname === '/ws') {
      const proxy = createProxyMiddleware({
        target: 'http://localhost:3001',
        ws: true,
        changeOrigin: true,
        logLevel: 'silent',
      });
      
      proxy.upgrade(request, socket, head);
    } else {
      socket.destroy();
    }
  });

  server.once('error', (err) => {
    console.error(err);
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
  });
});