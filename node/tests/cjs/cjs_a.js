// deno-lint-ignore-file no-undef
/* eslint-disable */
const { helloB } = require("./cjs_b.js");
const C = require("./subdir/cjs_c");
const leftPad = require("left-pad");

function helloA() {
  return "A";
}

module.exports = { helloA, helloB, C, leftPad };
