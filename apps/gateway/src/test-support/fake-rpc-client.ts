// A scriptable in-memory `RpcClient` fake for unit-testing command/query
// handlers WITHOUT a NATS broker. Records every call for assertions.
import type { RpcCallMeta, RpcClient } from '../application/ports/rpc-client.port';

export interface RecordedRpcCall {
  readonly subject: string;
  readonly payload: unknown;
  readonly meta: RpcCallMeta;
}

export class FakeRpcClient implements RpcClient {
  readonly calls: RecordedRpcCall[] = [];
  private readonly scripted = new Map<string, unknown[]>();

  /** Queues a reply (or a thrown error) for the NEXT call to `subject`, FIFO. */
  respondWith(subject: string, reply: unknown): void {
    const queue = this.scripted.get(subject) ?? [];
    queue.push(reply);
    this.scripted.set(subject, queue);
  }

  async call<TRequest, TReply>(subject: string, payload: TRequest, meta: RpcCallMeta): Promise<TReply> {
    this.calls.push({ subject, payload, meta });
    const queue = this.scripted.get(subject);
    if (!queue || queue.length === 0) {
      throw new Error(`FakeRpcClient: no scripted reply for subject "${subject}"`);
    }
    const next = queue.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next as TReply;
  }
}
