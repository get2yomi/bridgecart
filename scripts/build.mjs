import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

const [template, html, css, app, manifest] = await Promise.all([
  readFile("worker/index.template.js", "utf8"),
  readFile("site/index.html", "utf8"),
  readFile("site/styles.css", "utf8"),
  readFile("site/app.js", "utf8"),
  readFile(".openai/hosting.json", "utf8")
]);

const output = template
  .replace("__HTML__", JSON.stringify(html))
  .replace("__CSS__", JSON.stringify(css))
  .replace("__APP__", JSON.stringify(app));

await rm("dist", { recursive: true, force: true });
await mkdir("dist/server", { recursive: true });
await mkdir("dist/.openai", { recursive: true });
await writeFile("dist/server/index.js", output);
await writeFile("dist/.openai/hosting.json", manifest);
