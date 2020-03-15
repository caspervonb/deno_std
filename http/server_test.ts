// Copyright 2010 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

// Ported from
// https://github.com/golang/go/blob/master/src/net/http/responsewrite_test.go

import { TextProtoReader } from "../textproto/mod.ts";
import { assert, assertEquals, assertNotEOF } from "../testing/asserts.ts";
import { Response, ServerRequest, serve } from "./server.ts";
import { BufReader, BufWriter } from "../io/bufio.ts";
import { delay, deferred } from "../util/async.ts";
import { encode, decode } from "../strings/mod.ts";
import { mockConn } from "./mock.ts";

const { Buffer, test } = Deno;

interface ResponseTest {
  response: Response;
  raw: string;
}

const responseTests: ResponseTest[] = [
  // Default response
  {
    response: {},
    raw: "HTTP/1.1 200 OK\r\n" + "content-length: 0" + "\r\n\r\n"
  },
  // Empty body with status
  {
    response: {
      status: 404
    },
    raw: "HTTP/1.1 404 Not Found\r\n" + "content-length: 0" + "\r\n\r\n"
  },
  // HTTP/1.1, chunked coding; empty trailer; close
  {
    response: {
      status: 200,
      body: new Buffer(new TextEncoder().encode("abcdef"))
    },

    raw:
      "HTTP/1.1 200 OK\r\n" +
      "transfer-encoding: chunked\r\n\r\n" +
      "6\r\nabcdef\r\n0\r\n\r\n"
  }
];

test(async function responseWrite(): Promise<void> {
  for (const testCase of responseTests) {
    const buf = new Buffer();
    const bufw = new BufWriter(buf);
    const request = new ServerRequest();
    request.w = bufw;

    request.conn = mockConn();

    await request.respond(testCase.response);
    assertEquals(buf.toString(), testCase.raw);
    await request.done;
  }
});

test(async function requestContentLength(): Promise<void> {
  // Has content length
  {
    const req = new ServerRequest();
    req.headers = new Headers();
    req.headers.set("content-length", "5");
    const buf = new Buffer(encode("Hello"));
    req.r = new BufReader(buf);
    assertEquals(req.contentLength, 5);
  }
  // No content length
  {
    const shortText = "Hello";
    const req = new ServerRequest();
    req.headers = new Headers();
    req.headers.set("transfer-encoding", "chunked");
    let chunksData = "";
    let chunkOffset = 0;
    const maxChunkSize = 70;
    while (chunkOffset < shortText.length) {
      const chunkSize = Math.min(maxChunkSize, shortText.length - chunkOffset);
      chunksData += `${chunkSize.toString(16)}\r\n${shortText.substr(
        chunkOffset,
        chunkSize
      )}\r\n`;
      chunkOffset += chunkSize;
    }
    chunksData += "0\r\n\r\n";
    const buf = new Buffer(encode(chunksData));
    req.r = new BufReader(buf);
    assertEquals(req.contentLength, null);
  }
});

