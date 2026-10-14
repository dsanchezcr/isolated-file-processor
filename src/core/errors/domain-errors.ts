export class DomainError extends Error {
  constructor(message: string, readonly code: string, readonly httpStatus: number) {
    super(message);
    this.name = new.target.name;
  }
}

export class SecurityViolationError extends DomainError {
  constructor(message = 'Attachment rejected by security policy') {
    super(message, 'QUARANTINE_REJECTED', 422);
  }
}

export class PayloadTooLargeError extends DomainError {
  constructor() { super('Attachment exceeds upload limit', 'PAYLOAD_TOO_LARGE', 413); }
}

export class UnsupportedMediaError extends DomainError {
  constructor() { super('Unsupported binary signature', 'UNSUPPORTED_MEDIA', 415); }
}
