import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { parsePageParams, toStringArray } from './pagination';

describe('parsePageParams', () => {
  it('defaults to page=1, pageSize=25 (openapi.yaml Page/PageSize)', () => {
    expect(parsePageParams({})).toEqual({ page: 1, pageSize: 25 });
  });

  it('parses valid page/pageSize', () => {
    expect(parsePageParams({ page: '3', pageSize: '10' })).toEqual({ page: 3, pageSize: 10 });
  });

  it('rejects pageSize above 200', () => {
    expect(() => parsePageParams({ pageSize: '201' })).toThrow(BadRequestException);
  });

  it('rejects page below 1', () => {
    expect(() => parsePageParams({ page: '0' })).toThrow(BadRequestException);
  });

  it('rejects a non-integer page', () => {
    expect(() => parsePageParams({ page: 'abc' })).toThrow(BadRequestException);
  });
});

describe('toStringArray', () => {
  it('returns undefined when the parameter is absent', () => {
    expect(toStringArray(undefined)).toBeUndefined();
  });

  it('wraps a single value in an array', () => {
    expect(toStringArray('placed')).toEqual(['placed']);
  });

  it('passes an already-array value through', () => {
    expect(toStringArray(['placed', 'confirmed'])).toEqual(['placed', 'confirmed']);
  });
});