interface TotalReader extends Deno.Reader {
  total: number;
}
function totalReader(r: Deno.Reader): TotalReader {
  let _total = 0;
  async function read(p: Uint8Array): Promise<number | Deno.EOF> {
    const result = await r.read(p);
    if (typeof result === "number") {
      _total += result;
    }
    return result;
  }
  return {
    read,
    get total(): number {
      return _total;
    }
  };
}
test(async function requestBodyWithContentLength(): Promise<void> {
  {
    const req = new ServerRequest();
    req.headers = new Headers();
    req.headers.set("content-length", "5");
    const buf = new Buffer(encode("Hello"));
    req.r = new BufReader(buf);
    const body = decode(await Deno.readAll(req.body));
    assertEquals(body, "Hello");
  }

  // Larger than internal buf
  {
    const longText = "1234\n".repeat(1000);
    const req = new ServerRequest();
    req.headers = new Headers();
    req.headers.set("Content-Length", "5000");
    const buf = new Buffer(encode(longText));
    req.r = new BufReader(buf);
    const body = decode(await Deno.readAll(req.body));
    assertEquals(body, longText);
  }
  // Handler ignored to consume body
});
test("ServerRequest.finalize() should consume unread body / content-length", async () => {
  const text = "deno.land";
  const req = new ServerRequest();
  req.headers = new Headers();
  req.headers.set("content-length", "" + text.length);
  const tr = totalReader(new Buffer(encode(text)));
  req.r = new BufReader(tr);
  req.w = new BufWriter(new Buffer());
  await req.respond({ status: 200, body: "ok" });
  assertEquals(tr.total, 0);
  await req.finalize();
  assertEquals(tr.total, text.length);
});
test("ServerRequest.finalize() should consume unread body / chunked, trailers", async () => {
  const text = [
    "5",
    "Hello",
    "4",
    "Deno",
    "0",
    "",
    "deno: land",
    "node: js",
    "",
    ""
  ].join("\r\n");
  const req = new ServerRequest();
  req.headers = new Headers();
  req.headers.set("transfer-encoding", "chunked");
  req.headers.set("trailer", "deno,node");
  const body = encode(text);
  const tr = totalReader(new Buffer(body));
  req.r = new BufReader(tr);
  req.w = new BufWriter(new Buffer());
  await req.respond({ status: 200, body: "ok" });
  assertEquals(tr.total, 0);
  assertEquals(req.headers.has("trailer"), true);
  assertEquals(req.headers.has("deno"), false);
  assertEquals(req.headers.has("node"), false);
  await req.finalize();
  assertEquals(tr.total, body.byteLength);
  assertEquals(req.headers.has("trailer"), false);
  assertEquals(req.headers.get("deno"), "land");
  assertEquals(req.headers.get("node"), "js");
});
test(async function requestBodyWithTransferEncoding(): Promise<void> {
  {
    const shortText = "Hello";
    const req = new ServerRequest();
    req.headers = new Headers();
    req.headers.set("transfer-encoding", "chunked");
    let chunksData = "";
    let chunkOffset = 0;
    const maxChunkSize = 70;
    while (chunkOffset < shortText.length) {
      const chunkSize = Math.min(maxChunkSize, shortText.length - chunkOffset);
      chunksData += `${chunkSize.toString(16)}\r\n${shortText.substr(
        chunkOffset,
        chunkSize
      )}\r\n`;
      chunkOffset += chunkSize;
    }
    chunksData += "0\r\n\r\n";
    const buf = new Buffer(encode(chunksData));
    req.r = new BufReader(buf);
    const body = decode(await Deno.readAll(req.body));
    assertEquals(body, shortText);
  }

  // Larger than internal buf
  {
    const longText = "1234\n".repeat(1000);
    const req = new ServerRequest();
    req.headers = new Headers();
    req.headers.set("transfer-encoding", "chunked");
    let chunksData = "";
    let chunkOffset = 0;
    const maxChunkSize = 70;
    while (chunkOffset < longText.length) {
      const chunkSize = Math.min(maxChunkSize, longText.length - chunkOffset);
      chunksData += `${chunkSize.toString(16)}\r\n${longText.substr(
        chunkOffset,
        chunkSize
      )}\r\n`;
      chunkOffset += chunkSize;
    }
    chunksData += "0\r\n\r\n";
    const buf = new Buffer(encode(chunksData));
    req.r = new BufReader(buf);
    const body = decode(await Deno.readAll(req.body));
    assertEquals(body, longText);
  }
});

