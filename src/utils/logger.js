// Minimal JSON-lines logger. Silent during tests so test output stays readable.

const isSilent = process.env.NODE_ENV === 'test';

// Writes one log entry as a single JSON line to stdout or stderr.
function writeLog(stream, level, message, fields) {
  if (isSilent) return;
  const entry = { level, time: new Date().toISOString(), message, ...fields };
  stream.write(`${JSON.stringify(entry)}\n`);
}

export const logger = {
  // Logs normal events such as server start.
  info: (message, fields = {}) => writeLog(process.stdout, 'info', message, fields),
  // Logs situations that work but need attention, such as the fixed OTP mode.
  warn: (message, fields = {}) => writeLog(process.stderr, 'warn', message, fields),
  // Logs failures. Details here stay on the server and are never sent to clients.
  error: (message, fields = {}) => writeLog(process.stderr, 'error', message, fields),
};
