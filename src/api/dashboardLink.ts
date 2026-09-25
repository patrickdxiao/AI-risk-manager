import { readLocalToken } from "./apiToken.js";

/** Request a fresh one-use browser link from the running app using its private owner credential. */
export async function requestDashboardLink(input: {
  readonly stateDir: string;
  readonly port: number;
}): Promise<string> {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535)
    throw new TypeError("Use the running app's actual port");
  const origin = `http://127.0.0.1:${String(input.port)}`;
  const token = await readLocalToken(input.stateDir);
  const response = await fetch(`${origin}/api/ui/sign-in-link`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: "{}",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("The running app did not accept the owner credential");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of response.body ?? []) {
    const chunk: unknown = value;
    if (!(chunk instanceof Uint8Array)) throw new Error("Invalid sign-in response bytes");
    bytes += chunk.byteLength;
    if (bytes > 4_096) throw new Error("Sign-in response exceeds its bound");
    chunks.push(Buffer.from(chunk));
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("url" in value) ||
    typeof value.url !== "string"
  )
    throw new Error("The running app returned an invalid sign-in link");
  const link = new URL(value.url);
  if (
    link.origin !== origin ||
    link.pathname !== "/" ||
    link.search !== "" ||
    link.username !== "" ||
    link.password !== "" ||
    !/^#bootstrap=[A-Za-z0-9_-]{43}$/u.test(link.hash)
  )
    throw new Error("The running app returned an invalid sign-in link");
  return link.href;
}
