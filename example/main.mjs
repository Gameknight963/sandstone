import * as sandstone from "../dist/sandstone.mjs";
import resources from "./resources/index.mjs";

const from_id = (id) => document.getElementById(id);

const favicon_img = from_id("favicon_img");
const favicon_text = from_id("favicon_text");
const navigate_button = from_id("navigate_button");
const url_box = from_id("url_box");
const frame_container = from_id("frame_container");
const version_text = from_id("version_text");
const options_button = from_id("options_button");
const options_div = from_id("options_div");
const wisp_url_input = from_id("wisp_url_input");
const close_options_button = from_id("close_options_button");
const eval_js_input = from_id("eval_js_input");
const eval_js_button = from_id("eval_js_button");
const theme_select = from_id("theme_select");
const allow_webrtc_input = from_id('allow_webrtc_input');
const site_data = sandstone.controller.site_data;
const indexed_db = sandstone.controller.indexed_db;
const cache_storage=sandstone.controller.cache_storage;
const file_system=sandstone.controller.file_system;
const service_workers=sandstone.service_workers;
let favicon_blob_url;
let data_render_id = 0;

function apply_theme(value) {
  theme_select.value = value;
  if (value === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = value;
  try { localStorage.setItem("sandstone_theme", value); } catch {}
}

function apply_webrtc(allowed){
  main_frame.default_settings.allow_webrtc=allowed===true;
  allow_webrtc_input.checked=allowed===true;
  try{localStorage.setItem('sandstone_allow_webrtc',allowed===true?'true':'false');}catch{}
}

function set_ui_hidden(hidden) {
  from_id("address_bar").hidden = hidden;
  from_id("show_ui_button").hidden = !hidden;
  if (hidden && options_div.style.display !== "none") toggle_options();
  if (!hidden) url_box.focus();
}

async function render_site_data() {
  const render_id = ++data_render_id;
  await Promise.all([indexed_db.catalog(),cache_storage.catalog(),service_workers.registrations.catalog(),file_system.storage.catalog()]);
  if (render_id !== data_render_id) return;
  const list = from_id("site_data_list");
  list.replaceChildren();
  from_id("storage_status").textContent =
    (site_data.persistent ? "Cookies and local storage are saved. " : "Cookies and local storage last until this file is closed. ") +
    (indexed_db.persistent ? "Databases are saved in this browser. " : "Databases last until this file is closed. ") +
    (cache_storage.persistent ? 'Caches are saved in this browser. ' : 'Caches last until this file is closed. ') +
    (service_workers.registrations.persistent ? 'Service workers are saved in this browser. ' : 'Service workers last until this file is closed. ') +
    (file_system.storage.persistent ? 'Files are saved in this browser. ' : 'Files last until this file is closed. ') +
    "Session cookies expire when this file is closed.";
  const sites = site_data.list();
  if (!sites.length) list.textContent = "No stored site data.";
  for (const site of sites) {
    const row = document.createElement("div");
    row.className = "site_data_row";
    const label = document.createElement("span");
    label.textContent = `${site.hostname}: ${site.cookies} cookies, ${site.localStorage} local storage entries, ${site.indexedDB} databases, ${site.cacheStorage||0} caches, ${site.serviceWorkers||0} service workers, ${site.files||0} files`;
    row.append(label);
    for (const [text, selection] of [
      ["Clear cookies", {cookies: true, localStorage: false, indexedDB: false}],
      ["Clear local storage", {cookies: false, localStorage: true, indexedDB: false}],
      ["Clear IndexedDB", {cookies: false, localStorage: false, indexedDB: true}],
      ['Clear caches',{cookies:false,localStorage:false,indexedDB:false,cacheStorage:true}],
      ['Clear service workers',{cookies:false,localStorage:false,indexedDB:false,serviceWorkers:true}],
      ['Clear files',{cookies:false,localStorage:false,indexedDB:false,fileSystems:true}],
      ["Clear all", {cookies: true, localStorage: true, indexedDB: true,cacheStorage:true,serviceWorkers:true,fileSystems:true}]
    ]) {
      const button = document.createElement("button");
      button.textContent = text;
      button.onclick = async () => {
        // Discard the current runtime before deletion so it cannot write stale data back.
        const current = main_frame.url;
        const affects_current = current && sandstone.controller.prepare_site_data_clear(site.hostname,selection,main_frame.id);
        if (affects_current) main_frame.iframe.src = "about:blank";
        if(selection.serviceWorkers)await service_workers.clear_registrations(site.hostname);
        if (selection.indexedDB) await indexed_db.clear(site.hostname);
        if(selection.cacheStorage)await cache_storage.clear(site.hostname);
        if(selection.fileSystems)await file_system.clear(site.hostname);
        site_data.clear(site.hostname, selection);
        await render_site_data();
        if (affects_current) await main_frame.navigate_to(current.href, null, {history_mode: "reload"});
      };
      row.append(button);
    }
    list.append(row);
  }
}

const main_frame = new sandstone.controller.ProxyFrame();
globalThis.sandstone = sandstone;
globalThis.main_frame = main_frame;

main_frame.special_pages = {
  "sandstone://home": null,
};

main_frame.on_navigate = () => {
  url_box.value = main_frame.url.href;
  favicon_img.style.display = "none";
  favicon_text.style.display = "initial";
}

main_frame.on_load = async () => {
  url_box.value = main_frame.url.href;
  let favicon_url = await main_frame.get_favicon();
  if (!favicon_url.startsWith("data:")) {
    let response = await sandstone.network.fetch(favicon_url,{mode:'no-cors',destination:'image',referrerPolicy:main_frame.referrer_policy},
      {url:main_frame.url.href,top_url:main_frame.url.href,broadcast_origin:main_frame.broadcast_origin});
    if (!response.ok) return;
    let favicon = await response.blob();
    if (favicon_blob_url) URL.revokeObjectURL(favicon_blob_url);
    favicon_url = favicon_blob_url = URL.createObjectURL(favicon);
  }
  favicon_img.src = favicon_url;
  favicon_img.style.display = "initial";
  favicon_text.style.display = "none";  
}

main_frame.on_url_change = () => {
  url_box.value = main_frame.url.href;
}

async function navigate_clicked() {
  let url = url_box.value;
  if (!url.startsWith("http:") && !url.startsWith("https:") && !url.startsWith("sandstone:")) 
    url_box.value = "https://" + url;
  await main_frame.navigate_to(url_box.value);
}

function toggle_options() {
  options_div.style.display = options_div.style.display === "none" ? "flex" : "none";
  frame_container.style.filter = frame_container.style.filter ? "" : "brightness(50%)";
  
  //apply options
  sandstone.libcurl.set_websocket(wisp_url_input.value);
  if (options_div.style.display !== "none") render_site_data();
}

async function create_homepage() {
  let parser = new DOMParser();
  let html = parser.parseFromString(resources["home.html"], "text/html");

  let icon_element = document.querySelector("link[rel='icon']");
  let icon_url = icon_element.href;

  if (!icon_url.startsWith("data:")) {
    let response = await fetch(icon_url);
    let icon_blob = await response.blob();
    icon_url = await new Promise((resolve) => {
      var reader = new FileReader();
      reader.onload = (event) => {resolve(event.target.result)}
      reader.readAsDataURL(icon_blob);
    });
  }

  html.querySelector("link[rel='icon']").href = icon_url;
  html.getElementById("main_img").src = icon_url;
  html.getElementById("sandstone_version").textContent = version_text.textContent;

  let homepage_html = "<!DOCTYPE html>" + html.documentElement.outerHTML;
  main_frame.special_pages["sandstone://home"] = homepage_html;
}

async function main() {
  let theme = "system";
  try { theme = localStorage.getItem("sandstone_theme") || theme; } catch {}
  apply_theme(["system", "light", "dark"].includes(theme) ? theme : "system");
  theme_select.onchange = () => apply_theme(theme_select.value);
  let allow_webrtc=false;
  try{allow_webrtc=localStorage.getItem('sandstone_allow_webrtc')==='true';}catch{}
  apply_webrtc(allow_webrtc);
  allow_webrtc_input.onchange=async()=>{
    apply_webrtc(allow_webrtc_input.checked);
    const status=from_id('webrtc_status');status.textContent='';
    if(main_frame.url)try{await main_frame.navigate_to(main_frame.url.href,null,{history_mode:'reload'});}
    catch(error){status.textContent='Could not reload the site: '+error.message;}
  };
  from_id("hide_ui_button").onclick = () => set_ui_hidden(true);
  from_id("show_ui_button").onclick = () => set_ui_hidden(false);
  from_id("site_data_details").ontoggle = render_site_data;
  if (location.hash)
    url_box.value = location.hash.substring(1);

  let wisp_url = "wss://wisp.mercurywork.shop/";
  if (location.hostname.endsWith(".pages.dev") || (location.protocol !== "http:" && location.protocol !== "https:")) 
    sandstone.libcurl.set_websocket(wisp_url);
  else {
    wisp_url = location.origin.replace("http", "ws");
    sandstone.libcurl.set_websocket(wisp_url);
  }

  version_text.textContent = `v${sandstone.version.ver} (${sandstone.version.hash})`;
  wisp_url_input.value = wisp_url;
  options_button.onclick = toggle_options;
  close_options_button.onclick = toggle_options;
  document.body.onkeydown = (event) => {
    if (event.key !== "Escape") return;
    if (options_div.style.display === "none") return;
    toggle_options();
  }

  eval_js_button.onclick = () => {
    main_frame.eval_js(eval_js_input.value);
  }

  await create_homepage();
  
  navigate_button.onclick = navigate_clicked;
  url_box.onkeydown = (event) => {
    if (event.code === "Enter") {
      navigate_clicked();
    }
  }
  frame_container.append(main_frame.iframe);
  await navigate_clicked();

  frame_container.style.backgroundColor = "unset";
}

main();
