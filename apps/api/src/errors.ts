import type { ErrorCode, ErrorResponse } from '@dhc/contracts';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

/** Thrown by modules for expected failures; rendered in the standard error shape. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

const STATUS_CODES: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'BUSINESS_RULE',
  429: 'RATE_LIMITED',
};

function send(
  reply: FastifyReply,
  request: FastifyRequest,
  statusCode: number,
  code: ErrorCode,
  message: string,
  fields?: Record<string, string>,
) {
  const body: ErrorResponse = {
    error: { code, message, ...(fields ? { fields } : {}), requestId: request.id },
  };
  return reply.status(statusCode).send(body);
}

function zodFields(error: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_';
    fields[path] ??= issue.message;
  }
  return fields;
}

/**
 * One error shape for every response (API guide §2). Messages are safe to show to
 * users; internal details only go to the logs, and the logs never carry patient data.
 */
export function registerErrorHandling(app: FastifyInstance) {
  app.setNotFoundHandler((request, reply) => send(reply, request, 404, 'NOT_FOUND', 'Not found.'));

  app.setErrorHandler((error: FastifyError | AppError | ZodError, request, reply) => {
    if (error instanceof AppError) {
      return send(reply, request, error.statusCode, error.code, error.message, error.fields);
    }
    if (error instanceof ZodError) {
      return send(
        reply,
        request,
        400,
        'VALIDATION_FAILED',
        'Check the highlighted fields.',
        zodFields(error),
      );
    }
    const statusCode = error.statusCode ?? 500;
    if (statusCode < 500) {
      const code = STATUS_CODES[statusCode] ?? 'VALIDATION_FAILED';
      const message =
        code === 'VALIDATION_FAILED' ? 'The request was not valid.' : 'Request failed.';
      return send(reply, request, statusCode, code, message);
    }
    request.log.error({ err: error }, 'Unhandled error');
    return send(reply, request, 500, 'INTERNAL', 'Something went wrong. Please try again.');
  });
}
