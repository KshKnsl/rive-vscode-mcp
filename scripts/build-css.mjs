import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = `
@import "tailwindcss" source(none);

@source "./src/rivePreview.ts";
@source "./assets/rive-preview.js";

:root {
  color-scheme: light dark;
  --page: var(--vscode-editor-background, #17181d);
  --surface: var(--vscode-sideBar-background, #1d1e24);
  --raised: var(--vscode-editorWidget-background, #25262d);
  --border: var(--vscode-panel-border, #343640);
  --text: var(--vscode-foreground, #e6e7eb);
  --muted: var(--vscode-descriptionForeground, #a0a3ad);
  --accent: var(--vscode-button-background, #6557e8);
  --accent-text: var(--vscode-button-foreground, #fff);
  --input: var(--vscode-input-background, #24252d);
  --focus: var(--vscode-focusBorder, #9185ff);
  --link: var(--vscode-textLink-foreground, #aaa0ff);
  --mono: var(--vscode-editor-font-family, ui-monospace, monospace);
  --status-ok: var(--vscode-testing-iconPassed, #7ac99a);
  --status-loading: var(--vscode-testing-iconQueued, #d6a948);
  --status-error: var(--vscode-testing-iconFailed, #e36b6b);
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation: none !important;
    transition-duration: 0.01ms !important;
  }
}

.timeline-range {
  appearance: none;
  height: 12px;
  margin: 0;
  border-radius: 9999px;
  background: transparent;
  outline: none;
}

.timeline-range::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 9999px;
  background: linear-gradient(
    to right,
    var(--accent) var(--timeline-progress, 0%),
    color-mix(in srgb, var(--border) 80%, transparent) var(--timeline-progress, 0%)
  );
}

.timeline-range::-moz-range-track {
  height: 4px;
  border-radius: 9999px;
  background: color-mix(in srgb, var(--border) 80%, transparent);
}

.timeline-range::-moz-range-progress {
  height: 4px;
  border-radius: 9999px;
  background: var(--accent);
}

.timeline-range::-webkit-slider-thumb {
  appearance: none;
  width: 10px;
  height: 10px;
  margin-top: -3px;
  border: 2px solid var(--surface);
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.timeline-range::-moz-range-thumb {
  width: 8px;
  height: 8px;
  border: 2px solid var(--surface);
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.timeline-range:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus) 45%, transparent);
}

.timeline-range:focus-visible::-moz-range-thumb {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus) 45%, transparent);
}

@theme inline {
  --color-page: var(--page);
  --color-surface: var(--surface);
  --color-raised: var(--raised);
  --color-border: var(--border);
  --color-text: var(--text);
  --color-muted: var(--muted);
  --color-accent: var(--accent);
  --color-accent-text: var(--accent-text);
  --color-input: var(--input);
  --color-focus: var(--focus);
  --color-link: var(--link);
  --font-sans: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  --font-mono: var(--mono);
}

@keyframes status-pulse {
  50% {
    opacity: 0.35;
  }
}
`;

const args = [
  path.join(root, "node_modules", "@tailwindcss", "cli", "dist", "index.mjs"),
  "-i",
  "-",
  "-o",
  path.join(root, "assets", "rive-preview-style.css"),
  "--cwd",
  root,
  "--minify",
];

if (process.argv.includes("--watch")) {
  args.push("--watch=always");
}

const build = spawn(process.execPath, args, { cwd: root, stdio: ["pipe", "inherit", "inherit"] });
build.stdin.end(source);
build.on("error", (error) => {
  console.error("Could not start the Tailwind CSS build.", error);
  process.exitCode = 1;
});
build.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
