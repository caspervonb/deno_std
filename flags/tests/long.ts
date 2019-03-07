// Copyright 2018-2019 the Deno authors. All rights reserved. MIT license.
import { test } from "../../testing/mod.ts";
import { assertEquals } from "../../testing/asserts.ts";
import { parse } from "../mod.ts";

test(function longOpts() {
  assertEquals(parse(["--bool"]), { bool: true, _: [] });
  assertEquals(parse(["--pow", "xixxle"]), { pow: "xixxle", _: [] });
  assertEquals(parse(["--pow=xixxle"]), { pow: "xixxle", _: [] });
  assertEquals(parse(["--host", "localhost", "--port", "555"]), {
    host: "localhost",
    port: 555,
    _: []
  });
  assertEquals(parse(["--host=localhost", "--port=555"]), {
    host: "localhost",
    port: 555,
    _: []
  });
});
