import { describe, expect, it } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import { normalizeGrpcError } from '../src/main/go-core-client';

/**
 * Guards the gRPC → AppError mapping (ipc-strategy.md §2.5): the domain code is
 * taken from the `x-app-error-code` trailer when present, otherwise falls back
 * to the gRPC status name; `x-app-error-details` carries structured JSON.
 */
describe('normalizeGrpcError', () => {
  it('falls back to the gRPC status name when no trailer is present', () => {
    const result = normalizeGrpcError({
      code: grpc.status.UNIMPLEMENTED,
      details: 'not implemented',
      message: 'x',
    } as unknown as grpc.ServiceError);

    expect(result).toEqual({
      code: 'UNIMPLEMENTED',
      message: 'not implemented',
      details: {},
    });
  });

  it('prefers the x-app-error-code trailer and parses x-app-error-details', () => {
    const metadata = new grpc.Metadata();
    metadata.set('x-app-error-code', 'REPO_NOT_FOUND');
    metadata.set('x-app-error-details', '{"repo_id":"abc"}');

    const result = normalizeGrpcError({
      code: grpc.status.NOT_FOUND,
      details: 'not found',
      message: 'x',
      metadata,
    } as unknown as grpc.ServiceError);

    expect(result).toMatchObject({
      code: 'REPO_NOT_FOUND',
      message: 'not found',
      details: { repo_id: 'abc' },
    });
  });

  it('ignores a non-object x-app-error-details payload', () => {
    const metadata = new grpc.Metadata();
    metadata.set('x-app-error-code', 'REPO_NOT_FOUND');
    metadata.set('x-app-error-details', '[1,2,3]');

    const result = normalizeGrpcError({
      code: grpc.status.NOT_FOUND,
      details: 'not found',
      message: 'x',
      metadata,
    } as unknown as grpc.ServiceError);

    expect(result.details).toEqual({});
  });
});
