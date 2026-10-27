import { generateKeyPairSync } from "node:crypto";
import type { Octokit } from "@octokit/rest";
import nock from "nock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureContainer, createProjectManagementService } from "../../../../container";
import { validateConfig } from "../../../../domain/config-schema";
import { getGitHubAppCredentials } from "../../../../env";
import { GitHubRepositoryFactory } from "../../../../infrastructure/github/GitHubRepositoryFactory";
import { BaseGitHubRepository } from "../../../../infrastructure/github/repositories/BaseRepository";
import { GitHubApiUtil } from "../../../../infrastructure/github/util/GitHubApiUtil";
import { executeListLinkedRepositories } from "../../../../infrastructure/tools/project-linking-tools";
import { createGitHubFactory } from "../../../../infrastructure/tools/tool-factory";

const owner = "test-owner";
const repo = "test-repo";
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const app = { appId: "1234", installationId: "5678", privateKey };
const appEnv = {
  GITHUB_OWNER: owner,
  GITHUB_REPO: repo,
  GITHUB_APP_ID: app.appId,
  GITHUB_APP_INSTALLATION_ID: app.installationId,
  GITHUB_APP_PRIVATE_KEY: privateKey,
};

class OwnerResolutionProbe extends BaseGitHubRepository {
  resolveOwner(login: string) {
    return this.resolveOwnerNodeId(login);
  }
}

function issueInstallationToken(token: string) {
  return nock("https://api.github.com")
    .post(`/app/installations/${app.installationId}/access_tokens`)
    .matchHeader("authorization", /^bearer [^.]+\.[^.]+\.[^.]+$/i)
    .reply(201, {
      token,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      permissions: { issues: "write" },
    });
}

