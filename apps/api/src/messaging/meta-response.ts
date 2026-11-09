/** Provider payloads stay in memory and are bounded before JSON parsing. Never log them. */
export async function boundedMetaJson(response: Response, max = 2 * 1048576): Promise<unknown> {
  if (!response.body) throw new Error('Empty provider response');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > max) throw new Error('Provider response exceeds limit');
      chunks.push(r.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
