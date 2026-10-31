import type { Router } from 'express';

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  name: string;
  handle: { stack?: Layer[] };
  regexp: RegExp & { fast_slash?: boolean };
  keys?: Array<{ name: string }>;
}
function mountPath(layer: Layer): string {
  if (layer.regexp.fast_slash) return '';
  let i = 0;
  const name = () => layer.keys?.[i++]?.name ?? 'param';
  // Express' compiled regex format changed between majors: v4 escapes slashes (`\/`) and keeps the
  // param group as `(?:([^\/]+?))` with the preceding literal slash outside; later versions keep the
  // slashes unescaped and move it inside, as `(?:/([^/]+?))`. Handle both so the route list prints
  // readable paths like `/plants/:plantId/foo` regardless of the installed Express.
  return layer.regexp.source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/i, '')           // v4 trailing `\/?(?=\/|$)`
    // Modern path-to-regexp emits the slash before the param group ESCAPED but keeps the one inside the
    // character class bare (so the source reads `(?:\/([^/]+?))`). Match that exact shape.
    .replace(/\(\?:\\\/\(\[\^\/\]\+\?\)\)/g, () => `/:${name()}`)
    .replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => `:${name()}`)  // v4 `(?:([^\/]+?))`
    .replace(/\\\//g, '/');
}
function walk(stack: Layer[], prefix: string, out: Set<string>): void {
  for (const layer of stack) {
    if (layer.route) {
      for (const m of Object.keys(layer.route.methods)) {
        const path = `${prefix}${layer.route.path}`.replace(/\/$/, '') || '/';
        out.add(`${m.toUpperCase()} ${path}`);
      }
    } else if (layer.name === 'router' && layer.handle.stack) {
      walk(layer.handle.stack, prefix + mountPath(layer), out);
    }
  }
}
export function listRoutes(router: Router): string[] {
  const out = new Set<string>();
  walk((router as unknown as { stack: Layer[] }).stack, '', out);
  return [...out].sort();
}
