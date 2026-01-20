import type { Request, Response, NextFunction } from 'express';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7); // Remove 'Bearer ' prefix
  const expectedToken = process.env.EXTRACTION_SECRET;

  if (!expectedToken) {
    res.status(500).json({ error: 'Server misconfigured: EXTRACTION_SECRET not set' });
    return;
  }

  if (token !== expectedToken) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  next();
}