test(async function requestBodyReaderWithContentLength(): Promise<void> {
  {
    const shortText = "Hello";
    const req = new ServerRequest();
    req.headers = new Headers();
    req.headers.set("content-length", "" + shortText.length);
    const buf = new Buffer(encode(shortText));
    req.r = new BufReader(buf);
    const readBuf = new Uint8Array(6);
    let offset = 0;
    while (offset < shortText.length) {
      const nread = await req.body.read(readBuf);
      assertNotEOF(nread);
      const s = decode(readBuf.subarray(0, nread as number));
      assertEquals(shortText.substr(offset, nread as number), s);
      offset += nread as number;
    }
    const nread = await req.body.read(readBuf);
    assertEquals(nread, Deno.EOF);
  }

  // Larger than given buf
  {
    const longText = "1234\n".repeat(1000);
    const req = new ServerRequest();
    req.headers = new Headers();
    req.headers.set("Content-Length", "5000");
    const buf = new Buffer(encode(longText));
    req.r = new BufReader(buf);
    const readBuf = new Uint8Array(1000);
    let offset = 0;
    while (offset < longText.length) {
      const nread = await req.body.read(readBuf);
      assertNotEOF(nread);
      const s = decode(readBuf.subarray(0, nread as number));
      assertEquals(longText.substr(offset, nread as number), s);
      offset += nread as number;
    }
    const nread = await req.body.read(readBuf);
    assertEquals(nread, Deno.EOF);
  }
});

test(async function requestBodyReaderWithTransferEncoding(): Promise<void> {
  {
    const shortText = "Hello";
    const req = new ServerRequest();
    req.headers = new Headers();
    req.headers.set("transfer-encoding", "chunked");
    let chunksData = "";
    let chunkOffset = 0;
    const maxChunkSize = 70;
    while (chunkOffset < shortText.length) {
      const chunkSize = Math.min(maxChunkSize, shortText.length - chunkOffset);
      chunksData += `${chunkSize.toString(16)}\r\n${shortText.substr(
        chunkOffset,
        chunkSize
      )}\r\n`;
      chunkOffset += chunkSize;
    }
    chunksData += "0\r\n\r\n";
    const buf = new Buffer(encode(chunksData));
    req.r = new BufReader(buf);
    const readBuf = new Uint8Array(6);
    let offset = 0;
    while (offset < shortText.length) {
      const nread = await req.body.read(readBuf);
      assertNotEOF(nread);
      const s = decode(readBuf.subarray(0, nread as number));
      assertEquals(shortText.substr(offset, nread as number), s);
      offset += nread as number;
    }
    const nread = await req.body.read(readBuf);
    assertEquals(nread, Deno.EOF);
  }

  // Larger than internal buf
  {
    const longText = "1234\n".repeat(1000);
    const req = new ServerRequest();
    req.headers = new Headers();
    req.headers.set("transfer-encoding", "chunked");
    let chunksData = "";
    let chunkOffset = 0;
    const maxChunkSize = 70;
    while (chunkOffset < longText.length) {
      const chunkSize = Math.min(maxChunkSize, longText.length - chunkOffset);
      chunksData += `${chunkSize.toString(16)}\r\n${longText.substr(
        chunkOffset,
        chunkSize
      )}\r\n`;
      chunkOffset += chunkSize;
    }
    chunksData += "0\r\n\r\n";
    const buf = new Buffer(encode(chunksData));
    req.r = new BufReader(buf);
    const readBuf = new Uint8Array(1000);
    let offset = 0;
    while (offset < longText.length) {
      const nread = await req.body.read(readBuf);
      assertNotEOF(nread);
      const s = decode(readBuf.subarray(0, nread as number));
      assertEquals(longText.substr(offset, nread as number), s);
      offset += nread as number;
    }
    const nread = await req.body.read(readBuf);
    assertEquals(nread, Deno.EOF);
  }
});

test("destroyed connection", async (): Promise<void> => {
  // Runs a simple server as another process
  const p = Deno.run({
    args: [Deno.execPath(), "--allow-net", "http/testdata/simple_server.ts"],
    stdout: "piped"
  });

  try {
    const r = new TextProtoReader(new BufReader(p.stdout!));
    const s = await r.readLine();
    assert(s !== Deno.EOF && s.includes("server listening"));

    let serverIsRunning = true;
    p.status()
      .then((): void => {
        serverIsRunning = false;
      })
      .catch((_): void => {}); // Ignores the error when closing the process.

    await delay(100);

    // Reqeusts to the server and immediately closes the connection
    const conn = await Deno.connect({ port: 4502 });
    await conn.write(new TextEncoder().encode("GET / HTTP/1.0\n\n"));
    conn.close();

    // Waits for the server to handle the above (broken) request
    await delay(100);

    assert(serverIsRunning);
  } finally {
    // Stops the sever.
    p.close();
  }
});