describe("GitHub App installation authentication", () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(appEnv)) vi.stubEnv(key, value);
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_CLI_TOKEN_FALLBACK", "false");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    nock.cleanAll();
  });

  it("accepts complete App-only startup configuration", () => {
    expect(() => validateConfig(appEnv)).not.toThrow();
  });

  it.each(["GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY"])(
    "rejects partial App configuration missing %s even if a token exists",
    (missing) => {
      const env: Record<string, string | undefined> = { ...appEnv, GITHUB_TOKEN: "test-pat" };
      delete env[missing];
      expect(() => validateConfig(env)).toThrow(missing);
      vi.stubEnv(missing, "");
      expect(() => getGitHubAppCredentials()).toThrow(/GitHub App/);
    }
  );

  it("normalizes literal newlines in a Coolify-supplied PEM", () => {
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey.replace(/\n/g, "\\n"));
    expect(getGitHubAppCredentials()?.privateKey).toBe(privateKey);
  });

  it("constructs an App-only client without a dummy token or serializable private key", () => {
    const factory = new GitHubRepositoryFactory("", owner, repo, { app });
    expect(factory.getConfig().token).toBe("");
    expect(JSON.stringify(factory.getConfig())).not.toContain(privateKey);
  });

  it("rejects an unauthenticated library client", () => {
    expect(() => new GitHubRepositoryFactory("", owner, repo)).toThrow(/Token/);
  });

  it("accepts App-only configuration through the library factory helper", () => {
    const factory = GitHubRepositoryFactory.create(
      { GITHUB_TOKEN: "", GITHUB_OWNER: owner, GITHUB_REPO: repo },
      { app }
    );
    expect(factory.getConfig().authMode).toBe("app");
  });

  it("uses the App instead of a simultaneously configured personal token", async () => {
    const exchange = issueInstallationToken("ghs_app_identity");
    const api = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/milestones`)
      .matchHeader("authorization", /^(token|bearer) ghs_app_identity$/i)
      .reply(200, []);
    const client = new GitHubRepositoryFactory("unused-personal-token", owner, repo, {
      app,
    }).getOctokit() as unknown as Octokit;
    await client.rest.issues.listMilestones({ owner, repo });
    expect(exchange.isDone() && api.isDone()).toBe(true);
  });

  it("lists project repositories without requiring a personal token", async () => {
    const exchange = issueInstallationToken("ghs_linked_repositories");
    const api = nock("https://api.github.com")
      .post("/graphql")
      .matchHeader("authorization", /^(token|bearer) ghs_linked_repositories$/i)
      .reply(200, {
        data: {
          node: {
            repositories: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
              totalCount: 0,
            },
          },
        },
      });
    const result = await executeListLinkedRepositories({ projectId: "PVT_test", first: 20 });
    expect(result.structuredContent.totalCount).toBe(0);
    expect(exchange.isDone() && api.isDone()).toBe(true);
  });

  it("uses App authentication through the standalone tool factory", async () => {
    const exchange = issueInstallationToken("ghs_standalone");
    const api = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/milestones`)
      .matchHeader("authorization", /^(token|bearer) ghs_standalone$/i)
      .reply(200, []);
    const client = createGitHubFactory(owner, repo).getOctokit() as unknown as Octokit;
    await client.rest.issues.listMilestones({ owner, repo });
    expect(exchange.isDone() && api.isDone()).toBe(true);
  });

  it.each(["container", "facade"])(
    "creates milestones as the App through the %s path",
    async (path) => {
      vi.spyOn(GitHubApiUtil.getInstance(), "shouldThrottle").mockResolvedValue(false);
      const token = `ghs_${path}`;
      const exchange = issueInstallationToken(token);
      const api = nock("https://api.github.com")
        .post(`/repos/${owner}/${repo}/milestones`, {
          title: "App auth",
          description: "",
          state: "open",
        })
        .matchHeader("authorization", new RegExp(`^(token|bearer) ${token}$`, "i"))
        .reply(201, {
          node_id: "MI_test",
          number: 1,
          title: "App auth",
          description: "",
          state: "open",
          due_on: null,
          open_issues: 0,
          closed_issues: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      const factory =
        path === "container"
          ? configureContainer("", owner, repo).resolve<GitHubRepositoryFactory>(
              "GitHubRepositoryFactory"
            )
          : createProjectManagementService(owner, repo, "").getRepositoryFactory();
      const milestone = await factory
        .createMilestoneRepository()
        .create({ title: "App auth", description: "" });
      expect(milestone.title).toBe("App auth");
      expect(exchange.isDone() && api.isDone()).toBe(true);
    }
  );

  it("renews an expired installation token on the same long-lived client", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-10-27T12:00:00Z");
    vi.setSystemTime(start);
    const client = new GitHubRepositoryFactory("", owner, repo, {
      app,
    }).getOctokit() as unknown as Octokit;
    const first = issueInstallationToken("ghs_first");
    const firstApi = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/milestones`)
      .matchHeader("authorization", /^(token|bearer) ghs_first$/i)
      .reply(200, []);
    await client.rest.issues.listMilestones({ owner, repo });
    expect(first.isDone() && firstApi.isDone()).toBe(true);
    vi.setSystemTime(new Date(start.getTime() + 61 * 60 * 1000));
    const second = issueInstallationToken("ghs_second");
    const secondApi = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/milestones`)
      .matchHeader("authorization", /^(token|bearer) ghs_second$/i)
      .reply(200, []);
    await client.rest.issues.listMilestones({ owner, repo });
    expect(second.isDone() && secondApi.isDone()).toBe(true);
  });

  it("preserves explicit token authentication when App credentials are absent", async () => {
    for (const key of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_INSTALLATION_ID"])
      vi.stubEnv(key, "");
    vi.stubEnv("GITHUB_TOKEN", "test-pat");
    const api = nock("https://api.github.com")
      .get(`/repos/${owner}/${repo}/milestones`)
      .matchHeader("authorization", /^(token|bearer) test-pat$/i)
      .reply(200, []);
    const client = createGitHubFactory(owner, repo).getOctokit() as unknown as Octokit;
    await client.rest.issues.listMilestones({ owner, repo });
    expect(api.isDone()).toBe(true);
  });

  it.each(["O_fixture_organization", "U_fixture_user"])(
    "creates an App-owned project using repository owner ID %s",
    async (ownerId) => {
      vi.spyOn(GitHubApiUtil.getInstance(), "shouldThrottle").mockResolvedValue(false);
      const exchange = issueInstallationToken(`ghs_project_${ownerId}`);
      const ownerApi = nock("https://api.github.com")
        .post(
          "/graphql",
          (body) => body.query.includes("repositoryOwner(login:") && body.variables.login === owner
        )
        .matchHeader("authorization", new RegExp(`^(token|bearer) ghs_project_${ownerId}$`, "i"))
        .reply(200, { data: { repositoryOwner: { id: ownerId } } });
      const repoApi = nock("https://api.github.com")
        .post("/graphql", (body) => body.query.includes("GetRepositoryNodeId"))
        .reply(200, { data: { repository: { id: "R_fixture" } } });
      // GitHub returns an error, not a successful null user, for an org login.
      nock("https://api.github.com")
        .post("/graphql", (body) => body.query.includes("user(login:"))
        .reply(200, { errors: [{ type: "NOT_FOUND", message: "Could not resolve to a User" }] });
      const createApi = nock("https://api.github.com")
        .post("/graphql", (body) => {
          if (!body.query.includes("createProjectV2")) return false;
          expect(body.variables.input).toEqual({
            ownerId,
            repositoryId: "R_fixture",
            title: "App project",
          });
          return true;
        })
        .reply(200, {
          data: {
            createProjectV2: {
              projectV2: {
                id: "PVT_fixture",
                title: "App project",
                shortDescription: null,
                closed: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            },
          },
        });
      const result = await new GitHubRepositoryFactory("", owner, repo, { app })
        .createProjectRepository()
        .create({ title: "App project", owner, visibility: "private", fields: [], views: [] });
      expect(result.id).toBe("PVT_fixture");
      expect(ownerApi.isDone() && repoApi.isDone() && createApi.isDone() && exchange.isDone()).toBe(
        true
      );
    }
  );

  it("reports an unresolved repository owner", async () => {
    vi.spyOn(GitHubApiUtil.getInstance(), "shouldThrottle").mockResolvedValue(false);
    const exchange = issueInstallationToken("ghs_missing_owner");
    const api = nock("https://api.github.com")
      .post("/graphql", (body) => body.query.includes("repositoryOwner(login:"))
      .reply(200, { data: { repositoryOwner: null } });
    const factory = new GitHubRepositoryFactory("", owner, repo, { app });
    const probe = new OwnerResolutionProbe(factory.getOctokit(), factory.getConfig());
    await expect(probe.resolveOwner("missing-owner")).rejects.toThrow("Could not resolve owner");
    expect(api.isDone() && exchange.isDone()).toBe(true);
  });

  it("preserves permission errors instead of treating them as an owner-type fallback", async () => {
    vi.spyOn(GitHubApiUtil.getInstance(), "shouldThrottle").mockResolvedValue(false);
    const exchange = issueInstallationToken("ghs_denied_owner");
    const api = nock("https://api.github.com")
      .post("/graphql", (body) => body.query.includes("repositoryOwner(login:"))
      .reply(403, { message: "Resource not accessible by integration" });
    const factory = new GitHubRepositoryFactory("", owner, repo, { app });
    const probe = new OwnerResolutionProbe(factory.getOctokit(), factory.getConfig());
    await expect(probe.resolveOwner(owner)).rejects.toThrow(/not accessible by integration/);
    expect(api.isDone() && exchange.isDone()).toBe(true);
  });
});
