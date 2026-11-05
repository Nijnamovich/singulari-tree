import { describe, expect, it } from 'vitest';
import { splitCommitMessage } from './commit-message';

describe('splitCommitMessage', () => {
  it('splits subject and description on the first blank line, trimming both', () => {
    const parts = splitCommitMessage('feat(graph): details panel\n\nfull body text\nsecond line');

    expect(parts.subject).toBe('feat(graph): details panel');
    expect(parts.description).toBe('full body text\nsecond line');
  });

  it('returns a bare subject with an empty description when there is no blank line', () => {
    const parts = splitCommitMessage('  single line subject  ');

    expect(parts.subject).toBe('single line subject');
    expect(parts.description).toBe('');
  });

  it('trims surrounding whitespace around the subject and description', () => {
    const parts = splitCommitMessage('\n  subject line  \n\n\n  body  \n');

    expect(parts.subject).toBe('subject line');
    expect(parts.description).toBe('body');
  });

  it('handles an empty message', () => {
    expect(splitCommitMessage('')).toEqual({ subject: '', description: '' });
  });
});
