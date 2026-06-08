export class AppError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function notFound(message = "资源不存在") {
  return new AppError(404, "NOT_FOUND", message);
}

export function badRequest(message: string, code = "BAD_REQUEST") {
  return new AppError(400, code, message);
}
