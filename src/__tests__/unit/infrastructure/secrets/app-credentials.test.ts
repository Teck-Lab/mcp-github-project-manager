import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GhCliSecretProvider } from "../../../../infrastructure/secrets/GhCliSecretProvider";
import { createDefaultSecretResolver } from "../../../../infrastructure/secrets/SecretProvider";

describe("App credentials prevent personal CLI credential fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY"])(
    "does not consult gh when %s is configured",
    (name) => {
      const gh = vi.spyOn(GhCliSecretProvider.prototype, "get").mockReturnValue("personal-token");
      const resolver = createDefaultSecretResolver({ NODE_ENV: "production", [name]: "app-value" });
      expect(resolver.resolve("GITHUB_TOKEN")).toBeUndefined();
      expect(gh).not.toHaveBeenCalled();
    }
  );

  it("also detects App credentials supplied through mounted secret files", () => {
    const directory = mkdtempSync(join(tmpdir(), "github-app-secrets-"));
    try {
      writeFileSync(join(directory, "GITHUB_APP_ID"), "1234\n");
      const gh = vi.spyOn(GhCliSecretProvider.prototype, "get").mockReturnValue("personal-token");
      const resolver = createDefaultSecretResolver({
        NODE_ENV: "production",
        SECRETS_DIR: directory,
      });
      expect(resolver.resolve("GITHUB_TOKEN")).toBeUndefined();
      expect(gh).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
