// @ts-check
const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");

const isWatch = process.argv.includes("--watch");
const isProduction = process.argv.includes("--production");

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !isProduction,
  minify: isProduction,
};

/** @type {esbuild.BuildOptions} */
const webviewConfig = {
  entryPoints: ["src/webview/index.ts"],
  bundle: true,
  outfile: "dist/webview.js",
  format: "iife",
  platform: "browser",
  target: "es2020",
  sourcemap: !isProduction,
  minify: isProduction,
  // Import .css files as plain text strings so the webview can inject them.
  loader: { ".css": "text" },
};

function copyAssets() {
  const assetsDir = path.join(__dirname, "assets");
  const distDir = path.join(__dirname, "dist");

  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  if (fs.existsSync(assetsDir)) {
    const files = fs.readdirSync(assetsDir);
    for (const file of files) {
      fs.copyFileSync(
        path.join(assetsDir, file),
        path.join(distDir, file)
      );
    }
  }
}

async function build() {
  copyAssets();

  if (isWatch) {
    const extCtx = await esbuild.context(extensionConfig);
    const webCtx = await esbuild.context(webviewConfig);

    await extCtx.watch();
    await webCtx.watch();

    console.log("[valt] Watching for changes...");
  } else {
    await esbuild.build(extensionConfig);
    await esbuild.build(webviewConfig);
    console.log("[valt] Build complete.");
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
