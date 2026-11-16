import { server as wisp } from "@mercuryworkshop/wisp-js/server";
import express from "express";
import morgan from "morgan";
import {create_relay_server} from './http.mjs';

const app = express();
const port = process.env.PORT || 5001;
const host = process.env.HOST || "0.0.0.0";

app.use(morgan("combined"));
app.use(express.static("./"));

const server = create_relay_server(app);
server.listen(port, host, () => {
  console.log(`Listening on: ${host}:${port}`)
});

server.on("upgrade", (request, socket, head) => {
  wisp.routeRequest(request, socket, head);
});
