import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { readBody } from "../src/http/body.js";
import { HttpError } from "../src/http/response.js";
import { isLocalHost } from "../src/http/security.js";

function makeRequest(headers: Record<string, string>): IncomingMessage {
  const request = new EventEmitter() as unknown as IncomingMessage;
  Object.defineProperty(request, "headers", { value: headers });
  return request;
}

describe("http modules", () => {
  it("accepts only loopback hostnames", () => {
    expect(isLocalHost("127.0.0.1:8123")).toBe(true);
    expect(isLocalHost("localhost:8123")).toBe(true);
    expect(isLocalHost("[::1]:8123")).toBe(true);
    expect(isLocalHost("evil.com")).toBe(false);
    expect(isLocalHost(undefined)).toBe(false);
  });

  it("parses an empty request body as an empty object", async () => {
    const request = makeRequest({});
    const body = readBody(request);
    request.emit("end");
    await expect(body).resolves.toEqual({});
  });

  it("rejects invalid JSON with the original status code", async () => {
    const request = makeRequest({ "content-length": "9" });
    const body = readBody(request);
    request.emit("data", Buffer.from("{invalid"));
    request.emit("end");
    await expect(body).rejects.toMatchObject({
      status: 400,
      message: "invalid JSON body",
    });
  });

  it("rejects an oversized body before reading it", async () => {
    const request = makeRequest({ "content-length": String(1024 * 1024 + 1) });
    await expect(readBody(request)).rejects.toBeInstanceOf(HttpError);
  });
});
