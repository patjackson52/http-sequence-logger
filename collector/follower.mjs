import { createHash } from "node:crypto";
export const boundaryHash = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
// Reader only returns published durable bytes; checkpoint commits with its batch.
export async function followJournal({
  collector,
  connection,
  key,
  generation,
  durableBytes,
  read,
  identity,
}) {
  let cp = await collector.store.checkpoint(connection.source_id, key);
  if (
    !cp ||
    cp.generation !== generation ||
    cp.identity !== identity ||
    cp.offset > durableBytes
  )
    cp = { generation, identity, offset: 0, boundary: "" };
  if (cp.offset && cp.boundary) {
    const boundary = await read(
      Math.max(0, cp.offset - 64),
      Math.min(64, cp.offset),
    );
    if (boundaryHash(boundary) !== cp.boundary)
      cp = { generation, identity, offset: 0, boundary: "" };
  }
  let offset = cp.offset,
    pending = Buffer.alloc(0),
    batch = "",
    count = 0,
    committed = offset;
  async function commit() {
    if (!batch) return;
    const bytes = await read(
      Math.max(0, committed - 64),
      Math.min(64, committed),
    );
    await collector.ingest(connection.source_token, batch, {
      key,
      value: {
        generation,
        identity,
        offset: committed,
        boundary: boundaryHash(bytes),
      },
    });
    batch = "";
    count = 0;
  }
  // One bounded batch per source each tick. Never hydrate a historical file.
  while (
    offset < durableBytes &&
    count < 500 &&
    Buffer.byteLength(batch) < 1024 * 1024
  ) {
    const chunk = await read(offset, Math.min(65536, durableBytes - offset));
    if (!chunk.length) break;
    offset += chunk.length;
    pending = Buffer.concat([pending, chunk]);
    let end;
    while ((end = pending.indexOf(10)) >= 0) {
      const line = pending.subarray(0, end + 1);
      if (line.length > 1024 * 1024)
        throw new Error("Journal line exceeds batch limit");
      if (
        count &&
        (count === 500 || Buffer.byteLength(batch) + line.length > 1024 * 1024)
      ) {
        await commit();
        return;
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
      batch += text;
      count++;
      committed = offset - pending.length + line.length;
      pending = pending.subarray(end + 1);
    }
    // A read can finish a legal large line and include bytes from its successor.
    // Apply the line limit after extracting complete lines, not to both together.
    if (pending.length > 1024 * 1024)
      throw new Error("Journal line exceeds batch limit");
  }
  await commit();
}