test("serveTLS", async (): Promise<void> => {
  // Runs a simple server as another process
  const p = Deno.run({
    args: [
      Deno.execPath(),
      "--allow-net",
      "--allow-read",
      "http/testdata/simple_https_server.ts"
    ],
    stdout: "piped"
  });

  try {
    const r = new TextProtoReader(new BufReader(p.stdout!));
    const s = await r.readLine();
    assert(
      s !== Deno.EOF && s.includes("server listening"),
      "server must be started"
    );

    let serverIsRunning = true;
    p.status()
      .then((): void => {
        serverIsRunning = false;
      })
      .catch((_): void => {}); // Ignores the error when closing the process.

    // Requests to the server and immediately closes the connection
    const conn = await Deno.connectTLS({
      hostname: "localhost",
      port: 4503,
      certFile: "http/testdata/tls/RootCA.pem"
    });
    await Deno.writeAll(
      conn,
      new TextEncoder().encode("GET / HTTP/1.0\r\n\r\n")
    );
    const res = new Uint8Array(100);
    const nread = assertNotEOF(await conn.read(res));
    conn.close();
    const resStr = new TextDecoder().decode(res.subarray(0, nread));
    assert(resStr.includes("Hello HTTPS"));
    assert(serverIsRunning);
  } finally {
    // Stops the sever.
    p.close();
  }
});

test("close server while iterating", async (): Promise<void> => {
  const server = serve(":8123");
  const nextWhileClosing = server[Symbol.asyncIterator]().next();
  server.close();
  assertEquals(await nextWhileClosing, { value: undefined, done: true });

  const nextAfterClosing = server[Symbol.asyncIterator]().next();
  assertEquals(await nextAfterClosing, { value: undefined, done: true });
});

// TODO(kevinkassimo): create a test that works on Windows.
// The following test is to ensure that if an error occurs during respond
// would result in connection closed. (such that fd/resource is freed).
// On *nix, a delayed second attempt to write to a CLOSE_WAIT connection would
// receive a RST and thus trigger an error during response for us to test.
// We need to find a way to similarly trigger an error on Windows so that
// we can test if connection is closed.
test({
  skip: Deno.build.os == "win",
  name: "respond error handling",
  async fn(): Promise<void> {
    const connClosedPromise = deferred();
    const serverRoutine = async (): Promise<void> => {
      let reqCount = 0;
      const server = serve(":8124");
      // @ts-ignore
      const serverRid = server.listener["rid"];
      let connRid = -1;
      for await (const req of server) {
        connRid = req.conn.rid;
        reqCount++;
        await Deno.readAll(req.body);
        await connClosedPromise;
        try {
          await req.respond({
            body: new TextEncoder().encode("Hello World")
          });
          await delay(100);
          req.done = deferred();
          // This duplicate respond is to ensure we get a write failure from the
          // other side. Our client would enter CLOSE_WAIT stage after close(),
          // meaning first server .send (.respond) after close would still work.
          // However, a second send would fail under RST, which is similar
          // to the scenario where a failure happens during .respond
          await req.respond({
            body: new TextEncoder().encode("Hello World")
          });
        } catch {
          break;
        }
      }
      server.close();
      const resources = Deno.resources();
      assert(reqCount === 1);
      // Server should be gone
      assert(!(serverRid in resources));
      // The connection should be destroyed
      assert(!(connRid in resources));
    };
    const p = serverRoutine();
    const conn = await Deno.connect({
      hostname: "127.0.0.1",
      port: 8124
    });
    await Deno.writeAll(
      conn,
      new TextEncoder().encode("GET / HTTP/1.1\r\n\r\n")
    );
    conn.close(); // abruptly closing connection before response.
    // conn on server side enters CLOSE_WAIT state.
    connClosedPromise.resolve();
    await p;
  }
});
