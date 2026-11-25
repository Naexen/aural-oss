const paths = {
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4m-3 0h6"/>',
  micOff: '<path d="m3 3 18 18M9 9v2a3 3 0 0 0 4.9 2.3M15 9V5a3 3 0 0 0-5.1-2.1M5 10v1a7 7 0 0 0 10.4 6.1M19 11a7 7 0 0 1-.3 2M12 18v4m-3 0h6"/>',
  layers: '<rect x="7" y="3" width="13" height="13" rx="3"/><path d="M16 17v1a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3h1"/>',
  sliders: '<path d="M4 7h4m4 0h8M4 17h9m4 0h3"/><circle cx="10" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  star: '<path d="m12 3 2.75 5.57 6.15.9-4.45 4.33 1.05 6.12L12 17.03l-5.5 2.9 1.05-6.13L3.1 9.47l6.15-.9z"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3c-1 0-2-.2-3-.5L5 21l.9-4A8.2 8.2 0 0 1 4 11.5a8.5 8.5 0 0 1 17 0Z"/><path d="M9 11.5h.1m3.4 0h.1m3.4 0h.1" stroke-width="2.7"/>',
  minus: '<path d="M5 12h14"/>',
  expand: '<path d="M5 10V5h5m4 0h5v5m0 4v5h-5m-4 0H5v-5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
} as const;

export function icon(name: keyof typeof paths, size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

export function escapeHtml(value: string) {
  const replacements: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return value.replace(/[&<>"']/g, (character) => replacements[character]);
}

export function elapsed(start: number, stop = Date.now()) {
  const seconds = Math.max(0, Math.floor((stop - start) / 1000));
  const parts = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
  return parts.map((part) => String(part).padStart(2, "0")).join(":");
}

export function message(error: unknown, fallback = "操作未完成") {
  if (!(error instanceof Error)) return fallback;
  const details = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  return details ? details.slice(0, 180) : fallback;
}
