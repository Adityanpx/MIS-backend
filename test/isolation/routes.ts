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
  return layer.regexp.source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/i, '')
    .replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => `:${layer.keys?.[i++]?.name ?? 'param'}`)
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
