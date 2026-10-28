import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, test, type TestContext } from "vitest";

const require = createRequire(import.meta.url);
const umiCLI = require.resolve("umi/bin/umi.js");
const compilerCLI = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");
const plugin = require.resolve("umi-plugin-openapi");

function schema(project: string) {
  return {
    openapi: "3.0.3",
    info: { title: `${project} pets`, version: "1.0.0" },
    paths: {
      [`/${project}/pets/{id}`]: {
        get: {
          operationId: "fetchPet",
          tags: ["pets"],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "search", in: "query", schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "A pet",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Pet" },
                  example: { id: "mock-pet", name: project },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Pet: {
          type: "object",
          required: ["id", "name"],
          properties: { id: { type: "string" }, name: { type: "string" } },
        },
      },
    },
  };
}

type RunningProcess = {
  child: ChildProcess;
  signal: AbortSignal;
  done: Promise<number | null>;
  output: () => string;
  stop: () => Promise<void>;
};

async function closeServer(server: Server) {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.close((error) => (error ? reject(error) : resolve()));
  await promise;
}

function startProcess(
  cwd: string,
  args: string[],
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = {},
) {
  signal.throwIfAborted();
  const child = spawn(process.execPath, args, {
    cwd,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      NODE_ENV: "development",
      BROWSER: "none",
      HOST: "127.0.0.1",
      UMI_TELEMETRY_DISABLED: "1",
      UMI_CHECK_UPDATE: "false",
      FORCE_COLOR: "0",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const { promise: done, resolve, reject } = Promise.withResolvers<number | null>();
  child.once("error", reject);
  child.once("close", resolve);
  // A dev process can fail before the first readiness request observes it.
  void done.catch(() => {});
  const killGroup = (value: NodeJS.Signals) => {
    try {
      if (process.platform === "win32") child.kill(value);
      else if (child.pid) process.kill(-child.pid, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  let abortTimer: NodeJS.Timeout | undefined;
  // Real detached Umi workers need a wall-clock escalation deadline; fake timers cannot stop them.
  const onAbort = () => {
    killGroup("SIGTERM");
    abortTimer = setTimeout(() => killGroup("SIGKILL"), 5_000);
    abortTimer.unref();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  let stopping: Promise<void> | undefined;
  return {
    child,
    signal,
    done,
    output: () => output,
    stop() {
      stopping ??= (async () => {
        killGroup("SIGTERM");
        try {
          await Promise.race([
            done,
            delay(5_000, undefined, { ref: false }).then(() => {
              throw new Error("termination timed out");
            }),
          ]);
        } catch {
          killGroup("SIGKILL");
          await Promise.race([
            done,
            delay(5_000, undefined, { ref: false }).then(() => {
              throw new Error(`Cannot stop process\n${output}`);
            }),
          ]);
        } finally {
          // Umi may exit before its compiler worker does; kill the remaining group too.
          killGroup("SIGKILL");
          signal.removeEventListener("abort", onAbort);
          clearTimeout(abortTimer);
        }
      })();
      return stopping;
    },
  };
}

async function run(
  cwd: string,
  args: string[],
  signal: AbortSignal,
  processes: RunningProcess[],
  success = true,
) {
  const process = startProcess(cwd, args, signal);
  processes.push(process);
  try {
    const code = await Promise.race([
      process.done,
      delay(90_000, undefined, { ref: false, signal }).then(() => {
        throw new Error(`Command timed out: ${args.join(" ")}\n${process.output()}`);
      }),
    ]);
    signal.throwIfAborted();
    if ((code === 0) !== success) {
      throw new Error(`Unexpected command exit ${code}: ${args.join(" ")}\n${process.output()}`);
    }
    return process.output();
  } finally {
    await process.stop();
  }
}

async function fixture(context: TestContext, sourceDirectory = "src") {
  context.signal.throwIfAborted();
  const cwd = await mkdtemp(join(tmpdir(), "umi-openapi-plugin-"));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    response.setHeader("Content-Type", "application/json");
    if (url.pathname === "/alpha.json" || url.pathname === "/beta.json") {
      response.end(JSON.stringify(schema(url.pathname.slice(1, -5))));
    } else if (/^\/(alpha|beta)\/pets\/42$/.test(url.pathname)) {
      requests.push(`${request.method} ${url.pathname}${url.search}`);
      response.end(JSON.stringify({ id: "42", name: url.pathname.split("/")[1] }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    }
  });
  const processes: RunningProcess[] = [];
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const setupFinished = Promise.withResolvers<void>();
  let cleaning: Promise<void> | undefined;
  const cleanup = () =>
    (cleaning ??= (async () => {
      controller.abort();
      // Do not remove the directory while fixture initialization is still writing it.
      await setupFinished.promise;
      try {
        await Promise.all(processes.map((process) => process.stop()));
      } finally {
        try {
          if (server.listening) {
            server.closeAllConnections();
            await closeServer(server);
          }
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      }
    })());
  context.onTestFinished(cleanup, 20_000);
  try {
    signal.throwIfAborted();
    server.listen(0, "127.0.0.1");
    await once(server, "listening", { signal });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No schema server port");
    const origin = `http://127.0.0.1:${address.port}`;
    const sourcePath = join(cwd, sourceDirectory);
    await mkdir(join(sourcePath, "pages"), { recursive: true });
    await mkdir(join(cwd, "node_modules"));
    for (const name of [
      "umi",
      "react",
      "react-dom",
      "@umijs/renderer-react",
      "@umijs/utils",
      "@babel/runtime",
    ]) {
      const target = join(cwd, "node_modules", name);
      await mkdir(dirname(target), { recursive: true });
      await symlink(dirname(require.resolve(`${name}/package.json`)), target, "dir");
    }
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ name: "integration-app", private: true }),
    );
    await writeFile(
      join(sourcePath, "pages/index.tsx"),
      "export default function Home() { return <h1>Integration app</h1>; }",
    );
    await writeFile(
      join(sourcePath, "request.ts"),
      `
export default async function request<T>(path: string, options: { method?: string; params?: Record<string, unknown> }): Promise<T> {
  const url = new URL(path, ${JSON.stringify(origin)});
  for (const [key, value] of Object.entries(options.params || {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { method: options.method });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json() as Promise<T>;
}
`,
    );
    // Observe real Umi routing and compilation without depending on generated source text.
    await writeFile(
      join(cwd, "observe.cjs"),
      `
module.exports = (api) => {
  let paths = [];
  let errors;
  api.modifyRoutes({
    stage: Infinity,
    fn(routes) {
      paths = Object.values(routes).map(route => route.path);
      return routes;
    },
  });
  api.onDevCompileDone(({ stats }) => {
    errors = stats.toJson({ all: false, errors: true }).errors;
  });
  api.addBeforeMiddlewares(() => [(req, res, next) => {
    if (req.url !== '/__integration/status') return next();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ compiled: errors !== undefined, errors, paths }));
  }]);
};
`,
    );
    signal.throwIfAborted();
    return {
      cwd,
      requests,
      cleanup,
      run: (args: string[], success = true) => run(cwd, args, signal, processes, success),
      async configure(value: string) {
        signal.throwIfAborted();
        await writeFile(
          join(cwd, ".umirc.ts"),
          `export default {
  plugins: [${JSON.stringify(plugin)}, './observe.cjs'],
  mfsu: false,
  routeLoader: { moduleType: 'cjs' },
  openAPI: ${value},
};`,
        );
      },
      config(project: string, mock = false) {
        return `{ schemaPath: ${JSON.stringify(`${origin}/${project}.json`)}, projectName: '${project}', namespace: '${project === "alpha" ? "Alpha" : "Beta"}', requestLibPath: '../../request', mock: ${mock}, hook: { customFunctionName: () => 'fetchPet', customClassName: () => 'pets' } }`;
      },
      start(port: number) {
        const process = startProcess(cwd, [umiCLI, "dev"], signal, {
          PORT: String(port),
          STRICT_PORT: String(port),
        });
        processes.push(process);
        return process;
      },
    };
  } finally {
    setupFinished.resolve();
  }
}

async function unusedPort(signal: AbortSignal) {
  signal.throwIfAborted();
  const server = createServer();
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening", { signal });
    signal.throwIfAborted();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No dev server port");
    return address.port;
  } finally {
    if (server.listening) await closeServer(server);
  }
}

async function waitForResponse(
  process: RunningProcess,
  url: string,
  accept: (body: string) => boolean,
) {
  const deadline = Date.now() + 120_000;
  let last = "No response";
  while (Date.now() < deadline) {
    process.signal.throwIfAborted();
    if (process.child.exitCode !== null || process.child.signalCode !== null) {
      throw new Error(`Umi exited before serving ${url}\n${process.output()}`);
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([process.signal, AbortSignal.timeout(3_000)]),
      });
      const body = await response.text();
      if (response.ok && accept(body)) return body;
      last = `HTTP ${response.status}: ${body.slice(0, 1_000)}`;
    } catch (error) {
      process.signal.throwIfAborted();
      last = String(error);
    }
    await delay(200, undefined, { signal: process.signal });
  }
  throw new Error(`Timed out waiting for ${url}\n${last}\n${process.output()}`);
}

async function consumeServices(
  cwd: string,
  projects: string[],
  signal: AbortSignal,
  runCommand: (args: string[]) => Promise<string>,
  sourceDirectory = "src",
) {
  signal.throwIfAborted();
  const sourcePrefix = sourceDirectory ? `${sourceDirectory}/` : "";
  await writeFile(
    join(cwd, "consume.ts"),
    `
${projects.map((project) => `import { fetchPet as ${project} } from './${sourcePrefix}services/${project}/pets';`).join("\n")}
async function main() {
  const results = [];
  ${projects
    .map(
      (project) => `
  const ${project}Pet: ${project === "alpha" ? "Alpha" : "Beta"}.Pet = await ${project}({ id: '42', search: 'hello world' });
  const ${project}Name: string = ${project}Pet.name;
  // @ts-expect-error response fields must retain their schema types
  const ${project}Wrong: number = ${project}Pet.name;
  results.push({ id: ${project}Pet.id, name: ${project}Name });
  `,
    )
    .join("\n")}
  console.log(JSON.stringify(results));
}
function rejectInvalidParameters() {
  // @ts-expect-error path parameters must retain their schema types
  void ${projects[0]}({ id: 42 });
}
void main().catch(error => { console.error(error); throw error; });
`,
  );
  await writeFile(
    join(cwd, "tsconfig.consume.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "Node16",
        moduleResolution: "Node16",
        strict: true,
        skipLibCheck: true,
        outDir: "compiled",
        types: [],
      },
      include: ["consume.ts", `${sourcePrefix}request.ts`, `${sourcePrefix}services/**/*.ts`],
    }),
  );
  await runCommand([compilerCLI, "--project", "tsconfig.consume.json"]);
  const output = await runCommand([join(cwd, "compiled/consume.js")]);
  expect(JSON.parse(output.trim())).toEqual(
    projects.map((project) => ({ id: "42", name: project })),
  );
}

