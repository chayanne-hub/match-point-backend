const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn('[auth] JWT_SECRET is not set — set it in .env before going live.');
}

function signToken(user) {
  return jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET || 'dev-secret', {
    expiresIn: '30d',
  });
}

// Express middleware: requires a valid "Authorization: Bearer <token>" header.
// Attaches req.userId on success.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET || 'dev-secret');
    req.userId = payload.userId;
    req.userEmail = payload.email;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

module.exports = { signToken, requireAuth };
