import { expect, test, vi } from "vitest";

vi.mock("node-pty", () => {
  throw new Error("A core socket client must not load the native pane host addon.");
});

test("the client entrypoint loads in a service that has no native PTY addon", async () => {
  const client = await import("../src/client-entry.js");
  expect(client.CliHostClient).toBeTypeOf("function");
  expect(client.CliHostError).toBeTypeOf("function");
  expect(client.maskUploadPaths).toBeTypeOf("function");
});
