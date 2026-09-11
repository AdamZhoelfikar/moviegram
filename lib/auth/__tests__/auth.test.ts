import { describe, expect, it } from "vitest";
import {
  createGrant,
  createSessionToken,
  createWsTicket,
  verifyGrant,
  verifySessionToken,
  verifyWsTicket,
} from "../../auth";

describe("session tokens", () => {
  it("round-trips a payload", () => {
    const token = createSessionToken({ userId: "u1", displayName: "Adam" });
    expect(verifySessionToken(token)).toEqual({ userId: "u1", displayName: "Adam" });
  });

  it("rejects tampered payloads", () => {
    const token = createSessionToken({ userId: "u1", displayName: "Adam" });
    const [body, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ userId: "admin", displayName: "Admin" }),
    ).toString("base64url");
    expect(verifySessionToken(`${forged}.${sig}`)).toBeNull();
    expect(verifySessionToken(`${body}.AAAAAAAA`)).toBeNull();
    expect(verifySessionToken("garbage")).toBeNull();
    expect(verifySessionToken(null)).toBeNull();
  });
});

describe("stream grants (PRD 16.6)", () => {
  it("validates only for the same resource", () => {
    const grant = createGrant("vid1", 1);
    expect(verifyGrant("vid1", grant)).toBe(true);
    expect(verifyGrant("vid2", grant)).toBe(false);
  });

  it("rejects expired grants", () => {
    const grant = createGrant("vid1", -1);
    expect(verifyGrant("vid1", grant)).toBe(false);
  });

  it("rejects malformed grants", () => {
    expect(verifyGrant("vid1", "")).toBe(false);
    expect(verifyGrant("vid1", "a.b")).toBe(false);
    expect(verifyGrant("vid1", "vid1.99999999999999.notsig")).toBe(false);
  });
});

describe("ws tickets", () => {
  it("binds the ticket to one room code", () => {
    const ticket = createWsTicket("u1", "ABC123");
    expect(verifyWsTicket(ticket)).toMatchObject({ userId: "u1", code: "abc123" });
  });

  it("rejects expired tickets", () => {
    const ticket = createWsTicket("u1", "ABC", -1);
    expect(verifyWsTicket(ticket)).toBeNull();
  });
});
