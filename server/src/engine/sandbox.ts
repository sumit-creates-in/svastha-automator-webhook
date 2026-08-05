import vm from 'node:vm';
import { env } from '../config/env';

export interface SandboxResult {
  value: unknown;
  logs: string[];
}

/**
 * Runs user-authored JavaScript for the Code node.
 *
 * Isolation: a fresh V8 context with no `require`, `process`, `fs`, `global`,
 * network or timers, plus a hard wall-clock timeout. Only authenticated members of
 * your team can create workflows, so this is a guard-rail against mistakes rather
 * than a defence against a hostile tenant. Do not expose workflow editing to the
 * public internet.
 */
export async function runSandboxedCode(
  code: string,
  context: Record<string, unknown>,
  timeoutMs = env.engine.codeTimeoutMs,
): Promise<SandboxResult> {
  const logs: string[] = [];

  const console = {
    log: (...args: unknown[]) => logs.push(args.map(stringify).join(' ')),
    info: (...args: unknown[]) => logs.push(args.map(stringify).join(' ')),
    warn: (...args: unknown[]) => logs.push(`WARN ${args.map(stringify).join(' ')}`),
    error: (...args: unknown[]) => logs.push(`ERROR ${args.map(stringify).join(' ')}`),
  };

  const sandbox = {
    ...context,
    console,
    JSON,
    Math,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    Map,
    Set,
    Promise,
    Buffer,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    btoa: (v: string) => Buffer.from(v, 'utf8').toString('base64'),
    atob: (v: string) => Buffer.from(v, 'base64').toString('utf8'),
  };

  const vmContext = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });

  const wrapped = `(async () => {\n${code}\n})()`;

  let value: unknown;
  try {
    const script = new vm.Script(wrapped, { filename: 'code-node.js' });
    const promise = script.runInContext(vmContext, { timeout: timeoutMs });
    value = await withTimeout(Promise.resolve(promise), timeoutMs);
  } catch (error) {
    const message = (error as { message?: string })?.message ?? String(error);
    throw new Error(`Code node failed: ${message}`);
  }

  return { value: marshal(value), logs };
}

/**
 * Values created inside the VM belong to another realm — their prototypes differ
 * from the host's, which breaks Mongoose serialisation and deep comparison.
 * A JSON round-trip brings them home.
 */
function marshal(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new Error('Code node returned a value that cannot be serialised (circular reference?)');
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`execution timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
