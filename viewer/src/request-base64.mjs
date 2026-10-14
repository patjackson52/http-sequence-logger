import { BASE64_MAX_LENGTH, detectBase64, inspectBase64Body, inspectBase64Header } from './base64.mjs';

export function bodyIsPartial(body) {
  return !!(body?.reason?.includes('partial') || body?.reason?.includes('read_failure') ||
    (body?.total_bytes != null && body?.observed_bytes != null && body.observed_bytes < body.total_bytes));
}

export function inspectCapturedBody(body) {
  if (!body || body.availability !== 'captured' || body.redacted || body.truncated || bodyIsPartial(body)) return null;
  return inspectBase64Body(body.content?.data, { mediaType: body.media_type, encoding: body.content?.encoding });
}

/** Projection for paired Request previews only. Never change the snapshot or URL. */
export function inspectRequestMetadata(request) {
  if (!request) return null;
  const headers = request.headers?.entries || [];
  if (headers.length > 10000 || (request.url?.length || 0) > BASE64_MAX_LENGTH) return null;
  let length = request.url?.length || 0;
  for (const header of headers) {
    length += header.value?.length || 0;
    if (length > BASE64_MAX_LENGTH) return null;
  }
  let count = 0;
  const preview = { ...request };
  if (request.headers) preview.headers = { ...request.headers, entries: headers.map(header => {
    const match = header.redacted ? null : inspectBase64Header(header.value);
    if (!match) return header;
    count++;
    return { ...header, value: match.decoded };
  }) };
  if (!request.url_redacted) {
    try {
      let queryCount = 0;
      const query = [...new URL(request.url).searchParams];
      if (query.length + headers.length > 10000) return null;
      const parameters = query.map(([name, value]) => {
        const match = detectBase64(value);
        if (match) queryCount++;
        return { name, value: match?.decoded ?? value };
      });
      if (queryCount) { preview.decoded_query_parameters = parameters; count += queryCount; }
    } catch { /* Invalid recorded URLs retain their original presentation. */ }
  }
  return count && count <= 64 ? { decoded: JSON.stringify(preview, null, 2), count } : null;
}

export function inspectRequestBodyData(data) {
  const match = inspectCapturedBody(data?.body);
  if (!match) return null;
  // Keep capture metadata visible and distinguish the decoded preview from its
  // recorded content.encoding through the UI label, not a changed snapshot.
  return { decoded: JSON.stringify({ ...data, body: { ...data.body, content: { ...data.body.content, data: match.decoded } } }, null, 2), count: match.count };
}
