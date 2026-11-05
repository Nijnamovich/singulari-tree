/**
 * Splits a raw commit message into its subject (the text before the first blank
 * line) and description (everything after it), each trimmed. Shared by the
 * commit details panel and the File-status commit-variant pane title so both
 * read the subject exactly the same way.
 */
export function splitCommitMessage(message: string): {
  subject: string;
  description: string;
} {
  // The blank-line separator is LF LF; built from char codes to keep the
  // source free of escape sequences.
  const blankLine = String.fromCharCode(10, 10);
  const split = message.indexOf(blankLine);
  if (split === -1) return { subject: message.trim(), description: '' };
  return {
    subject: message.slice(0, split).trim(),
    description: message.slice(split + blankLine.length).trim(),
  };
}
