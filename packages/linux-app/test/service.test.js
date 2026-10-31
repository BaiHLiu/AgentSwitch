import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { consoleLink, localPort, ownPage, readToken, serviceBase } from "../lib/service.js";

const home = () => mkdtempSync(join(tmpdir(), "agentswitch-linux-app-"));

test("the local port is node.json's, else 4711; an address given overrides it", () => {
  const h = home();
  assert.equal(localPort(h), 4711);
  writeFileSync(join(h, "node.json"), JSON.stringify({ ports: { local: 5711 } }));
  assert.equal(localPort(h), 5711);
  assert.equal(serviceBase({}, h), "http://127.0.0.1:5711");
  writeFileSync(join(h, "node.json"), JSON.stringify({ ports: { local: 80 } }));
  assert.equal(localPort(h), 4711);
  writeFileSync(join(h, "node.json"), "{ not json");
  assert.equal(localPort(h), 4711);
  assert.equal(serviceBase({ AGENTSWITCH_URL: "http://127.0.0.1:6000/" }, h), "http://127.0.0.1:6000");
});

test("the token is read as the file holds it", () => {
  const h = home();
  assert.throws(() => readToken(h));
  writeFileSync(join(h, "local-token"), "abc\n");
  assert.equal(readToken(h), "abc");
});

test("signing in asks for a one-time link with the token, and takes only a sign-in link back", async () => {
  const asked = [];
  const fetch = async (url, init) => { asked.push([url, init.headers.authorization]); return new Response(JSON.stringify({ path: "/ui/login?code=x&next=%2Fui%2Fterminal.html" })); };
  const link = await consoleLink({ base: "http://127.0.0.1:4711", token: "tok", next: "/ui/terminal.html?id=ab", fetch });
  assert.equal(link, "http://127.0.0.1:4711/ui/login?code=x&next=%2Fui%2Fterminal.html");
  assert.deepEqual(asked, [["http://127.0.0.1:4711/local/console-link?next=%2Fui%2Fterminal.html%3Fid%3Dab", "Bearer tok"]]);
  await assert.rejects(consoleLink({ base: "http://x", token: "t", fetch: async () => new Response(JSON.stringify({ path: "https://evil/" })) }));
  await assert.rejects(consoleLink({ base: "http://x", token: "t", fetch: async () => new Response("no", { status: 401 }) }));
});

test("only the service's own pages are the window's", () => {
  assert.equal(ownPage("http://127.0.0.1:4711", "http://127.0.0.1:4711/ui/terminal.html"), true);
  assert.equal(ownPage("http://127.0.0.1:4711", "http://127.0.0.1:4712/"), false);
  assert.equal(ownPage("http://127.0.0.1:4711", "https://example.com/"), false);
  assert.equal(ownPage("http://127.0.0.1:4711", "not a url"), false);
});
