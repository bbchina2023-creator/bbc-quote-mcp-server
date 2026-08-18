import { DurableObject } from "cloudflare:workers";
import { constantTimeEqual } from "./oauth-security.js";

const RECORD_KEY = "oauth-state-record";

export class OAuthStateDurableObject extends DurableObject {
  async putState(record, expiresAt) {
    const expiry = Number(expiresAt);
    if (!record || typeof record !== "object") throw new Error("OAuth state record is required");
    if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error("OAuth state expiry is invalid");

    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.put(RECORD_KEY, { record, expiresAt: expiry });
      await this.ctx.storage.setAlarm(expiry);
    });
    return { ok: true };
  }

  async consumeState(expectedHash = "") {
    let envelope;
    await this.ctx.blockConcurrencyWhile(async () => {
      envelope = await this.ctx.storage.get(RECORD_KEY);
      if (envelope) {
        await this.ctx.storage.delete(RECORD_KEY);
        await this.ctx.storage.deleteAlarm();
      }
    });

    if (!envelope || Number(envelope.expiresAt) <= Date.now()) {
      return { ok: false, reason: "expired_or_replayed" };
    }

    if (expectedHash) {
      const storedHash = String(envelope.record?.csrfHash || "");
      if (!storedHash || !constantTimeEqual(storedHash, expectedHash)) {
        return { ok: false, reason: "mismatch" };
      }
    }

    return { ok: true, record: envelope.record };
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
