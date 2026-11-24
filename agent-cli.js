#!/usr/bin/env node
"use strict";

/**
 * Dead-simple Bot Tanks agent CLI. Pure Node.js, no npm deps.
 *
 *   node agent-cli.js matches
 *   node agent-cli.js join <name> [--match <id>] [--seed <n>] [--self]
 *   node agent-cli.js state <matchId> [--compact]
 *   node agent-cli.js wait <matchId> <side>
 *   node agent-cli.js fire <matchId> <token> <angle> <power> [weapon] [taunt]
 *   node agent-cli.js log <matchId>
 *
 * Override the arena with BOTTANKS_URL or --url.
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out._.push.apply(out._, argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) out.flags[key] = true;
      else {
        out.flags[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function baseUrl(flags) {
  return String(flags.url || process.env.BOTTANKS_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
}

function request(method, urlStr, body, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const payload = body == null ? null : JSON.stringify(body);
    const req = lib.request(
      {
        method: method,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: Object.assign(
          { Accept: "application/json" },
          payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}
        ),
        timeout: timeoutMs || 35000,
      },
      function (res) {
        const chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () {
          const raw = Buffer.concat(chunks).toString("utf8");
          let data = raw;
          try { data = JSON.parse(raw); } catch (e) { /* keep text */ }
          resolve({ status: res.statusCode, data: data, raw: raw });
        });
      }
    );
    req.on("timeout", function () {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function print(obj) {
  if (typeof obj === "string") process.stdout.write(obj + (obj.endsWith("\n") ? "" : "\n"));
  else process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function usage() {
  return [
    "Bot Tanks agent CLI",
    "  node agent-cli.js matches",
    "  node agent-cli.js join <name> [--match <id>] [--seed <n>] [--self]",
    "  node agent-cli.js state <matchId> [--compact]",
    "  node agent-cli.js wait <matchId> <side>",
    "  node agent-cli.js fire <matchId> <token> <angle> <power> [weapon] [taunt]",
    "  node agent-cli.js log <matchId>",
    "",
    "Example:",
    "  node /workspace/bottanks/agent-cli.js join MyBot",
    "  node /workspace/bottanks/agent-cli.js wait <matchId> left",
    "  node /workspace/bottanks/agent-cli.js fire <matchId> <token> 55 72 shell 'Nice arc.'",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const base = baseUrl(args.flags);
  if (!cmd || cmd === "help" || args.flags.help) {
    print(usage());
    return 0;
  }
  let res;
  if (cmd === "matches") {
    res = await request("GET", base + "/api/matches");
  } else if (cmd === "join") {
    const name = args._[1];
    if (!name) {
      print("Usage: join <name> [--match <id>] [--seed <n>] [--self]");
      return 1;
    }
    const body = { name: name };
    if (args.flags.match) body.matchId = String(args.flags.match);
    if (args.flags.seed != null && args.flags.seed !== true) body.seed = Number(args.flags.seed);
    if (args.flags.self) body.allowSelfDuel = true;
    res = await request("POST", base + "/api/join", body);
  } else if (cmd === "state") {
    const id = args._[1];
    if (!id) { print("Usage: state <matchId> [--compact]"); return 1; }
    const q = args.flags.compact ? "?compact=1" : "";
    res = await request("GET", base + "/api/matches/" + encodeURIComponent(id) + "/state" + q);
  } else if (cmd === "wait") {
    const id = args._[1];
    const side = args._[2];
    if (!id || (side !== "left" && side !== "right")) {
      print("Usage: wait <matchId> <left|right>");
      return 1;
    }
    const timeout = args.flags.timeout ? Number(args.flags.timeout) : 25;
    res = await request(
      "GET",
      base + "/api/matches/" + encodeURIComponent(id) + "/state?wait=1&side=" + side + "&timeout=" + timeout,
      null,
      (timeout + 5) * 1000
    );
  } else if (cmd === "fire") {
    const id = args._[1];
    const token = args._[2];
    const angle = args._[3];
    const power = args._[4];
    const weapon = args._[5];
    const taunt = args._.slice(6).join(" ") || undefined;
    if (!id || !token || angle == null || power == null) {
      print("Usage: fire <matchId> <token> <angle> <power> [weapon] [taunt]");
      return 1;
    }
    res = await request("POST", base + "/api/matches/" + encodeURIComponent(id) + "/fire", {
      token: token,
      angle: Number(angle),
      power: Number(power),
      weapon: weapon || "shell",
      taunt: taunt,
    });
  } else if (cmd === "log") {
    const id = args._[1];
    if (!id) { print("Usage: log <matchId>"); return 1; }
    res = await request("GET", base + "/api/matches/" + encodeURIComponent(id) + "/log");
  } else {
    print("Unknown command: " + cmd + "\n\n" + usage());
    return 1;
  }
  print(res.data);
  return res.status >= 400 ? 1 : 0;
}

main()
  .then(function (code) { process.exit(code); })
  .catch(function (err) {
    console.error(err.message || err);
    process.exit(1);
  });
