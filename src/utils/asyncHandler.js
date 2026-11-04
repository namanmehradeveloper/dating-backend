// Wraps async route handlers so a thrown error or rejected promise reaches the error middleware.

// Runs the handler and passes any error to next(), so controllers can simply `throw`.
export const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};
