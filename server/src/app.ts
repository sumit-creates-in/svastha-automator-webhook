import path from 'node:path';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Request, type Response } from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import routes from './routes';

export function createApp(): express.Express {
  const app = express();

  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(compression());
  app.use(cookieParser());

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (env.corsOrigins.includes('*') || env.corsOrigins.includes(origin)) {
          return callback(null, true);
        }
        // Same-origin deployments (client served by this server) never hit CORS.
        return callback(null, env.appUrl === origin);
      },
      credentials: true,
    }),
  );

  // Keep the raw body around so webhook HMAC signatures can be verified.
  app.use(
    express.json({
      limit: '5mb',
      verify: (req, _res, buffer) => {
        (req as Request & { rawBody?: string }).rawBody = buffer.toString('utf8');
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));
  app.use(express.text({ type: ['text/*', 'application/xml'], limit: '5mb' }));

  app.use('/api', routes);

  // Serve the built React app in production (single Railway service).
  const clientDist = path.resolve(__dirname, '../../client/dist');
  app.use(express.static(clientDist, { maxAge: '1h', index: false }));
  app.get(/^\/(?!api).*/, (_req: Request, res: Response) => {
    res.sendFile(path.join(clientDist, 'index.html'), (error) => {
      if (error) {
        res
          .status(200)
          .type('html')
          .send(
            '<h1>SVASTHA Automator API is running</h1><p>The web interface has not been built yet. Run <code>npm run build</code>.</p>',
          );
      }
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
