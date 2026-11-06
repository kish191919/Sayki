/** An error whose message is safe to show to the user (Korean). */
export class LessonError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 422) {
    super(message);
    this.name = "LessonError";
    this.code = code;
    this.status = status;
  }
}
