import * as fs from "node:fs/promises";

// Use no subprocesses or runtime asset requests: the result also opens via file:.
let html = await fs.readFile("index.html", "utf8");
const script = await fs.readFile("dist/sandstone_frontend.js", "utf8");
const style = await fs.readFile("resources/main.css", "utf8");
const logo = await fs.readFile("resources/logo_128.png");
html = html.replace('<script src="dist/sandstone_frontend.js" defer></script>', () =>
  `<script>${script.replace(/<\/script/gi, "<\\/script")}</script>`);
html = html.replace('<link rel="stylesheet" href="resources/main.css">', () =>
  `<style>${style.replace(/<\/style/gi, "<\\/style")}</style>`);
html = html.replaceAll("resources/logo_128.png", `data:image/png;base64,${logo.toString("base64")}`);
await fs.writeFile("bundled.html", html);
