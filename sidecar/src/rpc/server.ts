import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import {
  RpcErrorCode,
  type RpcError,
  type RpcNotification,
  type RpcRequest,
  type RpcResponse,
} from '@regis/shared';

export type MethodHandler = (params: unknown) => unknown | Promise<unknown>;

export class RpcMethodError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface RpcServerOptions {
  input: Readable;
  output: Writable;
  methods: Record<string, MethodHandler>;
  onLog?: (message: string) => void;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: RpcMethodError) => void;
}

type IncomingMessage = Partial<RpcRequest & RpcResponse>;

export class RpcServer {
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;

  constructor(private readonly options: RpcServerOptions) {}

  start(): void {
    const lines = createInterface({ input: this.options.input, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (line.trim().length > 0) {
        void this.handleLine(line);
      }
    });
  }

  call<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.send({ jsonrpc: '2.0', id, method, params } satisfies RpcRequest);
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, params } satisfies RpcNotification);
  }

  private send(message: RpcRequest | RpcResponse | RpcNotification): void {
    this.options.output.write(`${JSON.stringify(message)}\n`);
  }

  private async handleLine(line: string): Promise<void> {
    let message: IncomingMessage;
    try {
      message = JSON.parse(line) as IncomingMessage;
    } catch {
      this.sendError(0, { code: RpcErrorCode.ParseError, message: 'Parse error' });
      return;
    }
    if (typeof message.method === 'string') {
      await this.handleRequest(message.method, message.id, message.params);
    } else if (typeof message.id === 'number') {
      this.handleResponse(message.id, message);
    }
  }

  private async handleRequest(method: string, id: number | undefined, params: unknown): Promise<void> {
    const handler = Object.hasOwn(this.options.methods, method) ? this.options.methods[method] : undefined;
    if (id === undefined) {
      await handler?.(params);
      return;
    }
    if (!handler) {
      this.sendError(id, { code: RpcErrorCode.MethodNotFound, message: `Method not found: ${method}` });
      return;
    }
    try {
      const result = await handler(params);
      this.send({ jsonrpc: '2.0', id, result: result ?? null } satisfies RpcResponse);
    } catch (error) {
      this.sendError(id, toRpcError(error));
    }
  }

  private handleResponse(id: number, message: IncomingMessage): void {
    const call = this.pending.get(id);
    if (!call) {
      this.options.onLog?.(`response for unknown id ${id}`);
      return;
    }
    this.pending.delete(id);
    if (message.error) {
      call.reject(new RpcMethodError(message.error.code, message.error.message, message.error.data));
    } else {
      call.resolve(message.result);
    }
  }

  private sendError(id: number, error: RpcError): void {
    this.send({ jsonrpc: '2.0', id, error } satisfies RpcResponse);
  }
}

function toRpcError(error: unknown): RpcError {
  if (error instanceof RpcMethodError) {
    return { code: error.code, message: error.message, data: error.data };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: RpcErrorCode.Internal, message };
}