describe("published plugin in real Umi projects", () => {
  test.for([false, true])(
    "generates usable requests and types with multiple projects=%s",
    { timeout: 240_000 },
    async (multiple, context) => {
      const app = await fixture(context);
      try {
        const projects = multiple ? ["alpha", "beta"] : ["alpha"];
        await app.configure(
          multiple ? `[${app.config("alpha", true)}, ${app.config("beta")}]` : app.config("alpha"),
        );
        await app.run([umiCLI, "openapi"]);
        await consumeServices(app.cwd, projects, context.signal, app.run);
        expect(app.requests).toEqual(
          projects.map((project) => `GET /${project}/pets/42?search=hello+world`),
        );

        if (multiple) {
          const port = await unusedPort(context.signal);
          const process = app.start(port);
          const origin = `http://127.0.0.1:${port}`;
          const html = await waitForResponse(process, `${origin}/umi/plugin/openapi`, (body) =>
            body.includes('id="root"'),
          );
          const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)];
          expect(scripts.some((match) => new URL(match[1]!, origin).origin === origin)).toBe(true);
          for (const match of scripts) {
            const response = await fetch(new URL(match[1]!, origin), {
              signal: AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]),
            });
            expect(response.status).toBe(200);
            expect(response.headers.get("content-type")).toMatch(/javascript/);
            await response.arrayBuffer();
          }
          const status = await waitForResponse(
            process,
            `${origin}/__integration/status`,
            (body) => {
              try {
                return JSON.parse(body).compiled === true;
              } catch {
                return false;
              }
            },
          );
          expect(JSON.parse(status)).toMatchObject({
            errors: [],
            paths: expect.arrayContaining(["/umi/plugin/openapi"]),
          });
          for (const project of projects) {
            const body = await waitForResponse(
              process,
              `${origin}/umi-plugins_${project}.json`,
              (value) => {
                try {
                  return JSON.parse(value).info?.title === `${project} pets`;
                } catch {
                  return false;
                }
              },
            );
            expect(JSON.parse(body)).toEqual(schema(project));
          }
          // The generated mock is consumed by Umi's real mock middleware, not just inspected.
          const mock = await waitForResponse(process, `${origin}/alpha/pets/42`, (body) => {
            try {
              return typeof JSON.parse(body).name === "string";
            } catch {
              return false;
            }
          });
          expect(JSON.parse(mock)).toEqual({ id: expect.any(String), name: expect.any(String) });
        }
      } finally {
        await app.cleanup();
      }
    },
  );

  test("generates usable services beside root pages without creating src", async (context) => {
    const app = await fixture(context, "");
    try {
      await app.configure(app.config("alpha"));
      await app.run([umiCLI, "openapi"]);
      await consumeServices(app.cwd, ["alpha"], context.signal, app.run, "");
      expect(app.requests).toEqual(["GET /alpha/pets/42?search=hello+world"]);
      await expect(stat(join(app.cwd, "src"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await app.cleanup();
    }
  }, 240_000);

  test("rejects invalid configuration through Umi config validation", async (context) => {
    const app = await fixture(context);
    try {
      await app.configure("{ schemaPath: 123 }");
      await app.run([umiCLI, "openapi"], false);
      await expect(stat(join(app.cwd, "src/services"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await app.cleanup();
    }
  }, 200_000);
});
