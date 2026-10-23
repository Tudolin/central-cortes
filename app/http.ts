import { timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { config } from "./config.ts";

/** Quem pode chamar a rota: dashboard (Basic Auth), worker (Bearer token) ou público (OAuth callback, protegido por state). */
export type Access = "dashboard" | "worker" | "public";
export type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], body: any) => unknown;

const routes: { method: string; re: RegExp; fn: Handler; access: Access }[] = [];
export const route = (method: string, path: string, fn: Handler, access: Access = "dashboard") =>
  routes.push({ method, re: new RegExp(`^${path.replace(/:\w+/g, "([^/]+)")}$`), fn, access });

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const must = <T>(v: T | undefined | null, what: string): T => {
  if (!v) throw new HttpError(404, `${what} não encontrado`);
  return v;
};

export const json = (res: ServerResponse, data: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
};

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".json": "application/json",
};

/** Envia arquivo com suporte a Range (seek no player de vídeo). */
export function serveFile(req: IncomingMessage, res: ServerResponse, path: string, download?: string) {
  if (!existsSync(path)) throw new HttpError(404, "Arquivo não encontrado");
  const size = statSync(path).size;
  const headers: Record<string, string | number> = { "content-type": MIME[extname(path)] ?? "application/octet-stream", "accept-ranges": "bytes" };
  if (download) headers["content-disposition"] = `attachment; filename="${download}"`;
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range && size > 0) {
    const start = range[1] ? +range[1] : Math.max(0, size - +range[2]);
    const end = range[1] && range[2] ? Math.min(+range[2], size - 1) : size - 1;
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    createReadStream(path, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, "content-length": size });
    createReadStream(path).pipe(res);
  }
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function authorized(req: IncomingMessage, access: Access): boolean {
  if (access === "public") return true;
  const [scheme, value = ""] = (req.headers.authorization ?? "").split(" ");
  if (access === "worker") return scheme === "Bearer" && !!config.workerToken && safeEqual(value, config.workerToken);
  if (!config.dashboardPassword) return true;
  return scheme === "Basic" && safeEqual(Buffer.from(value, "base64").toString(), `${config.dashboardUser}:${config.dashboardPassword}`);
}

/** JSON é lido automaticamente; outros content-types (upload de arquivo) ficam para o handler fazer stream. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!(req.headers["content-type"] ?? "").includes("application/json")) return undefined;
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > 2_000_000) throw new HttpError(413, "Corpo muito grande");
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "JSON inválido");
  }
}

export function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url!, "http://x").pathname);
      for (const r of routes) {
        const m = req.method === r.method && path.match(r.re);
        if (!m) continue;
        if (!authorized(req, r.access)) {
          if (r.access === "dashboard") res.setHeader("www-authenticate", 'Basic realm="Central de Cortes"');
          throw new HttpError(401, "Não autorizado");
        }
        const out = await r.fn(req, res, m.slice(1), await readJson(req));
        if (!res.headersSent && out !== undefined) json(res, out);
        return;
      }
      if (req.method === "GET" && !path.startsWith("/api/")) {
        if (!authorized(req, "dashboard")) {
          res.writeHead(401, { "www-authenticate": 'Basic realm="Central de Cortes"' });
          return res.end();
        }
        const file = normalize(join(config.webDir, path === "/" ? "index.html" : path));
        if (file.startsWith(config.webDir) && existsSync(file) && statSync(file).isFile()) {
          // no-cache: o navegador revalida a cada carga, então um deploy novo do painel aparece na hora.
          res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
          return createReadStream(file).pipe(res);
        }
      }
      throw new HttpError(404, "Rota não encontrada");
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) json(res, { error: (e as Error).message }, status);
      else res.end();
    }
  });
  server.requestTimeout = 0; // uploads de vídeo do worker podem demorar
  server.listen(config.port, config.host, () => console.log(`[hub] dashboard em http://${config.host}:${config.port}`));
  return server;
}
