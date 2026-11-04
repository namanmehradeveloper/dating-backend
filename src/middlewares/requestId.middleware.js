// Gives every request a unique id (req_xxx) used in response `meta`, the X-Request-Id header and logs.

import { v4 as uuidv4 } from 'uuid';

// Creates a new request id such as req_3f2a9c... (32 hex characters).
export function generateRequestId() {
  return `req_${uuidv4().replace(/-/g, '')}`;
}

// Assigns a server-generated request id and echoes it in the X-Request-Id header.
// Ids sent by the client are ignored so logs cannot be spoofed.
export function requestId(req, res, next) {
  const id = generateRequestId();
  req.id = id;
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
